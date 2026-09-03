import type { IncidentSeverity } from "@busstops/contracts";
import { empiricalPercentile, median, quantile, robustZScore } from "./statistics.js";

/**
 * Typical versus abnormal (docs/08_ANALYTICS_ENGINE.md).
 *
 * The product's core claim is not "this is slow" but "this is unusual for this place at this
 * time". That requires a comparable baseline, and where one does not exist the honest answer is
 * "insufficient baseline" rather than a classification the data cannot support.
 */

export type WeekdayType = "weekday" | "saturday" | "sunday_or_holiday";

export interface BaselineKey {
  /** Corridor, segment or route this baseline describes. */
  scopeId: string;
  direction?: string;
  weekdayType: WeekdayType;
  /** Start of the 15-minute window, in minutes since local midnight. */
  windowStartMinute: number;
}

export interface BaselineSample {
  key: BaselineKey;
  /** Observations from comparable periods, e.g. segment travel times in seconds. */
  values: number[];
  /** Number of distinct comparable periods, which is what actually bounds confidence. */
  comparablePeriods: number;
  /** Days spanned, so a baseline built entirely from one week is visible as such. */
  spanDays: number;
}

/** Minimums from the specification: 20 comparable periods across at least four weeks. */
export const MINIMUM_COMPARABLE_PERIODS = 20;
export const MINIMUM_SPAN_DAYS = 28;

export interface BaselineDistribution {
  key: BaselineKey;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p97_5: number;
  sampleCount: number;
  comparablePeriods: number;
  spanDays: number;
  sufficient: boolean;
  insufficiencyReason?: string;
}

export function buildBaseline(sample: BaselineSample): BaselineDistribution | null {
  if (sample.values.length === 0) return null;

  const reasons: string[] = [];
  if (sample.comparablePeriods < MINIMUM_COMPARABLE_PERIODS) {
    reasons.push(
      `only ${sample.comparablePeriods} comparable periods; ${MINIMUM_COMPARABLE_PERIODS} are needed`,
    );
  }
  if (sample.spanDays < MINIMUM_SPAN_DAYS) {
    reasons.push(`covers only ${sample.spanDays} days; at least ${MINIMUM_SPAN_DAYS} are needed`);
  }

  return {
    key: sample.key,
    p10: quantile(sample.values, 0.1)!,
    p25: quantile(sample.values, 0.25)!,
    p50: median(sample.values)!,
    p75: quantile(sample.values, 0.75)!,
    p90: quantile(sample.values, 0.9)!,
    p97_5: quantile(sample.values, 0.975)!,
    sampleCount: sample.values.length,
    comparablePeriods: sample.comparablePeriods,
    spanDays: sample.spanDays,
    sufficient: reasons.length === 0,
    ...(reasons.length > 0 ? { insufficiencyReason: reasons.join("; ") } : {}),
  };
}

export type AbnormalityClass = IncidentSeverity | "insufficient_baseline";

export interface AbnormalityInput {
  /** Current observed value, in the same units as the baseline. */
  value: number;
  baseline: BaselineDistribution;
  sample: readonly number[];
  /** How long the condition has persisted, in minutes. */
  persistenceMinutes?: number;
  /** Minimum absolute excess before anything is called abnormal, in the value's units. */
  materialityThreshold?: number;
  minimumPersistenceMinutes?: number;
}

export interface AbnormalityResult {
  classification: AbnormalityClass;
  percentile: number | null;
  robustZScore: number | null;
  excessOverMedian: number;
  /** Empirical frequency of conditions at least this bad, with its sample size. */
  occurrenceFrequency: number | null;
  occurrenceSample: number;
  explanation: string;
  materially: boolean;
}

/**
 * Classifies current conditions against the baseline.
 *
 * Percentile and robust z-score are computed independently and the *less* alarming of the two
 * is taken. They disagree in exactly the cases where one of them is misleading — a tight
 * distribution makes small absolute differences look extreme by z-score, while a fat-tailed one
 * flattens genuinely bad values by percentile — and overstating abnormality is the worse error.
 */
