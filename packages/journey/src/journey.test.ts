import { describe, expect, it } from "vitest";
import {
  buildGraph,
  bruteForceEarliestArrival,
  candidateStops,
  explainBoardingStop,
  plan,
  runRaptor,
  bestArrival,
  walkSeconds,
  type JourneyStop,
  type Trip,
} from "./index.js";

/**
 * A small deliberately awkward network around Leeds:
 *
 *   A (origin area) --- route 1 (slow, direct) ------------------> D (destination area)
 *   B (5 min walk from origin) --- route 2 (fast, direct) ------> D
 *   C --- route 3 --> E --- route 4 --> D   (two changes)
 *
 * Route 2 departs from the further stop but arrives earlier, which is exactly the
 * nearest-is-not-fastest case the product has to get right.
 */

const HOUR = 3600;
const MIN = 60;

const stops: JourneyStop[] = [
  { id: "A", name: "Boar Lane", coordinate: { lat: 53.7946, lon: -1.5419 } },
  { id: "B", name: "City Square", coordinate: { lat: 53.7955, lon: -1.5478 } },
  { id: "C", name: "Wellington Street", coordinate: { lat: 53.7962, lon: -1.5512 } },
  { id: "D", name: "Armley Road", coordinate: { lat: 53.8115, lon: -1.6205 } },
  { id: "E", name: "Kirkstall Road", coordinate: { lat: 53.8221, lon: -1.6602 } },
];

const origin = { lat: 53.7944, lon: -1.5415 }; // right next to A
const destination = { lat: 53.8117, lon: -1.6207 }; // right next to D, ~5km from the origin

function trip(
  id: string,
  routeName: string,
  entries: Array<[string, number]>,
  overrides: Partial<Trip> = {},
): Trip {
  return {
    id,
    routeId: `route-${routeName}`,
    patternId: `pattern-${routeName}`,
    routeName,
    headsign: "Test",
    stopTimes: entries.map(([stopId, seconds]) => ({
      stopId,
      arrivalSeconds: seconds,
      departureSeconds: seconds,
    })),
    ...overrides,
  };
}

const departAt = 8 * HOUR;

const trips: Trip[] = [
  // Slow direct from A: leaves promptly but takes 30 minutes.
  trip("t1", "1", [
    ["A", departAt + 2 * MIN],
    ["D", departAt + 32 * MIN],
  ]),
  // Fast direct from B: leaves later but arrives well before route 1.
  trip("t2", "2", [
    ["B", departAt + 9 * MIN],
    ["D", departAt + 19 * MIN],
  ]),
  // Two-leg option via E.
  trip("t3", "3", [
    ["C", departAt + 5 * MIN],
    ["E", departAt + 12 * MIN],
  ]),
  trip("t4", "4", [
    ["E", departAt + 16 * MIN],
    ["D", departAt + 24 * MIN],
  ]),
];

const graph = buildGraph({ stops, trips, maxTransferSeconds: 600 });

describe("graph construction", () => {
  it("indexes trips by stop", () => {
    expect(graph.tripsByStop.get("A")?.map((t) => t.id)).toEqual(["t1"]);
    expect(
      graph.tripsByStop
        .get("D")
        ?.map((t) => t.id)
        .sort(),
    ).toEqual(["t1", "t2", "t4"]);
  });

  it("creates walking transfers only within range", () => {
    const fromA = graph.transfers.get("A") ?? [];
    expect(fromA.some((t) => t.toStopId === "B")).toBe(true);
    // A to E is over a kilometre, beyond the 10-minute transfer cap.
    expect(fromA.some((t) => t.toStopId === "E")).toBe(false);
  });

  it("computes walking time from distance at a plausible pace", () => {
    const seconds = walkSeconds(stops[0]!.coordinate, stops[1]!.coordinate);
    expect(seconds).toBeGreaterThan(200);
    expect(seconds).toBeLessThan(500);
  });
});

describe("candidate stops", () => {
  it("ranks by walking time, not crow-flight ordering alone", () => {
    const candidates = candidateStops(graph, origin, 900, 5);
    expect(candidates[0]?.stop.id).toBe("A");
    const walkTimes = candidates.map((c) => c.walkSeconds);
    expect(walkTimes).toEqual([...walkTimes].sort((a, b) => a - b));
  });

  it("caps the candidate set", () => {
    expect(candidateStops(graph, origin, 3600, 2)).toHaveLength(2);
  });

  it("expands rather than returning nothing when no stop is in range", () => {
    const candidates = candidateStops(graph, { lat: 53.9, lon: -1.9 }, 60, 5);
    expect(candidates.length).toBeGreaterThan(0);
  });
});

