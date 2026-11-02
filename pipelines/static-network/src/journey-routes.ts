/**
 * Route grouping, published per trip shard instead of inferred per request.
 *
 * Grouping trips into routes — the sets of trips that run the same stop sequence, split so that no
 * bus in a route overtakes another — is derived entirely from the published timetable, and the
 * request was deriving it every time. Measured on real corridors it cost more than the walking
 * transfers did: 27.65 ms against 23.56 in Manchester, 38.28 against 24.76 in Birmingham, in a
 * request allowed ten milliseconds for everything.
 *
 * What makes it publishable is a property of the trip shard. A row's times are indexed by position
 * in its pattern's stop sequence and the array is dense, so a trip with fewer times runs the
 * pattern's first *n* stops: "the same stop sequence" is exactly "the same pattern and the same
 * number of calls", and the grouping needs no stop ids at all. So this artifact is small — a few
 * integers per trip — and it names trips by their index in the shard it belongs to.
 *
 * ```
 *   header: 10 × u32
 *     0  magic 'BRGP'        20  tripCount      (of the shard it describes)
 *     4  version            24  callCount      (of the shard: part of the fingerprint)
 *     8  routeCount         28  firstDeparture (of the shard: part of the fingerprint)
 *    12  tripsInRoutes      32  lastDeparture  (of the shard: part of the fingerprint)
 *    16  byteLength         36  reserved (0)
 *   routeOffsets  u32[routeCount + 1]  where each route's trips begin
 *   routeTrips    u32[tripsInRoutes]   trip indices, in the order the search scans them
 *   routePattern  u32[routeCount]      the pattern index each route is on
 *   routeCalls    u32[routeCount]      how many calls its trips make
 * ```
 *
 * Because trips are named by index, this artifact is only meaningful for the exact shard it was
 * built from — so the shard's own shape travels in the header as a fingerprint, and a reader whose
 * shard disagrees falls back to grouping in the request rather than mapping an index onto the wrong
 * bus. That is the whole of the version-consistency rule, enforced rather than documented.
 */

import { SHARDED } from "./shards.js";

const MAGIC = 0x50475242; /* 'BRGP' little-endian */
const VERSION = 1;
const HEADER_U32 = 10;
const HEADER_BYTES = HEADER_U32 * 4;

/** Where one shard's grouping is published. Mirrors the trips' own dataset path. */
export function journeyRoutesDataset(serviceDate: string, tile: string, window: number): string {
  return `${SHARDED.journeyRoutes}/${serviceDate}/${String(window)}/${tile}`;
}

/**
 * The shape of the shard a grouping belongs to.
 *
 * Four numbers rather than a hash of the bytes: they are what a reader has already read by the
 * time it needs to check, so verifying costs nothing. Two different shards agreeing on all four —
 * the same trips, the same total calls, the same first and last departure — would have to be the
 * same timetable.
 */
export interface ShardFingerprint {
  tripCount: number;
  callCount: number;
  firstDeparture: number;
  lastDeparture: number;
}

export interface RouteGroupingInput {
  fingerprint: ShardFingerprint;
  routes: readonly { patternKey: number; callCount: number; trips: readonly number[] }[];
}

export interface RouteGroupingStats {
  routes: number;
  trips: number;
  bytes: number;
}

