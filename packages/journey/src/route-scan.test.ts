import { describe, expect, it } from "vitest";
import { bruteForceEarliestArrival } from "./brute-force.js";
import {
  buildGraph,
  buildTransfers,
  groupRoutes,
  walkSeconds,
  type JourneyStop,
  type Trip,
} from "./graph.js";
import { bestArrival, runRaptor } from "./raptor.js";

/**
 * The route scan, against exhaustive enumeration, on timetables built to break it.
 *
 * The search became route-centric to get its cost down: it used to board every trip serving every
 * improved stop and ride each to its end — 442,670 trip scans and 6,510,009 alighting offers for
 * one Manchester plan — and now walks each route once per round, boarding the earliest trip it can
 * catch. That last step is only sound when an earlier departure means an earlier arrival all the
 * way down the route, and the existing brute-force comparison found the counter-example on the
 * first run: two buses on one stop sequence, the later one faster, and boarding the earlier one
 * arrives a minute after the bus a passenger would actually have taken.
 *
 * So the shapes that break it are generated on purpose here rather than hoped for. Forty
 * two-stop trips in a five-stop town, which is what the suite had, exercises none of this: no
 * route has more than one trip, so there is nothing to overtake and nothing to scan past.
 */

const HOUR = 3600;
const MIN = 60;
const departAt = 8 * HOUR;

/** Eight stops close enough together that walking transfers exist between most pairs. */
const stops: JourneyStop[] = [
  { id: "A", name: "A", coordinate: { lat: 53.7946, lon: -1.5419 } },
  { id: "B", name: "B", coordinate: { lat: 53.7955, lon: -1.5478 } },
  { id: "C", name: "C", coordinate: { lat: 53.7962, lon: -1.5512 } },
  { id: "D", name: "D", coordinate: { lat: 53.8005, lon: -1.5605 } },
  { id: "E", name: "E", coordinate: { lat: 53.8061, lon: -1.5712 } },
  { id: "F", name: "F", coordinate: { lat: 53.8115, lon: -1.6205 } },
  { id: "G", name: "G", coordinate: { lat: 53.8221, lon: -1.6602 } },
  { id: "H", name: "H", coordinate: { lat: 53.8155, lon: -1.6402 } },
];

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

interface Generated {
  trips: Trip[];
  /** How many of the stop sequences generated had a bus overtaking another on them. */
  overtakingSequences: number;
}

/**
 * A timetable with several trips to a pattern, uneven running times, and the occasional express.
 *
 * The express is the point: a trip that leaves after another and arrives before it is what makes
 * "board the earliest you can catch" wrong, and it has to occur often enough in the generated
 * cases to be exercised rather than stumbled on.
 */
function timetable(seed: number): Generated {
  const random = mulberry32(seed);
  const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)]!;
  const trips: Trip[] = [];
  let overtakingSequences = 0;

  const patterns = 2 + Math.floor(random() * 4);
  for (let p = 0; p < patterns; p++) {
    /* A random ordered run of stops, sometimes returning to one it has already called at. */
    const length = 3 + Math.floor(random() * 4);
    const sequence: string[] = [];
    while (sequence.length < length) {
      const stop = pick(stops).id;
      if (sequence[sequence.length - 1] === stop) continue;
      sequence.push(stop);
    }

    const tripCount = 2 + Math.floor(random() * 5);
    const headway = (3 + Math.floor(random() * 10)) * MIN;
    const firstDeparture = departAt + Math.floor(random() * 10) * MIN;
    let overtakes = false;

    for (let t = 0; t < tripCount; t++) {
      /*
       * One trip in five runs at between a third and a half of the normal pace, which is what an
       * express or a bus that has caught up looks like in a published timetable.
       */
      const express = random() < 0.2;
      if (express && t > 0) overtakes = true;
      const hopSeconds = express
        ? (1 + Math.floor(random() * 2)) * MIN
        : (3 + Math.floor(random() * 5)) * MIN;
      let clock = firstDeparture + t * headway;
      const stopTimes = sequence.map((stopId, at) => {
        if (at > 0) clock += hopSeconds;
        return { stopId, arrivalSeconds: clock, departureSeconds: clock };
      });
      trips.push({
        id: `s${String(seed)}-p${String(p)}-t${String(t)}`,
        routeId: `route-${String(p)}`,
        patternId: `pattern-${String(p)}`,
        routeName: `R${String(p)}`,
        headsign: "Test",
        stopTimes,
        /* A cancelled trip must be skipped, and a delayed one must shift by exactly its delay. */
        ...(random() < 0.08 ? { cancelled: true } : {}),
        ...(random() < 0.15 ? { delaySeconds: Math.floor(random() * 6) * MIN } : {}),
      });
    }
    if (overtakes) overtakingSequences += 1;
  }

  return { trips, overtakingSequences };
}

