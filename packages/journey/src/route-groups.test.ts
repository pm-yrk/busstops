import { describe, expect, it } from "vitest";
import { groupRoutes, type Trip } from "./graph.js";
import { groupRouteIndices } from "./route-groups.js";

/**
 * The published grouping must be the grouping.
 *
 * `groupRoutes` is what the search has always used and what the brute-force oracle is checked
 * against; `groupRouteIndices` is the same decision taken over arrays, so a publisher holding a
 * binary trip shard can make it without building an object. If the two disagree, the published
 * artifact splits a route the search expects whole — which halves the buses it can see on it — or
 * merges two it expects apart, which lets it board a bus that overtakes another and report an
 * arrival that will not happen.
 *
 * So they are run against the same generated timetables and required to produce the same
 * partition: the same routes, the same trips on each, in the same order.
 */

const MIN = 60;
const departAt = 8 * 3600;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Timetables with the shapes that make grouping hard: expresses that overtake, trips cut short,
 * several patterns, and trips whose first departures tie.
 */
function timetable(seed: number): Trip[] {
  const random = mulberry32(seed);
  const trips: Trip[] = [];
  const patterns = 2 + Math.floor(random() * 4);
  for (let p = 0; p < patterns; p += 1) {
    const length = 3 + Math.floor(random() * 5);
    const tripCount = 2 + Math.floor(random() * 6);
    const headway = (3 + Math.floor(random() * 10)) * MIN;
    const first = departAt + Math.floor(random() * 10) * MIN;
    for (let t = 0; t < tripCount; t += 1) {
      /* One in five runs fast enough to overtake the one in front. */
      const hop = random() < 0.2 ? 1 * MIN : (3 + Math.floor(random() * 5)) * MIN;
      /* One in six is cut short, which is a different sequence on the same pattern. */
      const calls = random() < 0.167 ? Math.max(2, length - 1 - Math.floor(random() * 2)) : length;
      /* One in eight departs at exactly the same minute as the trip before it. */
      const tie = random() < 0.125 && t > 0;
      let clock = first + (tie ? t - 1 : t) * headway;
      const stopTimes = Array.from({ length: calls }, (_, at) => {
        if (at > 0) clock += hop;
        return {
          stopId: `p${String(p)}-s${String(at)}`,
          arrivalSeconds: clock,
          departureSeconds: clock,
        };
      });
      trips.push({
        id: `s${String(seed)}-p${String(p)}-t${String(t)}`,
        routeId: `route-${String(p)}`,
        patternId: `pattern-${String(p)}`,
        routeName: `R${String(p)}`,
        headsign: "Test",
        stopTimes,
      });
    }
  }
  return trips;
}

/** The two forms, as comparable shapes: the pattern, the sequence length, and the trips in order. */
const fromObjects = (trips: readonly Trip[]): string[] =>
  groupRoutes(trips)
    .routes.map(
      (route) =>
        `${route.trips[0]!.patternId}|${String(route.stopIds.length)}|${route.trips
          .map((trip) => trip.id)
          .join(",")}`,
    )
    .sort();

const fromIndices = (trips: readonly Trip[]): string[] => {
  const patternKeys = new Map<string, number>();
  for (const trip of trips) {
    if (!patternKeys.has(trip.patternId)) patternKeys.set(trip.patternId, patternKeys.size);
  }
  const patternIds = [...patternKeys.keys()];
  return groupRouteIndices({
    tripCount: trips.length,
    patternKeyOf: (trip) => patternKeys.get(trips[trip]!.patternId)!,
    callCountOf: (trip) => trips[trip]!.stopTimes!.length,
    departureOf: (trip, call) => trips[trip]!.stopTimes![call]!.departureSeconds,
    tripIdOf: (trip) => trips[trip]!.id,
  })
    .map(
      (group) =>
        `${patternIds[group.patternKey]!}|${String(group.callCount)}|${group.trips
          .map((trip) => trips[trip]!.id)
          .join(",")}`,
    )
    .sort();
};

