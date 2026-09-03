import type {
  Confidence,
  Coordinate,
  RoutePattern,
  ScheduledJourney,
  VehicleObservation,
  VehicleState,
} from "@busstops/contracts";
import {
  bearingDegrees,
  bearingDifference,
  derivedSpeedMetresPerSecond,
  haversineMetres,
  projectOntoPath,
} from "@busstops/pipeline-core";

/**
 * Vehicle-to-journey matching (docs/07_DATA_PIPELINES.md "Geospatial matching").
 *
 * Nearest-line alone is not enough: parallel roads, opposite directions and terminus loops all
 * defeat it. Candidates are scored on perpendicular distance, direction agreement, sequence
 * continuity with the previous match, and whether the feed's own journey reference agrees.
 * Low-confidence matches are returned as such and must not create incidents.
 */

export const MATCH_DEFAULTS = {
  /** Beyond this, a candidate route is not plausible for the observation at all. */
  maxDistanceMetres: 120,
  /** A vehicle heading the opposite way along a road is not on that pattern. */
  maxBearingDifferenceDegrees: 75,
  /** Below this score, the match is reported but treated as low confidence. */
  minAcceptableScore: 0.35,
  /** A stationary vehicle within this radius is treated as not moving. */
  stationaryRadiusMetres: 25,
  stationarySpeedMetresPerSecond: 0.5,
} as const;

export interface PatternGeometry {
  pattern: RoutePattern;
  shape: readonly Coordinate[];
  /** Along-path distance of each stop, used for stop progression and headways. */
  stopDistancesMetres: readonly number[];
}

export interface MatchCandidate {
  patternId: string;
  score: number;
  distanceMetres: number;
  alongPathMetres: number;
  bearingDifferenceDegrees: number | null;
  reasons: string[];
}

export interface MatchContext {
  /** Line name from the feed, when present — a strong signal, not a decisive one. */
  publishedLineName?: string | undefined;
  directionRef?: string | undefined;
  /** The feed's own journey reference, which when it resolves is the strongest signal. */
  datedVehicleJourneyRef?: string | undefined;
  /** The previous accepted match, used for sequence continuity. */
  previousPatternId?: string | undefined;
  previousAlongPathMetres?: number | undefined;
  previousObservedAt?: string | undefined;
}

/**
 * Scores one pattern against an observation. Returns null when the candidate is implausible,
 * so an impossible match can never be "the best of a bad set".
 */
export function scoreCandidate(
  observation: VehicleObservation,
  geometry: PatternGeometry,
  context: MatchContext = {},
  limits = MATCH_DEFAULTS,
): MatchCandidate | null {
  if (geometry.shape.length < 2) return null;

  const projection = projectOntoPath(observation.coordinate, geometry.shape);
  if (!projection || projection.distanceMetres > limits.maxDistanceMetres) return null;

  const reasons: string[] = [];

  // Distance: full marks on the line, zero at the plausibility limit.
  const distanceScore = 1 - projection.distanceMetres / limits.maxDistanceMetres;
  let score = distanceScore * 0.4;
  reasons.push(`${Math.round(projection.distanceMetres)}m from the route`);

  // Direction: compare the vehicle's bearing with the route's local heading.
  let bearingDifferenceDegrees: number | null = null;
  if (observation.bearingDegrees !== undefined) {
    const segmentIndex = Math.min(projection.segmentIndex, geometry.shape.length - 2);
    const routeBearing = bearingDegrees(
      geometry.shape[segmentIndex]!,
      geometry.shape[segmentIndex + 1]!,
    );
    bearingDifferenceDegrees = bearingDifference(observation.bearingDegrees, routeBearing);
    if (bearingDifferenceDegrees > limits.maxBearingDifferenceDegrees) {
      // Travelling against the pattern direction: this is the other direction's pattern.
      return null;
    }
    score += (1 - bearingDifferenceDegrees / limits.maxBearingDifferenceDegrees) * 0.25;
    reasons.push(`heading within ${Math.round(bearingDifferenceDegrees)}° of the route`);
  } else {
    // No bearing is not evidence against; it simply cannot contribute.
    score += 0.1;
    reasons.push("no bearing reported by the feed");
  }

  // Sequence continuity: a vehicle should progress forward along the same pattern.
  if (
    context.previousPatternId === geometry.pattern.id &&
    context.previousAlongPathMetres !== undefined
  ) {
    const progress = projection.alongPathMetres - context.previousAlongPathMetres;
    if (progress >= -50) {
      score += 0.2;
      reasons.push("continues forward along the pattern it was already matched to");
    } else {
      score -= 0.15;
      reasons.push("would require moving backwards along the pattern");
    }
  }

  if (
    context.publishedLineName !== undefined &&
    context.publishedLineName.length > 0 &&
    geometry.pattern.serviceRouteId.length > 0
  ) {
    // Line agreement is applied by the caller, which knows the route's public name.
    score += 0.05;
  }

  return {
    patternId: geometry.pattern.id,
    score: Math.max(0, Math.min(1, score)),
    distanceMetres: projection.distanceMetres,
    alongPathMetres: projection.alongPathMetres,
    bearingDifferenceDegrees,
    reasons,
  };
}

