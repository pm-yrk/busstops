import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUNCTUALITY_WINDOW,
  contextAdjust,
  empiricalPercentile,
  headwayAdherence,
  interquartileRange,
  median,
  medianAbsoluteDeviation,
  networkHealth,
  proportion,
  punctuality,
  quantile,
  rankingEligibility,
  reliability,
  robustZScore,
  summariseDelay,
  trimmedMean,
} from "./index.js";

/**
 * Golden cases are hand-calculated. Each one states the arithmetic in a comment so the expected
 * value can be checked by a reader rather than taken on trust from the implementation.
 */

describe("robust statistics", () => {
  it("computes quantiles by linear interpolation", () => {
    // [1,2,3,4]: p50 sits between 2 and 3.
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([10], 0.9)).toBe(10);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("resists the outlier that would wreck a mean", () => {
    const values = [10, 11, 12, 11, 10, 600];
    expect(median(values)).toBe(11);
    // The mean of the same data is over 100: exactly why the engine reports medians.
    expect(trimmedMean(values, 0.2)!).toBeLessThan(20);
  });

  it("computes MAD scaled to be comparable with a standard deviation", () => {
    // [1,2,3,4,5]: median 3, deviations [2,1,0,1,2], median deviation 1, x1.4826.
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])!).toBeCloseTo(1.4826, 4);
  });

  it("computes the interquartile range", () => {
    expect(interquartileRange([1, 2, 3, 4, 5])).toBe(2);
  });

  it("falls back to the IQR when the MAD is zero", () => {
    // More than half the sample is identical, so the MAD is 0 and would divide by zero — but
    // the upper tail still gives a non-zero IQR to scale by.
    const sample = [5, 5, 5, 5, 5, 6, 7, 8];
    expect(medianAbsoluteDeviation(sample)).toBe(0);
    expect(interquartileRange(sample)!).toBeGreaterThan(0);

    const z = robustZScore(8, sample);
    expect(z).not.toBeNull();
    expect(Number.isFinite(z!)).toBe(true);
    expect(z!).toBeGreaterThan(0);
  });

  it("returns null rather than infinity when there is no spread at all", () => {
    expect(robustZScore(5, [5, 5, 5, 5])).toBeNull();
  });

  it("computes the empirical percentile", () => {
    // 3 of 5 values are at or below 3.
    expect(empiricalPercentile(3, [1, 2, 3, 4, 5])).toBe(0.6);
    expect(empiricalPercentile(3, [])).toBeNull();
  });

  it("widens the proportion interval when the sample is small", () => {
    const small = proportion(8, 10)!;
    const large = proportion(800, 1000)!;
    expect(small.value).toBeCloseTo(large.value, 6);
    // The same 80% from ten observations is a far weaker claim than from a thousand.
    expect(small.high - small.low).toBeGreaterThan(large.high - large.low);
  });

  it("returns null for an empty denominator rather than dividing by zero", () => {
    expect(proportion(0, 0)).toBeNull();
  });
});

describe("delay summary", () => {
  it("reports median, mean and percentiles, excluding poorly matched observations", () => {
    const summary = summariseDelay([
      { delaySeconds: 0, matchQuality: "good" },
      { delaySeconds: 60, matchQuality: "good" },
      { delaySeconds: 120, matchQuality: "good" },
      { delaySeconds: 9999, matchQuality: "poor" },
    ]);

    expect(summary.medianSeconds).toBe(60);
    expect(summary.meanSeconds).toBe(60);
    expect(summary.denominator).toBe(3);
    expect(summary.excludedForQuality).toBe(1);
  });

  it("keeps early running as negative rather than absolute", () => {
    const summary = summariseDelay([
      { delaySeconds: -120, matchQuality: "good" },
      { delaySeconds: -60, matchQuality: "good" },
    ]);
    expect(summary.medianSeconds).toBe(-90);
  });
});

