import { describe, expect, it } from "vitest";
import {
  RECENT_TRACE_BUCKETS,
  RECENT_TRACE_MAX_POINTS,
  buildRecentTraceBuckets,
  decodeRecentTrace,
  encodeRecentTraceBucket,
  recentTraceBucket,
  recentTraceKey,
} from "./recent-traces.js";

/**
 * The storage behind "where has this bus just been".
 *
 * The design was chosen on arithmetic rather than taste, and these assert the properties that
 * arithmetic depends on: a bounded number of objects, a bounded number of points, a trail that
 * expires by being read rather than by a cleanup job, and no way to follow a bus across service
 * days.
 */

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 20, 9, minutes));
const iso = (minutes: number) => at(minutes).toISOString();

function observation(ref: string, minutes: number, lat = 53.79, lon = -1.55) {
  return { vehicleRef: ref, observedAt: iso(minutes), lat, lon };
}

describe("bucketing recent traces", () => {
  it("writes a fixed, small number of objects however many buses it saw", () => {
    const few = buildRecentTraceBuckets([observation("a", 0), observation("a", 2)], at(2));
    const many = buildRecentTraceBuckets(
      Array.from({ length: 4000 }, (_, index) => [
        observation(`veh-${index}`, 0),
        observation(`veh-${index}`, 2, 53.8),
      ]).flat(),
      at(2),
    );

    /*
     * The whole point of the design: a run's write count is the bucket count, not the fleet size.
     * One object per vehicle would have been ~26,000 writes a day against an allowance of ~33,000.
     */
    expect(few.size).toBe(RECENT_TRACE_BUCKETS);
    expect(many.size).toBe(RECENT_TRACE_BUCKETS);
  });

  /*
   * Measured rather than assumed, because the read cost of a bus tap is this number.
   */
  it("keeps a bucket small enough to read inside a 10ms budget", () => {
    const fleet = Array.from({ length: 6500 }, (_, index) => [
      observation(`veh-${index}`, 0),
      observation(`veh-${index}`, 2, 53.8),
      observation(`veh-${index}`, 4, 53.81),
    ]).flat();

    const files = buildRecentTraceBuckets(fleet, at(4));
    const sizes = [...files.values()].map((body) => body.length);
    const largest = Math.max(...sizes);

    // About 6,500 vehicles over 64 buckets is ~100 each at roughly 100 bytes a line.
    expect(largest).toBeLessThan(40_000);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThan(1_500_000);
  });

  it("writes every bucket, including the empty ones", () => {
    const files = buildRecentTraceBuckets([observation("a", 0), observation("a", 2)], at(2));
    /*
     * A bucket nobody wrote this run would keep the previous run's contents at its fixed key, and
     * the reader would serve them as current until the stamp aged out. An empty bucket with a fresh
     * stamp is the cheapest correct answer.
     */
    for (let bucket = 0; bucket < RECENT_TRACE_BUCKETS; bucket += 1) {
      expect(files.has(recentTraceKey(bucket))).toBe(true);
    }
  });

  it("spreads references across buckets rather than piling them into one", () => {
    const used = new Set(
      Array.from({ length: 2000 }, (_, index) => recentTraceBucket(`vehicle-${index}`)),
    );
    expect(used.size).toBe(RECENT_TRACE_BUCKETS);
  });

  it("puts a reference in the same bucket every time", () => {
    expect(recentTraceBucket("abc123")).toBe(recentTraceBucket("abc123"));
  });

  /* One position is a position, not a path, and a line of one point is a line nobody can draw. */
  it("stores nothing for a bus seen only once", () => {
    const files = buildRecentTraceBuckets([observation("lonely", 0)], at(0));
    const body = files.get(recentTraceKey(recentTraceBucket("lonely")))!;
    expect(decodeRecentTrace(body, "lonely", at(1)).points).toEqual([]);
  });

  it("caps the points kept for one vehicle", () => {
    const chatty = Array.from({ length: 40 }, (_, index) =>
      observation("chatty", index, 53.79 + index * 0.001),
    );
    const files = buildRecentTraceBuckets(chatty, at(39));
    const body = files.get(recentTraceKey(recentTraceBucket("chatty")))!;
    const { points } = decodeRecentTrace(body, "chatty", at(39), 60 * 60 * 24);
    expect(points.length).toBe(RECENT_TRACE_MAX_POINTS);
    // The newest are kept: a trail is about where a bus has just been.
    expect(points[points.length - 1]![0]).toBe(Math.round(at(39).getTime() / 1000));
  });
});

