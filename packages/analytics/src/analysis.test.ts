import { describe, expect, it } from "vitest";
import {
  MINIMUM_COMPARABLE_PERIODS,
  analyseCongestion,
  analyseWeatherSensitivity,
  assessConfidence,
  assessFloodSusceptibility,
  baselineAdequacyComponent,
  baselineKeyFor,
  buildBaseline,
  classifyAbnormality,
  corroborationComponent,
  detectBunching,
  detectDiversion,
  detectServiceGap,
  detectSkippedStop,
  detectSpeedAnomaly,
  findDelayOrigin,
  forecastRouteRisk,
  freshnessComponent,
  headwaysFromPositions,
  matchQualityComponent,
  measureCalibration,
  sampleSizeComponent,
  type BaselineDistribution,
} from "./index.js";

/** A well-populated baseline: 40 comparable periods over 8 weeks, travel times around 300s. */
function goodBaseline(values: number[]): BaselineDistribution {
  return buildBaseline({
    key: baselineKeyFor("corridor-1", "weekday", 8 * 60 + 37, "forward"),
    values,
    comparablePeriods: 40,
    spanDays: 56,
  })!;
}

const typicalValues = [
  280, 285, 290, 295, 300, 300, 300, 305, 305, 310, 310, 315, 315, 320, 320, 325, 330, 335, 340,
  345, 350, 355, 360, 370, 380, 390, 400, 420, 450, 480,
];

describe("baseline construction", () => {
  it("computes the distribution and its dimension key", () => {
    const baseline = goodBaseline(typicalValues);
    expect(baseline.p50).toBeGreaterThan(300);
    expect(baseline.p97_5).toBeGreaterThan(baseline.p90);
    expect(baseline.key.windowStartMinute).toBe(8 * 60 + 30);
    expect(baseline.key.weekdayType).toBe("weekday");
    expect(baseline.sufficient).toBe(true);
  });

  it("marks a baseline built from too few comparable periods as insufficient", () => {
    const baseline = buildBaseline({
      key: baselineKeyFor("corridor-1", "weekday", 500),
      values: typicalValues,
      comparablePeriods: 5,
      spanDays: 56,
    })!;
    expect(baseline.sufficient).toBe(false);
    expect(baseline.insufficiencyReason).toMatch(/only 5 comparable periods/);
  });

  it("marks a baseline built from a single week as insufficient however many samples it has", () => {
    // Plenty of observations, but all from one week: it cannot represent "normal".
    const baseline = buildBaseline({
      key: baselineKeyFor("corridor-1", "weekday", 500),
      values: typicalValues,
      comparablePeriods: MINIMUM_COMPARABLE_PERIODS + 10,
      spanDays: 7,
    })!;
    expect(baseline.sufficient).toBe(false);
    expect(baseline.insufficiencyReason).toMatch(/covers only 7 days/);
  });

  it("returns null for an empty sample", () => {
    expect(
      buildBaseline({
        key: baselineKeyFor("x", "weekday", 0),
        values: [],
        comparablePeriods: 40,
        spanDays: 56,
      }),
    ).toBeNull();
  });
});