describe("RAPTOR search", () => {
  const origins = [
    { stopId: "A", accessSeconds: 30 },
    { stopId: "B", accessSeconds: 300 },
    { stopId: "C", accessSeconds: 500 },
  ];
  const destinations = [{ stopId: "D", egressSeconds: 30 }];

  it("finds the earliest arrival at the destination", () => {
    const result = runRaptor(graph, origins, { departAtSeconds: departAt });
    const arrival = bestArrival(result.best, destinations)!;
    // Route 2 from B arrives at 08:19 plus 30s walk.
    expect(arrival.arrivalSeconds).toBe(departAt + 19 * MIN + 30);
  });

  it("agrees with brute force on the earliest arrival", () => {
    const raptor = runRaptor(graph, origins, { departAtSeconds: departAt });
    const raptorArrival = bestArrival(raptor.best, destinations)!;
    const brute = bruteForceEarliestArrival(graph, origins, destinations, departAt, 3)!;

    expect(raptorArrival.arrivalSeconds).toBe(brute.arrivalSeconds);
  });

  it("agrees with brute force across many random timetables", () => {
    // A single hand-built case can be passed by an algorithm that is wrong in general.
    let comparisons = 0;

    for (let seed = 0; seed < 40; seed++) {
      const random = mulberry32(seed);
      const randomTrips: Trip[] = [];

      for (let t = 0; t < 6; t++) {
        const from = stops[Math.floor(random() * stops.length)]!;
        let to = stops[Math.floor(random() * stops.length)]!;
        if (to.id === from.id) to = stops[(stops.indexOf(from) + 1) % stops.length]!;

        const departure = departAt + Math.floor(random() * 30) * MIN;
        const duration = (2 + Math.floor(random() * 20)) * MIN;
        randomTrips.push(
          trip(`r${seed}-${t}`, `R${t}`, [
            [from.id, departure],
            [to.id, departure + duration],
          ]),
        );
      }

      const randomGraph = buildGraph({ stops, trips: randomTrips, maxTransferSeconds: 600 });
      const raptor = runRaptor(randomGraph, origins, { departAtSeconds: departAt, maxRounds: 3 });
      const raptorArrival = bestArrival(raptor.best, destinations);
      const brute = bruteForceEarliestArrival(randomGraph, origins, destinations, departAt, 3);

      if (brute === null) {
        expect(raptorArrival).toBeNull();
      } else {
        expect(raptorArrival).not.toBeNull();
        expect(raptorArrival!.arrivalSeconds).toBe(brute.arrivalSeconds);
        comparisons += 1;
      }
    }

    expect(comparisons).toBeGreaterThan(5);
  });

  it("never boards a cancelled trip", () => {
    const cancelledGraph = buildGraph({
      stops,
      trips: trips.map((t) => (t.id === "t2" ? { ...t, cancelled: true } : t)),
      maxTransferSeconds: 600,
    });
    // C gets a zero access walk here so the two-leg alternative is genuinely boardable: with
    // the 500s walk used elsewhere, route 3's 08:05 departure has already gone.
    const reachableOrigins = [
      { stopId: "A", accessSeconds: 30 },
      { stopId: "C", accessSeconds: 0 },
    ];

    const withRoute2 = runRaptor(graph, reachableOrigins, { departAtSeconds: departAt });
    const cancelled = runRaptor(cancelledGraph, reachableOrigins, { departAtSeconds: departAt });

    // Route 2 is reachable by walking C to B, so it wins until it is cancelled.
    expect(bestArrival(withRoute2.best, destinations)!.arrivalSeconds).toBe(
      departAt + 19 * MIN + 30,
    );
    // With it cancelled, the two-leg option via E is the best remaining answer.
    expect(bestArrival(cancelled.best, destinations)!.arrivalSeconds).toBe(
      departAt + 24 * MIN + 30,
    );
  });

  it("applies live delay to the journeys it plans around", () => {
    const delayedGraph = buildGraph({
      stops,
      trips: trips.map((t) => (t.id === "t2" ? { ...t, delaySeconds: 15 * MIN } : t)),
      maxTransferSeconds: 600,
    });
    const result = runRaptor(delayedGraph, origins, { departAtSeconds: departAt });
    const arrival = bestArrival(result.best, destinations)!;
    // Route 2 delayed by 15 minutes is no longer the winner.
    expect(arrival.arrivalSeconds).toBeLessThan(departAt + 34 * MIN);
  });

  it("returns nothing reachable when every service has already gone", () => {
    const result = runRaptor(graph, origins, { departAtSeconds: departAt + 2 * HOUR });
    expect(bestArrival(result.best, destinations)).toBeNull();
  });

  it("respects the interchange buffer between two boardings", () => {
    // Only the two-leg route, so the buffer is what decides the outcome rather than the direct
    // service being reachable by walking to another stop.
    const twoLegOnly = buildGraph({
      stops,
      trips: trips.filter((t) => t.id === "t3" || t.id === "t4"),
      maxTransferSeconds: 600,
    });

    // Route 3 arrives at E at 08:12; route 4 leaves at 08:16, inside a 5-minute interchange.
    const strict = runRaptor(twoLegOnly, [{ stopId: "C", accessSeconds: 0 }], {
      departAtSeconds: departAt,
      minTransferSeconds: 5 * MIN,
    });
    expect(bestArrival(strict.best, destinations)).toBeNull();

    const relaxed = runRaptor(twoLegOnly, [{ stopId: "C", accessSeconds: 0 }], {
      departAtSeconds: departAt,
      minTransferSeconds: 2 * MIN,
    });
    expect(bestArrival(relaxed.best, destinations)).not.toBeNull();
  });
});

