import type { Confidence } from "@busstops/contracts";
import { clamp, median, quantile } from "./statistics.js";

/**
 * Weather sensitivity, flood susceptibility and route risk (docs/08_ANALYTICS_ENGINE.md).
 *
 * Everything here reports association, never causation. Buses are slower in the rain and also
 * slower in the dark, in the winter, and at rush hour — so outcomes are only compared within
 * matched conditions, and the wording never claims the weather caused anything.
 */

export type RainfallBand = "dry" | "light" | "moderate" | "heavy";

export interface WeatherMatchedObservation {
  /** Outcome being compared, e.g. segment travel time in seconds. */
  value: number;
  rainfallBand: RainfallBand;
  /** Matched conditions: comparisons only happen within the same stratum. */
  weekdayType: string;
  hourOfDay: number;
}

export interface WeatherSensitivityInput {
  observations: readonly WeatherMatchedObservation[];
  minimumPerBand?: number;
  /** Minimum relative difference before an association is worth reporting. */
  minimumEffectSize?: number;
}

export interface WeatherSensitivityResult {
  dryMedian: number | null;
  wetMedian: number | null;
  /** Relative difference, e.g. 0.12 for 12% slower in the wet. */
  relativeDifference: number | null;
  dryCount: number;
  wetCount: number;
  significant: boolean;
  confidence: Confidence;
  /** Always association language: "associated with", never "caused by". */
  narrative: string;
}

export const WEATHER_DEFAULTS = {
  minimumPerBand: 20,
  minimumEffectSize: 0.05,
} as const;

export function analyseWeatherSensitivity(
  input: WeatherSensitivityInput,
): WeatherSensitivityResult {
  const minimumPerBand = input.minimumPerBand ?? WEATHER_DEFAULTS.minimumPerBand;
  const minimumEffect = input.minimumEffectSize ?? WEATHER_DEFAULTS.minimumEffectSize;

  // Only compare like with like: the same day type and hour, so rush hour is not mistaken for rain.
  const strata = new Map<string, WeatherMatchedObservation[]>();
  for (const observation of input.observations) {
    const key = `${observation.weekdayType}|${observation.hourOfDay}`;
    const existing = strata.get(key);
    if (existing) existing.push(observation);
    else strata.set(key, [observation]);
  }

  const dryValues: number[] = [];
  const wetValues: number[] = [];

  for (const group of strata.values()) {
    const dry = group.filter((o) => o.rainfallBand === "dry");
    const wet = group.filter((o) => o.rainfallBand !== "dry");
    // A stratum only contributes when it contains both conditions, which is what makes the
    // comparison matched rather than a raw split of everything.
    if (dry.length > 0 && wet.length > 0) {
      dryValues.push(...dry.map((o) => o.value));
      wetValues.push(...wet.map((o) => o.value));
    }
  }

  const dryMedian = median(dryValues);
  const wetMedian = median(wetValues);

  const relativeDifference =
    dryMedian !== null && wetMedian !== null && dryMedian > 0
      ? (wetMedian - dryMedian) / dryMedian
      : null;

  const reasons: string[] = [];
  let score = 0.25;

  const enoughSamples = dryValues.length >= minimumPerBand && wetValues.length >= minimumPerBand;
  if (enoughSamples) {
    score += 0.3;
    reasons.push(
      `${dryValues.length} dry and ${wetValues.length} wet observations in matched conditions`,
    );
  } else {
    reasons.push(
      `only ${dryValues.length} dry and ${wetValues.length} wet matched observations; ${minimumPerBand} of each are needed`,
    );
  }

  const bigEnough = relativeDifference !== null && Math.abs(relativeDifference) >= minimumEffect;
  if (bigEnough) {
    score += 0.2;
    reasons.push(`difference of ${((relativeDifference ?? 0) * 100).toFixed(0)}%`);
  } else if (relativeDifference !== null) {
    reasons.push("difference is too small to be meaningful");
  }

  if (strata.size < 3) {
    score -= 0.1;
    reasons.push("few distinct time periods contribute, so seasonality may not be controlled for");
  }

  score = clamp(score, 0.05, 1);
  const significant = enoughSamples && bigEnough;

  return {
    dryMedian,
    wetMedian,
    relativeDifference,
    dryCount: dryValues.length,
    wetCount: wetValues.length,
    significant,
    confidence: {
      level: score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low",
      score,
      reasons,
    },
    narrative: !enoughSamples
      ? "Not enough matched observations to compare wet and dry conditions here."
      : significant
        ? `Journeys here are associated with being about ${((relativeDifference ?? 0) * 100).toFixed(0)}% ${(relativeDifference ?? 0) > 0 ? "slower" : "faster"} in wet weather, compared with dry conditions at the same times. This is an association, not a demonstrated cause.`
        : "No meaningful difference between wet and dry conditions here.",
  };
}

