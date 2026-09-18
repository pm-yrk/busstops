import type { Coordinate, VehicleObservation } from "@busstops/contracts";
import { haversineMetres } from "@busstops/pipeline-core";
import { mapMatch, type MapMatchCandidateGeometry } from "@busstops/matching";

/**
 * Segment sampling (docs/07_DATA_PIPELINES.md stage "segment samples").
 *
 * A segment sample is one vehicle's traversal of one road segment: how long it took, and how
 * confident we are that the vehicle was actually on that segment. Everything about congestion is
 * built from these, which is why the confidence gate lives here rather than downstream — a
 * traversal derived from a low-confidence match is not evidence, and letting it through would put
 * a fabricated number into an aggregate that then looks perfectly solid.
 */

export interface RoadSegment {
  id: string;
  path: readonly Coordinate[];
  lengthMetres: number;
  /** Speed limit in metres per second, only when a source provides one. */
  speedLimitMetresPerSecond: number | null;
  speedLimitSource: string | null;
}

export interface SegmentSample {
  segmentId: string;
  vehicleRef: string;
  routeId: string | null;
  enteredAt: string;
  exitedAt: string;
  traversalSeconds: number;
  distanceMetres: number;
  meanSpeedMetresPerSecond: number;
  matchConfidence: number;
}

export interface SegmentSamplingOptions {
  /** Matches below this confidence produce no samples at all. */
  minimumMatchConfidence?: number;
  /** A traversal longer than this is treated as a layover or a gap, not a slow journey. */
  maxTraversalSeconds?: number;
  minimumPointsPerSegment?: number;
}

export const SEGMENT_DEFAULTS = {
  minimumMatchConfidence: 0.45,
  maxTraversalSeconds: 1800,
  minimumPointsPerSegment: 2,
} as const;

export interface SegmentSamplingResult {
  samples: SegmentSample[];
  discardedLowConfidence: number;
  discardedImplausible: number;
  unmatchedTraces: number;
}

/**
 * Where each segment is, so a trace is matched against its own street rather than the country.
 *
 * `sampleSegmentsForTrace` was handed every segment in the batch and rebuilt the whole candidate
 * array for each vehicle. Run 45 measured what that costs: 2,927 traces against 76,298 segments
 * took 960 seconds, consumed the run's entire time budget, and left `interval_aggregates` and
 * `incident_lifecycle` skipped — so Pro had no live figures to publish and fell back to the demo
 * snapshot. It also measured the other half of the damage: 2,184 of those traces produced nothing
 * because their match was below the confidence floor. A matcher offered a bus in Leeds a road in
 * Bristol has no locality to reason from, and the confidence it returns reflects that.
 *
 * A quarter-degree grid — roughly 28 km north to south — is coarse enough that a segment lands in
 * a handful of cells and fine enough that a city trace sees a city's roads. A segment is filed
 * under every cell its path passes through, so a road crossing a boundary is found from either
 * side, and a lookup takes the cells the trace touches plus their neighbours, because a vehicle
 * near a cell edge is matched to roads just over it.
 */
const SEGMENT_GRID_DEGREES = 0.25;

function cellKey(lat: number, lon: number): string {
  return `${Math.floor(lat / SEGMENT_GRID_DEGREES)}:${Math.floor(lon / SEGMENT_GRID_DEGREES)}`;
}

export interface SegmentIndex {
  /** Candidate geometries near a trace, in a stable order. */
  near(trace: readonly { coordinate: Coordinate }[]): MapMatchCandidateGeometry[];
  /** How many segments were filed, for the batch report. */
  readonly size: number;
}

export function indexSegments(segments: readonly RoadSegment[]): SegmentIndex {
  const cells = new Map<string, MapMatchCandidateGeometry[]>();
  for (const segment of segments) {
    const geometry: MapMatchCandidateGeometry = { id: segment.id, path: segment.path };
    // Every cell the path passes through, not just its ends: a 1.2 km segment can cross one.
    const keys = new Set(segment.path.map((point) => cellKey(point.lat, point.lon)));
    for (const key of keys) {
      const bucket = cells.get(key);
      if (bucket) bucket.push(geometry);
      else cells.set(key, [geometry]);
    }
  }

  return {
    size: segments.length,
    near(trace) {
      const wanted = new Set<string>();
      for (const point of trace) {
        const lat = Math.floor(point.coordinate.lat / SEGMENT_GRID_DEGREES);
        const lon = Math.floor(point.coordinate.lon / SEGMENT_GRID_DEGREES);
        // The neighbours too, so a vehicle a hundred metres from a cell edge still sees the road
        // it is actually on.
        for (let dLat = -1; dLat <= 1; dLat += 1) {
          for (let dLon = -1; dLon <= 1; dLon += 1) {
            wanted.add(`${lat + dLat}:${lon + dLon}`);
          }
        }
      }
      const seen = new Set<string>();
      const candidates: MapMatchCandidateGeometry[] = [];
      for (const key of wanted) {
        for (const geometry of cells.get(key) ?? []) {
          if (seen.has(geometry.id)) continue;
          seen.add(geometry.id);
          candidates.push(geometry);
        }
      }
      return candidates;
    },
  };
}

