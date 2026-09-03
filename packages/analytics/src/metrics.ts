import type { Confidence } from "@busstops/contracts";
import { clamp, mean, median, proportion, quantile, sum } from "./statistics.js";

/**
 * Core service metrics (docs/08_ANALYTICS_ENGINE.md).
 *
 * Every function here returns its denominator and coverage alongside the number. A metric
 * without them is KPI theatre: 100% punctuality from three observations is not the same claim
 * as 92% from four thousand, and the product must never let those look alike.
 */

/** The on-time window. Labelled explicitly because standards differ and the definition matters. */
export interface PunctualityWindow {
  name: string;
  earliestSeconds: number;
  latestSeconds: number;
}

export const DEFAULT_PUNCTUALITY_WINDOW: PunctualityWindow = {
  name: "one minute early to five minutes late",
  earliestSeconds: -60,
  latestSeconds: 300,
};

export interface MetricResult {
  value: number | null;
  denominator: number;
  coverage: number;
  /** Definition applied, carried with the number so it cannot be quoted out of context. */
  definition: string;
  suppressed: boolean;
  suppressionReason?: string;
}

/** Below this many observations a rate is too noisy to publish as a headline figure. */
export const MINIMUM_DENOMINATOR = 20;

export interface DelayObservation {
  delaySeconds: number;
  /** Excluded when the underlying match was poor; a bad match is not evidence of lateness. */
  matchQuality: "good" | "poor";
}

export interface DelaySummary {
  medianSeconds: number | null;
  meanSeconds: number | null;
  p90Seconds: number | null;
  p10Seconds: number | null;
  denominator: number;
  excludedForQuality: number;
}

export function summariseDelay(observations: readonly DelayObservation[]): DelaySummary {
  const usable = observations.filter((o) => o.matchQuality === "good").map((o) => o.delaySeconds);

  return {
    medianSeconds: median(usable),
    meanSeconds: mean(usable),
    p90Seconds: quantile(usable, 0.9),
    p10Seconds: quantile(usable, 0.1),
    denominator: usable.length,
    excludedForQuality: observations.length - usable.length,
  };
}

export interface PunctualityInput {
  observations: readonly DelayObservation[];
  window?: PunctualityWindow;
  /** Journeys that should have been observed, for the coverage figure. */
  expectedObservations?: number;
  minimumDenominator?: number;
}

export function punctuality(input: PunctualityInput): MetricResult {
  const window = input.window ?? DEFAULT_PUNCTUALITY_WINDOW;
  const minimum = input.minimumDenominator ?? MINIMUM_DENOMINATOR;

  const usable = input.observations.filter((o) => o.matchQuality === "good");
  const onTime = usable.filter(
    (o) => o.delaySeconds >= window.earliestSeconds && o.delaySeconds <= window.latestSeconds,
  ).length;

  const expected = input.expectedObservations ?? usable.length;
  const coverage = expected > 0 ? clamp(usable.length / expected, 0, 1) : 0;
  const definition = `within ${window.name}`;

  if (usable.length < minimum) {
    return {
      value: null,
      denominator: usable.length,
      coverage,
      definition,
      suppressed: true,
      suppressionReason: `only ${usable.length} eligible observations; at least ${minimum} are needed`,
    };
  }

  return {
    value: onTime / usable.length,
    denominator: usable.length,
    coverage,
    definition,
    suppressed: false,
  };
}

export interface ReliabilityInput {
  scheduledEligible: number;
  observedEligible: number;
  /** Journeys an operator confirmed cancelled. Never inferred from missing telemetry. */
  confirmedCancellations: number;
  /** Journeys not observed because a source was down, which is not the operator's failure. */
  sourceOutageAffected: number;
  minimumDenominator?: number;
}

export interface ReliabilityResult extends MetricResult {
  confirmedCancellations: number;
  notObserved: number;
  sourceOutageAffected: number;
}

/**
 * Reliability = observed eligible / scheduled eligible.
 *
 * Journeys missed because a source was down are removed from the denominator entirely: counting
 * our own outage as an operator's cancellation would be a false accusation, and the spec
 * forbids labelling missing telemetry as cancellation.
 */
export function reliability(input: ReliabilityInput): ReliabilityResult {
  const minimum = input.minimumDenominator ?? MINIMUM_DENOMINATOR;
  const eligible = Math.max(0, input.scheduledEligible - input.sourceOutageAffected);
  const notObserved = Math.max(0, eligible - input.observedEligible - input.confirmedCancellations);

  const base = {
    denominator: eligible,
    coverage: input.scheduledEligible > 0 ? eligible / input.scheduledEligible : 0,
    definition: "observed eligible journeys divided by scheduled eligible journeys",
    confirmedCancellations: input.confirmedCancellations,
    notObserved,
    sourceOutageAffected: input.sourceOutageAffected,
  };

  if (eligible < minimum) {
    return {
      ...base,
      value: null,
      suppressed: true,
      suppressionReason: `only ${eligible} comparable scheduled journeys after excluding source outages`,
    };
  }

  return { ...base, value: clamp(input.observedEligible / eligible, 0, 1), suppressed: false };
}