export interface FloodSusceptibilityInput {
  /** Historic rain-associated disruption on this corridor, 0..1. */
  historicRainAssociation: number | null;
  /** Whether an official Environment Agency notice is currently active. */
  officialNoticeActive: boolean;
  officialNoticeSeverity?: "alert" | "warning" | "severe_warning";
  /** Forecast rainfall for the period, mm/hour. */
  forecastRainfallMmPerHour: number | null;
  /** Whether the corridor lies within a licensed flood area. */
  withinFloodArea: boolean | null;
}

export interface FloodSusceptibilityResult {
  band: "low" | "moderate" | "elevated" | "high";
  /** The exact phrase the UI must use, so the official/derived distinction cannot be lost. */
  wording: string;
  official: boolean;
  confidence: Confidence;
}

/**
 * Flood susceptibility. Only an active official notice may be called a warning; everything we
 * derive ourselves is worded as elevated risk, per the specification's wording rule.
 */
export function assessFloodSusceptibility(
  input: FloodSusceptibilityInput,
): FloodSusceptibilityResult {
  if (input.officialNoticeActive) {
    const severity = input.officialNoticeSeverity ?? "alert";
    return {
      band:
        severity === "severe_warning" ? "high" : severity === "warning" ? "elevated" : "moderate",
      wording:
        severity === "severe_warning"
          ? "Severe flood warning active"
          : severity === "warning"
            ? "Flood warning active"
            : "Flood alert active",
      official: true,
      confidence: {
        level: "high",
        score: 0.95,
        reasons: ["published by the Environment Agency"],
      },
    };
  }

  const reasons: string[] = [];
  let risk = 0;

  if (input.historicRainAssociation !== null) {
    risk += input.historicRainAssociation * 0.5;
    reasons.push("historic rain-associated disruption on this corridor");
  } else {
    reasons.push("no historic rain association available for this corridor");
  }

  if (input.forecastRainfallMmPerHour !== null) {
    risk += clamp(input.forecastRainfallMmPerHour / 8, 0, 1) * 0.35;
    reasons.push(`forecast rainfall of ${input.forecastRainfallMmPerHour.toFixed(1)}mm/h`);
  }

  if (input.withinFloodArea === true) {
    risk += 0.15;
    reasons.push("the corridor lies within a mapped flood area");
  }

  const band = risk >= 0.65 ? "elevated" : risk >= 0.35 ? "moderate" : "low";

  return {
    band,
    // Never "warning": nothing official is in force.
    wording: band === "low" ? "No elevated flooding risk indicated" : "Elevated flooding risk",
    official: false,
    confidence: {
      level: risk > 0 && reasons.length >= 2 ? "medium" : "low",
      score: clamp(0.2 + risk * 0.5, 0.05, 0.7),
      reasons,
    },
  };
}

export interface RouteRiskInput {
  /** Historic excess journey times in seconds under comparable conditions. */
  historicExcessSeconds: readonly number[];
  plannedRoadworksCount: number;
  activeIncidentCount: number;
  forecastRainfallMmPerHour: number | null;
  floodNoticeActive: boolean;
  /** Early live behaviour today, if the period has begun. */
  observedExcessSecondsSoFar: number | null;
  dataCoverage: number;
}