export interface MatchResult {
  best: MatchCandidate | null;
  candidates: MatchCandidate[];
  confidence: Confidence;
}

export function matchObservation(
  observation: VehicleObservation,
  geometries: readonly PatternGeometry[],
  context: MatchContext = {},
  limits = MATCH_DEFAULTS,
): MatchResult {
  const candidates = geometries
    .map((geometry) => scoreCandidate(observation, geometry, context, limits))
    .filter((candidate): candidate is MatchCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0] ?? null;
  const runnerUp = candidates[1];

  const reasons: string[] = [];
  let score = best?.score ?? 0;

  if (!best) {
    reasons.push("no route within plausible distance and direction");
  } else {
    reasons.push(...best.reasons);
    // Ambiguity between two close candidates should reduce confidence, not be hidden.
    if (runnerUp && best.score - runnerUp.score < 0.1) {
      score *= 0.7;
      reasons.push("another route matches almost as well");
    }
    if (best.score < limits.minAcceptableScore) {
      reasons.push("match quality below the acceptance threshold");
    }
  }

  const level = score >= 0.7 ? "high" : score >= limits.minAcceptableScore ? "medium" : "low";
  return { best, candidates, confidence: { level, score, reasons } };
}

export interface MotionAssessment {
  motionState: "moving" | "stationary" | "unknown";
  speedMetresPerSecond: number | null;
  reason: string;
}

/**
 * Motion from consecutive observations. A stationary marker is genuinely ambiguous — terminus,
 * layover, congestion, stale feed or a stopped service — so this reports movement only, and
 * never asserts a cause.
 */
export function assessMotion(
  previous: VehicleObservation | null,
  current: VehicleObservation,
  limits = MATCH_DEFAULTS,
): MotionAssessment {
  if (!previous) {
    return { motionState: "unknown", speedMetresPerSecond: null, reason: "only one observation" };
  }

  const metres = haversineMetres(previous.coordinate, current.coordinate);
  const speed = derivedSpeedMetresPerSecond(
    { coordinate: previous.coordinate, observedAt: previous.observedAt },
    { coordinate: current.coordinate, observedAt: current.observedAt },
  );

  if (speed === null) {
    return {
      motionState: "unknown",
      speedMetresPerSecond: null,
      reason: "observations too close together in time to derive speed",
    };
  }

  if (metres <= limits.stationaryRadiusMetres && speed < limits.stationarySpeedMetresPerSecond) {
    return {
      motionState: "stationary",
      speedMetresPerSecond: speed,
      reason: `moved ${Math.round(metres)}m, within the GPS noise radius`,
    };
  }

  return {
    motionState: "moving",
    speedMetresPerSecond: speed,
    reason: `moved ${Math.round(metres)}m since the previous observation`,
  };
}

export interface StopProgress {
  nextStopIndex: number | null;
  passedStopIndices: number[];
  /** Distance along the pattern to the next stop, in metres. */
  metresToNextStop: number | null;
}