describe("grouping trips into routes, over indices", () => {
  it("partitions two hundred generated timetables exactly as the object form does", () => {
    let routes = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const trips = timetable(seed);
      const objects = fromObjects(trips);
      routes += objects.length;
      expect(fromIndices(trips), `seed ${String(seed)}`).toEqual(objects);
    }
    /* Enough routes that the agreement is not two empty lists. */
    expect(routes).toBeGreaterThan(1_000);
  });

  it("splits an express out of the group it overtakes", () => {
    const slow: Trip = {
      id: "slow",
      routeId: "r",
      patternId: "p",
      routeName: "1",
      headsign: "x",
      stopTimes: [
        { stopId: "a", arrivalSeconds: 0, departureSeconds: 0 },
        { stopId: "b", arrivalSeconds: 900, departureSeconds: 900 },
      ],
    };
    const express: Trip = {
      ...slow,
      id: "express",
      stopTimes: [
        { stopId: "a", arrivalSeconds: 60, departureSeconds: 60 },
        { stopId: "b", arrivalSeconds: 300, departureSeconds: 300 },
      ],
    };
    expect(fromIndices([slow, express])).toEqual(fromObjects([slow, express]));
    expect(fromIndices([slow, express])).toHaveLength(2);
  });

  it("keeps a trip cut short apart from the ones that run the whole pattern", () => {
    /* Built rather than generated, so the only cut trip here is the one this test cuts: the
     * generator cuts some of its own, and a cut trip may legitimately join one of those. */
    const base: Trip = {
      id: "whole-1",
      routeId: "r",
      patternId: "p",
      routeName: "1",
      headsign: "x",
      stopTimes: [
        { stopId: "a", arrivalSeconds: 0, departureSeconds: 0 },
        { stopId: "b", arrivalSeconds: 600, departureSeconds: 600 },
        { stopId: "c", arrivalSeconds: 1_200, departureSeconds: 1_200 },
      ],
    };
    const second: Trip = {
      ...base,
      id: "whole-2",
      stopTimes: base.stopTimes!.map((call) => ({
        ...call,
        arrivalSeconds: call.arrivalSeconds + 900,
        departureSeconds: call.departureSeconds + 900,
      })),
    };
    const cut: Trip = { ...base, id: "cut", stopTimes: base.stopTimes!.slice(0, 2) };

    const trips = [base, second, cut];
    const grouped = fromIndices(trips);
    expect(grouped).toEqual(fromObjects(trips));
    /* Two routes on one pattern: the two whole trips together, the cut one on its own. */
    expect(grouped).toHaveLength(2);
    expect(grouped).toContain("p|3|whole-1,whole-2");
    expect(grouped).toContain("p|2|cut");
  });

  it("never groups trips from different patterns, even with identical times", () => {
    const one = timetable(5)[0]!;
    const other: Trip = { ...one, id: "other", patternId: "pattern-elsewhere", routeId: "other" };
    const grouped = groupRouteIndices({
      tripCount: 2,
      patternKeyOf: (trip) => trip,
      callCountOf: () => one.stopTimes!.length,
      departureOf: (_trip, call) => one.stopTimes![call]!.departureSeconds,
      tripIdOf: (trip) => (trip === 0 ? one.id : other.id),
    });
    expect(grouped).toHaveLength(2);
  });

  it("is deterministic: the same shard twice gives the same order", () => {
    const trips = timetable(42);
    const once = fromIndices(trips);
    const again = fromIndices([...trips].reverse());
    expect(again).toEqual(once);
  });
});

/**
 * And the request-time fast path: trips carrying the route the publisher gave them.
 *
 * `groupRoutes` takes a `Map` insert per trip when every trip has a key, skipping the sequence
 * comparison, the sort and the overtaking split entirely — which is the artifact's whole value on
 * the request path. If that path disagreed with the long one, the published grouping would be a
 * silent change to which buses the search can see on a route.
 */
