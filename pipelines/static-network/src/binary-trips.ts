/**
 * A pattern-trips shard as bytes, so that opening one costs no parse.
 *
 * The measured shape of a journey request, on real published data (scripts/measure-serving-cpu.ts,
 * Manchester corridor): walking the trip shards 0.47 ms, **parsing every trip row 24.26 ms**,
 * building the graph 10.29 ms, searching it 3.24 ms. The search — the part that is actually
 * transport computation — is the cheapest thing in the request. What does not fit in ten
 * milliseconds of Workers Free CPU is turning eight megabytes of JSON into objects first.
 *
 * Filtering before the parse helps and is already done, on both read paths. It cannot be enough:
 * the rows a plan does keep still have to become objects, and `JSON.parse` on a line with two
 * arrays of twenty-five numbers is the dominant cost whichever lines are chosen.
 *
 * So the shard is published in a form a search can read directly. Columnar, little-endian, and
 * laid out so every number the search touches is already a number in a typed array:
 *
 * ```
 *   header: 11 × u32
 *     0  magic 'BST1'          16  patternCount
 *     4  version               20  reserved (0)
 *     8  tripCount             24  patternOffsetsAt   32  tripIdOffsetsAt
 *    12  callCount             28  patternBlobAt      36  tripIdBlobAt
 *                                                     40  byteLength
 *   callOffsets    u32[tripCount + 1]   where each trip's calls begin
 *   patternIndex   u32[tripCount]       which pattern id each trip is on
 *   departures     u32[callCount]       epoch seconds, in the pattern's stop order
 *   arrivalDeltas  u16[callCount]       departure − arrival, almost always zero
 *   patternOffsets u32[patternCount+1]  into the pattern-id blob
 *   patternBlob    utf-8
 *   tripIdOffsets  u32[tripCount + 1]   into the trip-id blob
 *   tripIdBlob     utf-8
 * ```
 *
 * The two string blobs sit at the end and are never touched by a search: a plan decodes the ids of
 * the two or three trips it actually recommends. The numbers are read through `Uint32Array` views
 * over the same bytes, so "opening" a shard is three view constructions and no allocation per row.
 *
 * Epoch seconds as u32 are good until 2106. Arrival deltas are unsigned sixteen-bit because a bus
 * arrives before it leaves and the gap is a layover, not a day; a longer gap is clamped, and the
 * clamp is reported by `encodePatternTripShard` rather than hidden, so a timetable that needs more
 * is a visible fact and not a silently wrong transfer.
 */

import type { PatternTripRow } from "./departures-index.js";

const MAGIC = 0x31545342; /* 'BST1' little-endian */
const VERSION = 1;
const HEADER_U32 = 11;
const HEADER_BYTES = HEADER_U32 * 4;
const MAX_ARRIVAL_DELTA = 0xffff;

/** What an encode had to give up on, if anything. Empty is the normal case. */
export interface BinaryTripShardStats {
  trips: number;
  calls: number;
  patterns: number;
  bytes: number;
  /** Calls whose arrival was further than eighteen hours before its departure, and was clamped. */
  clampedArrivals: number;
  /** Rows dropped because they carried no calls at all, which no search can use. */
  droppedEmptyRows: number;
}

const align4 = (value: number): number => (value + 3) & ~3;

/**
 * Encode rows as one shard's bytes.
 *
 * Publish-side, so it is allowed to be the slow half: it runs once a day in a GitHub job, and
 * what it buys is every passenger request that opens the shard afterwards.
 */
