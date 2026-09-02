import { describe, expect, it } from "vitest";
import {
  VehicleStateSchema,
  type ScheduledJourney,
  type VehicleObservation,
} from "@busstops/contracts";
import {
  assessMotion,
  buildVehicleState,
  computeDelaySeconds,
  computeStopProgress,
  matchObservation,
  scoreCandidate,
  type PatternGeometry,
} from "./match-vehicle.js";

/**
 * A straight north-bound route with three stops, 1km apart, so distances are easy to reason
 * about: 0.009 degrees of latitude is almost exactly 1km.
 */
const northboundShape = [
  { lat: 53.79, lon: -1.55 },
  { lat: 53.799, lon: -1.55 },
  { lat: 53.808, lon: -1.55 },
];

const northbound: PatternGeometry = {
  pattern: {
    id: "00000000-0000-5000-8000-00000000aaa1",
    provenance: { source: "bods", retrievedAt: "2026-09-02T08:00:00.000Z", externalIds: [] },
    ingestedAt: "2026-09-02T08:00:00.000Z",
    qualityFlags: [],
    serviceRouteId: "00000000-0000-5000-8000-00000000bbb1",
    direction: "outbound",
    stopSequence: [
      "00000000-0000-5000-8000-00000000ccc1",
      "00000000-0000-5000-8000-00000000ccc2",
      "00000000-0000-5000-8000-00000000ccc3",
    ],
    shapeRef: "pattern:north",
    distanceMetres: 2000,
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
  },
  shape: northboundShape,
  stopDistancesMetres: [0, 1000, 2000],
};

/** The same road in the opposite direction: geometrically identical, directionally wrong. */
const southbound: PatternGeometry = {
  ...northbound,
  pattern: {
    ...northbound.pattern,
    id: "00000000-0000-5000-8000-00000000aaa2",
    direction: "inbound",
  },
  shape: [...northboundShape].reverse(),
};

/** A parallel road 300m east, which nearest-line matching alone could confuse. */
const parallel: PatternGeometry = {
  ...northbound,
  pattern: { ...northbound.pattern, id: "00000000-0000-5000-8000-00000000aaa3" },
  shape: northboundShape.map((c) => ({ ...c, lon: c.lon + 0.0046 })),
};

function observation(overrides: Partial<VehicleObservation> = {}): VehicleObservation {
  return {
    id: "00000000-0000-5000-8000-00000000dddd",
    provenance: { source: "bods", retrievedAt: "2026-09-02T08:00:00.000Z", externalIds: [] },
    ingestedAt: "2026-09-02T08:00:00.000Z",
    qualityFlags: [],
    vehicleRef: "abc123",
    coordinate: { lat: 53.7945, lon: -1.55 },
    bearingDegrees: 0,
    observedAt: "2026-09-02T08:00:00.000Z",
    ...overrides,
  };
}

describe("scoreCandidate", () => {
  it("scores a vehicle on the line, heading the right way, highly", () => {
    const candidate = scoreCandidate(observation(), northbound)!;
    expect(candidate.score).toBeGreaterThan(0.6);
    expect(candidate.distanceMetres).toBeLessThan(5);
  });

  it("rejects a vehicle heading the opposite way along the same geometry", () => {
    // This is the case nearest-line matching gets wrong: same road, wrong direction.
    expect(scoreCandidate(observation({ bearingDegrees: 180 }), northbound)).toBeNull();
  });

  it("rejects a vehicle too far from the route", () => {
    expect(
      scoreCandidate(observation({ coordinate: { lat: 53.7945, lon: -1.56 } }), northbound),
    ).toBeNull();
  });

  it("still scores an observation with no bearing, without inventing direction agreement", () => {
    const withBearing = scoreCandidate(observation(), northbound)!;
    const withoutBearing = scoreCandidate(observation({ bearingDegrees: undefined }), northbound)!;
    expect(withoutBearing.bearingDifferenceDegrees).toBeNull();
    expect(withoutBearing.score).toBeLessThan(withBearing.score);
    expect(withoutBearing.reasons.join(" ")).toMatch(/no bearing/);
  });

  it("rewards forward progress along the pattern it was already on", () => {
    const continuing = scoreCandidate(observation(), northbound, {
      previousPatternId: northbound.pattern.id,
      previousAlongPathMetres: 100,
    })!;
    const fresh = scoreCandidate(observation(), northbound)!;
    expect(continuing.score).toBeGreaterThan(fresh.score);
  });

  it("penalises a match that would require moving backwards", () => {
    const backwards = scoreCandidate(observation(), northbound, {
      previousPatternId: northbound.pattern.id,
      previousAlongPathMetres: 1800,
    })!;
    expect(backwards.reasons.join(" ")).toMatch(/backwards/);
    expect(backwards.score).toBeLessThan(scoreCandidate(observation(), northbound)!.score);
  });

  it("returns null for a pattern with no usable geometry", () => {
    expect(scoreCandidate(observation(), { ...northbound, shape: [] })).toBeNull();
  });
});

