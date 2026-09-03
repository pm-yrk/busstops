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
 * Derives segment traversals from one vehicle's ordered trace, using the sequence-aware map
 * match rather than snapping each point independently.
 */
export function sampleSegmentsForTrace(
  trace: readonly VehicleObservation[],
  segments: readonly RoadSegment[],
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

  if (trace.length < 2 || segments.length === 0) {
    result.unmatchedTraces += trace.length > 0 ? 1 : 0;
    return result;
  }

  const geometries: MapMatchCandidateGeometry[] = segments.map((segment) => ({
    id: segment.id,
    path: segment.path,
  }));

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
