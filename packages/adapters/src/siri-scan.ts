import type { BoundingBox, VehicleObservation } from "@busstops/contracts";
import { isPlausibleEnglandCoordinate } from "@busstops/pipeline-core";
import { deterministicUuid, vehicleRefHasher } from "./identity.js";

/**
 * SIRI-VM for a passenger map, scanned rather than parsed.
 *
 * Cloudflare classified this Worker's failures as `exceededCpu` against a ten-millisecond free
 * limit, and `/v1/map` was measured at about ninety-six milliseconds of which eighty-eight were
 * turning the live feed into observations. Split by stage on a 542,940-character, 437-vehicle
 * feed:
 *
 * | Stage                                        | CPU      | Share |
 * | -------------------------------------------- | -------: | ----: |
 * | `fast-xml-parser` DOM of the whole document  | 23.84 ms |   68% |
 * | Zod `safeParse` per vehicle                  |  7.61 ms |   22% |
 * | building `VehicleObservation` records        |  3.29 ms |    9% |
 *
 * All three are avoidable for this caller, and none of them is avoidable by reading R2 differently
 * — which is why the streaming work, real as it is, could not have fixed this.
 *
 * **The DOM** materialises every element of a half-megabyte document as JavaScript objects so that
 * twelve fields can be read out of each vehicle. This walks the text instead: find the next
 * `<VehicleActivity>`, read the twelve tags inside it by bounded `indexOf`, and never build a node.
 *
 * **Zod** validates a shape this caller already handles field by field. A missing `VehicleRef` or
 * an unparseable coordinate is rejected here with the same reason string and the same counting, so
 * the degradation messaging keeps working; what is gone is schema machinery for fields nobody reads.
 *
 * **The observation records** carry a `deterministicUuid`, a provenance object, an `externalIds`
 * array, an `ingestedAt`, `qualityFlags` and an ISO string round-trip of a timestamp. A map draws
 * a marker from six fields. The full `VehicleObservation` shape is what the *collector* publishes,
 * and the collector runs in CI where CPU is free, so `normalizeSiriVm` stays exactly as it is for
 * that caller — this is a second, narrower reader beside it, not a replacement.
 *
 * What is deliberately kept: the opaque vehicle reference. Source vehicle codes persist for months
 * and republishing them would let anyone follow one vehicle across days
 * (docs/14_SECURITY.md "Privacy"), so the salted hash is not something to optimise away. It is one
 * hash per vehicle rather than three.
 *
 * Namespace prefixes vary between producers, which is why the DOM parser was configured with
 * `removeNSPrefix`. A text scan has to handle that itself: tags are matched on the local name with
 * the character before it required to be `<` or `:`, so `<Latitude>` and `<siri:Latitude>` both
 * read and `<SomeOtherLatitude>` does not.
 */

/** What a passenger map and a selected-bus panel actually read from a live feed. */
export interface LiveVehicle {
  /** Salted, rotating, opaque. Never the operator's own code. */
  vehicleRef: string;
  lat: number;
  lon: number;
  bearingDegrees?: number;
  /** Epoch milliseconds, not a `Date` and not an ISO string: both are allocations per vehicle. */
  observedAtMs: number;
  publishedLineName?: string;
  lineRef?: string;
  directionRef?: string;
  destinationName?: string;
  originName?: string;
  operatorRef?: string;
  journeyRef?: string;
  blockRef?: string;
}

export interface LiveScanOptions {
  /** Rotating salt, so public vehicle references cannot be correlated across service days. */
  vehicleSalt: string;
  nowMs: number;
  /** Discard observations older than this; a stale position is worse than none. */
  maxAgeSeconds?: number;
  /**
   * Keep only vehicles inside this box.
   *
   * BODS honours a bounding box on the request, so this is a second line rather than the first —
   * but a producer that ignores it would otherwise put a Cornish bus on a Leeds map, and the
   * filter costs two comparisons.
   */
  within?: BoundingBox;
  /** Stop after this many kept vehicles. A map caps what it draws anyway. */
  limit?: number;
  /**
   * Whether to read the four fields only a selected bus needs.
   *
   * A map marker shows a route number and a destination. The origin, the direction, the operator
   * and the block are read by `/v1/vehicles/:ref` for the one bus a passenger tapped, and reading
   * them for all 437 cost a measured 1.5 ms of a 4 ms budget — a third of it spent on five
   * hundred buses' worth of strings so that one bus can be described.
   *
   * Opt-in rather than opt-out, because the expensive caller is the rare one: the selected-bus
   * endpoint fetches its own feed for a box around a single vehicle, which is a far smaller
   * document than a city viewport.
   */
  detail?: boolean;
}