describe("punctuality", () => {
  const good = (delaySeconds: number) => ({ delaySeconds, matchQuality: "good" as const });

  it("counts observations inside the default window", () => {
    // 25 observations: 20 on time (0s), 5 late (600s) = 80%.
    const observations = [
      ...Array.from({ length: 20 }, () => good(0)),
      ...Array.from({ length: 5 }, () => good(600)),
    ];
    const result = punctuality({ observations });

    expect(result.value).toBeCloseTo(0.8, 6);
    expect(result.denominator).toBe(25);
    expect(result.suppressed).toBe(false);
    expect(result.definition).toContain("one minute early");
  });

  it("treats the window boundaries as inclusive", () => {
    const observations = Array.from({ length: 20 }, (_, i) =>
      good(
        i % 2 === 0
          ? DEFAULT_PUNCTUALITY_WINDOW.earliestSeconds
          : DEFAULT_PUNCTUALITY_WINDOW.latestSeconds,
      ),
    );
    expect(punctuality({ observations }).value).toBe(1);
  });

  it("counts running very early as not punctual", () => {
    const observations = [
      ...Array.from({ length: 10 }, () => good(-300)),
      ...Array.from({ length: 10 }, () => good(0)),
    ];
    expect(punctuality({ observations }).value).toBeCloseTo(0.5, 6);
  });

  it("suppresses the figure below the minimum denominator instead of publishing noise", () => {
    const result = punctuality({ observations: [good(0), good(0), good(600)] });
    expect(result.value).toBeNull();
    expect(result.suppressed).toBe(true);
    expect(result.suppressionReason).toMatch(/only 3 eligible observations/);
  });

  it("reports coverage against what was expected", () => {
    const observations = Array.from({ length: 25 }, () => good(0));
    const result = punctuality({ observations, expectedObservations: 100 });
    expect(result.coverage).toBeCloseTo(0.25, 6);
  });

  it("honours an alternative window profile", () => {
    const observations = Array.from({ length: 20 }, () => good(200));
    const strict = punctuality({
      observations,
      window: { name: "on the minute", earliestSeconds: 0, latestSeconds: 60 },
    });
    expect(strict.value).toBe(0);
    expect(strict.definition).toContain("on the minute");
  });
});

describe("reliability", () => {
  it("computes observed over scheduled, hand-checked", () => {
    // 100 scheduled, 10 lost to a source outage, so 90 eligible; 81 observed = 90%.
    const result = reliability({
      scheduledEligible: 100,
      observedEligible: 81,
      confirmedCancellations: 0,
      sourceOutageAffected: 10,
    });

    expect(result.value).toBeCloseTo(0.9, 6);
    expect(result.denominator).toBe(90);
    expect(result.coverage).toBeCloseTo(0.9, 6);
  });

  it("never counts missing telemetry as a cancellation", () => {
    const result = reliability({
      scheduledEligible: 100,
      observedEligible: 70,
      confirmedCancellations: 5,
      sourceOutageAffected: 0,
    });

    // 25 journeys were simply not observed. They are reported separately and are emphatically
    // not added to the 5 confirmed cancellations.
    expect(result.notObserved).toBe(25);
    expect(result.confirmedCancellations).toBe(5);
  });

  it("excludes source outages from the denominator rather than blaming the operator", () => {
    const withOutage = reliability({
      scheduledEligible: 100,
      observedEligible: 50,
      confirmedCancellations: 0,
      sourceOutageAffected: 50,
    });
    // 50 eligible, 50 observed: our outage does not make the operator look unreliable.
    expect(withOutage.value).toBe(1);
  });

  it("suppresses when too few comparable journeys remain", () => {
    const result = reliability({
      scheduledEligible: 100,
      observedEligible: 5,
      confirmedCancellations: 0,
      sourceOutageAffected: 95,
    });
    expect(result.value).toBeNull();
    expect(result.suppressionReason).toMatch(/only 5 comparable/);
  });
});

describe("headway adherence", () => {
  it("scores perfect adherence when every gap matches the schedule", () => {
    const result = headwayAdherence({
      observedHeadwaysSeconds: [600, 600, 600, 600, 600],
      scheduledHeadwaySeconds: 600,
    });
    expect(result.value).toBe(1);
    expect(result.meanAbsoluteDeviationSeconds).toBe(0);
  });

  it("computes adherence from the mean absolute deviation, hand-checked", () => {
    // Deviations from 600: 100, 100, 0, 0, 0 -> mean 40 -> adherence 1 - 40/600 = 0.9333.
    const result = headwayAdherence({
      observedHeadwaysSeconds: [700, 500, 600, 600, 600],
      scheduledHeadwaySeconds: 600,
    });
    expect(result.meanAbsoluteDeviationSeconds).toBeCloseTo(40, 6);
    expect(result.value).toBeCloseTo(0.9333, 3);
  });

  it("identifies frequent services, which are judged on headway not timetable", () => {
    expect(
      headwayAdherence({
        observedHeadwaysSeconds: [300, 300, 300, 300, 300],
        scheduledHeadwaySeconds: 300,
      }).frequentService,
    ).toBe(true);
    expect(
      headwayAdherence({
        observedHeadwaysSeconds: [1800, 1800, 1800, 1800, 1800],
        scheduledHeadwaySeconds: 1800,
      }).frequentService,
    ).toBe(false);
  });

  it("suppresses without a scheduled headway to compare against", () => {
    const result = headwayAdherence({
      observedHeadwaysSeconds: [600, 600, 600, 600, 600],
      scheduledHeadwaySeconds: null,
    });
    expect(result.value).toBeNull();
    expect(result.suppressionReason).toMatch(/no scheduled headway/);
  });
});

