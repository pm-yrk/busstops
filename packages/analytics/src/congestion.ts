import type { Confidence } from "@busstops/contracts";
import { clamp, median, sum } from "./statistics.js";

/**
 * Congestion and delay origin (docs/08_ANALYTICS_ENGINE.md).
 *
 * The unit of impact is excess vehicle-minutes, not "how slow is it": a badly congested back
 * street that two buses an hour use matters less than a corridor carrying forty. One stationary
 * bus is never corridor congestion, which is why sample count and route diversity drive
 * confidence directly.
 */

export interface SegmentTraversal {
  vehicleRef: string;
  routeId: string;
  /** Observed time to traverse the segment, in seconds. */
  observedSeconds: number;
  observedAt: string;
  reliable: boolean;
}

export interface CongestionInput {
  corridorId: string;
  traversals: readonly SegmentTraversal[];
  /** Expected traversal time from the matched baseline, in seconds. */
  expectedSeconds: number | null;
  minimumTraversals?: number;
  minimumDistinctRoutes?: number;
}

export interface CongestionResult {
  corridorId: string;
  observedMedianSeconds: number | null;
  expectedSeconds: number | null;
  /** Sum of positive excess over all valid traversals, in vehicle-minutes. */
  excessVehicleMinutes: number;
  excessPerTraversalSeconds: number | null;
  traversalCount: number;
  distinctRoutes: number;
  distinctVehicles: number;
  confidence: Confidence;
  narrative: string;
}

export const CONGESTION_DEFAULTS = {
  minimumTraversals: 3,
  minimumDistinctRoutes: 2,
} as const;

export function analyseCongestion(input: CongestionInput): CongestionResult {
  const minimumTraversals = input.minimumTraversals ?? CONGESTION_DEFAULTS.minimumTraversals;
  const minimumRoutes = input.minimumDistinctRoutes ?? CONGESTION_DEFAULTS.minimumDistinctRoutes;

  const reliable = input.traversals.filter((t) => t.reliable);
  const observedTimes = reliable.map((t) => t.observedSeconds);
  const observedMedianSeconds = median(observedTimes);

  const distinctRoutes = new Set(reliable.map((t) => t.routeId)).size;
  const distinctVehicles = new Set(reliable.map((t) => t.vehicleRef)).size;

  // excess vehicle-minutes = sum of max(0, observed - expected) over valid traversals.
  const excessSeconds =
    input.expectedSeconds === null
      ? 0
      : sum(reliable.map((t) => Math.max(0, t.observedSeconds - input.expectedSeconds!)));
  const excessVehicleMinutes = excessSeconds / 60;

  const excessPerTraversalSeconds =
    reliable.length > 0 && input.expectedSeconds !== null ? excessSeconds / reliable.length : null;

  const reasons: string[] = [];
  let score = 0.25;

  if (reliable.length >= minimumTraversals) {
    score += 0.2;
    reasons.push(`${reliable.length} reliable traversals`);
  } else {
    reasons.push(`only ${reliable.length} reliable traversals; ${minimumTraversals} are needed`);
  }

  if (distinctRoutes >= minimumRoutes) {
    // Independent routes agreeing is the strongest signal that this is the road, not one bus.
    score += 0.25;
    reasons.push(`${distinctRoutes} different routes affected`);
  } else {
    reasons.push(`only ${distinctRoutes} route observed, so this may be specific to one service`);
  }

  if (distinctVehicles >= minimumTraversals) {
    score += 0.15;
    reasons.push(`${distinctVehicles} different vehicles`);
  }

  if (input.expectedSeconds === null) {
    score -= 0.2;
    reasons.push("no comparable baseline for this corridor and time");
  }

  score = clamp(score, 0.05, 1);

  const sufficient = reliable.length >= minimumTraversals && distinctRoutes >= minimumRoutes;

  return {
    corridorId: input.corridorId,
    observedMedianSeconds,
    expectedSeconds: input.expectedSeconds,
    excessVehicleMinutes,
    excessPerTraversalSeconds,
    traversalCount: reliable.length,
    distinctRoutes,
    distinctVehicles,
    confidence: {
      level: score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low",
      score,
      reasons,
    },
    narrative: !sufficient
      ? "Not enough independent observations to say whether this corridor is congested."
      : excessPerTraversalSeconds === null
        ? "No baseline to compare this corridor against."
        : excessPerTraversalSeconds <= 30
          ? "Traffic here is running close to normal."
          : `Buses are taking about ${Math.round(excessPerTraversalSeconds / 60)} minutes longer than usual through here, costing roughly ${excessVehicleMinutes.toFixed(0)} vehicle-minutes.`,
  };
}