const origins = [
  { stopId: "A", accessSeconds: 30 },
  { stopId: "B", accessSeconds: 300 },
  { stopId: "C", accessSeconds: 500 },
];
const destinations = [
  { stopId: "F", egressSeconds: 30 },
  { stopId: "G", egressSeconds: 120 },
];

describe("the route scan against exhaustive enumeration", () => {
  it("finds the same earliest arrival on two hundred generated timetables", () => {
    let compared = 0;
    let withOvertaking = 0;

    for (let seed = 0; seed < 200; seed++) {
      const generated = timetable(seed);
      if (generated.overtakingSequences > 0) withOvertaking += 1;
      /*
       * Every pair of stops joined directly, which is what makes this comparison faithful.
       *
       * The planner's round-zero footpath step re-reads the labels it has just improved, so it
       * can chain walks — stop to stop to stop — and reach further than any single transfer edge.
       * The oracle walks one edge at a time. With a cap, that is a difference in the travel model
       * rather than in the search, and it showed up as both a journey the planner found and the
       * oracle could not, and one the oracle found and the planner could not.
       *
       * An hour's cap over stops three kilometres apart joins all of them, and then chaining can
       * never beat the direct edge, because walking A to B to C is never shorter than walking A
       * to C. The two searches are then enumerating the same journeys and a disagreement is the
       * scan's.
       */
      const graph = buildGraph({
        stops,
        trips: generated.trips,
        maxTransferSeconds: 3600,
      });
      const raptor = runRaptor(graph, origins, { departAtSeconds: departAt, maxRounds: 3 });
      const found = bestArrival(raptor.best, destinations);
      const brute = bruteForceEarliestArrival(graph, origins, destinations, departAt, 3);

      if (brute === null) {
        expect(
          found,
          `seed ${String(seed)} found a journey brute force says is impossible`,
        ).toBeNull();
        continue;
      }
      expect(
        found,
        `seed ${String(seed)} found nothing where brute force found a journey`,
      ).not.toBeNull();
      expect(
        found!.arrivalSeconds,
        `seed ${String(seed)} arrives later than the journey brute force found`,
      ).toBe(brute.arrivalSeconds);
      compared += 1;
    }

    /* The generator has to actually produce the hard cases, or this test proves nothing. */
    expect(compared).toBeGreaterThan(150);
    expect(withOvertaking).toBeGreaterThan(40);
  });

  it("splits a stop sequence whose buses overtake, and keeps every trip", () => {
    const sequence = ["A", "D", "F"];
    const slow = {
      id: "slow",
      routeId: "r",
      patternId: "p",
      routeName: "R",
      headsign: "T",
      stopTimes: sequence.map((stopId, at) => ({
        stopId,
        arrivalSeconds: departAt + at * 12 * MIN,
        departureSeconds: departAt + at * 12 * MIN,
      })),
    };
    const express = {
      ...slow,
      id: "express",
      stopTimes: sequence.map((stopId, at) => ({
        stopId,
        arrivalSeconds: departAt + 5 * MIN + at * 2 * MIN,
        departureSeconds: departAt + 5 * MIN + at * 2 * MIN,
      })),
    };

    const grouped = groupRoutes([slow, express]);
    expect(grouped.routes).toHaveLength(2);
    expect(grouped.routes.flatMap((route) => route.trips.map((trip) => trip.id)).sort()).toEqual([
      "express",
      "slow",
    ]);
    /* Both are reachable from the first stop, which is what the scan queues from. */
    expect(grouped.routesByStop.get("A")).toHaveLength(2);
  });

  it("keeps one route when nothing overtakes, and orders it by departure", () => {
    const sequence = ["A", "D", "F"];
    const at = (minute: number) =>
      sequence.map((stopId, i) => ({
        stopId,
        arrivalSeconds: departAt + (minute + i * 10) * MIN,
        departureSeconds: departAt + (minute + i * 10) * MIN,
      }));
    const later = {
      id: "later",
      routeId: "r",
      patternId: "p",
      routeName: "R",
      headsign: "T",
      stopTimes: at(20),
    };
    const earlier = { ...later, id: "earlier", stopTimes: at(5) };

    const grouped = groupRoutes([later, earlier]);
    expect(grouped.routes).toHaveLength(1);
    expect(grouped.routes[0]!.trips.map((trip) => trip.id)).toEqual(["earlier", "later"]);
    expect(grouped.routes[0]!.stopIds).toEqual(sequence);
  });

  it("files a stop a route calls at twice at both of its positions", () => {
    const loop = {
      id: "loop",
      routeId: "r",
      patternId: "p",
      routeName: "R",
      headsign: "T",
      stopTimes: ["A", "D", "A", "F"].map((stopId, at) => ({
        stopId,
        arrivalSeconds: departAt + at * 6 * MIN,
        departureSeconds: departAt + at * 6 * MIN,
      })),
    };
    const grouped = groupRoutes([loop]);
    expect(grouped.routesByStop.get("A")?.map((entry) => entry.at)).toEqual([0, 2]);
  });

  it("ignores a trip with fewer than two calls, which is not a ride", () => {
    const stub = {
      id: "stub",
      routeId: "r",
      patternId: "p",
      routeName: "R",
      headsign: "T",
      stopTimes: [{ stopId: "A", arrivalSeconds: departAt, departureSeconds: departAt }],
    };
    expect(groupRoutes([stub]).routes).toEqual([]);
  });
});