export function encodeRouteGrouping(input: RouteGroupingInput): {
  bytes: Uint8Array;
  stats: RouteGroupingStats;
} {
  const routeCount = input.routes.length;
  let tripsInRoutes = 0;
  for (const route of input.routes) tripsInRoutes += route.trips.length;

  const routeOffsetsAt = HEADER_BYTES;
  const routeTripsAt = routeOffsetsAt + (routeCount + 1) * 4;
  const routePatternAt = routeTripsAt + tripsInRoutes * 4;
  const routeCallsAt = routePatternAt + routeCount * 4;
  const byteLength = routeCallsAt + routeCount * 4;

  const bytes = new Uint8Array(byteLength);
  const header = new Uint32Array(bytes.buffer, 0, HEADER_U32);
  header[0] = MAGIC;
  header[1] = VERSION;
  header[2] = routeCount;
  header[3] = tripsInRoutes;
  header[4] = byteLength;
  header[5] = input.fingerprint.tripCount;
  header[6] = input.fingerprint.callCount;
  header[7] = input.fingerprint.firstDeparture;
  header[8] = input.fingerprint.lastDeparture;
  header[9] = 0;

  const routeOffsets = new Uint32Array(bytes.buffer, routeOffsetsAt, routeCount + 1);
  const routeTrips = new Uint32Array(bytes.buffer, routeTripsAt, tripsInRoutes);
  const routePattern = new Uint32Array(bytes.buffer, routePatternAt, routeCount);
  const routeCalls = new Uint32Array(bytes.buffer, routeCallsAt, routeCount);

  let at = 0;
  for (let route = 0; route < routeCount; route += 1) {
    const group = input.routes[route]!;
    routeOffsets[route] = at;
    routePattern[route] = group.patternKey;
    routeCalls[route] = group.callCount;
    for (const trip of group.trips) {
      routeTrips[at] = trip;
      at += 1;
    }
  }
  routeOffsets[routeCount] = at;

  return { bytes, stats: { routes: routeCount, trips: tripsInRoutes, bytes: byteLength } };
}

/** One shard's published grouping, read in place. */
export class RouteGrouping {
  readonly routeCount: number;
  readonly tripCount: number;
  readonly fingerprint: ShardFingerprint;

  private readonly routeOffsets: Uint32Array;
  private readonly routeTrips: Uint32Array;
  private readonly routePattern: Uint32Array;
  private readonly routeCalls: Uint32Array;

  constructor(input: Uint8Array | ArrayBuffer) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const aligned = bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes);
    const base = aligned.byteOffset;
    const buffer = aligned.buffer;
    const header = new Uint32Array(buffer, base, HEADER_U32);
    if (header[0] !== MAGIC) throw new Error("not a published route grouping");
    if (header[1] !== VERSION) {
      throw new Error(`unsupported route grouping version ${String(header[1])}`);
    }
    this.routeCount = header[2]!;
    const tripsInRoutes = header[3]!;
    if (header[4]! > aligned.byteLength) throw new Error("truncated route grouping");
    this.fingerprint = {
      tripCount: header[5]!,
      callCount: header[6]!,
      firstDeparture: header[7]!,
      lastDeparture: header[8]!,
    };
    this.tripCount = tripsInRoutes;

    const routeOffsetsAt = HEADER_BYTES;
    const routeTripsAt = routeOffsetsAt + (this.routeCount + 1) * 4;
    const routePatternAt = routeTripsAt + tripsInRoutes * 4;
    const routeCallsAt = routePatternAt + this.routeCount * 4;
    this.routeOffsets = new Uint32Array(buffer, base + routeOffsetsAt, this.routeCount + 1);
    this.routeTrips = new Uint32Array(buffer, base + routeTripsAt, tripsInRoutes);
    this.routePattern = new Uint32Array(buffer, base + routePatternAt, this.routeCount);
    this.routeCalls = new Uint32Array(buffer, base + routeCallsAt, this.routeCount);
  }

  /** Whether this grouping describes that shard. A reader that cannot say yes must not use it. */
  describes(shard: ShardFingerprint): boolean {
    return (
      this.fingerprint.tripCount === shard.tripCount &&
      this.fingerprint.callCount === shard.callCount &&
      this.fingerprint.firstDeparture === shard.firstDeparture &&
      this.fingerprint.lastDeparture === shard.lastDeparture
    );
  }

  patternKeyOf(route: number): number {
    return this.routePattern[route]!;
  }

  callCountOf(route: number): number {
    return this.routeCalls[route]!;
  }

  firstTrip(route: number): number {
    return this.routeOffsets[route]!;
  }

  tripEnd(route: number): number {
    return this.routeOffsets[route + 1]!;
  }

  tripAt(at: number): number {
    return this.routeTrips[at]!;
  }
}