describe("typical versus abnormal", () => {
  const baseline = goodBaseline(typicalValues);

  it("calls a normal value typical", () => {
    const result = classifyAbnormality({ value: 310, baseline, sample: typicalValues });
    expect(result.classification).toBe("typical");
    expect(result.explanation).toMatch(/within the normal range/);
  });

  it("calls a clearly extreme value abnormal", () => {
    const result = classifyAbnormality({
      value: 900,
      baseline,
      sample: typicalValues,
      materialityThreshold: 60,
    });
    expect(["abnormal", "highly_abnormal"]).toContain(result.classification);
    expect(result.percentile).toBeGreaterThan(0.9);
  });

  it("reports occurrence frequency with its sample size, as an empirical figure", () => {
    const result = classifyAbnormality({ value: 300, baseline, sample: typicalValues });
    expect(result.occurrenceSample).toBe(typicalValues.length);
    expect(result.occurrenceFrequency).toBeGreaterThan(0);
    expect(result.explanation).toMatch(/comparable periods/);
  });

  it("refuses to classify at all without a sufficient baseline", () => {
    const thin = buildBaseline({
      key: baselineKeyFor("corridor-1", "weekday", 500),
      values: typicalValues,
      comparablePeriods: 3,
      spanDays: 4,
    })!;
    const result = classifyAbnormality({ value: 900, baseline: thin, sample: typicalValues });
    expect(result.classification).toBe("insufficient_baseline");
    expect(result.explanation).toMatch(/Not enough comparable history/);
  });

  it("takes the less alarming of percentile and z-score when they disagree", () => {
    // A very tight distribution makes a tiny absolute difference look extreme by z-score.
    const tight = [300, 300, 300, 300, 301, 301, 301, 302, 302, 303];
    const tightBaseline = buildBaseline({
      key: baselineKeyFor("c", "weekday", 500),
      values: tight,
      comparablePeriods: 40,
      spanDays: 56,
    })!;

    const result = classifyAbnormality({
      value: 305,
      baseline: tightBaseline,
      sample: tight,
      materialityThreshold: 60,
    });
    // Five seconds slower is not an incident, whatever the z-score says.
    expect(result.classification).toBe("typical");
  });

  it("downgrades a statistically unusual but immaterial difference", () => {
    const result = classifyAbnormality({
      value: 490,
      baseline,
      sample: typicalValues,
      materialityThreshold: 600,
    });
    expect(result.classification).toBe("typical");
    expect(result.materially).toBe(false);
    // A downgraded reading must not be described the same way as a plainly normal one.
    expect(result.explanation).toMatch(/too small to be meaningful/);
    expect(result.explanation).not.toMatch(/within the normal range/);
  });

  it("requires persistence when a minimum is set", () => {
    const brief = classifyAbnormality({
      value: 900,
      baseline,
      sample: typicalValues,
      materialityThreshold: 60,
      persistenceMinutes: 1,
      minimumPersistenceMinutes: 10,
    });
    expect(brief.classification).toBe("typical");

    const sustained = classifyAbnormality({
      value: 900,
      baseline,
      sample: typicalValues,
      materialityThreshold: 60,
      persistenceMinutes: 20,
      minimumPersistenceMinutes: 10,
    });
    expect(sustained.classification).not.toBe("typical");
  });
});

describe("bunching", () => {
  const vehicle = (ref: string, metres: number, reliable = true) => ({
    vehicleRef: ref,
    alongPathMetres: metres,
    observedAt: "2026-09-02T08:00:00.000Z",
    reliable,
  });

  it("detects two buses running close together and closing", () => {
    const result = detectBunching({
      patternId: "p1",
      samples: [
        { leader: vehicle("a", 1000), follower: vehicle("b", 700), headwaySeconds: 150 },
        { leader: vehicle("a", 1200), follower: vehicle("b", 1050), headwaySeconds: 90 },
      ],
      scheduledHeadwaySeconds: 600,
    });

    expect(result.detected).toBe(true);
    expect(result.closing).toBe(true);
    // Threshold is max(120s, half of 600s) = 300s.
    expect(result.thresholdSeconds).toBe(300);
    expect(result.narrative).toMatch(/close together/);
  });

  it("uses the two-minute floor for very frequent services", () => {
    const result = detectBunching({
      patternId: "p1",
      samples: [{ leader: vehicle("a", 100), follower: vehicle("b", 50), headwaySeconds: 150 }],
      scheduledHeadwaySeconds: 180,
    });
    expect(result.thresholdSeconds).toBe(120);
  });

  it("does not fire on a single sample", () => {
    const result = detectBunching({
      patternId: "p1",
      samples: [{ leader: vehicle("a", 1000), follower: vehicle("b", 950), headwaySeconds: 60 }],
      scheduledHeadwaySeconds: 600,
    });
    expect(result.detected).toBe(false);
  });

  it("ignores samples with poor match quality", () => {
    const result = detectBunching({
      patternId: "p1",
      samples: [
        {
          leader: vehicle("a", 1000, false),
          follower: vehicle("b", 950, false),
          headwaySeconds: 30,
        },
        {
          leader: vehicle("a", 1100, false),
          follower: vehicle("b", 1080, false),
          headwaySeconds: 20,
        },
      ],
      scheduledHeadwaySeconds: 600,
    });
    expect(result.detected).toBe(false);
    expect(result.confidence.reasons.join(" ")).toMatch(/excluded for poor match quality/);
  });
});