describe("network health", () => {
  const healthy = {
    punctuality: 0.9,
    reliability: 0.98,
    excessDelaySeconds: 30,
    headwayAdherence: 0.9,
    severeIncidentsPerHundredJourneys: 0,
    dataCoverage: 0.9,
  };

  it("scores a healthy network highly and a struggling one low", () => {
    const good = networkHealth(healthy);
    const bad = networkHealth({
      punctuality: 0.4,
      reliability: 0.7,
      excessDelaySeconds: 600,
      headwayAdherence: 0.3,
      severeIncidentsPerHundredJourneys: 5,
      dataCoverage: 0.9,
    });

    expect(good.score).toBeGreaterThan(85);
    expect(bad.score!).toBeLessThan(55);
  });

  it("exposes every component so the score can be explained", () => {
    const result = networkHealth(healthy);
    expect(Object.keys(result.components).sort()).toEqual([
      "dataCoverage",
      "excessDelay",
      "headwayStability",
      "punctuality",
      "reliability",
      "severeIncidentBurden",
    ]);
    expect(result.version).toMatch(/network-health/);
  });

  it("rounds to whole points rather than implying false precision", () => {
    const result = networkHealth(healthy);
    expect(Number.isInteger(result.score)).toBe(true);
  });

  it("caps confidence at what coverage supports, however good the score looks", () => {
    const thin = networkHealth({ ...healthy, dataCoverage: 0.3 });
    const full = networkHealth(healthy);
    expect(thin.confidence.score).toBeLessThan(full.confidence.score);
    expect(thin.confidence.reasons.join(" ")).toMatch(/30% data coverage/);
  });

  it("refuses to score at all below the minimum coverage", () => {
    const result = networkHealth({ ...healthy, dataCoverage: 0.05 });
    expect(result.score).toBeNull();
    expect(result.suppressed).toBe(true);
    expect(result.confidence.level).toBe("low");
  });

  it("never returns a score outside 0-100", () => {
    const extreme = networkHealth({
      punctuality: 1,
      reliability: 1,
      excessDelaySeconds: -1000,
      headwayAdherence: 1,
      severeIncidentsPerHundredJourneys: -5,
      dataCoverage: 1,
    });
    expect(extreme.score!).toBeLessThanOrEqual(100);
    expect(extreme.score!).toBeGreaterThanOrEqual(0);
  });
});

describe("ranking eligibility", () => {
  it("permits a ranking when coverage is comparable", () => {
    const result = rankingEligibility({
      coverages: [
        { id: "a", coverage: 0.9, denominator: 500 },
        { id: "b", coverage: 0.85, denominator: 400 },
      ],
    });
    expect(result.eligible).toBe(true);
  });

  it("refuses a ranking when coverage differs wildly", () => {
    // Ranking these would measure our coverage, not their performance.
    const result = rankingEligibility({
      coverages: [
        { id: "a", coverage: 0.95, denominator: 500 },
        { id: "b", coverage: 0.3, denominator: 400 },
      ],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/coverage varies by 65 percentage points/);
  });

  it("excludes entities below the minimum sample and refuses if too few remain", () => {
    const result = rankingEligibility({
      coverages: [
        { id: "a", coverage: 0.9, denominator: 500 },
        { id: "b", coverage: 0.9, denominator: 3 },
      ],
    });
    expect(result.excludedIds).toEqual(["b"]);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/fewer than two entities/);
  });
});

describe("context adjustment", () => {
  it("reports raw and expected side by side", () => {
    const result = contextAdjust({ actual: 0.75, expected: 0.65, denominator: 200 });
    expect(result.raw).toBe(0.75);
    expect(result.expected).toBe(0.65);
    expect(result.differenceFromExpected).toBeCloseTo(0.1, 6);
    expect(result.adjusted).toBeCloseTo(0.6, 6);
  });

  it("shows an operator doing worse than conditions predict as a negative difference", () => {
    const result = contextAdjust({ actual: 0.5, expected: 0.7, denominator: 200 });
    expect(result.differenceFromExpected!).toBeLessThan(0);
  });

  it("suppresses the adjustment below the minimum sample", () => {
    const result = contextAdjust({ actual: 0.9, expected: 0.6, denominator: 4 });
    expect(result.adjusted).toBeNull();
    expect(result.suppressed).toBe(true);
    // The raw figure is still returned, so the caller can show it with its caveat.
    expect(result.raw).toBe(0.9);
  });
});
