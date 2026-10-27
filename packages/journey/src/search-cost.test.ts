import { describe, expect, it } from "vitest";
import { buildGraph, type JourneyStop, type Trip } from "./graph.js";
import { newSearchCounters, runRaptor } from "./raptor.js";
import { bruteForceEarliestArrival } from "./brute-force.js";

/**
 * What the search no longer does, pinned so a regression is visible.
 *
 * Cloudflare classifies this Worker's journey failures as `exceededCpu` against a ten-millisecond
 * limit, and profiling the real planner over real corridors found the reason was not the algorithm
 * — which is RAPTOR-shaped, the right family for scheduled transport — but how much it allocated
 * to decide nothing. A Manchester corridor measured:
 *
 * | Counter                        |     Count |
 * | ------------------------------ | --------: |
 * | labels offered                 | 6,510,009 |
 * | labels accepted                |    24,105 |
 * | accept rate                    |     0.004 |
 * | `effectiveStopTimes` calls     |   885,340 |
 * | trips scanned                  |   442,670 |
 *
 * So thirteen million objects — a `StopLabel` and a nested `leg` each — were built and discarded
 * per plan, and the effective stop times of every trip were computed twice. Both are now done
 * once, and neither changes an answer: the acceptance test is the same test on the same numbers,
 * only asked before anything is built.
 *
 * These assert the counts rather than a duration. A millisecond threshold on a CI runner would be
 * a number pinned to somebody else's hardware; a call count is a property of the code.
 */

/** A small line of stops a bus runs along, with a second line crossing it for transfers. */
function network(options: { delaySeconds?: number; cancelled?: boolean } = {}) {
  const stops: JourneyStop[] = Array.from({ length: 8 }, (_, i) => ({
    id: `s${String(i)}`,
    name: `Stop ${String(i)}`,
    /* Far enough apart that walking transfers exist but do not connect everything. */
    coordinate: { lat: 53.8 + i * 0.004, lon: -1.55 },
  }));

  const trip = (id: string, stopIds: string[], startSeconds: number): Trip =>
    ({
      id,
      routeId: id.slice(0, 2),
      stopTimes: stopIds.map((stopId, i) => ({
        stopId,
        arrivalSeconds: startSeconds + i * 120,
        departureSeconds: startSeconds + i * 120,
      })),
      ...(options.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }),
      ...(options.cancelled === true ? { cancelled: true } : {}),
    }) as unknown as Trip;

  const trips = [
    trip("r1-a", ["s0", "s1", "s2", "s3"], 9 * 3600),
    trip("r1-b", ["s0", "s1", "s2", "s3"], 9 * 3600 + 600),
    trip("r2-a", ["s3", "s4", "s5", "s6", "s7"], 9 * 3600 + 500),
    trip("r2-b", ["s3", "s4", "s5", "s6", "s7"], 9 * 3600 + 1_100),
  ];

  return { graph: buildGraph({ stops, trips }), stops, trips };
}

const DEPART = 9 * 3600;

describe("what the search allocates", () => {
  it("computes a trip's effective stop times once per scan, not twice", () => {
    const { graph } = network();
    const counters = newSearchCounters();
    runRaptor(graph, [{ stopId: "s0", accessSeconds: 0 }], { departAtSeconds: DEPART }, counters);

    expect(counters.tripScans).toBeGreaterThan(0);
    expect(counters.effectiveStopTimesCalls, "one call per trip scanned; it used to be two").toBe(
      counters.tripScans,
    );
  });

  it("still computes them once when a trip carries a live delay", () => {
    /*
     * The case that made the doubling expensive rather than merely wasteful: for a delayed trip
     * `effectiveStopTimes` allocates a fresh array of stop-time objects rather than returning the
     * published one.
     */
    const { graph } = network({ delaySeconds: 180 });
    const counters = newSearchCounters();
    runRaptor(graph, [{ stopId: "s0", accessSeconds: 0 }], { departAtSeconds: DEPART }, counters);
    expect(counters.effectiveStopTimesCalls).toBe(counters.tripScans);
  });

  it("offers labels without building the ones it rejects", () => {
    const { graph } = network();
    const counters = newSearchCounters();
    runRaptor(graph, [{ stopId: "s0", accessSeconds: 0 }], { departAtSeconds: DEPART }, counters);

    /*
     * The counters still record every offer, which is the point: the rejected ones are counted and
     * not constructed. A build-then-test implementation would show the same counts, so this pins
     * the ratio the profile found rather than the mechanism — and the mechanism is pinned by the
     * brute-force agreement below, which is what a wrong laziness would break.
     */
    expect(counters.improveCalls).toBeGreaterThan(counters.improveAccepted);
    expect(counters.improveAccepted).toBeGreaterThan(0);
  });
});

describe("and that it still finds the right journey", () => {
  const cases = [
    { name: "a direct ride", from: "s0", to: "s3" },
    { name: "one change", from: "s0", to: "s7" },
    { name: "boarding later on the same line", from: "s1", to: "s5" },
  ] as const;

  for (const scenario of cases) {
    it(`matches the exhaustive reference for ${scenario.name}`, () => {
      const { graph } = network();
      const origins = [{ stopId: scenario.from, accessSeconds: 0 }];
      const destinations = [{ stopId: scenario.to, egressSeconds: 0 }];

      const result = runRaptor(graph, origins, { departAtSeconds: DEPART, maxRounds: 4 });
      const label = result.best.get(scenario.to);
      const reference = bruteForceEarliestArrival(graph, origins, destinations, DEPART, 4);

      expect(reference, "the reference must find something, or this proves nothing").not.toBeNull();
      expect(label, scenario.name).toBeDefined();
      expect(label!.arrivalSeconds).toBe(reference!.arrivalSeconds);
    });
  }

  it("agrees that a cancelled trip is not boardable", () => {
    const { graph } = network({ cancelled: true });
    const result = runRaptor(graph, [{ stopId: "s0", accessSeconds: 0 }], {
      departAtSeconds: DEPART,
      maxRounds: 4,
    });
    /*
     * Walking still reaches the nearer stops, so the assertion is about riding: no label may carry
     * a boarding leg when every trip is cancelled. "No data" and "confirmed not running" must not
     * be blurred, and the cancellation check moved when the stop times stopped being computed
     * twice.
     */
    for (const label of result.best.values()) {
      expect(label.leg?.kind ?? "none").not.toBe("board");
    }
  });

  it("applies a live delay to the arrival it reports", () => {
    const onTime = runRaptor(network().graph, [{ stopId: "s0", accessSeconds: 0 }], {
      departAtSeconds: DEPART,
      maxRounds: 4,
    }).best.get("s3");
    const delayed = runRaptor(
      network({ delaySeconds: 300 }).graph,
      [{ stopId: "s0", accessSeconds: 0 }],
      { departAtSeconds: DEPART, maxRounds: 4 },
    ).best.get("s3");

    expect(onTime).toBeDefined();
    expect(delayed).toBeDefined();
    expect(delayed!.arrivalSeconds).toBe(onTime!.arrivalSeconds + 300);
  });
});