describe("service gaps", () => {
  it("detects a gap beyond the threshold", () => {
    const result = detectServiceGap({
      patternId: "p1",
      observedHeadwaySeconds: 1800,
      scheduledHeadwaySeconds: 600,
      missingScheduledJourneyIds: [],
      sourceHealthy: true,
    });
    // Threshold is max(600s, 1.5 x 600s) = 900s.
    expect(result.thresholdSeconds).toBe(900);
    expect(result.detected).toBe(true);
  });

  it("refuses to call a gap when the feed was down", () => {
    // Our blind spot is not the operator's gap. This distinction is the whole point.
    const result = detectServiceGap({
      patternId: "p1",
      observedHeadwaySeconds: 3600,
      scheduledHeadwaySeconds: 600,
      missingScheduledJourneyIds: ["j1", "j2"],
      sourceHealthy: false,
    });
    expect(result.detected).toBe(false);
    expect(result.narrative).toMatch(/live feed was unavailable/);
  });

  it("detects a gap supported by missing scheduled journeys", () => {
    const result = detectServiceGap({
      patternId: "p1",
      observedHeadwaySeconds: null,
      scheduledHeadwaySeconds: 600,
      missingScheduledJourneyIds: ["j1"],
      sourceHealthy: true,
    });
    expect(result.detected).toBe(true);
  });

  it("computes headways from along-path positions", () => {
    const headways = headwaysFromPositions(
      [
        { vehicleRef: "a", alongPathMetres: 0, observedAt: "", reliable: true },
        { vehicleRef: "b", alongPathMetres: 1000, observedAt: "", reliable: true },
        { vehicleRef: "c", alongPathMetres: 3000, observedAt: "", reliable: true },
      ],
      10,
    );
    expect(headways).toEqual([100, 200]);
  });
});

describe("diversion", () => {
  const sample = (offRouteMetres: number, minute: number, reliable = true) => ({
    observedAt: `2026-09-02T08:${String(minute).padStart(2, "0")}:00.000Z`,
    offRouteMetres,
    reliable,
  });

  it("detects a sustained run of off-route positions that later rejoins", () => {
    const result = detectDiversion({
      samples: [sample(10, 0), sample(300, 1), sample(400, 2), sample(350, 3), sample(15, 5)],
      rejoined: true,
    });

    expect(result.detected).toBe(true);
    expect(result.consecutiveOffRoute).toBe(3);
    expect(result.durationSeconds).toBe(120);
    // Cautious wording is mandatory: this is inference from positions, not an observed fact.
    expect(result.narrative).toMatch(/appears to have taken a different route/);
    expect(result.narrative).not.toMatch(/is diverted|has been diverted/);
  });

  it("does not fire on a single GPS excursion", () => {
    const result = detectDiversion({
      samples: [sample(10, 0), sample(400, 1), sample(12, 2)],
      rejoined: true,
    });
    expect(result.detected).toBe(false);
  });

  it("does not fire on a run that is too brief", () => {
    const result = detectDiversion({
      samples: [sample(300, 0), sample(320, 0), sample(310, 1)],
      rejoined: false,
      minimumDurationSeconds: 300,
    });
    expect(result.detected).toBe(false);
  });

  it("lowers confidence when the distance off route is close to GPS error", () => {
    const marginal = detectDiversion({
      samples: [sample(90, 0), sample(95, 1), sample(100, 2)],
      rejoined: true,
    });
    const clear = detectDiversion({
      samples: [sample(500, 0), sample(520, 1), sample(510, 2)],
      rejoined: true,
    });
    expect(marginal.confidence.score).toBeLessThan(clear.confidence.score);
    expect(marginal.confidence.reasons.join(" ")).toMatch(/close to normal GPS error/);
  });
});

