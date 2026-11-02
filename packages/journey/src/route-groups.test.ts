import { describe, expect, it } from "vitest";
import { groupRouteIndices } from "./route-groups.js";

/**
 * Grouping trips into routes, over a shard's arrays.
 *
 * A route is the set of trips running the same stop sequence, split so that no bus in it overtakes
 * another — the search binary-searches a route's trips for the earliest one it can catch, which is
 * only sound if they are ordered and non-overtaking. Get this wrong in the published artifact and
 * the endpoint either splits a route the search expects whole, halving the buses it can see on it,
 * or merges two it expects apart and reports an arrival that will not happen.
 *
 * `groupRouteIndices` takes that decision over indices, so the refresh can make it while holding a
 * binary trip shard and never build an object. The one thing a shard makes possible is the reason
 * the artifact is small: a row's times are indexed by position in its pattern's stop sequence and
 * the array is dense, so a trip with fewer times runs the pattern's first *n* stops. "The same
 * stop sequence" is therefore exactly "the same pattern and the same number of calls", and no stop
 * ids are needed at all.
 *
 * The test that this agrees with the request-time grouping lives with the request-time grouping,
 * on the branch that introduces it. Here the decision is held to its own rules, which is what the
 * refresh needs in order to publish it.
 */

const MIN = 60;
const departAt = 8 * 3600;

/** A trip as the shard holds one: a pattern, and a departure per call. */
interface Timed {
  id: string;
  patternKey: number;
  departures: number[];
}

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
function timetable(seed: number): Timed[] {
  const random = mulberry32(seed);
  const trips: Timed[] = [];
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
      const departures = Array.from({ length: calls }, (_, at) => {
        if (at > 0) clock += hop;
        return clock;
      });
      trips.push({ id: `s${String(seed)}-p${String(p)}-t${String(t)}`, patternKey: p, departures });
    }
  }
  return trips;
}

/** The grouping as comparable shapes: the pattern, the sequence length, and the trips in order. */
function shapeOf(trips: readonly Timed[]): string[] {
  return groupRouteIndices({
    tripCount: trips.length,
    patternKeyOf: (trip) => trips[trip]!.patternKey,
    callCountOf: (trip) => trips[trip]!.departures.length,
    departureOf: (trip, call) => trips[trip]!.departures[call]!,
    tripIdOf: (trip) => trips[trip]!.id,
  })
    .map(
      (group) =>
        `p${String(group.patternKey)}|${String(group.callCount)}|${group.trips
          .map((trip) => trips[trip]!.id)
          .join(",")}`,
    )
    .sort();
}

describe("grouping trips into routes, over indices", () => {
  it("places every trip on exactly one route, over two hundred timetables", () => {
    let routes = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const trips = timetable(seed);
      const grouped = shapeOf(trips);
      routes += grouped.length;
      const placed = grouped.flatMap((route) => route.split("|")[2]!.split(","));
      expect(placed.slice().sort(), `seed ${String(seed)}`).toEqual(
        trips.map((trip) => trip.id).sort(),
      );
      expect(new Set(placed).size, `seed ${String(seed)}`).toBe(trips.length);
    }
    /* Enough routes that the agreement is not two empty lists. */
    expect(routes).toBeGreaterThan(1_000);
  });

  it("orders every route's trips by first departure, over two hundred timetables", () => {
    /* The search binary-searches a route's trips. Unordered is not slower, it is wrong: an
     * earlier reader of this artifact walked the shard in index order and the corpus caught four
     * of ten recommendations changing, one arriving 4,050 seconds later. */
    for (let seed = 1; seed <= 200; seed += 1) {
      const trips = timetable(seed);
      for (const group of groupRouteIndices({
        tripCount: trips.length,
        patternKeyOf: (trip) => trips[trip]!.patternKey,
        callCountOf: (trip) => trips[trip]!.departures.length,
        departureOf: (trip, call) => trips[trip]!.departures[call]!,
        tripIdOf: (trip) => trips[trip]!.id,
      })) {
        for (let at = 1; at < group.trips.length; at += 1) {
          expect(
            trips[group.trips[at]!]!.departures[0]!,
            `seed ${String(seed)}`,
          ).toBeGreaterThanOrEqual(trips[group.trips[at - 1]!]!.departures[0]!);
        }
      }
    }
  });

  it("never lets one trip in a route overtake another, over two hundred timetables", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const trips = timetable(seed);
      for (const group of groupRouteIndices({
        tripCount: trips.length,
        patternKeyOf: (trip) => trips[trip]!.patternKey,
        callCountOf: (trip) => trips[trip]!.departures.length,
        departureOf: (trip, call) => trips[trip]!.departures[call]!,
        tripIdOf: (trip) => trips[trip]!.id,
      })) {
        for (let at = 1; at < group.trips.length; at += 1) {
          const ahead = trips[group.trips[at - 1]!]!.departures;
          const behind = trips[group.trips[at]!]!.departures;
          for (let call = 0; call < group.callCount; call += 1) {
            expect(
              behind[call]!,
              `seed ${String(seed)} call ${String(call)}`,
            ).toBeGreaterThanOrEqual(ahead[call]!);
          }
        }
      }
    }
  });

  it("splits an express out of the group it overtakes", () => {
    const slow: Timed = { id: "slow", patternKey: 0, departures: [0, 900] };
    const express: Timed = { id: "express", patternKey: 0, departures: [60, 300] };
    expect(shapeOf([slow, express])).toHaveLength(2);
  });

  it("keeps a trip cut short apart from the ones that run the whole pattern", () => {
    /* Built rather than generated, so the only cut trip here is the one this test cuts: the
     * generator cuts some of its own, and a cut trip may legitimately join one of those. */
    const whole1: Timed = { id: "whole-1", patternKey: 0, departures: [0, 600, 1_200] };
    const whole2: Timed = { id: "whole-2", patternKey: 0, departures: [900, 1_500, 2_100] };
    const cut: Timed = { id: "cut", patternKey: 0, departures: [0, 600] };

    const grouped = shapeOf([whole1, whole2, cut]);
    /* Two routes on one pattern: the two whole trips together, the cut one on its own. */
    expect(grouped).toHaveLength(2);
    expect(grouped).toContain("p0|3|whole-1,whole-2");
    expect(grouped).toContain("p0|2|cut");
  });

  it("never groups trips from different patterns, even with identical times", () => {
    const one: Timed = { id: "one", patternKey: 0, departures: [0, 600] };
    const other: Timed = { id: "other", patternKey: 1, departures: [0, 600] };
    expect(shapeOf([one, other])).toHaveLength(2);
  });

  it("is deterministic: the same shard twice gives the same order", () => {
    const trips = timetable(42);
    expect(shapeOf([...trips].reverse())).toEqual(shapeOf(trips));
  });
});
