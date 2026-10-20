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
  stopsAheadWindow,
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

/**
 * Which stops are actually ahead of the bus.
 *
 * The defect these exist for: `/v1/vehicles/:ref` answered with `stopSequence.slice(0, 40)` and
 * every entry `passed: false`, so a bus halfway along its route was shown the stops it had left
 * behind as the stops it was about to call at. The projection and the stop offsets were both
 * already computed; nothing had ever put them together.
 *
 * Six stops a kilometre apart, which makes every expectation arithmetic rather than judgement.
 */
describe("stops ahead of a bus", () => {
  /** A → B → C → D → E → F, 1km apart. */
  const sixStops = [0, 1000, 2000, 3000, 4000, 5000];
  const NAMES = ["A", "B", "C", "D", "E", "F"];
  const named = (window: { indices: number[] }) => window.indices.map((index) => NAMES[index]);

  /*
   * The headline case from the brief. The bus is between C and D, so what is ahead is D, E, F —
   * not A, B, C, and not all six.
   */
  it("starts at the next stop when the bus is between C and D", () => {
    const window = stopsAheadWindow(2500, sixStops);

    expect(window.state).toBe("ahead");
    expect(window.nextStopIndex).toBe(3);
    // D is the next stop, and E and F follow it in timetable order.
    const ahead = window.indices.filter((index) => index >= window.nextStopIndex!);
    expect(ahead.map((index) => NAMES[index])).toEqual(["D", "E", "F"]);
    // A is not in the window at all: three stops of context, so it begins at B.
    expect(named(window)).toEqual(["A", "B", "C", "D", "E", "F"].slice(0, 6));
  });

  it("never offers the beginning of the route as what is coming next", () => {
    const window = stopsAheadWindow(4200, sixStops);
    const ahead = window.indices.filter((index) => index >= window.nextStopIndex!);
    expect(ahead.map((index) => NAMES[index])).toEqual(["F"]);
    expect(ahead.map((index) => NAMES[index])).not.toContain("A");
  });

  /* Context behind the bus is deliberate, and bounded, so "passed" has something to subdue. */
  it("includes a little of what the bus has just come from", () => {
    const window = stopsAheadWindow(4200, sixStops, { passedContext: 2 });
    expect(named(window)).toEqual(["D", "E", "F"]);
    expect(window.nextStopIndex).toBe(5);
  });

  it("keeps the window bounded however long the route is", () => {
    const long = Array.from({ length: 300 }, (_, index) => index * 500);
    const window = stopsAheadWindow(60_000, long, { limit: 40 });
    expect(window.indices.length).toBe(40);
    // And it is a window around the bus, not the first forty stops of the route.
    expect(window.indices[0]).toBeGreaterThan(100);
  });

  it("says the bus has finished rather than showing an empty list", () => {
    const window = stopsAheadWindow(5200, sixStops);
    expect(window.state).toBe("end_of_route");
    expect(window.nextStopIndex).toBeNull();
    // The last stops are still named, so the panel can say where it ended.
    expect(named(window)).toEqual(["D", "E", "F"]);
  });

  it("treats a bus before its first stop as having the whole route ahead", () => {
    const window = stopsAheadWindow(0, [100, 1000, 2000]);
    expect(window.state).toBe("ahead");
    expect(window.nextStopIndex).toBe(0);
    expect(window.indices).toEqual([0, 1, 2]);
  });

  /*
   * A pattern with no stop offsets is a pattern we cannot place the bus on. That is a different
   * answer from "no more stops", and the caller renders a different sentence for it.
   */
  it("refuses to guess when there are no stop offsets", () => {
    const window = stopsAheadWindow(2500, []);
    expect(window.state).toBe("progress_unknown");
    expect(window.indices).toEqual([]);
  });

  it("refuses to guess when the projection is not a number", () => {
    expect(stopsAheadWindow(Number.NaN, sixStops).state).toBe("progress_unknown");
    expect(stopsAheadWindow(Number.POSITIVE_INFINITY, sixStops).state).toBe("progress_unknown");
  });

  /*
   * Never reverse a route accidentally. `computeStopProgress` walks the offsets and breaks at the
   * first one beyond the bus, so offsets that dip backwards would report the dip as "next" and
   * everything after it as unvisited — a route shown in the wrong order.
   */
  it("refuses to guess when the stop offsets go backwards", () => {
    const window = stopsAheadWindow(2500, [0, 1000, 2000, 1500, 4000]);
    expect(window.state).toBe("progress_unknown");
    expect(window.indices).toEqual([]);
  });

  /*
   * A stop with no coordinate gets the previous stop's offset from the publisher, so two stops
   * share a distance. Both are correctly behind a bus past them; the order is still the
   * timetable's, which is the thing that must not break.
   */
  it("handles a stop whose coordinate was missing when the artifact was built", () => {
    // D had no coordinate, so it carries C's offset.
    const window = stopsAheadWindow(2500, [0, 1000, 2000, 2000, 4000, 5000]);
    expect(window.state).toBe("ahead");
    expect(window.nextStopIndex).toBe(4);
    expect(window.indices).toEqual([1, 2, 3, 4, 5]);
  });

  /*
   * A circular route's offsets still rise monotonically along its shape, so a bus three quarters
   * of the way round is three quarters of the way through its stop list — the fact that the last
   * stop is next to the first changes nothing about the order.
   */
  it("follows a circular route round rather than back to its start", () => {
    const circle = [0, 800, 1600, 2400, 3200, 4000];
    const window = stopsAheadWindow(3300, circle);
    expect(window.nextStopIndex).toBe(5);
    const ahead = window.indices.filter((index) => index >= window.nextStopIndex!);
    expect(ahead).toEqual([5]);
  });
});