export interface LiveScanResult {
  vehicles: LiveVehicle[];
  responseTimestamp: string | null;
  /**
   * Why vehicles were dropped, counted by reason rather than listed per vehicle.
   *
   * The old path returned one entry per rejection, which on a national feed is thousands of
   * objects built to be counted. The counts are what the diagnostics show.
   */
  rejected: Record<string, number>;
  rejectedCount: number;
  /**
   * Age in seconds of every record the feed offered, accepted or not.
   *
   * A viewport with no buses because the feed was empty and one with no buses because every record
   * was twenty minutes old are different faults, and only the ages tell them apart.
   */
  recordAgeSeconds: number[];
  /** True when `limit` cut the scan short, so a caller can say the list is partial. */
  truncated: boolean;
}

/**
 * Where the content after `<LocalName ...>` begins, searching `[from, to)`. −1 when absent.
 *
 * Three producer variations have to survive here, and each is a way a text scan goes quietly
 * wrong where a DOM parser would not:
 *
 * **Namespace prefixes.** The DOM parser was configured with `removeNSPrefix` because prefixes
 * vary between producers, so `<siri:Latitude>` and `<Latitude>` must both read. The character
 * before the local name is required to be `<` or `:`.
 *
 * **Longer names ending with this one.** `<GridLatitude>` must not answer a search for
 * `Latitude`, which the rule above already prevents.
 *
 * **Attributes.** `<VehicleActivity>` and `<VehicleActivity xmlns="...">` are the same element.
 * The character after the local name is required to be `>` or whitespace, and the scan then moves
 * to the end of the tag — so an attribute does not make a viewport's buses disappear.
 */
function tagOpen(xml: string, from: number, to: number, localName: string): number {
  let at = xml.indexOf(localName, from);
  while (at !== -1 && at < to) {
    const before = xml.charCodeAt(at - 1);
    const after = xml.charCodeAt(at + localName.length);
    const named = before === 0x3c /* < */ || before === 0x3a; /* : */
    const ended =
      after === 0x3e /* > */ ||
      after === 0x20 ||
      after === 0x09 ||
      after === 0x0a ||
      after === 0x0d;
    if (named && ended) {
      if (after === 0x3e) return at + localName.length + 1;
      const close = xml.indexOf(">", at + localName.length);
      return close === -1 ? -1 : close + 1;
    }
    at = xml.indexOf(localName, at + localName.length);
  }
  return -1;
}

/**
 * The five predefined XML entities, decoded only when one is present.
 *
 * The DOM parser decodes these and a raw scan does not, which would put a literal `&amp;` on a
 * passenger's screen the first time a destination is "Bath & Wells". Numeric character references
 * are left alone: they do not appear in these feeds, and a half-implemented decoder is worse than
 * an obvious gap.
 */
