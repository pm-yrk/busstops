import { describe, expect, it } from "vitest";
import { PatternTripShard, encodePatternTripShard } from "./binary-trips.js";
import type { PatternTripRow } from "./departures-index.js";

/**
 * The format exists to remove a parse from a passenger request, so what it has to prove is that
 * nothing else goes with it: the same trips, the same times, the same arrivals, the same ids.
 *
 * The oracle is the JSON form itself. Every assertion here is "the bytes say what the row said",
 * because a shard that is cheap to open and wrong about a departure is worse than the parse.
 */

const MIDNIGHT = Date.parse("2026-10-28T00:00:00.000Z") / 1000;

/** Rows shaped like the published ones: most arrivals equal to departures, some not. */
function rows(count: number, seed = 1): PatternTripRow[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  return Array.from({ length: count }, (_, index) => {
    const calls = 2 + Math.floor(next() * 28);
    const start = MIDNIGHT + 6 * 3600 + Math.floor(next() * 12 * 3600);
    const times: number[] = [];
    let at = start;
    for (let call = 0; call < calls; call += 1) {
      times.push(at);
      at += 60 + Math.floor(next() * 240);
    }
    const layover = next() < 0.3;
    const row: PatternTripRow = {
      p: `0191bd0a-${String(index % 7).padStart(4, "0")}-7c1e-9a2b-4f6c8d1e2a3b`,
      j: `vj-${String(index)}-${String(Math.floor(next() * 1e6))}`,
      t: times,
    };
    if (!layover) return row;
    /* A real layover: the bus arrives before it leaves at one interchange. */
    const arrivals = times.map((time, call) => (call === 1 ? time - 180 : time));
    return { ...row, a: arrivals };
  });
}