describe("skipped stops", () => {
  it("flags a possible skip only when the path bypassed the stop and progression continued", () => {
    const result = detectSkippedStop({
      stopId: "s1",
      closestApproachMetres: 150,
      progressionContinued: true,
      reliable: true,
    });
    expect(result.possiblySkipped).toBe(true);
    expect(result.narrative).toMatch(/may not have served/);
  });

  it("does not infer a skip from a close pass alone", () => {
    // Buses pass close to stops without stopping constantly; absence of dwell proves nothing.
    const result = detectSkippedStop({
      stopId: "s1",
      closestApproachMetres: 20,
      progressionContinued: true,
      reliable: true,
    });
    expect(result.possiblySkipped).toBe(false);
  });

  it("does not conclude anything before the bus reaches later stops", () => {
    const result = detectSkippedStop({
      stopId: "s1",
      closestApproachMetres: 200,
      progressionContinued: false,
      reliable: true,
    });
    expect(result.possiblySkipped).toBe(false);
  });
});

describe("congestion", () => {
  const traversal = (routeId: string, vehicleRef: string, observedSeconds: number) => ({
    routeId,
    vehicleRef,
    observedSeconds,
    observedAt: "2026-09-02T08:00:00.000Z",
    reliable: true,
  });

  it("computes excess vehicle-minutes, hand-checked", () => {
    // Four traversals at 400s against an expected 300s: 100s excess each = 400s = 6.67 min.
    const result = analyseCongestion({
      corridorId: "c1",
      traversals: [
        traversal("r1", "v1", 400),
        traversal("r2", "v2", 400),
        traversal("r3", "v3", 400),
        traversal("r1", "v4", 400),
      ],
      expectedSeconds: 300,
    });

    expect(result.excessVehicleMinutes).toBeCloseTo(6.667, 2);
    expect(result.excessPerTraversalSeconds).toBe(100);
    expect(result.distinctRoutes).toBe(3);
  });

  it("never counts a faster-than-expected traversal as negative excess", () => {
    const result = analyseCongestion({
      corridorId: "c1",
      traversals: [
        traversal("r1", "v1", 200),
        traversal("r2", "v2", 400),
        traversal("r3", "v3", 300),
      ],
      expectedSeconds: 300,
    });
    // Only the 400s traversal contributes: 100s, not 100 - 100 + 0.
    expect(result.excessVehicleMinutes).toBeCloseTo(1.667, 2);
  });

  it("refuses to call one stationary bus corridor congestion", () => {
    const result = analyseCongestion({
      corridorId: "c1",
      traversals: [traversal("r1", "v1", 1200)],
      expectedSeconds: 300,
    });
    expect(result.confidence.level).toBe("low");
    expect(result.narrative).toMatch(/Not enough independent observations/);
  });

  it("raises confidence when independent routes agree", () => {
    const oneRoute = analyseCongestion({
      corridorId: "c1",
      traversals: [
        traversal("r1", "v1", 500),
        traversal("r1", "v2", 500),
        traversal("r1", "v3", 500),
      ],
      expectedSeconds: 300,
    });
    const manyRoutes = analyseCongestion({
      corridorId: "c1",
      traversals: [
        traversal("r1", "v1", 500),
        traversal("r2", "v2", 500),
        traversal("r3", "v3", 500),
      ],
      expectedSeconds: 300,
    });
    expect(manyRoutes.confidence.score).toBeGreaterThan(oneRoute.confidence.score);
  });

  it("says so when there is no baseline to compare against", () => {
    const result = analyseCongestion({
      corridorId: "c1",
      traversals: [
        traversal("r1", "v1", 500),
        traversal("r2", "v2", 500),
        traversal("r3", "v3", 500),
      ],
      expectedSeconds: null,
    });
    expect(result.narrative).toMatch(/No baseline/);
    expect(result.confidence.reasons.join(" ")).toMatch(/no comparable baseline/);
  });
});