export function encodePatternTripShard(rows: readonly PatternTripRow[]): {
  bytes: Uint8Array;
  stats: BinaryTripShardStats;
} {
  const kept: PatternTripRow[] = [];
  let droppedEmptyRows = 0;
  for (const row of rows) {
    if (row.t.length === 0) droppedEmptyRows += 1;
    else kept.push(row);
  }

  const patternIds: string[] = [];
  const patternIndexById = new Map<string, number>();
  let callCount = 0;
  for (const row of kept) {
    callCount += row.t.length;
    if (!patternIndexById.has(row.p)) {
      patternIndexById.set(row.p, patternIds.length);
      patternIds.push(row.p);
    }
  }

  const encoder = new TextEncoder();
  const patternBytes = patternIds.map((id) => encoder.encode(id));
  const tripIdBytes = kept.map((row) => encoder.encode(row.j));
  const patternBlobLength = patternBytes.reduce((total, part) => total + part.length, 0);
  const tripIdBlobLength = tripIdBytes.reduce((total, part) => total + part.length, 0);

  const trips = kept.length;
  const patterns = patternIds.length;

  const callOffsetsAt = HEADER_BYTES;
  const patternIndexAt = callOffsetsAt + (trips + 1) * 4;
  const departuresAt = patternIndexAt + trips * 4;
  const arrivalDeltasAt = departuresAt + callCount * 4;
  const patternOffsetsAt = align4(arrivalDeltasAt + callCount * 2);
  const patternBlobAt = patternOffsetsAt + (patterns + 1) * 4;
  const tripIdOffsetsAt = align4(patternBlobAt + patternBlobLength);
  const tripIdBlobAt = tripIdOffsetsAt + (trips + 1) * 4;
  const byteLength = tripIdBlobAt + tripIdBlobLength;

  const bytes = new Uint8Array(byteLength);
  const header = new Uint32Array(bytes.buffer, 0, HEADER_U32);
  header[0] = MAGIC;
  header[1] = VERSION;
  header[2] = trips;
  header[3] = callCount;
  header[4] = patterns;
  header[5] = 0;
  header[6] = patternOffsetsAt;
  header[7] = patternBlobAt;
  header[8] = tripIdOffsetsAt;
  header[9] = tripIdBlobAt;
  header[10] = byteLength;

  const callOffsets = new Uint32Array(bytes.buffer, callOffsetsAt, trips + 1);
  const patternIndex = new Uint32Array(bytes.buffer, patternIndexAt, trips);
  const departures = new Uint32Array(bytes.buffer, departuresAt, callCount);
  /* Unaligned by construction — u16 after an odd number of u32 sections is fine, but a typed
   * array needs its own alignment, so the deltas go through a DataView. */
  const view = new DataView(bytes.buffer);

  let clampedArrivals = 0;
  let cursor = 0;
  for (let trip = 0; trip < trips; trip += 1) {
    const row = kept[trip]!;
    callOffsets[trip] = cursor;
    patternIndex[trip] = patternIndexById.get(row.p)!;
    for (let call = 0; call < row.t.length; call += 1) {
      const departure = row.t[call]!;
      departures[cursor] = departure;
      const arrival = row.a?.[call];
      let delta = arrival === undefined ? 0 : departure - arrival;
      if (!Number.isFinite(delta) || delta < 0) delta = 0;
      if (delta > MAX_ARRIVAL_DELTA) {
        delta = MAX_ARRIVAL_DELTA;
        clampedArrivals += 1;
      }
      view.setUint16(arrivalDeltasAt + cursor * 2, delta, true);
      cursor += 1;
    }
  }
  callOffsets[trips] = cursor;

  const patternOffsets = new Uint32Array(bytes.buffer, patternOffsetsAt, patterns + 1);
  let at = 0;
  for (let index = 0; index < patterns; index += 1) {
    patternOffsets[index] = at;
    bytes.set(patternBytes[index]!, patternBlobAt + at);
    at += patternBytes[index]!.length;
  }
  patternOffsets[patterns] = at;

  const tripIdOffsets = new Uint32Array(bytes.buffer, tripIdOffsetsAt, trips + 1);
  at = 0;
  for (let index = 0; index < trips; index += 1) {
    tripIdOffsets[index] = at;
    bytes.set(tripIdBytes[index]!, tripIdBlobAt + at);
    at += tripIdBytes[index]!.length;
  }
  tripIdOffsets[trips] = at;

  return {
    bytes,
    stats: {
      trips,
      calls: callCount,
      patterns,
      bytes: byteLength,
      clampedArrivals,
      droppedEmptyRows,
    },
  };
}