/**
 * The flag that lets the grouping skip a comparison must never change what it groups.
 *
 * `wholePatternSequence` says a trip's stop times are the pattern's whole sequence, so trips
 * carrying it on one pattern are identical without checking — which for a Manchester corridor
 * saves 238,000 stop-id comparisons. The risk is obvious: a flag that is wrong, or a grouping that
 * treats a flagged trip and an unflagged one with the same sequence as two routes, splits a route
 * in half and halves the buses the search can see on it.
 *
 * So the grouping is run twice over the same generated timetables — once with every trip flagged
 * where the flag is true, once with none of them flagged — and the two have to agree about
 * everything: the routes, their stop sequences, and which trips are on them.
 */
describe("the whole-pattern flag changes nothing about the grouping", () => {
  /** Routes as a comparable shape: sequence, then the trips on it, in order. */
  const shapeOf = (grouped: ReturnType<typeof groupRoutes>) =>
    grouped.routes
      .map((route) => `${route.stopIds.join(">")}|${route.trips.map((trip) => trip.id).join(",")}`)
      .sort();

  it("agrees with the element-wise comparison over two hundred timetables", () => {
    let flaggedTrips = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const { trips } = timetable(seed);
      /*
       * The flag as a trip builder would set it: these generated trips all carry their pattern's
       * whole sequence, because nothing here cuts one.
       */
      const flagged = trips.map((trip) => ({ ...trip, wholePatternSequence: true }));
      flaggedTrips += flagged.length;

      expect(shapeOf(groupRoutes(flagged)), `seed ${String(seed)}`).toEqual(
        shapeOf(groupRoutes(trips)),
      );
    }
    expect(flaggedTrips).toBeGreaterThan(1_000);
  });

  /*
   * A flag that is wrong must cost nothing but the saving.
   *
   * The profile harness set the flag on trips it had built without a pattern id, so every trip in
   * a corridor grouped together under `undefined` — sequences of different lengths in one route —
   * and the non-overtaking scan read a stop that was not there: "Cannot read properties of
   * undefined". The flag is a caller's claim and this is where a wrong one does its damage, so the
   * lengths are checked whatever it says.
   */
  it("does not take the flag's word for it when the lengths disagree", () => {
    const base = timetable(3).trips[0]!;
    const long = { ...base, id: "long", wholePatternSequence: true };
    const short = {
      ...base,
      id: "short",
      stopTimes: base.stopTimes.slice(0, base.stopTimes.length - 1),
      wholePatternSequence: true,
    };
    expect(short.stopTimes.length).toBeGreaterThanOrEqual(2);

    const grouped = groupRoutes([long, short]);
    /* Two routes, not one route with a sequence it cannot scan. */
    expect(grouped.routes).toHaveLength(2);
    for (const route of grouped.routes) {
      expect(route.trips).toHaveLength(1);
      expect(route.stopIds).toHaveLength(route.trips[0]!.stopTimes.length);
    }
  });

  it("keeps a cut trip with the flagged trips it matches, and apart from the ones it does not", () => {
    const { trips } = timetable(7);
    const pattern = trips[0]!.patternId;
    const onPattern = trips.filter((trip) => trip.patternId === pattern);
    expect(onPattern.length).toBeGreaterThan(1);

    /* One trip on the pattern, unflagged but with the same sequence: one route, all of them. */
    const sameSequence = [
      ...onPattern.slice(1).map((trip) => ({ ...trip, wholePatternSequence: true })),
      { ...onPattern[0]!, wholePatternSequence: false },
    ];
    const together = groupRoutes(sameSequence);
    const onlyWhole = groupRoutes(
      onPattern.map((trip) => ({ ...trip, wholePatternSequence: true })),
    );
    expect(shapeOf(together)).toEqual(shapeOf(onlyWhole));

    /* And one genuinely cut short: a route of its own, not merged into the whole-sequence one. */
    const cut = {
      ...onPattern[0]!,
      id: `${onPattern[0]!.id}-cut`,
      stopTimes: onPattern[0]!.stopTimes.slice(0, onPattern[0]!.stopTimes.length - 1),
      wholePatternSequence: false,
    };
    const mixed = groupRoutes([
      ...onPattern.map((trip) => ({ ...trip, wholePatternSequence: true })),
      cut,
    ]);
    const sequences = new Set(mixed.routes.map((route) => route.stopIds.join(">")));
    expect(sequences.size).toBe(2);
    const cutRoute = mixed.routes.find((route) => route.trips.some((trip) => trip.id === cut.id));
    expect(cutRoute?.trips.map((trip) => trip.id)).toEqual([cut.id]);
  });
});