describe("grouping from the keys the publisher assigned", () => {
  /** The keys a publisher would have written, taken from the long path's own answer. */
  function keyed(trips: readonly Trip[]): Trip[] {
    const grouped = groupRoutes(trips);
    const keyOf = new Map<string, string>();
    grouped.routes.forEach((route, at) => {
      for (const trip of route.trips) keyOf.set(trip.id, `r${String(at)}`);
    });
    /* In the order the publisher writes them, which is the order the reader hands them back. */
    const ordered: Trip[] = [];
    for (const route of grouped.routes) {
      for (const trip of route.trips) ordered.push({ ...trip, routeKey: keyOf.get(trip.id)! });
    }
    return ordered;
  }

  const shapeOf = (grouped: ReturnType<typeof groupRoutes>): string[] =>
    grouped.routes
      .map((route) => `${route.stopIds.join(">")}|${route.trips.map((trip) => trip.id).join(",")}`)
      .sort();

  it("produces the same routes as the long path, over two hundred timetables", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const trips = timetable(seed);
      expect(shapeOf(groupRoutes(keyed(trips))), `seed ${String(seed)}`).toEqual(
        shapeOf(groupRoutes(trips)),
      );
    }
  });

  it("keeps each route's trips in the order they arrive", () => {
    const trips = keyed(timetable(9));
    const grouped = groupRoutes(trips);
    for (const route of grouped.routes) {
      const arrival = trips.filter((trip) => route.trips.some((member) => member.id === trip.id));
      expect(route.trips.map((trip) => trip.id)).toEqual(arrival.map((trip) => trip.id));
    }
  });

  /*
   * The order within a route is load-bearing, and this is the test that was missing.
   *
   * `earliestBoardable` binary-searches a route's trips, which is only sound if they are in
   * departure order. The published grouping lists them that way; the first reader of it walked the
   * shard in index order and merely tagged each trip with its route, so the order was lost and the
   * search boarded a later bus. The corpus caught it — four of ten recommendations changed, one
   * arriving 4,050 seconds later — and nothing in this file did, because the helper above happened
   * to emit trips in route order.
   */
  it("orders a route's trips by departure even when the keys arrive shuffled", () => {
    const trips = keyed(timetable(21));
    const shuffled = [...trips];
    /* A deterministic shuffle: the shard's own order has no reason to match the publisher's. */
    for (let at = shuffled.length - 1; at > 0; at -= 1) {
      const swap = (at * 7 + 3) % (at + 1);
      [shuffled[at], shuffled[swap]] = [shuffled[swap]!, shuffled[at]!];
    }

    const grouped = groupRoutes(shuffled);
    expect(shapeOf(grouped)).toEqual(shapeOf(groupRoutes(trips)));
    for (const route of grouped.routes) {
      const departures = route.trips.map((trip) => trip.stopTimes![0]!.departureSeconds);
      expect([...departures], `route ${route.stopIds.join(">")}`).toEqual(
        [...departures].sort((a, b) => a - b),
      );
    }
  });

  it("goes the long way when even one trip has no key", () => {
    const trips = keyed(timetable(13));
    /* A mixture cannot be grouped by key: an unkeyed trip may belong in a keyed trip's route, and
     * only the comparison can say so. */
    const mixed = trips.map((trip, at) => (at === 0 ? { ...trip, routeKey: undefined } : trip));
    expect(shapeOf(groupRoutes(mixed))).toEqual(shapeOf(groupRoutes(timetable(13))));
  });

  it("reflects a corridor that cut the sequences, not the sequence the publisher saw", () => {
    const trips = keyed(timetable(17)).map((trip) => ({
      ...trip,
      /* The corridor dropped the last stop of every trip, identically, as it must. */
      stopTimes: trip.stopTimes!.slice(0, trip.stopTimes!.length - 1),
    }));
    const grouped = groupRoutes(trips.filter((trip) => trip.stopTimes!.length >= 2));
    for (const route of grouped.routes) {
      expect(route.stopIds.length).toBe(route.trips[0]!.stopTimes!.length);
    }
  });
});