describe("plan", () => {
  const request = { origin, destination, departAtSeconds: departAt };

  it("returns at least a fastest option", () => {
    const result = plan(graph, request);
    expect(result.options.length).toBeGreaterThan(0);
    expect(result.options[0]?.ranking).toBe("fastest");
  });

  it("boards the faster stop even though it is not the nearest", () => {
    const result = plan(graph, request);
    expect(result.options[0]?.boardingStopId).toBe("B");
  });

  it("explains why the further stop wins, in plain language with a real saving", () => {
    const result = plan(graph, request);
    expect(result.explanation).toMatch(/City Square is a \d+ minute walk/);
    expect(result.explanation).toMatch(/expected sooner/);
    expect(result.explanation).toMatch(/earlier than Boar Lane/);
  });

  it("stays silent when the difference is inside the uncertainty", () => {
    // Make both routes arrive within a minute of each other.
    const closeGraph = buildGraph({
      stops,
      trips: trips.map((t) =>
        t.id === "t1"
          ? trip("t1", "1", [
              ["A", departAt + 2 * MIN],
              ["D", departAt + 20 * MIN],
            ])
          : t,
      ),
      maxTransferSeconds: 600,
    });

    const result = plan(closeGraph, request);
    expect(result.explanation).toMatch(/within the uncertainty/);
  });

  it("builds walking legs at each end", () => {
    const result = plan(graph, request);
    const legs = result.options[0]!.legs;
    expect(legs[0]?.mode).toBe("walk");
    expect(legs[legs.length - 1]?.mode).toBe("walk");
    expect(legs.some((leg) => leg.mode === "bus")).toBe(true);
  });

  it("reports the arrival as an interval, not a single time", () => {
    const option = plan(graph, request).options[0]!;
    expect(option.arrivalLowSeconds).toBeLessThan(option.arrivalSeconds);
    expect(option.arrivalHighSeconds).toBeGreaterThan(option.arrivalSeconds);
  });

  it("does not add the reliability penalty into the arrival estimate", () => {
    // The penalty is a ranking cost. Adding it to the ETA as well would double-count the risk.
    const option = plan(graph, request).options[0]!;
    expect(option.arrivalSeconds).toBe(
      departAt +
        19 * MIN +
        option.legs.at(-1)!.arrivalSeconds -
        option.legs.at(-1)!.departureSeconds,
    );
  });

  it("lowers confidence when a plan has changes and no live data", () => {
    const direct = plan(graph, request).options[0]!;
    expect(direct.confidence.reasons.join(" ")).toMatch(/timetable/);
    expect(direct.confidence.level).not.toBe("low");
  });

  it("returns no options when the destination is unreachable", () => {
    const result = plan(graph, { ...request, departAtSeconds: departAt + 5 * HOUR });
    expect(result.options).toEqual([]);
    expect(result.explanation).toBeNull();
  });

  it("offers distinct options rather than three copies of the same journey", () => {
    const result = plan(graph, request);
    const signatures = result.options.map(
      (o) => `${o.boardingStopId}:${o.changeCount}:${o.arrivalSeconds}`,
    );
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("handles a map-tapped destination with no stop nearby", () => {
    const result = plan(graph, { ...request, destination: { lat: 53.9, lon: -1.9 } });
    // Either it finds a long walk or it honestly finds nothing; it must not throw.
    expect(Array.isArray(result.options)).toBe(true);
  });
});

describe("explainBoardingStop", () => {
  it("says so when the nearest stop has no useful service at all", () => {
    const noServiceFromA = buildGraph({
      stops,
      // Remove the only service from A, and the footpath that would let A reach another stop.
      trips: trips.filter((t) => t.id !== "t1"),
      maxTransferSeconds: 1,
    });
    const result = plan(noServiceFromA, { origin, destination, departAtSeconds: departAt });
    expect(result.explanation).toMatch(/could not find a useful service from Boar Lane/);
  });

  it("returns nothing to say when the nearest stop is the one being recommended", () => {
    const explanation = explainBoardingStop({
      graph,
      origins: candidateStops(graph, origin, 900, 8),
      winner: {
        ...plan(graph, { origin, destination, departAtSeconds: departAt }).options[0]!,
        boardingStopId: "A",
      },
      nearestArrivalSeconds: departAt + 30 * MIN,
    });
    expect(explanation).toBeNull();
  });
});

/** Small deterministic PRNG so the randomised comparison is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed + 0x6d2b79f5;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
