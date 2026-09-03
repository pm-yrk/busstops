import type { Confidence } from "@busstops/contracts";
import { clamp, median } from "./statistics.js";

/**
 * Operational events: bunching, service gaps, diversions and skipped stops
 * (docs/08_ANALYTICS_ENGINE.md).
 *
 * Each detector requires several reliable samples before it will claim anything, and each
 * reports the evidence that produced it. A single noisy observation must never become an alert.
 */

export interface VehicleOnPattern {
  vehicleRef: string;
  /** Distance travelled along the pattern, in metres. Ordering by this is what defines a gap. */
  alongPathMetres: number;
  observedAt: string;
  /** Whether the underlying match was good enough to reason about. */
  reliable: boolean;
}

export interface BunchingInput {
  patternId: string;
  /** Successive observations of the same pair, ordered in time. */
  samples: ReadonlyArray<{
    leader: VehicleOnPattern;
    follower: VehicleOnPattern;
    headwaySeconds: number;
  }>;
  scheduledHeadwaySeconds: number | null;
  minimumSamples?: number;
}

export interface BunchingResult {
  detected: boolean;
  patternId: string;
  minObservedHeadwaySeconds: number | null;
  thresholdSeconds: number;
  /** True when the gap is still closing, which distinguishes bunching from a single tight gap. */
  closing: boolean;
  sustained: boolean;
  confidence: Confidence;
  narrative: string;
}

export const BUNCHING_ABSOLUTE_FLOOR_SECONDS = 120;
export const BUNCHING_SCHEDULED_FRACTION = 0.5;
export const MINIMUM_RELIABLE_SAMPLES = 2;

/**
 * Bunching: consecutive same-direction vehicles closer than
 * max(2 minutes, half the scheduled headway), for at least two reliable samples, and either
 * still closing or sustained.
 */
export function detectBunching(input: BunchingInput): BunchingResult {
  const minimumSamples = input.minimumSamples ?? MINIMUM_RELIABLE_SAMPLES;

  const threshold = Math.max(
    BUNCHING_ABSOLUTE_FLOOR_SECONDS,
    (input.scheduledHeadwaySeconds ?? 0) * BUNCHING_SCHEDULED_FRACTION,
  );

  const reliable = input.samples.filter((s) => s.leader.reliable && s.follower.reliable);
  const breaching = reliable.filter((s) => s.headwaySeconds < threshold);

  const headways = reliable.map((s) => s.headwaySeconds);
  const minObserved = headways.length > 0 ? Math.min(...headways) : null;

  // Closing: the most recent gap is smaller than the earliest one.
  const closing =
    reliable.length >= 2 &&
    reliable[reliable.length - 1]!.headwaySeconds < reliable[0]!.headwaySeconds;
  const sustained = breaching.length >= minimumSamples;

  const detected = breaching.length >= minimumSamples && (closing || sustained);

  const reasons: string[] = [];
  let score = 0.4;

  if (breaching.length >= minimumSamples) {
    score += 0.25;
    reasons.push(
      `${breaching.length} reliable samples below the ${Math.round(threshold / 60)} minute threshold`,
    );
  } else {
    reasons.push(`only ${breaching.length} reliable samples below the threshold`);
  }
  if (closing) {
    score += 0.2;
    reasons.push("the gap is still closing");
  }
  if (input.scheduledHeadwaySeconds === null) {
    score -= 0.15;
    reasons.push("no scheduled headway to compare against");
  }
  if (reliable.length < input.samples.length) {
    reasons.push(
      `${input.samples.length - reliable.length} samples excluded for poor match quality`,
    );
  }

  score = clamp(score, 0.05, 1);

  return {
    detected,
    patternId: input.patternId,
    minObservedHeadwaySeconds: minObserved,
    thresholdSeconds: threshold,
    closing,
    sustained,
    confidence: {
      level: score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low",
      score,
      reasons,
    },
    narrative: detected
      ? `Two buses on this route are running close together, ${minObserved === null ? "" : `about ${Math.round(minObserved / 60)} minutes apart, `}where the timetable expects a longer gap.`
      : "No bunching detected on this route.",
  };
}

export interface ServiceGapInput {
  patternId: string;
  observedHeadwaySeconds: number | null;
  scheduledHeadwaySeconds: number | null;
  /** Scheduled journeys in the window with no observation at all. */
  missingScheduledJourneyIds: readonly string[];
  /** Whether the live source was healthy; a gap during an outage is our blind spot, not a gap. */
  sourceHealthy: boolean;
}