describe("matchObservation", () => {
  it("picks the correctly-directed pattern over its opposite", () => {
    const result = matchObservation(observation(), [southbound, northbound]);
    expect(result.best?.patternId).toBe(northbound.pattern.id);
    expect(result.confidence.level).not.toBe("low");
  });

  it("prefers the route the vehicle is actually on over a parallel one", () => {
    const result = matchObservation(observation(), [parallel, northbound]);
    expect(result.best?.patternId).toBe(northbound.pattern.id);
  });

  it("reduces confidence when two candidates are nearly indistinguishable", () => {
    // Two identical geometries: the matcher cannot honestly claim to know which.
    const twin = {
      ...northbound,
      pattern: { ...northbound.pattern, id: "00000000-0000-5000-8000-00000000aaa4" },
    };
    const ambiguous = matchObservation(observation(), [northbound, twin]);
    const unambiguous = matchObservation(observation(), [northbound]);
    expect(ambiguous.confidence.score).toBeLessThan(unambiguous.confidence.score);
    expect(ambiguous.confidence.reasons.join(" ")).toMatch(/almost as well/);
  });

  it("returns no match, with a reason, when nothing is plausible", () => {
    const result = matchObservation(observation({ coordinate: { lat: 51.5, lon: -0.12 } }), [
      northbound,
    ]);
    expect(result.best).toBeNull();
    expect(result.confidence.level).toBe("low");
    expect(result.confidence.reasons.join(" ")).toMatch(/no route within plausible/);
  });

  it("handles an empty candidate set", () => {
    expect(matchObservation(observation(), []).best).toBeNull();
  });
});

describe("assessMotion", () => {
  const base = observation();

  it("reports unknown with only one observation", () => {
    expect(assessMotion(null, base).motionState).toBe("unknown");
  });

  it("reports stationary inside the GPS noise radius without asserting why", () => {
    const later = observation({
      coordinate: { lat: 53.79451, lon: -1.55 },
      observedAt: "2026-09-02T08:01:00.000Z",
    });
    const motion = assessMotion(base, later);
    expect(motion.motionState).toBe("stationary");
    // Deliberately no claim of breakdown, layover or congestion.
    expect(motion.reason).toMatch(/noise radius/);
    expect(motion.reason).not.toMatch(/broken|breakdown|cancelled/i);
  });

  it("reports moving when the vehicle has genuinely travelled", () => {
    const later = observation({
      coordinate: { lat: 53.8, lon: -1.55 },
      observedAt: "2026-09-02T08:01:00.000Z",
    });
    const motion = assessMotion(base, later);
    expect(motion.motionState).toBe("moving");
    expect(motion.speedMetresPerSecond!).toBeGreaterThan(5);
  });

  it("reports unknown when the observations are too close in time", () => {
    const later = observation({ observedAt: "2026-09-02T08:00:02.000Z" });
    expect(assessMotion(base, later).motionState).toBe("unknown");
  });
});

describe("computeStopProgress", () => {
  it("identifies the next stop and those already passed", () => {
    const progress = computeStopProgress(1200, [0, 1000, 2000]);
    expect(progress.passedStopIndices).toEqual([0, 1]);
    expect(progress.nextStopIndex).toBe(2);
    expect(progress.metresToNextStop).toBe(800);
  });

  it("handles a vehicle before the first stop", () => {
    const progress = computeStopProgress(0, [0, 1000]);
    expect(progress.nextStopIndex).toBe(1);
  });

  it("returns no next stop once past the last one", () => {
    const progress = computeStopProgress(2500, [0, 1000, 2000]);
    expect(progress.nextStopIndex).toBeNull();
    expect(progress.metresToNextStop).toBeNull();
  });
});

