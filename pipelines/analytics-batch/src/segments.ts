// Imported explicitly rather than taken from the global: this package runs under Node in a
// scheduled Action, and a sub-millisecond clock is what a per-trace cost of a few hundred
// microseconds needs to be visible at all.
import { performance } from "node:perf_hooks";
import type { Coordinate, VehicleObservation } from "@busstops/contracts";
import { haversineMetres } from "@busstops/pipeline-core";
import {
  addMapMatchProfile,
  emptyMapMatchProfile,
  mapMatch,
  type MapMatchCandidateGeometry,
  type MapMatchProfile,
} from "@busstops/matching";

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
 * What the matching stage cost and why matches were rejected, accumulated across traces.
 *
 * The batch report could say "4,265 traces processed, 2,178 below the confidence floor" and no
 * more, which is enough to know something is wrong and not enough to know what. The confidence is
 * the product of three independent factors with three different remedies, so the rejections are
 * attributed to whichever factor was weakest — and the costs are split between finding candidates
 * and projecting onto them, because those are also different problems.
 *
 * Attribution is a diagnosis, not a verdict: "coverage was the weakest factor" means the roads
 * were missing under most of the trace, not that coverage alone caused the rejection.
 */
export interface SegmentMatchProfile {
  traces: number;
  /** Milliseconds inside the spatial index, looking up candidates. */
  candidateSearchMs: number;
  /** Milliseconds inside the decode itself. */
  decodeMs: number;
  /** Candidates offered per trace, for judging whether the grid is the right size. */
  candidatesMin: number;
  candidatesMax: number;
  candidatesTotal: number;
  /** Traces with no candidate geometry at all: a coverage gap, not a weak match. */
  tracesWithNoCandidates: number;
  /** Rejected below the floor, attributed to the weakest of the three confidence factors. */
  rejectedByCoverage: number;
  rejectedByDistance: number;
  rejectedByInstability: number;
  /** Summed over rejected traces, so the mean distance from the floor is recoverable. */
  rejectedConfidenceTotal: number;
  accepted: number;
  matcher: MapMatchProfile;
  /**
   * Match outcome by coarse geographic cell, so coverage can be read as a map rather than a
   * total.
   *
   * Index performance and network coverage are different problems and run 69 reported one number
   * for both. A finer grid makes the search cheaper everywhere; it does not put a road under a
   * bus that has none. 77% of traces failing nationally could be an even thinning across England
   * or three cities with no extraction at all, and those call for completely different work —
   * the first for a better extraction everywhere, the second for a re-run over the places that
   * were missed.
   *
   * Half a degree is roughly a county, which is the scale an extraction gap actually occurs at.
   */
  byCell: Map<string, { traces: number; noCandidates: number; accepted: number }>;
}

/** Roughly a county: fine enough to name a gap, coarse enough that the report stays readable. */
const COVERAGE_CELL_DEGREES = 0.5;

export function emptySegmentMatchProfile(): SegmentMatchProfile {
  return {
    traces: 0,
    candidateSearchMs: 0,
    decodeMs: 0,
    candidatesMin: Number.POSITIVE_INFINITY,
    candidatesMax: 0,
    candidatesTotal: 0,
    tracesWithNoCandidates: 0,
    rejectedByCoverage: 0,
    rejectedByDistance: 0,
    rejectedByInstability: 0,
    rejectedConfidenceTotal: 0,
    accepted: 0,
    matcher: emptyMapMatchProfile(),
    byCell: new Map(),
  };
}

/**
 * Where the road network is thin, worst first.
 *
 * Reported separately from the performance counters because they answer different questions and
 * only one of them is fixed by a better index. A cell is named only once it has enough traces to
 * mean something — a single unmatched bus in a rural cell is not a coverage gap.
 */
export function coverageGaps(
  profile: SegmentMatchProfile,
  { minimumTraces = 25, limit = 8 } = {},
): Array<{ cell: string; traces: number; matchedShare: number; noCandidateShare: number }> {
  return [...profile.byCell.entries()]
    .filter(([, counts]) => counts.traces >= minimumTraces)
    .map(([cell, counts]) => ({
      cell,
      traces: counts.traces,
      matchedShare: Number((counts.accepted / counts.traces).toFixed(3)),
      noCandidateShare: Number((counts.noCandidates / counts.traces).toFixed(3)),
    }))
    .sort((a, b) => a.matchedShare - b.matchedShare || b.traces - a.traces)
    .slice(0, limit);
}