/** A shard's bytes, read in place. Nothing here allocates per trip except where it says so. */
export class PatternTripShard {
  readonly tripCount: number;
  readonly callCount: number;
  readonly patternCount: number;

  private readonly bytes: Uint8Array;
  private readonly callOffsets: Uint32Array;
  private readonly patternIndex: Uint32Array;
  private readonly departures: Uint32Array;
  private readonly arrivalDeltasAt: number;
  private readonly view: DataView;
  private readonly patternOffsets: Uint32Array;
  private readonly patternBlobAt: number;
  private readonly tripIdOffsets: Uint32Array;
  private readonly tripIdBlobAt: number;
  private readonly decoder = new TextDecoder();

  constructor(input: Uint8Array | ArrayBuffer) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    /*
     * A copy only when the body does not begin on a four-byte boundary, which a sliced R2 body
     * can fail to do and which a `Uint32Array` view refuses. The normal case is no copy at all.
     */
    this.bytes = bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes);
    const base = this.bytes.byteOffset;
    const buffer = this.bytes.buffer;
    const header = new Uint32Array(buffer, base, HEADER_U32);
    if (header[0] !== MAGIC) throw new Error("not a binary trip shard");
    if (header[1] !== VERSION)
      throw new Error(`unsupported trip shard version ${String(header[1])}`);

    this.tripCount = header[2]!;
    this.callCount = header[3]!;
    this.patternCount = header[4]!;
    const patternOffsetsAt = header[6]!;
    this.patternBlobAt = header[7]!;
    const tripIdOffsetsAt = header[8]!;
    this.tripIdBlobAt = header[9]!;
    if (header[10]! > this.bytes.byteLength) throw new Error("truncated trip shard");

    const callOffsetsAt = HEADER_BYTES;
    const patternIndexAt = callOffsetsAt + (this.tripCount + 1) * 4;
    const departuresAt = patternIndexAt + this.tripCount * 4;
    this.callOffsets = new Uint32Array(buffer, base + callOffsetsAt, this.tripCount + 1);
    this.patternIndex = new Uint32Array(buffer, base + patternIndexAt, this.tripCount);
    this.departures = new Uint32Array(buffer, base + departuresAt, this.callCount);
    this.arrivalDeltasAt = base + departuresAt + this.callCount * 4;
    this.view = new DataView(buffer);
    this.patternOffsets = new Uint32Array(buffer, base + patternOffsetsAt, this.patternCount + 1);
    this.tripIdOffsets = new Uint32Array(buffer, base + tripIdOffsetsAt, this.tripCount + 1);
  }

  callsIn(trip: number): number {
    return this.callOffsets[trip + 1]! - this.callOffsets[trip]!;
  }

  departure(trip: number, call: number): number {
    return this.departures[this.callOffsets[trip]! + call]!;
  }

  arrival(trip: number, call: number): number {
    const at = this.callOffsets[trip]! + call;
    return this.departures[at]! - this.view.getUint16(this.arrivalDeltasAt + at * 2, true);
  }

  /**
   * The four numbers that identify this shard's contents.
   *
   * A published route grouping names trips by their index in a shard, so it is only meaningful for
   * the shard it was built from — and mapping an index onto the wrong bus would put a passenger on
   * a service that does not exist. These four travel in the grouping's header and are compared
   * before it is used: the trip count, the total number of calls, and the first and last departure
   * in the array. Two different timetables agreeing on all four is not a thing that happens by
   * accident, and checking costs nothing because the reader has them already.
   */
  fingerprint(): {
    tripCount: number;
    callCount: number;
    firstDeparture: number;
    lastDeparture: number;
  } {
    return {
      tripCount: this.tripCount,
      callCount: this.callCount,
      firstDeparture: this.callCount === 0 ? 0 : this.departures[0]!,
      lastDeparture: this.callCount === 0 ? 0 : this.departures[this.callCount - 1]!,
    };
  }

  /** The two numbers a horizon test needs, without touching anything else in the row. */
  firstDeparture(trip: number): number {
    return this.departures[this.callOffsets[trip]!]!;
  }

  lastDeparture(trip: number): number {
    return this.departures[this.callOffsets[trip + 1]! - 1]!;
  }

  patternOf(trip: number): number {
    return this.patternIndex[trip]!;
  }

  /** Allocates: a string. A search needs it once per pattern, not once per trip. */
  patternId(index: number): string {
    const from = this.patternBlobAt + this.patternOffsets[index]!;
    const to = this.patternBlobAt + this.patternOffsets[index + 1]!;
    return this.decoder.decode(this.bytes.subarray(from, to));
  }

  /** Allocates: a string. A plan needs it for the trips it recommends. */
  tripId(trip: number): string {
    const from = this.tripIdBlobAt + this.tripIdOffsets[trip]!;
    const to = this.tripIdBlobAt + this.tripIdOffsets[trip + 1]!;
    return this.decoder.decode(this.bytes.subarray(from, to));
  }

  /**
   * One row, as the JSON form would have given it.
   *
   * This is the escape hatch, not the point: it allocates exactly what the parse used to, so
   * calling it for every trip in a shard gives back the cost the format exists to avoid. It is
   * here so a caller that genuinely needs a row — a test, a diagnostic, the legs of a chosen
   * itinerary — does not have to reach into the views.
   */
  rowAt(trip: number): PatternTripRow {
    const calls = this.callsIn(trip);
    const times: number[] = new Array<number>(calls);
    let differs = false;
    const arrivals: number[] = new Array<number>(calls);
    for (let call = 0; call < calls; call += 1) {
      times[call] = this.departure(trip, call);
      arrivals[call] = this.arrival(trip, call);
      if (arrivals[call] !== times[call]) differs = true;
    }
    const row: PatternTripRow = {
      p: this.patternId(this.patternOf(trip)),
      j: this.tripId(trip),
      t: times,
    };
    return differs ? { ...row, a: arrivals } : row;
  }
}