describe("computeDelaySeconds", () => {
  const journey: ScheduledJourney = {
    id: "00000000-0000-5000-8000-00000000eeee",
    provenance: { source: "bods", retrievedAt: "2026-09-02T08:00:00.000Z", externalIds: [] },
    ingestedAt: "2026-09-02T08:00:00.000Z",
    qualityFlags: [],
    routePatternId: northbound.pattern.id,
    serviceDate: "2026-09-02",
    tripId: "VJ1",
    state: "scheduled",
    stopTimes: [
      {
        stopId: northbound.pattern.stopSequence[0]!,
        sequence: 1,
        scheduledDeparture: "2026-09-02T08:00:00.000Z",
        isTimingPoint: true,
        pickupAllowed: true,
        dropOffAllowed: false,
      },
      {
        stopId: northbound.pattern.stopSequence[1]!,
        sequence: 2,
        scheduledArrival: "2026-09-02T08:10:00.000Z",
        scheduledDeparture: "2026-09-02T08:10:00.000Z",
        isTimingPoint: false,
        pickupAllowed: true,
        dropOffAllowed: true,
      },
      {
        stopId: northbound.pattern.stopSequence[2]!,
        sequence: 3,
        scheduledArrival: "2026-09-02T08:20:00.000Z",
        scheduledDeparture: "2026-09-02T08:20:00.000Z",
        isTimingPoint: true,
        pickupAllowed: false,
        dropOffAllowed: true,
      },
    ],
  };

  it("reports zero delay for a vehicle exactly on schedule mid-segment", () => {
    // Halfway between stop 1 and stop 2 at 08:05 is exactly on time.
    const progress = computeStopProgress(500, northbound.stopDistancesMetres);
    const delay = computeDelaySeconds(
      journey,
      progress,
      "2026-09-02T08:05:00.000Z",
      northbound.stopDistancesMetres,
      500,
    );
    expect(delay).toBe(0);
  });

  it("reports a positive delay when running late", () => {
    const progress = computeStopProgress(500, northbound.stopDistancesMetres);
    const delay = computeDelaySeconds(
      journey,
      progress,
      "2026-09-02T08:08:00.000Z",
      northbound.stopDistancesMetres,
      500,
    )!;
    expect(delay).toBe(180);
  });

  it("reports a negative delay when running early", () => {
    const progress = computeStopProgress(500, northbound.stopDistancesMetres);
    const delay = computeDelaySeconds(
      journey,
      progress,
      "2026-09-02T08:03:00.000Z",
      northbound.stopDistancesMetres,
      500,
    )!;
    expect(delay).toBe(-120);
  });

  it("returns null once the journey has no next stop", () => {
    const progress = computeStopProgress(2500, northbound.stopDistancesMetres);
    expect(
      computeDelaySeconds(
        journey,
        progress,
        "2026-09-02T08:25:00.000Z",
        northbound.stopDistancesMetres,
        2500,
      ),
    ).toBeNull();
  });
});

describe("buildVehicleState", () => {
  it("assembles a contract-valid state carrying confidence and freshness", () => {
    const current = observation();
    const match = matchObservation(current, [northbound]);
    const state = buildVehicleState({
      observation: current,
      previousObservation: null,
      match,
      geometry: northbound,
      journey: null,
      now: new Date("2026-09-02T08:00:30Z"),
    });

    const parsed = VehicleStateSchema.safeParse(state);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(state.freshnessSeconds).toBe(30);
    expect(state.matchedRoutePatternId).toBe(northbound.pattern.id);
    expect(state.nextStopId).toBe(northbound.pattern.stopSequence[1]);
  });

  it("publishes an unmatched vehicle rather than hiding it, with null delay", () => {
    const current = observation({ coordinate: { lat: 51.5, lon: -0.12 } });
    const state = buildVehicleState({
      observation: current,
      previousObservation: null,
      match: matchObservation(current, [northbound]),
      geometry: null,
      journey: null,
      now: new Date("2026-09-02T08:00:10Z"),
    });

    expect(state.matchedRoutePatternId).toBeNull();
    expect(state.delaySeconds).toBeNull();
    expect(state.matchConfidence.level).toBe("low");
  });
});
