import type { Coordinate } from "@busstops/contracts";
import {
  OverpassResponseSchema,
  deterministicUuid,
  isBusRoutableHighway,
  mapRoadClass,
  parseMaxSpeedMph,
} from "@busstops/adapters";
import { haversineMetres, isPlausibleEnglandCoordinate } from "@busstops/pipeline-core";

/**
 * Road segments for the analytics batch, extracted from OpenStreetMap.
 *
 * This dataset is why Bus Stops Pro has never shown a live figure. The batch reads
 * `network/segments` before it will process anything, and nothing in the repository published it
 * — one constant in `run-batch.ts` naming a dataset that had no producer — so every scheduled run
 * ended at "No road segments published" and Pro fell back to its dated demonstration snapshot.
 * The batch's failures looked like an analytics problem; they were a missing input.
 *
 * The adapter's `normalizeOverpass` cannot be reused as it stands: it produces the contract's
 * `RoadSegment`, which describes a segment without saying where it goes. The batch samples vehicle
 * traces against a segment's geometry, so the path is the part it needs, and that is what this
 * keeps.
 */

/** What the batch reads. Deliberately small: the batch holds every segment it is given. */
export interface PublishedRoadSegment {
  id: string;
  /** The way's geometry, which is what a vehicle trace is sampled against. */
  path: Coordinate[];
  lengthMetres: number;
  /** Metres per second, only where OSM states a limit. Null is a real and common answer. */
  speedLimitMetresPerSecond: number | null;
  speedLimitSource: string | null;
  roadClass: string;
  /** Grouping key for corridor-level reporting: a road name where there is one, else the way. */
  corridorId: string;
  osmWayId: string;
}

const MPH_TO_METRES_PER_SECOND = 0.44704;

/**
 * Longer than this and a segment is not a useful unit of congestion.
 *
 * A traversal time over a ten-kilometre way says almost nothing about where the delay was, and a
 * trace that enters and leaves it is one sample rather than the several it should be. Long ways
 * are cut at node boundaries, so every piece keeps real geometry and no point is invented.
 */
const MAX_SEGMENT_METRES = 1_200;

/** Below this a piece is folded into its neighbour rather than published as its own segment. */
const MIN_SEGMENT_METRES = 40;

export interface ExtractOptions {
  retrievedAt: string;
  /** Where these came from, so a partial extraction can say what it covered. */
  areaId: string;
}

export interface ExtractResult {
  segments: PublishedRoadSegment[];
  /** Ways seen that were not bus-routable, or had too little geometry to place. */
  rejected: number;
  /** Ways that were split because they were longer than one segment should be. */
  split: number;
}

function pathLength(path: readonly Coordinate[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += haversineMetres(path[i - 1]!, path[i]!);
  return total;
}

/**
 * Cuts a way into pieces no longer than the cap, always at existing nodes.
 *
 * Never interpolates: a segment's geometry has to be geometry the map actually has, or the
 * traversal samples taken against it are measured off a road that is not there.
 */
function cut(path: readonly Coordinate[]): Coordinate[][] {
  const pieces: Coordinate[][] = [];
  let current: Coordinate[] = [path[0]!];
  let running = 0;

  for (let i = 1; i < path.length; i += 1) {
    const step = haversineMetres(path[i - 1]!, path[i]!);
    current.push(path[i]!);
    running += step;
    if (running >= MAX_SEGMENT_METRES && i < path.length - 1) {
      pieces.push(current);
      current = [path[i]!];
      running = 0;
    }
  }

  // The tail joins the previous piece rather than being published as a stub.
  if (current.length >= 2) {
    if (pieces.length > 0 && running < MIN_SEGMENT_METRES) {
      pieces[pieces.length - 1]!.push(...current.slice(1));
    } else {
      pieces.push(current);
    }
  }
  return pieces;
}

/**
 * Bus-routable segments from one Overpass response.
 *
 * Footways and paths are in the same response because the journey planner's walking graph wants
 * them; they are not roads a bus is delayed on, so they are counted and dropped here.
 */
export function segmentsFromOverpass(payload: unknown, options: ExtractOptions): ExtractResult {
  const parsed = OverpassResponseSchema.safeParse(payload);
  if (!parsed.success) return { segments: [], rejected: 1, split: 0 };

  const nodes = new Map<number, Coordinate>();
  for (const element of parsed.data.elements) {
    if (element.type !== "node") continue;
    const coordinate = { lat: element.lat, lon: element.lon };
    if (isPlausibleEnglandCoordinate(coordinate)) nodes.set(element.id, coordinate);
  }

  const segments: PublishedRoadSegment[] = [];
  let rejected = 0;
  let split = 0;

  for (const element of parsed.data.elements) {
    if (element.type !== "way") continue;
    const tags = element.tags ?? {};
    const highway = tags.highway;
    if (!highway || !isBusRoutableHighway(highway)) {
      rejected += 1;
      continue;
    }

    const path = element.nodes
      .map((id) => nodes.get(id))
      .filter((coordinate): coordinate is Coordinate => coordinate !== undefined);
    if (path.length < 2) {
      rejected += 1;
      continue;
    }

    const speedLimitMph = parseMaxSpeedMph(tags.maxspeed);
    const speedLimitMetresPerSecond =
      speedLimitMph === null ? null : speedLimitMph * MPH_TO_METRES_PER_SECOND;
    const corridorId = tags.ref ?? tags.name ?? `way-${element.id}`;
    const pieces = cut(path);
    if (pieces.length > 1) split += 1;

    for (const [at, piece] of pieces.entries()) {
      const lengthMetres = pathLength(piece);
      if (lengthMetres <= 0) {
        rejected += 1;
        continue;
      }
      segments.push({
        /*
         * Derived from the way and the piece index, so the same road extracted again is the same
         * segment id. Without that every extraction would orphan the interval buckets aggregated
         * against the previous one, and Pro's history would reset each time this ran.
         */
        id: deterministicUuid("segment", `osm-way:${element.id}:${at}`),
        path: piece,
        lengthMetres,
        speedLimitMetresPerSecond,
        speedLimitSource: speedLimitMph === null ? null : "osm:maxspeed",
        roadClass: mapRoadClass(highway),
        corridorId,
        osmWayId: String(element.id),
      });
    }
  }

  void options.areaId;
  return { segments, rejected, split };
}