describe("reading one bus's trail out of a bucket", () => {
  const twoPoints = buildRecentTraceBuckets(
    [observation("bus-a", 0), observation("bus-a", 2, 53.8), observation("bus-b", 0)],
    at(2),
  );
  const bucketA = twoPoints.get(recentTraceKey(recentTraceBucket("bus-a")))!;

  it("returns the points for the reference asked about", () => {
    const { points } = decodeRecentTrace(bucketA, "bus-a", at(3));
    expect(points.length).toBe(2);
    expect(points[0]![0]).toBeLessThan(points[1]![0]);
  });

  it("returns nothing for a reference that is not in the bucket", () => {
    expect(decodeRecentTrace(bucketA, "not-here", at(3)).points).toEqual([]);
  });

  /*
   * Expiry by reading, not by a cleanup job.
   *
   * The keys are fixed and overwritten, so nothing deletes them — and this project's schedules are
   * delivered roughly four times a day rather than on their stated cadence, so a bucket can be
   * five hours old. A five-hour-old "recent path" is a trail across a city the bus left long ago.
   */
  it("discards a whole bucket written too long ago", () => {
    // Stamped at 09:02; read at 09:33 the bucket itself is 31 minutes old and none of it counts.
    expect(decodeRecentTrace(bucketA, "bus-a", at(33)).points).toEqual([]);
    // Read at 09:27 both points are inside the window and both are drawn.
    expect(decodeRecentTrace(bucketA, "bus-a", at(27)).points.length).toBe(2);
  });

  /*
   * The two filters are not the same filter, and this is what separates them.
   *
   * At 09:31 the bucket is 29 minutes old, so it is still usable — but the point it holds from
   * 09:00 is 31 minutes old and is not. The first version of this test expected both points here
   * and was simply wrong about the arithmetic; the behaviour it caught is the one worth having.
   */
  it("keeps a usable bucket while dropping the points in it that have aged out", () => {
    const { points } = decodeRecentTrace(bucketA, "bus-a", at(31));
    expect(points.length).toBe(1);
    expect(points[0]![0]).toBe(Math.round(at(2).getTime() / 1000));
  });

  it("discards an ancient point out of a freshly written bucket", () => {
    // A bucket stamped now, carrying a point from two hours ago.
    const body = encodeRecentTraceBucket(at(120), [
      {
        r: "bus-a",
        p: [
          [Math.round(at(0).getTime() / 1000), 53.79, -1.55],
          [Math.round(at(119).getTime() / 1000), 53.8, -1.55],
        ],
      },
    ]);
    const { points } = decodeRecentTrace(body, "bus-a", at(120));
    expect(points.length).toBe(1);
  });

  it("treats a bucket with no readable stamp as unusable rather than as current", () => {
    expect(decodeRecentTrace("not json at all\n{}", "bus-a", at(3)).points).toEqual([]);
  });

  it("skips a malformed line rather than failing the lookup", () => {
    const body = `${bucketA}\n{"r":"bus-a","p":"not an array"}\nnonsense`;
    expect(decodeRecentTrace(body, "bus-a", at(3)).points.length).toBe(2);
  });

  it("drops a point whose numbers are not numbers", () => {
    const body = encodeRecentTraceBucket(at(2), [
      {
        r: "bus-a",
        p: [
          [Math.round(at(0).getTime() / 1000), 53.79, -1.55],
          [Number.NaN, 53.8, -1.55] as [number, number, number],
        ],
      },
    ]);
    expect(decodeRecentTrace(body, "bus-a", at(3)).points.length).toBe(1);
  });

  /*
   * No cross-day identity, and it costs nothing to guarantee because the reference already rotates.
   *
   * The collector salts the operator's vehicle identifier with a daily key, so yesterday's bucket
   * is keyed by yesterday's reference. Today's reference hashes to a different bucket and does not
   * appear in it — there is no query that follows a bus from one service day into the next, which
   * is the difference between a short visual trail and vehicle tracking.
   */
  it("cannot follow a bus from yesterday's reference into today's", () => {
    const yesterday = buildRecentTraceBuckets(
      [observation("salted-monday", 0), observation("salted-monday", 2, 53.8)],
      at(2),
    );
    const todaysRef = "salted-tuesday";
    const bucket = yesterday.get(recentTraceKey(recentTraceBucket(todaysRef)));
    // Either a different bucket entirely, or the same bucket without today's reference in it.
    if (bucket) {
      expect(decodeRecentTrace(bucket, todaysRef, at(3)).points).toEqual([]);
    }
    expect(recentTraceBucket("salted-monday")).not.toBe(recentTraceBucket(todaysRef));
  });

  /* Never the operator's own identifier: only what the collector already salted. */
  it("stores only the rotating reference it was given", () => {
    expect(bucketA).toContain("bus-a");
    expect(bucketA).not.toContain("FLEE-30412");
  });
});