function decodeEntities(value: string): string {
  if (value.indexOf("&") === -1) return value;
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The text of `<LocalName>` inside `[from, to)`, or undefined.
 *
 * Bounded to the range so one vehicle's scan can never read the next vehicle's field — the bug an
 * unbounded `indexOf` hides until two buses share a destination.
 */
function tagValue(xml: string, from: number, to: number, localName: string): string | undefined {
  const start = tagOpen(xml, from, to, localName);
  if (start === -1 || start > to) return undefined;
  const close = xml.indexOf("<", start);
  if (close === -1 || close > to) return undefined;
  const value = xml.slice(start, close).trim();
  return value.length === 0 ? undefined : decodeEntities(value);
}

const ACTIVITY = "VehicleActivity";
const ACTIVITY_CLOSE = "</VehicleActivity";

/**
 * Walks a SIRI-VM document's vehicle activities and builds only the vehicles a map keeps.
 *
 * Single pass, no document tree, no validation of fields nobody reads. Rejections are counted by
 * reason with the same rules the full normaliser applies: a missing reference, an implausible
 * coordinate, an unreadable timestamp, an observation too old, and a timestamp far enough in the
 * future to mean a broken producer clock.
 */
export function scanSiriVehicles(xml: string, options: LiveScanOptions): LiveScanResult {
  const maxAgeSeconds = options.maxAgeSeconds ?? 600;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const within = options.within;
  const detail = options.detail ?? false;

  /* The salt folded in once rather than per vehicle; see `vehicleRefHasher`. */
  const hashRef = vehicleRefHasher(options.vehicleSalt);

  const vehicles: LiveVehicle[] = [];
  const rejected: Record<string, number> = {};
  const recordAgeSeconds: number[] = [];
  let rejectedCount = 0;
  let truncated = false;

  const reject = (reason: string) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
    rejectedCount += 1;
  };

  /*
   * The response timestamp comes from the head of the document, before the first activity, so the
   * search is bounded there rather than scanning a half-megabyte body for a tag near the top.
   */
  const firstActivity = tagOpen(xml, 0, xml.length, ACTIVITY);
  const responseTimestamp =
    tagValue(
      xml,
      0,
      firstActivity === -1 ? Math.min(xml.length, 4_096) : firstActivity,
      "ResponseTimestamp",
    ) ?? null;

  if (firstActivity === -1) {
    return { vehicles, responseTimestamp, rejected, rejectedCount, recordAgeSeconds, truncated };
  }

  /*
   * From the start, not from `firstActivity`.
   *
   * `firstActivity` is where the *content* of the first activity begins, so using it as the
   * cursor made the first search for the opening tag start past that tag and find the second
   * vehicle. The scan reported 436 of 437 with no rejections, which is the shape of a silently
   * missing bus rather than a filtered one — exactly what the parity check in
   * `siri-scan.test.ts` catches.
   */
  let cursor = 0;
  for (;;) {
    const bodyFrom = tagOpen(xml, cursor, xml.length, ACTIVITY);
    if (bodyFrom === -1) break;
    const close = xml.indexOf(ACTIVITY_CLOSE, bodyFrom);
    const bodyTo = close === -1 ? xml.length : close;
    cursor = close === -1 ? xml.length : close + ACTIVITY_CLOSE.length;

    if (vehicles.length >= limit) {
      truncated = true;
      break;
    }

    const sourceRef = tagValue(xml, bodyFrom, bodyTo, "VehicleRef");
    if (sourceRef === undefined) {
      reject("missing VehicleRef");
      if (close === -1) break;
      continue;
    }

    const locationAt = tagOpen(xml, bodyFrom, bodyTo, "VehicleLocation");
    const lat =
      locationAt === -1 ? Number.NaN : Number(tagValue(xml, locationAt, bodyTo, "Latitude"));
    const lon =
      locationAt === -1 ? Number.NaN : Number(tagValue(xml, locationAt, bodyTo, "Longitude"));
    if (!isPlausibleEnglandCoordinate({ lat, lon })) {
      reject("implausible coordinate");
      if (close === -1) break;
      continue;
    }

    const recordedAt = tagValue(xml, bodyFrom, bodyTo, "RecordedAtTime");
    const observedAtMs = recordedAt === undefined ? Number.NaN : Date.parse(recordedAt);
    if (Number.isNaN(observedAtMs)) {
      reject("unparseable RecordedAtTime");
      if (close === -1) break;
      continue;
    }

    const ageSeconds = (options.nowMs - observedAtMs) / 1000;
    recordAgeSeconds.push(Math.round(ageSeconds));
    if (ageSeconds > maxAgeSeconds) {
      reject("observation too old");
      if (close === -1) break;
      continue;
    }
    if (ageSeconds < -120) {
      reject("observation timestamp in the future");
      if (close === -1) break;
      continue;
    }

    if (
      within !== undefined &&
      (lat < within.south || lat > within.north || lon < within.west || lon > within.east)
    ) {
      reject("outside the viewport");
      if (close === -1) break;
      continue;
    }

    const lineRef = tagValue(xml, bodyFrom, bodyTo, "LineRef");
    /* Many publishers give only `LineRef`, and a passenger-facing name is better than nothing. */
    const publishedLineName = tagValue(xml, bodyFrom, bodyTo, "PublishedLineName") ?? lineRef;
    const bearingRaw = Number(tagValue(xml, bodyFrom, bodyTo, "Bearing") ?? Number.NaN);
    const bearing =
      Number.isFinite(bearingRaw) && bearingRaw >= 0 && bearingRaw < 360
        ? Math.round(bearingRaw)
        : undefined;

    const framedAt = tagOpen(xml, bodyFrom, bodyTo, "FramedVehicleJourneyRef");
    const journeyRef =
      framedAt === -1 ? undefined : tagValue(xml, framedAt, bodyTo, "DatedVehicleJourneyRef");

    /* Every marker shows where its bus is going. */
    const destinationName = tagValue(xml, bodyFrom, bodyTo, "DestinationName");
    /* The rest only when a caller is describing one bus; see `detail`. */
    const directionRef = detail ? tagValue(xml, bodyFrom, bodyTo, "DirectionRef") : undefined;
    const originName = detail ? tagValue(xml, bodyFrom, bodyTo, "OriginName") : undefined;
    const operatorRef = detail ? tagValue(xml, bodyFrom, bodyTo, "OperatorRef") : undefined;
    const blockRef = detail ? tagValue(xml, bodyFrom, bodyTo, "BlockRef") : undefined;

    vehicles.push({
      vehicleRef: hashRef(sourceRef),
      lat,
      lon,
      ...(bearing === undefined ? {} : { bearingDegrees: bearing }),
      observedAtMs,
      ...(publishedLineName === undefined ? {} : { publishedLineName }),
      ...(lineRef === undefined ? {} : { lineRef }),
      ...(journeyRef === undefined ? {} : { journeyRef }),
      ...(destinationName === undefined ? {} : { destinationName }),
      ...(directionRef === undefined ? {} : { directionRef }),
      ...(originName === undefined ? {} : { originName }),
      ...(operatorRef === undefined ? {} : { operatorRef }),
      ...(blockRef === undefined ? {} : { blockRef }),
    });

    if (close === -1) break;
  }

  return { vehicles, responseTimestamp, rejected, rejectedCount, recordAgeSeconds, truncated };
}