/**
 * Derives segment traversals from one vehicle's ordered trace, using the sequence-aware map
 * match rather than snapping each point independently.
 */
export function sampleSegmentsForTrace(
  trace: readonly VehicleObservation[],
  /**
   * Either the batch's segments, or an index over them.
   *
   * A caller with one trace and a handful of segments passes the array and nothing changes. A
   * batch with thousands of traces builds the index once and passes that, which is the difference
   * between scanning the country per vehicle and scanning a city.
   */
  segments: readonly RoadSegment[] | SegmentIndex,
  routeId: string | null,
  options: SegmentSamplingOptions = {},
): SegmentSamplingResult {
  const config = { ...SEGMENT_DEFAULTS, ...options };
  const result: SegmentSamplingResult = {
    samples: [],
    discardedLowConfidence: 0,
    discardedImplausible: 0,
    unmatchedTraces: 0,
  };

  const indexed = "near" in segments ? segments : null;
  const available = indexed ? indexed.size : (segments as readonly RoadSegment[]).length;
  if (trace.length < 2 || available === 0) {
    result.unmatchedTraces += trace.length > 0 ? 1 : 0;
    return result;
  }

  const geometries: MapMatchCandidateGeometry[] = indexed
    ? indexed.near(trace)
    : (segments as readonly RoadSegment[]).map((segment) => ({
        id: segment.id,
        path: segment.path,
      }));
  // A trace with no road anywhere near it is unmatched, which is a fact about coverage rather
  // than a low-confidence match — and counting it as the latter would blame the matcher.
  if (geometries.length === 0) {
    result.unmatchedTraces += 1;
    return result;
  }

  const matched = mapMatch(
    trace.map((observation) => ({
      coordinate: observation.coordinate,
      observedAt: observation.observedAt,
      bearingDegrees: observation.bearingDegrees ?? null,
    })),
    geometries,
  );

  if (matched.confidence < config.minimumMatchConfidence) {
    result.discardedLowConfidence += 1;
    return result;
  }

  // Group consecutive points that decoded onto the same segment; each run is one traversal.
  let runStart = 0;
  for (let index = 1; index <= matched.points.length; index += 1) {
    const current = matched.points[index]?.geometryId ?? null;
    const previous = matched.points[index - 1]?.geometryId ?? null;
    if (index < matched.points.length && current === previous) continue;

    const runEnd = index - 1;
    const segmentId = previous;
    const pointCount = runEnd - runStart + 1;
    runStart = index;

    if (segmentId === null || pointCount < config.minimumPointsPerSegment) continue;

    const first = trace[runEnd - pointCount + 1];
    const last = trace[runEnd];
    if (!first || !last) continue;

    const traversalSeconds =
      (new Date(last.observedAt).getTime() - new Date(first.observedAt).getTime()) / 1000;
    if (traversalSeconds <= 0 || traversalSeconds > config.maxTraversalSeconds) {
      result.discardedImplausible += 1;
      continue;
    }

    const distanceMetres = haversineMetres(first.coordinate, last.coordinate);
    if (distanceMetres <= 0) {
      // Stationary at a stop or in a queue: real, but not a traversal of the segment.
      result.discardedImplausible += 1;
      continue;
    }

    const runConfidence =
      matched.points
        .slice(runEnd - pointCount + 1, runEnd + 1)
        .reduce((total, point) => total + point.confidence, 0) / pointCount;

    result.samples.push({
      segmentId,
      vehicleRef: last.vehicleRef,
      routeId,
      enteredAt: first.observedAt,
      exitedAt: last.observedAt,
      traversalSeconds,
      distanceMetres,
      meanSpeedMetresPerSecond: distanceMetres / traversalSeconds,
      matchConfidence: Math.min(runConfidence, matched.confidence),
    });
  }

  return result;
}