export interface HeadwayInput {
  /** Observed gaps between consecutive vehicles on the same pattern, in seconds. */
  observedHeadwaysSeconds: readonly number[];
  scheduledHeadwaySeconds: number | null;
  minimumDenominator?: number;
}

export interface HeadwayResult extends MetricResult {
  medianObservedSeconds: number | null;
  meanAbsoluteDeviationSeconds: number | null;
  /** True for frequent services, where headway matters more than timetable adherence. */
  frequentService: boolean;
}

/** Services at or below this scheduled headway are judged on headway, not timetable adherence. */
export const FREQUENT_SERVICE_HEADWAY_SECONDS = 12 * 60;

export function headwayAdherence(input: HeadwayInput): HeadwayResult {
  const minimum = input.minimumDenominator ?? 5;
  const observed = input.observedHeadwaysSeconds;
  const medianObserved = median(observed);

  const frequentService =
    input.scheduledHeadwaySeconds !== null &&
    input.scheduledHeadwaySeconds <= FREQUENT_SERVICE_HEADWAY_SECONDS;

  const base = {
    denominator: observed.length,
    coverage: 1,
    definition: "observed headway compared with the scheduled headway",
    medianObservedSeconds: medianObserved,
    frequentService,
  };

  if (observed.length < minimum || input.scheduledHeadwaySeconds === null) {
    return {
      ...base,
      value: null,
      meanAbsoluteDeviationSeconds: null,
      suppressed: true,
      suppressionReason:
        input.scheduledHeadwaySeconds === null
          ? "no scheduled headway to compare against"
          : `only ${observed.length} observed headways`,
    };
  }

  const deviations = observed.map((headway) => Math.abs(headway - input.scheduledHeadwaySeconds!));
  const meanAbsoluteDeviationSeconds = sum(deviations) / deviations.length;

  // Expressed as adherence 0..1: perfect when every gap matches the schedule, falling to zero
  // once the average deviation equals the scheduled headway itself.
  const adherence = clamp(1 - meanAbsoluteDeviationSeconds / input.scheduledHeadwaySeconds, 0, 1);

  return {
    ...base,
    value: adherence,
    meanAbsoluteDeviationSeconds,
    suppressed: false,
  };
}

export interface NetworkHealthComponents {
  punctuality: number;
  reliability: number;
  excessDelay: number;
  headwayStability: number;
  severeIncidentBurden: number;
  dataCoverage: number;
}

export interface NetworkHealthResult {
  score: number | null;
  components: NetworkHealthComponents;
  /** Confidence is capped by coverage: a great score from thin data is not a great score. */
  confidence: Confidence;
  version: string;
  suppressed: boolean;
  suppressionReason?: string;
}

export const NETWORK_HEALTH_VERSION = "network-health/1.0.0";

const NETWORK_HEALTH_WEIGHTS = {
  punctuality: 0.3,
  reliability: 0.25,
  excessDelay: 0.2,
  headwayStability: 0.1,
  severeIncidentBurden: 0.1,
  dataCoverage: 0.05,
} as const;

export interface NetworkHealthInput {
  punctuality: number | null;
  reliability: number | null;
  /** Median excess delay in seconds versus baseline; higher is worse. */
  excessDelaySeconds: number | null;
  headwayAdherence: number | null;
  /** Count of severe incidents in the window, per hundred scheduled journeys. */
  severeIncidentsPerHundredJourneys: number;
  dataCoverage: number;
  minimumCoverage?: number;
}

/**
 * Network health, 0-100. Weighted, documented and versioned, with every component exposed so a
 * user can see what drove it — an unexplained composite score is exactly what the product
 * principles rule out.
 */