export interface SegmentDelayContribution {
  corridorId: string;
  name: string;
  excessSecondsPerTraversal: number;
  traversalCount: number;
  distinctRoutes: number;
  /** Position along the journey, used to find where delay starts accumulating. */
  sequence: number;
}

export interface DelayOriginResult {
  originCorridorId: string | null;
  originName: string | null;
  /** Share of the total excess attributable to the origin segment, 0..1. */
  shareOfExcess: number | null;
  cumulativeExcessSeconds: number;
  competingExplanations: Array<{ corridorId: string; name: string; shareOfExcess: number }>;
  confidence: Confidence;
  narrative: string;
}

/**
 * Delay origin: the earliest, strongest contiguous segment where cumulative excess starts to
 * grow. Competing explanations are always returned, and the wording is "appears to originate
 * near" unless official evidence confirms a cause — which this function never has.
 */
export function findDelayOrigin(
  segments: readonly SegmentDelayContribution[],
  options: { minimumShare?: number } = {},
): DelayOriginResult {
  const minimumShare = options.minimumShare ?? 0.25;
  const ordered = [...segments].sort((a, b) => a.sequence - b.sequence);

  const totalExcess = sum(ordered.map((s) => Math.max(0, s.excessSecondsPerTraversal)));

  if (ordered.length === 0 || totalExcess <= 0) {
    return {
      originCorridorId: null,
      originName: null,
      shareOfExcess: null,
      cumulativeExcessSeconds: 0,
      competingExplanations: [],
      confidence: { level: "low", score: 0.1, reasons: ["no excess delay to attribute"] },
      narrative: "No meaningful delay to explain on this route.",
    };
  }

  const shares = ordered.map((segment) => ({
    corridorId: segment.corridorId,
    name: segment.name,
    shareOfExcess: Math.max(0, segment.excessSecondsPerTraversal) / totalExcess,
    sequence: segment.sequence,
    traversalCount: segment.traversalCount,
    distinctRoutes: segment.distinctRoutes,
  }));

  // The earliest segment carrying a material share: delay compounds downstream, so the first
  // place it appears explains more than the worst place it is felt.
  const origin = shares.find((segment) => segment.shareOfExcess >= minimumShare) ?? null;

  const competing = shares
    .filter((segment) => segment.corridorId !== origin?.corridorId && segment.shareOfExcess >= 0.15)
    .sort((a, b) => b.shareOfExcess - a.shareOfExcess)
    .slice(0, 3)
    .map(({ corridorId, name, shareOfExcess }) => ({ corridorId, name, shareOfExcess }));

  const reasons: string[] = [];
  let score = 0.3;

  if (origin) {
    score += 0.25;
    reasons.push(
      `${(origin.shareOfExcess * 100).toFixed(0)}% of the excess appears on this segment`,
    );
    if (origin.distinctRoutes >= 2) {
      score += 0.2;
      reasons.push(`${origin.distinctRoutes} routes affected there`);
    }
    if (origin.traversalCount >= 5) {
      score += 0.1;
      reasons.push(`${origin.traversalCount} traversals observed`);
    }
    if (competing.length > 0) {
      score -= 0.15;
      reasons.push(`${competing.length} other segments also contribute materially`);
    }
  } else {
    reasons.push("delay is spread across the route rather than concentrated anywhere");
  }

  score = clamp(score, 0.05, 1);

  return {
    originCorridorId: origin?.corridorId ?? null,
    originName: origin?.name ?? null,
    shareOfExcess: origin?.shareOfExcess ?? null,
    cumulativeExcessSeconds: totalExcess,
    competingExplanations: competing,
    confidence: {
      level: score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low",
      score,
      reasons,
    },
    narrative: origin
      ? `Delay appears to originate near ${origin.name}, which accounts for about ${(origin.shareOfExcess * 100).toFixed(0)}% of the extra journey time.`
      : "Delay on this route is spread out rather than starting in one place.",
  };
}