describe("delay origin", () => {
  const segment = (
    corridorId: string,
    name: string,
    excessSecondsPerTraversal: number,
    sequence: number,
    distinctRoutes = 3,
  ) => ({
    corridorId,
    name,
    excessSecondsPerTraversal,
    sequence,
    distinctRoutes,
    traversalCount: 8,
  });

  it("attributes delay to the earliest segment carrying a material share", () => {
    const result = findDelayOrigin([
      segment("c1", "Boar Lane", 240, 1),
      segment("c2", "Wellington Street", 60, 2),
      segment("c3", "Armley Road", 30, 3),
    ]);

    expect(result.originCorridorId).toBe("c1");
    // Cautious wording: "appears to originate", never a stated cause.
    expect(result.narrative).toMatch(/appears to originate near Boar Lane/);
    expect(result.shareOfExcess).toBeCloseTo(240 / 330, 3);
  });

  it("returns competing explanations rather than a single answer", () => {
    const result = findDelayOrigin([
      segment("c1", "A", 150, 1),
      segment("c2", "B", 140, 2),
      segment("c3", "C", 120, 3),
    ]);
    expect(result.competingExplanations.length).toBeGreaterThan(0);
    expect(result.confidence.reasons.join(" ")).toMatch(/other segments also contribute/);
  });

  it("says delay is spread out when nothing dominates", () => {
    const many = Array.from({ length: 10 }, (_, i) => segment(`c${i}`, `S${i}`, 30, i));
    const result = findDelayOrigin(many);
    expect(result.originCorridorId).toBeNull();
    expect(result.narrative).toMatch(/spread out/);
  });

  it("handles a route with no excess delay at all", () => {
    const result = findDelayOrigin([segment("c1", "A", 0, 1)]);
    expect(result.originCorridorId).toBeNull();
    expect(result.cumulativeExcessSeconds).toBe(0);
  });
});

describe("speed anomalies", () => {
  it("reports a possible anomaly without blaming anyone", () => {
    const result = detectSpeedAnomaly({
      corridorId: "c1",
      vehicleRef: "opaque-ref",
      // 20 m/s is about 45mph in a 30 limit.
      derivedSpeedsMetresPerSecond: [20, 21, 20.5, 20],
      speedLimitMph: 30,
      matchQuality: "good",
    });

    expect(result.detected).toBe(true);
    expect(result.narrative).toMatch(/Possible speed anomaly/);
    // Never an accusation about a person, and never a legal conclusion.
    expect(result.narrative).toMatch(/not a measurement of any individual vehicle or driver/);
    expect(result.narrative).not.toMatch(/speeding|offence|illegal/i);
  });

  it("refuses to compare without a sourced speed limit", () => {
    const result = detectSpeedAnomaly({
      corridorId: "c1",
      vehicleRef: "v",
      derivedSpeedsMetresPerSecond: [30, 31, 30],
      speedLimitMph: null,
      matchQuality: "good",
    });
    expect(result.detected).toBe(false);
    expect(result.confidence.score).toBeLessThan(0.2);
  });

  it("refuses to conclude anything from poorly matched positions", () => {
    const result = detectSpeedAnomaly({
      corridorId: "c1",
      vehicleRef: "v",
      derivedSpeedsMetresPerSecond: [40, 41, 42],
      speedLimitMph: 30,
      matchQuality: "poor",
    });
    expect(result.detected).toBe(false);
    expect(result.narrative).toMatch(/too poor/);
  });

  it("does not fire on a single sample", () => {
    const result = detectSpeedAnomaly({
      corridorId: "c1",
      vehicleRef: "v",
      derivedSpeedsMetresPerSecond: [25],
      speedLimitMph: 30,
      matchQuality: "good",
    });
    expect(result.detected).toBe(false);
  });
});

