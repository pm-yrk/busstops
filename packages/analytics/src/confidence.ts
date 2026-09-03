import type { Confidence, ConfidenceLevel } from "@busstops/contracts";
import { clamp } from "./statistics.js";

/**
 * The confidence framework (docs/08_ANALYTICS_ENGINE.md "Confidence").
 *
 * The rule that matters: confidence can never exceed the weakest essential evidence component.
 * Averaging would let four strong signals paper over one fatal weakness — a perfectly matched,
 * well-sampled, persistent measurement built on a feed that died an hour ago is not a
 * medium-confidence result, it is a low-confidence one.
 */

export interface EvidenceComponent {
  name: string;
  /** 0..1 strength of this component. */
  score: number;
  /** Essential components cap the final score; supporting ones only adjust within that cap. */
  essential: boolean;
  detail: string;
}

export interface ConfidenceAssessment extends Confidence {
  components: EvidenceComponent[];
  /** The component that limited the result, when one did. */
  limitingComponent: string | null;
}

export function assessConfidence(components: readonly EvidenceComponent[]): ConfidenceAssessment {
  if (components.length === 0) {
    return {
      level: "low",
      score: 0,
      reasons: ["no evidence available"],
      components: [],
      limitingComponent: null,
    };
  }

  const essential = components.filter((component) => component.essential);
  const supporting = components.filter((component) => !component.essential);

  // The cap: the weakest essential component. Nothing can raise the result above it.
  const weakest =
    essential.length > 0
      ? essential.reduce((lowest, component) =>
          component.score < lowest.score ? component : lowest,
        )
      : null;
  const cap = weakest?.score ?? 1;

  const supportingAverage =
    supporting.length > 0
      ? supporting.reduce((total, component) => total + component.score, 0) / supporting.length
      : cap;

  // Supporting evidence can only nudge within the cap, never past it.
  const score = clamp(Math.min(cap, cap * 0.75 + supportingAverage * 0.25), 0, 1);

  const reasons = components
    .filter((component) => component.score < 0.6 || component.essential)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((component) => component.detail);

  return {
    level: toLevel(score),
    score,
    reasons: reasons.length > 0 ? reasons : [components[0]!.detail],
    components: [...components],
    limitingComponent: weakest && weakest.score < 0.7 ? weakest.name : null,
  };
}

export function toLevel(score: number): ConfidenceLevel {
  if (score >= 0.7) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

/** Freshness as an evidence component: an old observation cannot support a confident claim. */
export function freshnessComponent(
  ageSeconds: number | null,
  slaSeconds: number,
): EvidenceComponent {
  if (ageSeconds === null) {
    return {
      name: "source_freshness",
      score: 0.1,
      essential: true,
      detail: "no recent observation from the source",
    };
  }

  const score = clamp(1 - ageSeconds / (slaSeconds * 3), 0, 1);
  return {
    name: "source_freshness",
    score,
    essential: true,
    detail:
      ageSeconds <= slaSeconds
        ? `data is ${Math.round(ageSeconds)}s old, within its freshness target`
        : `data is ${Math.round(ageSeconds / 60)} minutes old, older than its freshness target`,
  };
}

export function sampleSizeComponent(count: number, minimum: number): EvidenceComponent {
  const score = clamp(count / (minimum * 2), 0, 1);
  return {
    name: "sample_size",
    score,
    essential: true,
    detail:
      count >= minimum
        ? `${count} observations, above the minimum of ${minimum}`
        : `only ${count} observations; ${minimum} are needed for a confident result`,
  };
}

export function matchQualityComponent(quality: number): EvidenceComponent {
  return {
    name: "match_quality",
    score: clamp(quality, 0, 1),
    essential: true,
    detail:
      quality >= 0.7
        ? "vehicle positions matched to routes with high confidence"
        : "vehicle positions could not be matched to routes confidently",
  };
}

export function baselineAdequacyComponent(sufficient: boolean, reason?: string): EvidenceComponent {
  return {
    name: "baseline_adequacy",
    score: sufficient ? 0.9 : 0.15,
    essential: true,
    detail: sufficient
      ? "enough comparable history to judge what is normal"
      : (reason ?? "not enough comparable history to judge what is normal"),
  };
}

export function persistenceComponent(minutes: number, minimumMinutes: number): EvidenceComponent {
  return {
    name: "persistence",
    score: clamp(minutes / (minimumMinutes * 2), 0, 1),
    essential: false,
    detail:
      minutes >= minimumMinutes
        ? `condition has persisted for ${Math.round(minutes)} minutes`
        : `condition has only lasted ${Math.round(minutes)} minutes so far`,
  };
}

export function corroborationComponent(sources: number): EvidenceComponent {
  return {
    name: "corroboration",
    score: clamp(sources / 3, 0, 1),
    essential: false,
    detail:
      sources > 1
        ? `corroborated by ${sources} independent sources`
        : "only one source of evidence for this",
  };
}

export function diversityComponent(distinctRoutes: number, minimum: number): EvidenceComponent {
  return {
    name: "sample_diversity",
    score: clamp(distinctRoutes / (minimum * 2), 0, 1),
    essential: false,
    detail:
      distinctRoutes >= minimum
        ? `${distinctRoutes} independent routes show the same pattern`
        : `only ${distinctRoutes} route observed, so this may be specific to one service`,
  };
}

/**
 * Calibration measurement for published intervals: what share of actual outcomes fell inside
 * the predicted range. A "90% interval" that contains 60% of outcomes is not a 90% interval,
 * and publishing the measured figure is what keeps the claim honest.
 */
export interface CalibrationInput {
  predictions: ReadonlyArray<{ low: number; high: number; actual: number }>;
  nominalCoverage: number;
}

export interface CalibrationResult {
  observedCoverage: number | null;
  nominalCoverage: number;
  sampleSize: number;
  wellCalibrated: boolean;
  narrative: string;
}

export function measureCalibration(input: CalibrationInput): CalibrationResult {
  if (input.predictions.length === 0) {
    return {
      observedCoverage: null,
      nominalCoverage: input.nominalCoverage,
      sampleSize: 0,
      wellCalibrated: false,
      narrative: "No predictions available to measure calibration.",
    };
  }

  const inside = input.predictions.filter(
    (prediction) => prediction.actual >= prediction.low && prediction.actual <= prediction.high,
  ).length;

  const observedCoverage = inside / input.predictions.length;
  const wellCalibrated = Math.abs(observedCoverage - input.nominalCoverage) <= 0.1;

  return {
    observedCoverage,
    nominalCoverage: input.nominalCoverage,
    sampleSize: input.predictions.length,
    wellCalibrated,
    narrative: `${(observedCoverage * 100).toFixed(0)}% of outcomes fell inside the predicted range, against a target of ${(input.nominalCoverage * 100).toFixed(0)}% (${input.predictions.length} predictions).`,
  };
}