export interface SpeedAnomalyInput {
  corridorId: string;
  vehicleRef: string;
  /** Consecutive independent derived speeds in m/s, already cleaned of dwell and GPS jumps. */
  derivedSpeedsMetresPerSecond: readonly number[];
  speedLimitMph: number | null;
  matchQuality: "good" | "poor";
  minimumSamples?: number;
}

export interface SpeedAnomalyResult {
  detected: boolean;
  observedSpeedMetresPerSecond: number | null;
  speedLimitMetresPerSecond: number | null;
  confidence: Confidence;
  /** Deliberately non-judgemental: this is a data observation, not an accusation. */
  narrative: string;
}

const MPH_TO_METRES_PER_SECOND = 0.44704;

/**
 * Possible speed anomaly.
 *
 * Requires a sourced speed limit, good match quality and several consecutive samples. The
 * output is never a legal conclusion or a statement about a driver: it is "possible", it names
 * the corridor rather than the vehicle, and low-confidence results are meant to stay out of the
 * public UI entirely.
 */
export function detectSpeedAnomaly(input: SpeedAnomalyInput): SpeedAnomalyResult {
  const minimumSamples = input.minimumSamples ?? 3;
  const speeds = input.derivedSpeedsMetresPerSecond;
  const observed = median(speeds);

  const limit =
    input.speedLimitMph === null ? null : input.speedLimitMph * MPH_TO_METRES_PER_SECOND;

  const reasons: string[] = [];
  let score = 0.2;

  if (limit === null) {
    // Without a sourced limit there is nothing to be anomalous against, and guessing one would
    // manufacture anomalies that never happened.
    return {
      detected: false,
      observedSpeedMetresPerSecond: observed,
      speedLimitMetresPerSecond: null,
      confidence: {
        level: "low",
        score: 0.05,
        reasons: ["no sourced speed limit for this road, so nothing can be compared"],
      },
      narrative: "No speed limit is recorded for this road, so no comparison is possible.",
    };
  }

  if (input.matchQuality !== "good") {
    return {
      detected: false,
      observedSpeedMetresPerSecond: observed,
      speedLimitMetresPerSecond: limit,
      confidence: {
        level: "low",
        score: 0.1,
        reasons: ["position matching was too poor to derive a trustworthy speed"],
      },
      narrative: "Position quality here is too poor to say anything about speed.",
    };
  }

  if (speeds.length >= minimumSamples) {
    score += 0.3;
    reasons.push(`${speeds.length} consecutive independent samples`);
  } else {
    reasons.push(`only ${speeds.length} samples; ${minimumSamples} are needed`);
  }

  const exceeds = observed !== null && observed > limit * 1.1;
  if (exceeds) {
    score += 0.25;
    reasons.push("derived speed is above the recorded limit by more than the measurement error");
  }

  reasons.push("derived from position changes, which carry their own error");
  score = clamp(score, 0.05, 1);

  const detected = exceeds && speeds.length >= minimumSamples;

  return {
    detected,
    observedSpeedMetresPerSecond: observed,
    speedLimitMetresPerSecond: limit,
    confidence: {
      level: score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low",
      score,
      reasons,
    },
    narrative: detected
      ? `Possible speed anomaly on this corridor: derived speeds sit above the recorded limit. This is an observation from position data, not a measurement of any individual vehicle or driver.`
      : "No speed anomaly detected on this corridor.",
  };
}