export interface RouteRiskResult {
  band: "low" | "moderate" | "elevated" | "high";
  probabilityLow: number;
  probabilityHigh: number;
  expectedAdditionalMinutesLow: number;
  expectedAdditionalMinutesHigh: number;
  contributingFactors: string[];
  confidence: Confidence;
  narrative: string;
}

/**
 * Route risk for the period ahead. Returns a probability band and a range of additional time —
 * never a single number, because a point forecast of disruption implies knowledge nobody has.
 */
export function forecastRouteRisk(input: RouteRiskInput): RouteRiskResult {
  const factors: string[] = [];

  const historicMedian = median(input.historicExcessSeconds) ?? 0;
  const historicP90 = quantile(input.historicExcessSeconds, 0.9) ?? historicMedian;

  let risk = clamp(historicMedian / 600, 0, 0.5);
  if (historicMedian > 60) factors.push("this route usually runs behind under similar conditions");

  if (input.plannedRoadworksCount > 0) {
    risk += clamp(input.plannedRoadworksCount * 0.08, 0, 0.2);
    factors.push(
      `${input.plannedRoadworksCount} planned street works ${input.plannedRoadworksCount === 1 ? "site" : "sites"} on or near the route`,
    );
  }
  if (input.activeIncidentCount > 0) {
    risk += clamp(input.activeIncidentCount * 0.12, 0, 0.25);
    factors.push(`${input.activeIncidentCount} active road incidents nearby`);
  }
  if (input.forecastRainfallMmPerHour !== null && input.forecastRainfallMmPerHour >= 2.5) {
    risk += 0.1;
    factors.push("moderate or heavy rain forecast");
  }
  if (input.floodNoticeActive) {
    risk += 0.15;
    factors.push("an official flood notice is active nearby");
  }
  if (input.observedExcessSecondsSoFar !== null && input.observedExcessSecondsSoFar > 120) {
    risk += 0.15;
    factors.push("services are already running behind this morning");
  }

  risk = clamp(risk, 0, 1);
  const band = risk >= 0.7 ? "high" : risk >= 0.45 ? "elevated" : risk >= 0.25 ? "moderate" : "low";

  // The probability band widens as coverage falls: thin data cannot support a tight range.
  const spread = clamp(0.3 - input.dataCoverage * 0.2, 0.08, 0.3);

  const expectedLowSeconds = Math.max(0, historicMedian * (0.5 + risk));
  const expectedHighSeconds = Math.max(expectedLowSeconds, historicP90 * (0.5 + risk) + 120);

  const confidenceScore = clamp(
    0.3 + input.dataCoverage * 0.5 + (input.historicExcessSeconds.length >= 20 ? 0.2 : 0),
    0.05,
    1,
  );

  return {
    band,
    probabilityLow: clamp(risk - spread / 2, 0, 1),
    probabilityHigh: clamp(risk + spread / 2, 0, 1),
    expectedAdditionalMinutesLow: Math.round(expectedLowSeconds / 60),
    expectedAdditionalMinutesHigh: Math.round(expectedHighSeconds / 60),
    contributingFactors: factors,
    confidence: {
      level: confidenceScore >= 0.7 ? "high" : confidenceScore >= 0.45 ? "medium" : "low",
      score: confidenceScore,
      reasons: [
        `based on ${input.historicExcessSeconds.length} comparable historic periods`,
        `${(input.dataCoverage * 100).toFixed(0)}% data coverage`,
      ],
    },
    narrative:
      factors.length === 0
        ? "Nothing unusual is expected on this route today."
        : `${band === "low" ? "Some" : band === "moderate" ? "Moderate" : band === "elevated" ? "Elevated" : "High"} risk of delay today, expected to add roughly ${Math.round(expectedLowSeconds / 60)}–${Math.round(expectedHighSeconds / 60)} minutes. Contributing factors: ${factors.join("; ")}.`,
  };
}
