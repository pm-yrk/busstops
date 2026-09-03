import type { Coordinate } from "@busstops/contracts";
import {
  bearingDegrees,
  bearingDifference,
  haversineMetres,
  projectOntoPath,
  simplifyPath,
  type PointOnPath,
} from "@busstops/pipeline-core";

/**
 * Bounded hidden-state map matching (docs/07_DATA_PIPELINES.md "Geospatial matching").
 *
 * Nearest-line matching is not acceptable here and the specification says so explicitly. Two
 * parallel carriageways, a bus station forecourt beside a through road, and a stop pair either
 * side of a dual carriageway all defeat it: each individual point snaps to whichever geometry
 * happens to be a few metres closer, and the resulting "route" flips back and forth between
 * candidates. That produces phantom diversions, which is the most damaging kind of false
 * positive this system can publish.
 *
 * So the sequence is matched as a whole with a Viterbi decode: an emission score for how well a
 * point fits a candidate, and a transition score for how plausible the move from the previous
 * candidate is, given the along-path distance actually available and the great-circle distance
 * travelled. Staying on one geometry is cheap; hopping between them mid-sequence must be paid
 * for, so an isolated bad fix cannot drag the whole trace onto the wrong road.
 *
 * Bounded, as required: candidates per point are capped, the search is linear in points times
 * the square of that cap, and there is no backtracking beyond the single retained path per state.
 */

export interface MapMatchCandidateGeometry {
  id: string;
  path: readonly Coordinate[];
  /** Direction of travel along `path`, when the geometry is one-way. */
  oneWay?: boolean;
}

export interface MapMatchPoint {
  coordinate: Coordinate;
  observedAt: string;
  /** Reported horizontal accuracy in metres, when the source provides one. */
  accuracyMetres?: number | null;
  bearingDegrees?: number | null;
}

export const MAP_MATCH_DEFAULTS = {
  /** Points further than this from every candidate are treated as unmatchable. */
  maxSnapMetres: 60,
  /** Assumed positional noise; also the scale of the emission score. */
  sigmaMetres: 25,
  /** Scale for the transition score: how much route-distance/straight-line disagreement costs. */
  transitionScaleMetres: 40,
  /** Cost applied when the decoded path switches geometry between consecutive points. */
  switchPenalty: 1.2,
  /** Hard cap on states considered per point, which is what bounds the whole decode. */
  maxCandidatesPerPoint: 6,
  /** Above this speed the move is treated as implausible for a bus and heavily penalised. */
  maxPlausibleSpeedMps: 30,
  /** Bearing disagreement beyond this is penalised, when both bearings are known. */
  bearingToleranceDegrees: 60,
} as const;

export interface MatchedPoint {
  index: number;
  geometryId: string | null;
  snapped: Coordinate | null;
  distanceFromPathMetres: number | null;
  distanceAlongPathMetres: number | null;
  /** 0..1 confidence for this individual point within the decoded sequence. */
  confidence: number;
}

export interface MapMatchResult {
  points: MatchedPoint[];
  /** The dominant geometry, when one carried the majority of matched points. */
  geometryId: string | null;
  matchedCount: number;
  unmatchedCount: number;
  /** Number of times the decoded path changed geometry. */
  switchCount: number;
  /** 0..1 overall confidence. Low-confidence matches must not create incidents. */
  confidence: number;
  reasons: string[];
}

interface State {
  geometryId: string;
  projection: PointOnPath;
  score: number;
  previous: number | null;
}

function emissionScore(distanceMetres: number, sigma: number): number {
  // Gaussian in log space, so scores add along the sequence rather than multiplying to zero.
  return -0.5 * (distanceMetres / sigma) ** 2;
}