describe("weather sensitivity", () => {
  const observation = (value: number, rainfallBand: "dry" | "heavy", hourOfDay = 8) => ({
    value,
    rainfallBand,
    weekdayType: "weekday",
    hourOfDay,
  });

  it("compares like with like and reports an association, not a cause", () => {
    const observations = [
      ...Array.from({ length: 25 }, () => observation(300, "dry")),
      ...Array.from({ length: 25 }, () => observation(360, "heavy")),
    ];
    const result = analyseWeatherSensitivity({ observations });

    expect(result.significant).toBe(true);
    expect(result.relativeDifference).toBeCloseTo(0.2, 2);
    expect(result.narrative).toMatch(/association, not a demonstrated cause/);
  });

  it("only compares within strata that contain both conditions", () => {
    // All the wet observations are at 18:00 and all the dry ones at 08:00: comparing them would
    // measure the evening peak, not the rain.
    const observations = [
      ...Array.from({ length: 25 }, () => observation(300, "dry", 8)),
      ...Array.from({ length: 25 }, () => observation(600, "heavy", 18)),
    ];
    const result = analyseWeatherSensitivity({ observations });

    expect(result.dryCount).toBe(0);
    expect(result.wetCount).toBe(0);
    expect(result.significant).toBe(false);
    expect(result.narrative).toMatch(/Not enough matched observations/);
  });

  it("does not report a difference too small to matter", () => {
    const observations = [
      ...Array.from({ length: 25 }, () => observation(300, "dry")),
      ...Array.from({ length: 25 }, () => observation(303, "heavy")),
    ];
    expect(analyseWeatherSensitivity({ observations }).significant).toBe(false);
  });
});

describe("flood susceptibility", () => {
  it("uses official wording only when an official notice is active", () => {
    const official = assessFloodSusceptibility({
      historicRainAssociation: 0.1,
      officialNoticeActive: true,
      officialNoticeSeverity: "warning",
      forecastRainfallMmPerHour: 1,
      withinFloodArea: true,
    });
    expect(official.wording).toBe("Flood warning active");
    expect(official.official).toBe(true);
  });

  it("never says 'warning' for a derived assessment, however high the risk", () => {
    const derived = assessFloodSusceptibility({
      historicRainAssociation: 0.95,
      officialNoticeActive: false,
      forecastRainfallMmPerHour: 20,
      withinFloodArea: true,
    });
    expect(derived.official).toBe(false);
    expect(derived.wording).toBe("Elevated flooding risk");
    expect(derived.wording).not.toMatch(/warning/i);
  });

  it("reports no elevated risk when nothing indicates one", () => {
    const quiet = assessFloodSusceptibility({
      historicRainAssociation: 0,
      officialNoticeActive: false,
      forecastRainfallMmPerHour: 0,
      withinFloodArea: false,
    });
    expect(quiet.band).toBe("low");
  });
});

describe("route risk", () => {
  it("returns a probability band and a range, never a single number", () => {
    const result = forecastRouteRisk({
      historicExcessSeconds: Array.from({ length: 30 }, () => 180),
      plannedRoadworksCount: 1,
      activeIncidentCount: 1,
      forecastRainfallMmPerHour: 4,
      floodNoticeActive: false,
      observedExcessSecondsSoFar: null,
      dataCoverage: 0.8,
    });

    expect(result.probabilityHigh).toBeGreaterThan(result.probabilityLow);
    expect(result.expectedAdditionalMinutesHigh).toBeGreaterThanOrEqual(
      result.expectedAdditionalMinutesLow,
    );
    expect(result.contributingFactors.length).toBeGreaterThan(0);
  });

  it("widens the band when coverage is thin", () => {
    const base = {
      historicExcessSeconds: Array.from({ length: 30 }, () => 180),
      plannedRoadworksCount: 0,
      activeIncidentCount: 0,
      forecastRainfallMmPerHour: null,
      floodNoticeActive: false,
      observedExcessSecondsSoFar: null,
    };
    const thin = forecastRouteRisk({ ...base, dataCoverage: 0.1 });
    const full = forecastRouteRisk({ ...base, dataCoverage: 0.95 });

    expect(thin.probabilityHigh - thin.probabilityLow).toBeGreaterThan(
      full.probabilityHigh - full.probabilityLow,
    );
    expect(thin.confidence.score).toBeLessThan(full.confidence.score);
  });

  it("says nothing unusual is expected when no factor applies", () => {
    const result = forecastRouteRisk({
      historicExcessSeconds: Array.from({ length: 30 }, () => 0),
      plannedRoadworksCount: 0,
      activeIncidentCount: 0,
      forecastRainfallMmPerHour: 0,
      floodNoticeActive: false,
      observedExcessSecondsSoFar: null,
      dataCoverage: 0.9,
    });
    expect(result.band).toBe("low");
    expect(result.narrative).toMatch(/Nothing unusual/);
  });
});