describe("walking transfers from a grid", () => {
  /** The form it replaces: every pair, measured. */
  function allPairs(
    of: readonly JourneyStop[],
    maxTransferSeconds: number,
  ): Map<string, Array<{ toStopId: string; walkSeconds: number }>> {
    const transfers = new Map<string, Array<{ toStopId: string; walkSeconds: number }>>();
    for (const from of of) {
      const list: Array<{ toStopId: string; walkSeconds: number }> = [];
      for (const to of of) {
        if (from.id === to.id) continue;
        const seconds = walkSeconds(from.coordinate, to.coordinate);
        if (seconds <= maxTransferSeconds) list.push({ toStopId: to.id, walkSeconds: seconds });
      }
      transfers.set(from.id, list);
    }
    return transfers;
  }

  function scatter(count: number, seed: number, spreadDegrees: number): JourneyStop[] {
    const random = mulberry32(seed);
    return Array.from({ length: count }, (_, i) => ({
      id: `s${String(i).padStart(4, "0")}`,
      name: `Stop ${String(i)}`,
      coordinate: {
        /* Across England's latitudes, so the cell's longitude width is tested where it narrows. */
        lat: 50.1 + random() * spreadDegrees,
        lon: -3.2 + random() * spreadDegrees * 1.5,
      },
    }));
  }

  it("produces exactly the edges comparing every pair produces", () => {
    for (const seed of [1, 2, 3, 17, 99]) {
      for (const spread of [0.02, 0.5, 5]) {
        for (const cap of [120, 600, 1800]) {
          const of = scatter(400, seed, spread);
          const grid = buildTransfers(of, cap);
          const naive = allPairs(of, cap);
          for (const stop of of) {
            const mine = (grid.get(stop.id) ?? [])
              .map((t) => `${t.toStopId}@${String(t.walkSeconds)}`)
              .sort();
            const theirs = (naive.get(stop.id) ?? [])
              .map((t) => `${t.toStopId}@${String(t.walkSeconds)}`)
              .sort();
            expect(
              mine,
              `seed ${String(seed)} spread ${String(spread)} cap ${String(cap)} at ${stop.id}`,
            ).toEqual(theirs);
          }
        }
      }
    }
  });

  it("compares far fewer pairs than there are pairs", () => {
    /*
     * The point of the grid, stated as a measurement rather than as an intention: a Birmingham
     * corridor holds 2,737 stops, and comparing every pair is 7.5 million haversines to produce
     * 126,952 edges. This is the same shape at a size a test can run.
     */
    const of = scatter(1_200, 7, 0.08);
    const edges = [...buildTransfers(of, 600).values()].reduce(
      (total, list) => total + list.length,
      0,
    );
    expect(edges).toBeGreaterThan(0);
    expect(edges).toBeLessThan(of.length * of.length);
  });

  it("returns an empty map for no stops, rather than dividing by zero", () => {
    expect([...buildTransfers([], 600).entries()]).toEqual([]);
  });

  it("gives a lone stop no transfers rather than one to itself", () => {
    const only: JourneyStop[] = [
      { id: "only", name: "Only", coordinate: { lat: 53.8, lon: -1.5 } },
    ];
    expect(buildTransfers(only, 600).get("only")).toEqual([]);
  });
});