export interface ServiceGapResult {
  detected: boolean;
  thresholdSeconds: number;
  confidence: Confidence;
  narrative: string;
}

export const GAP_ABSOLUTE_FLOOR_SECONDS = 600;
export const GAP_SCHEDULED_MULTIPLE = 1.5;

/** Service gap: headway above max(10 minutes, 1.5x scheduled), or a supported missing journey. */
export function detectServiceGap(input: ServiceGapInput): ServiceGapResult {
  const threshold = Math.max(
    GAP_ABSOLUTE_FLOOR_SECONDS,
    (input.scheduledHeadwaySeconds ?? 0) * GAP_SCHEDULED_MULTIPLE,
  );

  const headwayBreach =
    input.observedHeadwaySeconds !== null && input.observedHeadwaySeconds > threshold;
  const missingSupported = input.missingScheduledJourneyIds.length > 0;

  const reasons: string[] = [];
  let score = 0.4;

  if (!input.sourceHealthy) {
    // Without a healthy feed this is our blind spot, not a demonstrated gap in service.
    return {
      detected: false,
      thresholdSeconds: threshold,
      confidence: {
        level: "low",
        score: 0.1,
        reasons: [
          "the live feed was unavailable, so a gap cannot be distinguished from missing data",
        ],
      },
      narrative: "We cannot tell whether there is a gap here: the live feed was unavailable.",
    };
  }

  if (headwayBreach) {
    score += 0.3;
    reasons.push(`observed gap exceeds the ${Math.round(threshold / 60)} minute threshold`);
  }
  if (missingSupported) {
    score += 0.2;
    reasons.push(`${input.missingScheduledJourneyIds.length} scheduled journeys were not observed`);
  }
  if (input.scheduledHeadwaySeconds === null) {
    score -= 0.1;
    reasons.push("no scheduled headway to compare against");
  }

  const detected = headwayBreach || missingSupported;
  score = clamp(score, 0.05, 1);

  return {
    detected,
    thresholdSeconds: threshold,
    confidence: {
      level: score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low",
      score,
      reasons,
    },
    narrative: detected
      ? `There is a longer gap than scheduled on this route${input.observedHeadwaySeconds === null ? "" : `, about ${Math.round(input.observedHeadwaySeconds / 60)} minutes`}.`
      : "Service intervals on this route look normal.",
  };
}

export interface DiversionSample {
  observedAt: string;
  /** Perpendicular distance from the expected route corridor, in metres. */
  offRouteMetres: number;
  reliable: boolean;
}

export interface DiversionInput {
  samples: readonly DiversionSample[];
  /** Corridor half-width beyond which a vehicle is genuinely off route. */
  corridorToleranceMetres?: number;
  minimumSamples?: number;
  minimumDurationSeconds?: number;
  /** Whether the vehicle later rejoined the expected route. */
  rejoined: boolean;
}

export interface DiversionResult {
  detected: boolean;
  consecutiveOffRoute: number;
  durationSeconds: number;
  maxOffRouteMetres: number;
  confidence: Confidence;
  narrative: string;
}

export const DIVERSION_DEFAULTS = {
  corridorToleranceMetres: 80,
  minimumSamples: 3,
  minimumDurationSeconds: 120,
} as const;

/**
 * Likely diversion: at least three consecutive reliable observations materially outside the
 * corridor, spanning at least two minutes. Always phrased as "appears to have", never asserted:
 * GPS error and map error both look like this from a distance.
 */