export function computeStopProgress(
  alongPathMetres: number,
  stopDistancesMetres: readonly number[],
): StopProgress {
  const passedStopIndices: number[] = [];
  let nextStopIndex: number | null = null;

  for (let i = 0; i < stopDistancesMetres.length; i++) {
    const distance = stopDistancesMetres[i]!;
    if (distance <= alongPathMetres) {
      passedStopIndices.push(i);
    } else {
      nextStopIndex = i;
      break;
    }
  }

  const metresToNextStop =
    nextStopIndex === null ? null : stopDistancesMetres[nextStopIndex]! - alongPathMetres;

  return { nextStopIndex, passedStopIndices, metresToNextStop };
}

/**
 * Delay against the schedule at the vehicle's current position, interpolating between the
 * surrounding stop times. Positive is late, negative is early, matching the data model.
 */
export function computeDelaySeconds(
  journey: ScheduledJourney,
  progress: StopProgress,
  observedAt: string,
  stopDistancesMetres: readonly number[],
  alongPathMetres: number,
): number | null {
  if (progress.nextStopIndex === null) return null;

  const nextIndex = progress.nextStopIndex;
  const previousIndex = nextIndex - 1;
  const nextStopTime = journey.stopTimes[nextIndex];
  if (!nextStopTime) return null;

  const observedMs = new Date(observedAt).getTime();
  const nextScheduledMs = new Date(
    nextStopTime.scheduledArrival ?? nextStopTime.scheduledDeparture,
  ).getTime();

  if (previousIndex < 0) {
    // Before the first stop: compare directly with the scheduled departure.
    return Math.round((observedMs - nextScheduledMs) / 1000);
  }

  const previousStopTime = journey.stopTimes[previousIndex];
  if (!previousStopTime) return null;

  const previousDistance = stopDistancesMetres[previousIndex];
  const nextDistance = stopDistancesMetres[nextIndex];
  if (previousDistance === undefined || nextDistance === undefined) return null;

  const span = nextDistance - previousDistance;
  if (span <= 0) return null;

  const fraction = Math.max(0, Math.min(1, (alongPathMetres - previousDistance) / span));
  const previousScheduledMs = new Date(previousStopTime.scheduledDeparture).getTime();
  const expectedMs = previousScheduledMs + (nextScheduledMs - previousScheduledMs) * fraction;

  return Math.round((observedMs - expectedMs) / 1000);
}

export interface BuildStateInput {
  observation: VehicleObservation;
  previousObservation: VehicleObservation | null;
  match: MatchResult;
  geometry: PatternGeometry | null;
  journey: ScheduledJourney | null;
  now: Date;
}

/** Assembles the published VehicleState, carrying match confidence and freshness honestly. */
export function buildVehicleState(input: BuildStateInput): VehicleState {
  const { observation, previousObservation, match, geometry, journey, now } = input;

  const motion = assessMotion(previousObservation, observation);
  const freshnessSeconds = Math.max(
    0,
    (now.getTime() - new Date(observation.observedAt).getTime()) / 1000,
  );

  let nextStopId: string | null = null;
  let delaySeconds: number | null = null;

  if (match.best && geometry) {
    const progress = computeStopProgress(match.best.alongPathMetres, geometry.stopDistancesMetres);
    if (progress.nextStopIndex !== null) {
      nextStopId = geometry.pattern.stopSequence[progress.nextStopIndex] ?? null;
    }
    if (journey) {
      delaySeconds = computeDelaySeconds(
        journey,
        progress,
        observation.observedAt,
        geometry.stopDistancesMetres,
        match.best.alongPathMetres,
      );
    }
  }

  return {
    id: observation.id,
    provenance: observation.provenance,
    ingestedAt: observation.ingestedAt,
    qualityFlags: observation.qualityFlags,
    vehicleRef: observation.vehicleRef,
    matchedRoutePatternId: match.best?.patternId ?? null,
    matchedScheduledJourneyId: journey?.id ?? null,
    position: observation.coordinate,
    ...(observation.bearingDegrees === undefined
      ? {}
      : { bearingDegrees: observation.bearingDegrees }),
    delaySeconds,
    motionState: motion.motionState,
    nextStopId,
    freshnessSeconds,
    matchConfidence: match.confidence,
  };
}