/** The profile as a report reads it, with the derived figures the raw counters imply. */
export function summariseSegmentMatchProfile(profile: SegmentMatchProfile): Record<string, number> {
  const traces = Math.max(1, profile.traces);
  const offered = profile.matcher.projections + profile.matcher.projectionsSkippedByBounds;
  return {
    traces: profile.traces,
    candidateSearchMs: Math.round(profile.candidateSearchMs),
    decodeMs: Math.round(profile.decodeMs),
    msPerTrace: Number(((profile.candidateSearchMs + profile.decodeMs) / traces).toFixed(3)),
    candidatesPerTrace: Math.round(profile.candidatesTotal / traces),
    candidatesMin: profile.candidatesMin === Number.POSITIVE_INFINITY ? 0 : profile.candidatesMin,
    candidatesMax: profile.candidatesMax,
    tracesWithNoCandidates: profile.tracesWithNoCandidates,
    projections: profile.matcher.projections,
    projectionsSkippedByBounds: profile.matcher.projectionsSkippedByBounds,
    /*
     * What the precomputed bounding boxes were worth. A high share means the grid hands the
     * decode many candidates it cannot use, which is a statement about the grid's size rather
     * than about the matcher.
     */
    boundsSkipShare:
      offered === 0 ? 0 : Number((profile.matcher.projectionsSkippedByBounds / offered).toFixed(3)),
    candidatesWithoutBounds: profile.matcher.candidatesWithoutBounds,
    pointsWithNoState: profile.matcher.pointsWithNoState,
    statesPerPoint:
      profile.matcher.points === 0
        ? 0
        : Number((profile.matcher.statesKept / profile.matcher.points).toFixed(2)),
    accepted: profile.accepted,
    rejectedByCoverage: profile.rejectedByCoverage,
    rejectedByDistance: profile.rejectedByDistance,
    rejectedByInstability: profile.rejectedByInstability,
    meanRejectedConfidence: Number(
      (
        profile.rejectedConfidenceTotal /
        Math.max(
          1,
          profile.rejectedByCoverage + profile.rejectedByDistance + profile.rejectedByInstability,
        )
      ).toFixed(3),
    ),
  };
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
 * A segment is filed under every cell its path passes through, so a road crossing a boundary is
 * found from either side, and a lookup takes the cells the trace touches plus their neighbours,
 * because a vehicle near a cell edge is matched to roads just over it.
 *
 * The cell was a quarter of a degree, and run 69 measured what that cost. With the eight
 * neighbours it hands every trace point a box roughly 83 km by 50 km: 14,468 candidate segments
 * on average and 40,518 at the worst, out of 76,312 nationally. Nineteen per cent of the road
 * network is not a spatial index, it is a formality — and the profile priced it exactly:
 * 26,563 ms finding candidates against 5,944 ms deciding between them, so four fifths of the
 * stage was spent building lists of roads in other counties.
 *
 * The bounding-box test the matcher now applies says the same thing from the other side. It
 * skipped 457,609,490 projections and let 51,433 through — 99.989 per cent of everything the
 * grid offered could not have matched anything.
 *
 * Two hundredths of a degree is about 2.2 km north to south, so a lookup covers roughly 6.7 km
 * by 4 km once the neighbours are included. That is still two orders of magnitude beyond the
 * sixty-metre snap cap, so no road a bus could match to can fall outside it; what goes is the
 * county.
 */
const SEGMENT_GRID_DEGREES = 0.02;

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
    /*
     * The extent is computed here, once per segment for the whole batch.
     *
     * A road's bounding box does not change between vehicles, and the matcher uses it to skip
     * projecting a point onto a path it cannot possibly be near. Computing it inside the matcher
     * would redo this work for every trace that sees the segment — which is precisely the
     * repeated static geometry work the profile exists to measure.
     */
    let minLat = Infinity;
    let minLon = Infinity;
    let maxLat = -Infinity;
    let maxLon = -Infinity;
    for (const point of segment.path) {
      if (point.lat < minLat) minLat = point.lat;
      if (point.lat > maxLat) maxLat = point.lat;
      if (point.lon < minLon) minLon = point.lon;
      if (point.lon > maxLon) maxLon = point.lon;
    }
    const geometry: MapMatchCandidateGeometry = {
      id: segment.id,
      path: segment.path,
      ...(Number.isFinite(minLat) ? { bounds: { minLat, minLon, maxLat, maxLon } } : {}),
    };
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
  /** Accumulated across every trace in the batch, when the caller is profiling. */
  profile?: SegmentMatchProfile,
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

  const searchStartedAt = profile ? performance.now() : 0;
  const geometries: MapMatchCandidateGeometry[] = indexed
    ? indexed.near(trace)
    : (segments as readonly RoadSegment[]).map((segment) => ({
        id: segment.id,
        path: segment.path,
      }));
  /*
   * The cell is taken from the trace's first point, not from every point: a trace is one bus in
   * one place for the purposes of "was there a road here", and spreading it across cells would
   * count a journey crossing a boundary as two half-failures.
   */
  const cell = `${Math.floor(trace[0]!.coordinate.lat / COVERAGE_CELL_DEGREES) * COVERAGE_CELL_DEGREES},${
    Math.floor(trace[0]!.coordinate.lon / COVERAGE_CELL_DEGREES) * COVERAGE_CELL_DEGREES
  }`;
  const cellCounts = profile
    ? (profile.byCell.get(cell) ?? { traces: 0, noCandidates: 0, accepted: 0 })
    : null;
  if (profile && cellCounts) {
    cellCounts.traces += 1;
    profile.byCell.set(cell, cellCounts);
  }

  if (profile) {
    profile.traces += 1;
    profile.candidateSearchMs += performance.now() - searchStartedAt;
    profile.candidatesTotal += geometries.length;
    profile.candidatesMin = Math.min(profile.candidatesMin, geometries.length);
    profile.candidatesMax = Math.max(profile.candidatesMax, geometries.length);
  }
  // A trace with no road anywhere near it is unmatched, which is a fact about coverage rather
  // than a low-confidence match — and counting it as the latter would blame the matcher.
  if (geometries.length === 0) {
    result.unmatchedTraces += 1;
    if (profile) profile.tracesWithNoCandidates += 1;
    if (cellCounts) cellCounts.noCandidates += 1;
    return result;
  }

  const matcherProfile = profile ? emptyMapMatchProfile() : undefined;
  const decodeStartedAt = profile ? performance.now() : 0;
  const matched = mapMatch(
    trace.map((observation) => ({
      coordinate: observation.coordinate,
      observedAt: observation.observedAt,
      bearingDegrees: observation.bearingDegrees ?? null,
    })),
    geometries,
    {},
    matcherProfile,
  );
  if (profile && matcherProfile) {
    profile.decodeMs += performance.now() - decodeStartedAt;
    addMapMatchProfile(profile.matcher, matcherProfile);
  }

  if (matched.confidence < config.minimumMatchConfidence) {
    result.discardedLowConfidence += 1;
    if (profile) {
      /*
       * Attributed to the weakest of the three factors the confidence multiplies together.
       *
       * Poor coverage, positions far from the centreline and an unsettled decode are three
       * different problems with three different fixes, and a single rejected count cannot tell
       * them apart. Ties go to coverage, then distance, which is the order of how fundamental
       * the problem is: roads that are not there cannot be matched better.
       */
      const { coverage, meanPointConfidence, stability } = matched.components;
      const weakest = Math.min(coverage, meanPointConfidence, stability);
      if (weakest === coverage) profile.rejectedByCoverage += 1;
      else if (weakest === meanPointConfidence) profile.rejectedByDistance += 1;
      else profile.rejectedByInstability += 1;
      profile.rejectedConfidenceTotal += matched.confidence;
    }
    return result;
  }
  if (profile) profile.accepted += 1;
  if (cellCounts) cellCounts.accepted += 1;

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