export function detectDiversion(input: DiversionInput): DiversionResult {
  const tolerance = input.corridorToleranceMetres ?? DIVERSION_DEFAULTS.corridorToleranceMetres;
  const minimumSamples = input.minimumSamples ?? DIVERSION_DEFAULTS.minimumSamples;
  const minimumDuration = input.minimumDurationSeconds ?? DIVERSION_DEFAULTS.minimumDurationSeconds;

  let bestRun: DiversionSample[] = [];
  let currentRun: DiversionSample[] = [];

  for (const sample of input.samples) {
    if (sample.reliable && sample.offRouteMetres > tolerance) {
      currentRun.push(sample);
      if (currentRun.length > bestRun.length) bestRun = [...currentRun];
    } else {
      currentRun = [];
    }
  }

  const durationSeconds =
    bestRun.length >= 2
      ? (new Date(bestRun[bestRun.length - 1]!.observedAt).getTime() -
          new Date(bestRun[0]!.observedAt).getTime()) /
        1000
      : 0;

  const maxOffRouteMetres =
    bestRun.length > 0 ? Math.max(...bestRun.map((s) => s.offRouteMetres)) : 0;
  const detected = bestRun.length >= minimumSamples && durationSeconds >= minimumDuration;

  const reasons: string[] = [];
  let score = 0.35;

  if (bestRun.length >= minimumSamples) {
    score += 0.25;
    reasons.push(`${bestRun.length} consecutive reliable positions off the expected route`);
  } else {
    reasons.push(`only ${bestRun.length} consecutive positions off route`);
  }
  if (durationSeconds >= minimumDuration) {
    score += 0.15;
    reasons.push(`sustained for ${Math.round(durationSeconds / 60)} minutes`);
  }
  if (input.rejoined) {
    score += 0.2;
    reasons.push("the vehicle later rejoined its expected route");
  } else {
    reasons.push(
      "the vehicle has not yet rejoined its route, so this may still be a mapping issue",
    );
  }
  if (maxOffRouteMetres < tolerance * 2) {
    score -= 0.1;
    reasons.push("the distance off route is close to normal GPS error");
  }

  score = clamp(score, 0.05, 1);

  return {
    detected,
    consecutiveOffRoute: bestRun.length,
    durationSeconds,
    maxOffRouteMetres,
    confidence: {
      level: score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low",
      score,
      reasons,
    },
    // Cautious wording is mandatory: this is an inference from position data, not a fact.
    narrative: detected
      ? `This bus appears to have taken a different route, staying about ${Math.round(maxOffRouteMetres)}m off its expected path for ${Math.round(durationSeconds / 60)} minutes.`
      : "No likely diversion detected.",
  };
}

export interface SkippedStopInput {
  stopId: string;
  /** Closest the vehicle came to the stop, in metres. */
  closestApproachMetres: number;
  /** Catchment radius within which a bus would have been considered to serve the stop. */
  catchmentMetres?: number;
  /** Whether the vehicle continued to later stops, which is what makes a skip inferable. */
  progressionContinued: boolean;
  reliable: boolean;
}

export interface SkippedStopResult {
  possiblySkipped: boolean;
  confidence: Confidence;
  narrative: string;
}

/**
 * A stop is only "possibly skipped" when the path bypassed its catchment *and* the vehicle
 * carried on to later stops. Absence of a dwell is explicitly not enough: buses pass stops
 * without stopping all the time when nobody is waiting.
 */
export function detectSkippedStop(input: SkippedStopInput): SkippedStopResult {
  const catchment = input.catchmentMetres ?? 60;
  const bypassed = input.closestApproachMetres > catchment;
  const possiblySkipped = bypassed && input.progressionContinued && input.reliable;

  const reasons: string[] = [];
  let score = 0.3;

  if (bypassed) {
    score += 0.25;
    reasons.push(`the bus stayed ${Math.round(input.closestApproachMetres)}m from the stop`);
  }
  if (input.progressionContinued) {
    score += 0.2;
    reasons.push("the bus continued to later stops on the route");
  } else {
    reasons.push("the bus has not yet reached later stops, so nothing can be concluded");
  }
  if (!input.reliable) {
    score -= 0.2;
    reasons.push("position quality was too poor to be sure");
  }

  score = clamp(score, 0.05, 1);

  return {
    possiblySkipped,
    confidence: {
      level: score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low",
      score,
      reasons,
    },
    narrative: possiblySkipped
      ? "This bus may not have served this stop: its path stayed clear of the stop and it carried on to later stops."
      : "No evidence that this stop was skipped.",
  };
}

/** Headways between consecutive vehicles ordered by distance along the pattern. */
export function headwaysFromPositions(
  vehicles: readonly VehicleOnPattern[],
  averageSpeedMetresPerSecond: number,
): number[] {
  const ordered = [...vehicles]
    .filter((vehicle) => vehicle.reliable)
    .sort((a, b) => a.alongPathMetres - b.alongPathMetres);

  const headways: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const gapMetres = ordered[i]!.alongPathMetres - ordered[i - 1]!.alongPathMetres;
    if (averageSpeedMetresPerSecond > 0) headways.push(gapMetres / averageSpeedMetresPerSecond);
  }
  return headways;
}

export function medianHeadwaySeconds(headways: readonly number[]): number | null {
  return median(headways);
}