export function classifyAbnormality(input: AbnormalityInput): AbnormalityResult {
  const materialityThreshold = input.materialityThreshold ?? 0;
  const minimumPersistence = input.minimumPersistenceMinutes ?? 0;

  const excessOverMedian = input.value - input.baseline.p50;
  const percentile = empiricalPercentile(input.value, input.sample);
  const zScore = robustZScore(input.value, input.sample);

  const atOrAbove = input.sample.filter((candidate) => candidate >= input.value).length;
  const occurrenceFrequency = input.sample.length > 0 ? atOrAbove / input.sample.length : null;

  const materially =
    excessOverMedian >= materialityThreshold &&
    (input.persistenceMinutes ?? Number.POSITIVE_INFINITY) >= minimumPersistence;

  if (!input.baseline.sufficient) {
    return {
      classification: "insufficient_baseline",
      percentile,
      robustZScore: zScore,
      excessOverMedian,
      occurrenceFrequency,
      occurrenceSample: input.sample.length,
      explanation: `Not enough comparable history to say whether this is unusual: ${input.baseline.insufficiencyReason}.`,
      materially,
    };
  }

  const byPercentile = classifyByPercentile(percentile);
  const byZScore = classifyByZScore(zScore);
  const classification = leastAlarming(byPercentile, byZScore);

  // Something statistically unusual but tiny in absolute terms is not worth an alert.
  const downgradedByMateriality = classification !== "typical" && !materially;
  const finalClassification: AbnormalityClass = downgradedByMateriality
    ? "typical"
    : classification;

  return {
    classification: finalClassification,
    percentile,
    robustZScore: zScore,
    excessOverMedian,
    occurrenceFrequency,
    occurrenceSample: input.sample.length,
    explanation: explain(
      finalClassification,
      percentile,
      occurrenceFrequency,
      input.sample.length,
      downgradedByMateriality,
    ),
    materially,
  };
}

function classifyByPercentile(percentile: number | null): IncidentSeverity {
  if (percentile === null) return "typical";
  if (percentile >= 0.975) return "highly_abnormal";
  if (percentile >= 0.9) return "abnormal";
  if (percentile >= 0.75) return "elevated";
  return "typical";
}

function classifyByZScore(zScore: number | null): IncidentSeverity {
  if (zScore === null) return "typical";
  if (zScore >= 3) return "highly_abnormal";
  if (zScore >= 2) return "abnormal";
  if (zScore >= 1) return "elevated";
  return "typical";
}

const SEVERITY_ORDER: IncidentSeverity[] = ["typical", "elevated", "abnormal", "highly_abnormal"];

function leastAlarming(a: IncidentSeverity, b: IncidentSeverity): IncidentSeverity {
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

function explain(
  classification: AbnormalityClass,
  percentile: number | null,
  occurrenceFrequency: number | null,
  sampleCount: number,
  downgradedByMateriality: boolean,
): string {
  if (classification === "insufficient_baseline") return "Insufficient baseline.";

  const frequencyText =
    occurrenceFrequency === null
      ? ""
      : ` Conditions at least this bad occur on ${(occurrenceFrequency * 100).toFixed(0)}% of comparable periods (${sampleCount} periods).`;

  if (classification === "typical") {
    // Two different reasons to call something typical, and conflating them would mislead: a value
    // that simply sits inside the normal range, versus one the statistics flagged but which is
    // too small or too short-lived to be worth reporting.
    return downgradedByMateriality
      ? `Slightly worse than usual, but the difference is too small to be meaningful.${frequencyText}`
      : `This is within the normal range for this time and place.${frequencyText}`;
  }

  const percentileText =
    percentile === null
      ? ""
      : ` It is worse than ${(percentile * 100).toFixed(0)}% of comparable periods.`;

  const label = {
    elevated: "Slightly worse than usual",
    abnormal: "Unusual for this time and place",
    highly_abnormal: "Highly unusual for this time and place",
  }[classification];

  return `${label}.${percentileText}${frequencyText}`;
}

/** Groups observations into the baseline's dimension keys. */
export function baselineKeyFor(
  scopeId: string,
  weekdayType: WeekdayType,
  minuteOfDay: number,
  direction?: string,
  windowMinutes = 15,
): BaselineKey {
  return {
    scopeId,
    ...(direction === undefined ? {} : { direction }),
    weekdayType,
    windowStartMinute: Math.floor(minuteOfDay / windowMinutes) * windowMinutes,
  };
}

export function baselineKeyToString(key: BaselineKey): string {
  return [key.scopeId, key.direction ?? "-", key.weekdayType, key.windowStartMinute].join("|");
}