describe("a pattern-trips shard as bytes", () => {
  it("gives back every row the JSON form carried", () => {
    const source = rows(500);
    const { bytes, stats } = encodePatternTripShard(source);
    const shard = new PatternTripShard(bytes);

    expect(stats.trips).toBe(source.length);
    expect(shard.tripCount).toBe(source.length);
    expect(stats.clampedArrivals).toBe(0);
    expect(stats.droppedEmptyRows).toBe(0);

    for (let trip = 0; trip < source.length; trip += 1) {
      expect(shard.rowAt(trip)).toEqual(source[trip]);
    }
  });

  it("answers the horizon test off the numbers, as the text scan does", () => {
    const source = rows(300, 7);
    const shard = new PatternTripShard(encodePatternTripShard(source).bytes);
    const from = MIDNIGHT + 9 * 3600;
    const to = from + 4 * 3600;

    const fromBytes: string[] = [];
    for (let trip = 0; trip < shard.tripCount; trip += 1) {
      if (shard.lastDeparture(trip) >= from && shard.firstDeparture(trip) <= to) {
        fromBytes.push(shard.tripId(trip));
      }
    }
    const fromRows = source
      .filter((row) => row.t[row.t.length - 1]! >= from && row.t[0]! <= to)
      .map((row) => row.j);

    expect(fromBytes).toEqual(fromRows);
    /* And the window genuinely bites, so the equality above is not two empty lists. */
    expect(fromBytes.length).toBeGreaterThan(0);
    expect(fromBytes.length).toBeLessThan(source.length);
  });

  it("holds the same pattern id for every trip without repeating it in the bytes", () => {
    const source = rows(200, 11);
    const { bytes, stats } = encodePatternTripShard(source);
    const shard = new PatternTripShard(bytes);

    expect(stats.patterns).toBe(new Set(source.map((row) => row.p)).size);
    for (let trip = 0; trip < shard.tripCount; trip += 1) {
      expect(shard.patternId(shard.patternOf(trip))).toBe(source[trip]!.p);
    }
    /*
     * Seven pattern ids for two hundred trips: the blob holds seven, not two hundred. Measured
     * against the same rows with every id distinct, where the blob has to hold all two hundred —
     * the difference is the 193 ids this form does not write, give or take their offsets.
     */
    const distinct = encodePatternTripShard(
      source.map((row, index) => ({
        ...row,
        p: `${row.p.slice(0, 24)}${String(index).padStart(12, "0")}`,
      })),
    );
    const idLength = source[0]!.p.length;
    expect(distinct.stats.patterns).toBe(source.length);
    expect(distinct.bytes.byteLength - bytes.byteLength).toBeGreaterThan(
      (source.length - stats.patterns) * idLength,
    );
  });

  it("is smaller than the JSON it replaces", () => {
    const source = rows(2_000, 3);
    const asJson = source.map((row) => JSON.stringify(row)).join("\n");
    const { bytes } = encodePatternTripShard(source);
    /*
     * Not a contrived margin: an epoch second is eleven characters of JSON and four bytes here,
     * and the pattern id is written once per shard instead of once per row. The published shards
     * are eight megabytes of text; a third of that is the number this asserts.
     */
    expect(bytes.byteLength).toBeLessThan(asJson.length / 2);
  });

  it("keeps an arrival that differs and does not invent one that does not", () => {
    const source: PatternTripRow[] = [
      { p: "p-1", j: "t-1", t: [MIDNIGHT + 100, MIDNIGHT + 400] },
      {
        p: "p-1",
        j: "t-2",
        t: [MIDNIGHT + 100, MIDNIGHT + 400],
        a: [MIDNIGHT + 100, MIDNIGHT + 220],
      },
    ];
    const shard = new PatternTripShard(encodePatternTripShard(source).bytes);
    expect(shard.rowAt(0).a).toBeUndefined();
    expect(shard.rowAt(1).a).toEqual([MIDNIGHT + 100, MIDNIGHT + 220]);
    expect(shard.arrival(1, 1)).toBe(MIDNIGHT + 220);
  });

  it("reports a layover it could not hold rather than writing a wrong one", () => {
    /* Eighteen hours is the ceiling of a sixteen-bit delta; a longer one is a data fault, and the
     * encode says so instead of wrapping it round into a transfer that looks makeable. */
    const departure = MIDNIGHT + 20 * 3600;
    const { bytes, stats } = encodePatternTripShard([
      { p: "p-1", j: "t-1", t: [departure, departure + 60], a: [departure - 19 * 3600, departure] },
    ]);
    expect(stats.clampedArrivals).toBe(1);
    const shard = new PatternTripShard(bytes);
    /* Clamped towards the departure, which makes a transfer look harder rather than easier. */
    expect(shard.arrival(0, 0)).toBe(departure - 0xffff);
  });

  it("drops a row with no calls, and counts it", () => {
    const { stats } = encodePatternTripShard([
      { p: "p-1", j: "t-1", t: [] },
      { p: "p-1", j: "t-2", t: [MIDNIGHT] },
    ]);
    expect(stats.droppedEmptyRows).toBe(1);
    expect(stats.trips).toBe(1);
  });

  it("opens a body that does not begin on a four-byte boundary", () => {
    const source = rows(50, 5);
    const { bytes } = encodePatternTripShard(source);
    /* What a sliced response body can hand over: the same bytes at an odd offset. */
    const padded = new Uint8Array(bytes.byteLength + 1);
    padded.set(bytes, 1);
    const shard = new PatternTripShard(padded.subarray(1));
    expect(shard.tripCount).toBe(source.length);
    expect(shard.rowAt(7)).toEqual(source[7]);
  });

  it("refuses bytes that are not a shard, rather than reading nonsense", () => {
    expect(() => new PatternTripShard(new Uint8Array(64))).toThrow(/not a binary trip shard/);
    const { bytes } = encodePatternTripShard(rows(20, 9));
    expect(() => new PatternTripShard(bytes.subarray(0, bytes.byteLength - 8))).toThrow(
      /truncated/,
    );
  });

  it("holds an empty shard", () => {
    const { bytes, stats } = encodePatternTripShard([]);
    const shard = new PatternTripShard(bytes);
    expect(stats.trips).toBe(0);
    expect(shard.tripCount).toBe(0);
    expect(shard.callCount).toBe(0);
  });
});