export function mapMatch(
  points: readonly MapMatchPoint[],
  geometries: readonly MapMatchCandidateGeometry[],
  options: Partial<typeof MAP_MATCH_DEFAULTS> = {},
): MapMatchResult {
  const config = { ...MAP_MATCH_DEFAULTS, ...options };
  const reasons: string[] = [];

  if (points.length === 0 || geometries.length === 0) {
    return {
      points: points.map((_, index) => ({
        index,
        geometryId: null,
        snapped: null,
        distanceFromPathMetres: null,
        distanceAlongPathMetres: null,
        confidence: 0,
      })),
      geometryId: null,
      matchedCount: 0,
      unmatchedCount: points.length,
      switchCount: 0,
      confidence: 0,
      reasons: [geometries.length === 0 ? "no candidate geometries" : "no positions to match"],
    };
  }

  // Layer of states per point, each already scored for emission.
  const layers: State[][] = [];
  for (const point of points) {
    const sigma = Math.max(config.sigmaMetres, point.accuracyMetres ?? 0);
    const states: State[] = [];

    for (const geometry of geometries) {
      const projection = projectOntoPath(point.coordinate, geometry.path);
      if (!projection || projection.distanceMetres > config.maxSnapMetres) continue;

      let score = emissionScore(projection.distanceMetres, sigma);

      // Direction of travel is strong evidence on parallel carriageways, where distance is not.
      if (point.bearingDegrees != null) {
        const pathBearing = bearingAlongPath(geometry.path, projection);
        if (pathBearing !== null) {
          const difference = bearingDifference(point.bearingDegrees, pathBearing);
          if (difference > config.bearingToleranceDegrees) {
            score -= (difference - config.bearingToleranceDegrees) / 45;
          }
        }
      }

      states.push({ geometryId: geometry.id, projection, score, previous: null });
    }

    states.sort((a, b) => b.score - a.score);
    layers.push(states.slice(0, config.maxCandidatesPerPoint));
  }

  // Viterbi forward pass. Layers with no states break the chain; the decode restarts after them
  // rather than inventing a link across an unmatchable gap.
  for (let index = 1; index < layers.length; index += 1) {
    const previousLayer = layers[index - 1]!;
    const layer = layers[index]!;
    if (previousLayer.length === 0 || layer.length === 0) continue;

    const from = points[index - 1]!;
    const to = points[index]!;
    const straightLine = haversineMetres(from.coordinate, to.coordinate);
    const elapsedSeconds = Math.max(
      1,
      (new Date(to.observedAt).getTime() - new Date(from.observedAt).getTime()) / 1000,
    );

    for (const state of layer) {
      let best: { score: number; previous: number } | null = null;

      for (let p = 0; p < previousLayer.length; p += 1) {
        const previous = previousLayer[p]!;
        let transition = previous.score;

        if (previous.geometryId === state.geometryId) {
          // Along-path progress should resemble the distance actually travelled.
          const alongPath = Math.abs(
            state.projection.alongPathMetres - previous.projection.alongPathMetres,
          );
          transition -= Math.abs(alongPath - straightLine) / config.transitionScaleMetres;
        } else {
          transition -= config.switchPenalty;
          transition -= straightLine / (config.transitionScaleMetres * 4);
        }

        // A move no bus could have made is evidence the pairing is wrong, not that it sped.
        if (straightLine / elapsedSeconds > config.maxPlausibleSpeedMps) {
          transition -= 5;
        }

        if (!best || transition > best.score) best = { score: transition, previous: p };
      }

      if (best) {
        state.score = state.score + best.score;
        state.previous = best.previous;
      }
    }
  }

  // Backward pass, restarting at each break in the chain.
  const chosen: Array<State | null> = new Array<State | null>(layers.length).fill(null);
  let index = layers.length - 1;
  while (index >= 0) {
    const layer = layers[index]!;
    if (layer.length === 0) {
      index -= 1;
      continue;
    }
    let best = layer[0]!;
    for (const state of layer) if (state.score > best.score) best = state;

    let cursor: State | null = best;
    let position = index;
    while (cursor && position >= 0) {
      chosen[position] = cursor;
      const previousIndex: number | null = cursor.previous;
      if (previousIndex === null) break;
      position -= 1;
      cursor = layers[position]?.[previousIndex] ?? null;
    }
    index = position - 1;
  }

  const matchedPoints: MatchedPoint[] = chosen.map((state, pointIndex) => {
    if (!state) {
      return {
        index: pointIndex,
        geometryId: null,
        snapped: null,
        distanceFromPathMetres: null,
        distanceAlongPathMetres: null,
        confidence: 0,
      };
    }
    const sigma = Math.max(config.sigmaMetres, points[pointIndex]?.accuracyMetres ?? 0);
    return {
      index: pointIndex,
      geometryId: state.geometryId,
      snapped: state.projection.point,
      distanceFromPathMetres: state.projection.distanceMetres,
      distanceAlongPathMetres: state.projection.alongPathMetres,
      confidence: Math.exp(emissionScore(state.projection.distanceMetres, sigma)),
    };
  });

  const matchedCount = matchedPoints.filter((p) => p.geometryId !== null).length;
  const unmatchedCount = matchedPoints.length - matchedCount;

  let switchCount = 0;
  let lastGeometry: string | null = null;
  const tally = new Map<string, number>();
  for (const point of matchedPoints) {
    if (point.geometryId === null) continue;
    tally.set(point.geometryId, (tally.get(point.geometryId) ?? 0) + 1);
    if (lastGeometry !== null && point.geometryId !== lastGeometry) switchCount += 1;
    lastGeometry = point.geometryId;
  }

  let dominant: string | null = null;
  let dominantCount = 0;
  for (const [geometryId, count] of tally) {
    if (count > dominantCount) {
      dominant = geometryId;
      dominantCount = count;
    }
  }

  const coverage = matchedPoints.length > 0 ? matchedCount / matchedPoints.length : 0;
  const meanPointConfidence =
    matchedCount > 0
      ? matchedPoints.reduce((total, p) => total + (p.geometryId ? p.confidence : 0), 0) /
        matchedCount
      : 0;
  // Frequent switching means the decode never settled, so the answer is not trustworthy even
  // when each individual point snapped tightly.
  const stability = matchedCount > 1 ? 1 - Math.min(1, switchCount / (matchedCount - 1)) : 1;

  if (unmatchedCount > 0)
    reasons.push(
      `${unmatchedCount} of ${points.length} positions did not match any candidate geometry`,
    );
  if (switchCount > 0)
    reasons.push(
      `the decoded path changed geometry ${switchCount} time${switchCount === 1 ? "" : "s"}`,
    );
  if (matchedCount > 0 && meanPointConfidence < 0.5)
    reasons.push("positions sit further from the geometry than the expected positional noise");
  if (reasons.length === 0)
    reasons.push(`${matchedCount} positions matched consistently to one geometry`);

  return {
    points: matchedPoints,
    geometryId: dominant,
    matchedCount,
    unmatchedCount,
    switchCount,
    confidence: coverage * meanPointConfidence * stability,
    reasons,
  };
}

function bearingAlongPath(path: readonly Coordinate[], projection: PointOnPath): number | null {
  const a = path[projection.segmentIndex];
  const b = path[projection.segmentIndex + 1];
  if (!a || !b) return null;
  return bearingDegrees(a, b);
}

/**
 * Display traces are simplified separately from analytical matching, as the specification
 * requires: the analytical path keeps every position it was given, while the drawn one is
 * thinned to what a map can usefully show.
 */
export function simplifyForDisplay(
  path: readonly Coordinate[],
  toleranceMetres = 15,
  maxPoints = 50,
): Coordinate[] {
  let tolerance = toleranceMetres;
  let simplified = simplifyPath(path, tolerance);
  // Raise the tolerance rather than truncating: dropping the tail would misrepresent the shape.
  while (simplified.length > maxPoints && tolerance < 500) {
    tolerance *= 1.6;
    simplified = simplifyPath(path, tolerance);
  }
  return simplified;
}