/**
 * Whether these bytes hold what these rows held.
 *
 * Read back out of the encoded form rather than compared against the encoder's own intermediate
 * state: what matters is that a reader opening the bytes sees the timetable, and the only honest
 * way to check that is to open them the way a reader will. This is what stands between a
 * migration and deleting a published timetable it has not replaced — so it compares the pattern,
 * the trip id, every departure and every arrival, not a count and a checksum.
 *
 * A row with no calls is excluded, because the encoder drops those: no search can use a trip that
 * stops nowhere, and the encode reports how many it dropped.
 */
export function shardHoldsEveryRow(
  bytes: Uint8Array,
  rows: readonly PatternTripRow[],
): { ok: true } | { ok: false; reason: string } {
  const expected = rows.filter((row) => row.t.length > 0);
  let shard: PatternTripShard;
  try {
    shard = new PatternTripShard(bytes);
  } catch (error) {
    return { ok: false, reason: `the bytes would not open: ${String(error).slice(0, 80)}` };
  }
  if (shard.tripCount !== expected.length) {
    return {
      ok: false,
      reason: `holds ${String(shard.tripCount)} trips, the rows have ${String(expected.length)}`,
    };
  }
  for (let trip = 0; trip < expected.length; trip += 1) {
    const want = expected[trip]!;
    const got = shard.rowAt(trip);
    if (got.p !== want.p) return { ok: false, reason: `trip ${String(trip)}: pattern differs` };
    if (got.j !== want.j) return { ok: false, reason: `trip ${String(trip)}: trip id differs` };
    if (got.t.length !== want.t.length) {
      return {
        ok: false,
        reason: `trip ${want.j}: ${String(got.t.length)} calls, not ${String(want.t.length)}`,
      };
    }
    for (let call = 0; call < want.t.length; call += 1) {
      if (got.t[call] !== want.t[call]) {
        return { ok: false, reason: `trip ${want.j}, call ${String(call)}: departure differs` };
      }
      const wantArrival = want.a?.[call] ?? want.t[call]!;
      if (shard.arrival(trip, call) !== wantArrival) {
        return { ok: false, reason: `trip ${want.j}, call ${String(call)}: arrival differs` };
      }
    }
  }
  return { ok: true };
}
