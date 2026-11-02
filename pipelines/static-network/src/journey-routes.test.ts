import { describe, expect, it } from "vitest";
import {
  RouteGrouping,
  encodeRouteGrouping,
  journeyRoutesDataset,
  type ShardFingerprint,
} from "./journey-routes.js";
import { PatternTripShard, encodePatternTripShard } from "./binary-trips.js";
import type { PatternTripRow } from "./departures-index.js";

/**
 * The published grouping's bytes, and the rule that keeps them attached to the right shard.
 *
 * A grouping names trips by their index in a trip shard, which makes it the one artifact here that
 * is meaningless on its own: used against a different shard it would put a passenger on a bus that
 * does not exist. So the shard's own shape travels in the header, and the reader has to be able to
 * say the two belong together before it uses anything.
 */

const MIDNIGHT = Date.parse("2026-10-28T00:00:00.000Z") / 1000;

function rows(count: number): PatternTripRow[] {
  return Array.from({ length: count }, (_, index) => ({
    p: `pattern-${String(index % 3)}`,
    j: `vj-${String(index)}`,
    t: [MIDNIGHT + 32_400 + index * 60, MIDNIGHT + 33_000 + index * 60],
  }));
}

const grouping = (fingerprint: ShardFingerprint) =>
  encodeRouteGrouping({
    fingerprint,
    routes: [
      { patternKey: 0, callCount: 2, trips: [0, 3, 6] },
      { patternKey: 1, callCount: 2, trips: [1, 4] },
      { patternKey: 2, callCount: 2, trips: [2, 5] },
    ],
  });

describe("a published route grouping", () => {
  it("reads back the routes, their trips and their order", () => {
    const shard = new PatternTripShard(encodePatternTripShard(rows(7)).bytes);
    const { bytes, stats } = grouping(shard.fingerprint());
    expect(stats.routes).toBe(3);
    expect(stats.trips).toBe(7);

    const read = new RouteGrouping(bytes);
    expect(read.routeCount).toBe(3);
    const seen: string[] = [];
    for (let route = 0; route < read.routeCount; route += 1) {
      const trips: number[] = [];
      for (let at = read.firstTrip(route); at < read.tripEnd(route); at += 1) {
        trips.push(read.tripAt(at));
      }
      seen.push(
        `${String(read.patternKeyOf(route))}|${String(read.callCountOf(route))}|${trips.join(",")}`,
      );
    }
    expect(seen).toEqual(["0|2|0,3,6", "1|2|1,4", "2|2|2,5"]);
  });

  it("says it belongs to the shard it was built from", () => {
    const shard = new PatternTripShard(encodePatternTripShard(rows(7)).bytes);
    const read = new RouteGrouping(grouping(shard.fingerprint()).bytes);
    expect(read.describes(shard.fingerprint())).toBe(true);
  });

  it("refuses a shard with a different number of trips", () => {
    const seven = new PatternTripShard(encodePatternTripShard(rows(7)).bytes);
    const eight = new PatternTripShard(encodePatternTripShard(rows(8)).bytes);
    const read = new RouteGrouping(grouping(seven.fingerprint()).bytes);
    expect(read.describes(eight.fingerprint())).toBe(false);
  });

  /*
   * What the fingerprint catches, and what it does not.
   *
   * It is four numbers a reader has already read — the trip count, the total calls, and the first
   * and last departure in the array — so checking costs nothing. That catches a shard with
   * different trips, a shard with different call counts, and a shard whose ends moved. It does not
   * catch a change strictly inside the array that leaves all four alone, and this test says so
   * rather than pretending otherwise.
   *
   * What makes that acceptable is not the fingerprint. Both artifacts are addressed by the same
   * artifact version, and a version's contents do not change — a new timetable is a new version —
   * so a grouping and a shard at the same version were built from the same bytes. The fingerprint
   * is there to catch the publishing accident: a grouping written for a shard that was then
   * rewritten, which is exactly the case where the counts or the ends move.
   */
  it("refuses a shard whose ends moved, and admits what it cannot see", () => {
    const original = rows(7);
    const endMoved = original.map((row, index) =>
      index === 6 ? { ...row, t: row.t.map((time) => time + 60) } : row,
    );
    const middleMoved = original.map((row, index) =>
      index === 4 ? { ...row, t: row.t.map((time) => time + 60) } : row,
    );
    const first = new PatternTripShard(encodePatternTripShard(original).bytes);
    const moved = new PatternTripShard(encodePatternTripShard(endMoved).bytes);
    const inside = new PatternTripShard(encodePatternTripShard(middleMoved).bytes);
    const read = new RouteGrouping(grouping(first.fingerprint()).bytes);

    expect(read.describes(moved.fingerprint())).toBe(false);
    /* Honest about the gap: the counts and both ends are identical here. */
    expect(inside.fingerprint()).toEqual(first.fingerprint());
    expect(read.describes(inside.fingerprint())).toBe(true);
  });

  it("costs a few bytes a trip, not a few hundred", () => {
    const trips = 11_727;
    const { stats } = encodeRouteGrouping({
      fingerprint: { tripCount: trips, callCount: trips * 25, firstDeparture: 1, lastDeparture: 2 },
      routes: Array.from({ length: 840 }, (_, route) => ({
        patternKey: route,
        callCount: 25,
        trips: Array.from({ length: Math.floor(trips / 840) }, (_, at) => route * 13 + at),
      })),
    });
    /* Four bytes a trip plus eight a route: a rounding error against the shard it describes. */
    expect(stats.bytes).toBeLessThan(trips * 6 + 840 * 16);
  });

  it("refuses bytes that are not a grouping, and bytes missing their tail", () => {
    expect(() => new RouteGrouping(new Uint8Array(80))).toThrow(/not a published route grouping/);
    const { bytes } = grouping({
      tripCount: 7,
      callCount: 14,
      firstDeparture: 1,
      lastDeparture: 2,
    });
    expect(() => new RouteGrouping(bytes.subarray(0, bytes.byteLength - 4))).toThrow(/truncated/);
  });

  it("files a grouping beside the trips it describes", () => {
    expect(journeyRoutesDataset("2026-10-28", "215_-7", 1)).toBe(
      "network/journey-routes/2026-10-28/1/215_-7",
    );
  });
});