export function networkHealth(input: NetworkHealthInput): NetworkHealthResult {
  const minimumCoverage = input.minimumCoverage ?? 0.2;

  // Excess delay is mapped onto 0..1 by a saturating curve: ten minutes of excess is bad, but
  // twenty is not twice as bad again — both mean "the corridor is not working".
  const excessDelayScore =
    input.excessDelaySeconds === null ? 0.5 : clamp(1 - input.excessDelaySeconds / 600, 0, 1);

  const incidentScore = clamp(1 - input.severeIncidentsPerHundredJourneys / 5, 0, 1);

  const components: NetworkHealthComponents = {
    punctuality: input.punctuality ?? 0.5,
    reliability: input.reliability ?? 0.5,
    excessDelay: excessDelayScore,
    headwayStability: input.headwayAdherence ?? 0.5,
    severeIncidentBurden: incidentScore,
    dataCoverage: clamp(input.dataCoverage, 0, 1),
  };

  if (input.dataCoverage < minimumCoverage) {
    return {
      score: null,
      components,
      confidence: {
        level: "low",
        score: 0.1,
        reasons: [`data coverage is ${(input.dataCoverage * 100).toFixed(0)}%, too low to score`],
      },
      version: NETWORK_HEALTH_VERSION,
      suppressed: true,
      suppressionReason: "insufficient data coverage to compute a meaningful score",
    };
  }

  const weighted =
    components.punctuality * NETWORK_HEALTH_WEIGHTS.punctuality +
    components.reliability * NETWORK_HEALTH_WEIGHTS.reliability +
    components.excessDelay * NETWORK_HEALTH_WEIGHTS.excessDelay +
    components.headwayStability * NETWORK_HEALTH_WEIGHTS.headwayStability +
    components.severeIncidentBurden * NETWORK_HEALTH_WEIGHTS.severeIncidentBurden +
    components.dataCoverage * NETWORK_HEALTH_WEIGHTS.dataCoverage;

  const reasons: string[] = [];
  let confidenceScore = 0.9;

  if (input.punctuality === null || input.reliability === null) {
    confidenceScore -= 0.3;
    reasons.push("one or more components could not be measured");
  }
  // Confidence can never exceed what coverage supports.
  confidenceScore = Math.min(confidenceScore, 0.3 + input.dataCoverage * 0.7);
  reasons.push(`based on ${(input.dataCoverage * 100).toFixed(0)}% data coverage`);

  return {
    // Rounded to whole points: publishing 73.418 would imply precision the inputs do not have.
    score: Math.round(clamp(weighted * 100, 0, 100)),
    components,
    confidence: {
      level: confidenceScore >= 0.7 ? "high" : confidenceScore >= 0.45 ? "medium" : "low",
      score: clamp(confidenceScore, 0, 1),
      reasons,
    },
    version: NETWORK_HEALTH_VERSION,
    suppressed: false,
  };
}

export interface ComparableCoverageInput {
  coverages: readonly { id: string; coverage: number; denominator: number }[];
  /** Maximum spread in coverage before a ranking becomes unfair. */
  maximumCoverageSpread?: number;
  minimumDenominator?: number;
}

export interface RankingEligibility {
  eligible: boolean;
  reason: string;
  excludedIds: string[];
}

/**
 * Whether a set of entities can honestly be ranked against each other. Comparing an operator
 * observed 95% of the time with one observed 30% of the time produces a league table that
 * measures our coverage, not their performance.
 */
export function rankingEligibility(input: ComparableCoverageInput): RankingEligibility {
  const maximumSpread = input.maximumCoverageSpread ?? 0.25;
  const minimumDenominator = input.minimumDenominator ?? MINIMUM_DENOMINATOR;

  const excludedIds = input.coverages
    .filter((entry) => entry.denominator < minimumDenominator)
    .map((entry) => entry.id);

  const comparable = input.coverages.filter((entry) => entry.denominator >= minimumDenominator);

  if (comparable.length < 2) {
    return {
      eligible: false,
      reason: "fewer than two entities have enough observations to compare",
      excludedIds,
    };
  }

  const coverages = comparable.map((entry) => entry.coverage);
  const spread = Math.max(...coverages) - Math.min(...coverages);

  if (spread > maximumSpread) {
    return {
      eligible: false,
      reason: `coverage varies by ${(spread * 100).toFixed(0)} percentage points, so a ranking would compare our coverage rather than their performance`,
      excludedIds,
    };
  }

  return { eligible: true, reason: "coverage is comparable across entities", excludedIds };
}

/**
 * Context-adjusted performance: actual versus what conditions would predict. Reported alongside
 * the raw figure, never instead of it, so the adjustment is always inspectable.
 */
export interface ContextAdjustmentInput {
  actual: number;
  /** Expected value given corridor, time of day, weather and road conditions. */
  expected: number;
  denominator: number;
  minimumDenominator?: number;
}

export interface ContextAdjustmentResult {
  raw: number;
  expected: number;
  /** Positive means better than conditions would predict. */
  differenceFromExpected: number | null;
  adjusted: number | null;
  suppressed: boolean;
  suppressionReason?: string;
}

export function contextAdjust(input: ContextAdjustmentInput): ContextAdjustmentResult {
  const minimum = input.minimumDenominator ?? MINIMUM_DENOMINATOR;

  if (input.denominator < minimum) {
    return {
      raw: input.actual,
      expected: input.expected,
      differenceFromExpected: null,
      adjusted: null,
      suppressed: true,
      suppressionReason: `only ${input.denominator} observations; adjustment needs at least ${minimum}`,
    };
  }

  const difference = input.actual - input.expected;
  return {
    raw: input.actual,
    expected: input.expected,
    differenceFromExpected: difference,
    // Centred on the network-typical value so an adjusted figure stays readable on the same scale.
    adjusted: clamp(0.5 + difference, 0, 1),
    suppressed: false,
  };
}

export { proportion };