describe("confidence framework", () => {
  it("can never exceed the weakest essential component", () => {
    const result = assessConfidence([
      matchQualityComponent(0.95),
      sampleSizeComponent(500, 20),
      // The feed died an hour ago: nothing else can rescue this.
      freshnessComponent(3600, 120),
      corroborationComponent(3),
    ]);

    expect(result.score).toBeLessThan(0.3);
    expect(result.level).toBe("low");
    expect(result.limitingComponent).toBe("source_freshness");
  });

  it("lets supporting evidence adjust within the cap but never past it", () => {
    const withSupport = assessConfidence([
      matchQualityComponent(0.8),
      sampleSizeComponent(100, 20),
      freshnessComponent(30, 120),
      corroborationComponent(3),
    ]);
    const withoutSupport = assessConfidence([
      matchQualityComponent(0.8),
      sampleSizeComponent(100, 20),
      freshnessComponent(30, 120),
      corroborationComponent(1),
    ]);

    expect(withSupport.score).toBeGreaterThan(withoutSupport.score);
    expect(withSupport.score).toBeLessThanOrEqual(0.8 + 1e-9);
  });

  it("explains what limited it", () => {
    const result = assessConfidence([
      matchQualityComponent(0.9),
      baselineAdequacyComponent(false, "only 4 comparable periods"),
      freshnessComponent(10, 120),
    ]);
    expect(result.reasons.join(" ")).toMatch(/only 4 comparable periods/);
    expect(result.limitingComponent).toBe("baseline_adequacy");
  });

  it("returns low confidence with no evidence at all", () => {
    const result = assessConfidence([]);
    expect(result.level).toBe("low");
    expect(result.score).toBe(0);
  });

  it("scores freshness from age against the source's own target", () => {
    expect(freshnessComponent(10, 120).score).toBeGreaterThan(0.9);
    expect(freshnessComponent(600, 120).score).toBe(0);
    expect(freshnessComponent(null, 120).score).toBeLessThan(0.2);
  });
});

describe("calibration", () => {
  it("measures what share of outcomes fell inside the published interval", () => {
    const predictions = [
      ...Array.from({ length: 9 }, () => ({ low: 0, high: 10, actual: 5 })),
      { low: 0, high: 10, actual: 50 },
    ];
    const result = measureCalibration({ predictions, nominalCoverage: 0.9 });

    expect(result.observedCoverage).toBeCloseTo(0.9, 6);
    expect(result.wellCalibrated).toBe(true);
    expect(result.narrative).toMatch(/90% of outcomes fell inside/);
  });

  it("reports an over-confident interval as badly calibrated", () => {
    // A "90% interval" containing 40% of outcomes is not a 90% interval.
    const predictions = [
      ...Array.from({ length: 4 }, () => ({ low: 0, high: 10, actual: 5 })),
      ...Array.from({ length: 6 }, () => ({ low: 0, high: 10, actual: 50 })),
    ];
    const result = measureCalibration({ predictions, nominalCoverage: 0.9 });
    expect(result.observedCoverage).toBeCloseTo(0.4, 6);
    expect(result.wellCalibrated).toBe(false);
  });

  it("handles having no predictions to measure", () => {
    const result = measureCalibration({ predictions: [], nominalCoverage: 0.9 });
    expect(result.observedCoverage).toBeNull();
    expect(result.wellCalibrated).toBe(false);
  });
});