/**
 * One scanned vehicle as the full `VehicleObservation`, for the caller that describes a single bus.
 *
 * `/v1/vehicles/:ref` publishes a `VehicleState` carrying provenance, an ingest stamp and quality
 * flags, so the selected bus genuinely needs the whole shape. Building it costs a
 * `deterministicUuid` — two FNV-1a hashes — plus a provenance object, an `externalIds` array and
 * an ISO round-trip of the timestamp, measured at about 2 ms for a 437-vehicle viewport.
 *
 * Which is exactly why the map does not use this. Two milliseconds of a ten-millisecond invocation
 * spent on records whose extra fields nothing reads was most of what the first attempt at Part A
 * got wrong: scanning and then building these came to 5.53 ms against a 4 ms target, so the map
 * keeps `LiveVehicle` and this builds the one.
 */
export function liveVehicleObservation(
  vehicle: LiveVehicle,
  retrievedAt: string,
  nowMs: number,
): VehicleObservation {
  const ageSeconds = (nowMs - vehicle.observedAtMs) / 1000;
  return {
    id: deterministicUuid("vehicle", `${vehicle.vehicleRef}:${String(vehicle.observedAtMs)}`),
    provenance: {
      source: "bods",
      retrievedAt,
      /* The source vehicle code is deliberately not republished as an external id. */
      externalIds:
        vehicle.journeyRef === undefined
          ? []
          : [{ source: "bods_journey" as const, id: vehicle.journeyRef }],
    },
    ingestedAt: retrievedAt,
    qualityFlags: ageSeconds > 120 ? ["stale"] : [],
    vehicleRef: vehicle.vehicleRef,
    ...(vehicle.journeyRef === undefined ? {} : { journeyRef: vehicle.journeyRef }),
    coordinate: { lat: vehicle.lat, lon: vehicle.lon },
    ...(vehicle.bearingDegrees === undefined ? {} : { bearingDegrees: vehicle.bearingDegrees }),
    observedAt: new Date(vehicle.observedAtMs).toISOString(),
    ...(vehicle.lineRef === undefined ? {} : { lineRef: vehicle.lineRef }),
    ...(vehicle.publishedLineName === undefined
      ? {}
      : { publishedLineName: vehicle.publishedLineName }),
    ...(vehicle.operatorRef === undefined ? {} : { operatorRef: vehicle.operatorRef }),
  };
}
