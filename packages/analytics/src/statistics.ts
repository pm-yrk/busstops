/**
 * Robust statistics.
 *
 * Transport data is full of long tails: one 40-minute journey distorts a mean but barely moves
 * a median. Every summary here is robust by default, and anything that is not says so.
 */

export function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Linear-interpolated quantile, the definition used consistently across the engine. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  if (q <= 0) return sorted(values)[0]!;
  if (q >= 1) return sorted(values)[values.length - 1]!;

  const ordered = sorted(values);
  const position = (ordered.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower]!;
  return ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (position - lower);
}

export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

/** Median absolute deviation, scaled so it is comparable to a standard deviation. */
export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const centre = median(values);
  if (centre === null) return null;
  const deviations = values.map((value) => Math.abs(value - centre));
  const mad = median(deviations);
  return mad === null ? null : mad * 1.4826;
}

export function interquartileRange(values: readonly number[]): number | null {
  const p25 = quantile(values, 0.25);
  const p75 = quantile(values, 0.75);
  if (p25 === null || p75 === null) return null;
  return p75 - p25;
}

/**
 * Robust z-score using MAD, falling back to the IQR when the MAD is zero — which happens
 * whenever more than half the sample is identical, a common case in timetable data.
 * Returns null when the spread cannot be estimated at all, rather than dividing by zero.
 */
export function robustZScore(value: number, sample: readonly number[]): number | null {
  const centre = median(sample);
  if (centre === null) return null;

  const mad = medianAbsoluteDeviation(sample);
  if (mad !== null && mad > 0) return (value - centre) / mad;

  const iqr = interquartileRange(sample);
  if (iqr !== null && iqr > 0) return (value - centre) / (iqr / 1.349);

  return null;
}

/** Share of the sample at or below `value`, 0..1. */
export function empiricalPercentile(value: number, sample: readonly number[]): number | null {
  if (sample.length === 0) return null;
  const atOrBelow = sample.filter((candidate) => candidate <= value).length;
  return atOrBelow / sample.length;
}

/**
 * Fraction with a Wilson score interval. A raw percentage from a handful of observations looks
 * identical to one from thousands, which is exactly the false confidence the product must avoid.
 */
export interface ProportionEstimate {
  value: number;
  low: number;
  high: number;
  denominator: number;
}

export function proportion(successes: number, total: number, z = 1.96): ProportionEstimate | null {
  if (total <= 0) return null;

  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));

  // The interval must bracket its own point estimate. At p = 0 or p = 1 the Wilson arithmetic can
  // land a hair the wrong side of the estimate through floating-point rounding, and an interval
  // whose upper bound sits below the value it describes is malformed however small the gap.
  return {
    value: p,
    low: Math.min(p, Math.max(0, (centre - spread) / denominator)),
    high: Math.max(p, Math.min(1, (centre + spread) / denominator)),
    denominator: total,
  };
}

/** Trimmed mean, used where a mean is genuinely wanted but outliers must not dominate. */
export function trimmedMean(values: readonly number[], trimFraction = 0.1): number | null {
  if (values.length === 0) return null;
  const ordered = sorted(values);
  const drop = Math.floor(ordered.length * trimFraction);
  const kept = ordered.slice(drop, ordered.length - drop);
  return mean(kept.length > 0 ? kept : ordered);
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
