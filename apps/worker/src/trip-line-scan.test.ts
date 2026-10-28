import { describe, expect, it } from "vitest";
import { patternIdInTripLine, tripWindowInLine } from "./journey-service.js";

/**
 * The scan that replaced five sixths of the journey planner's parse.
 *
 * A corridor tile holds every pattern crossing a half-degree square, so run 75 parsed 3,130 trip
 * rows to keep 479 and threw 2,651 away in the next statement — each one having built two arrays of
 * thirty-odd departure times on the way. The scan has to agree with the parse exactly, because a
 * disagreement silently removes buses from somebody's journey.
 */
describe("reading a trip's pattern off the text", () => {
  const line = (pattern: string, trip = "t1") =>
    JSON.stringify({ p: pattern, j: trip, t: [1, 2, 3], a: [1, 2, 3] });

  it("finds what JSON.parse would have found", () => {
    const pattern = "4f0a2c1e-1111-5000-8000-000000000001";
    const raw = line(pattern);
    expect(patternIdInTripLine(raw)).toBe(pattern);
    expect(patternIdInTripLine(raw)).toBe((JSON.parse(raw) as { p: string }).p);
  });

  it("agrees with the parse across a whole shard's worth of rows", () => {
    for (let index = 0; index < 200; index += 1) {
      const raw = line(`pattern-${index}`, `trip-${index}`);
      expect(patternIdInTripLine(raw)).toBe((JSON.parse(raw) as { p: string }).p);
    }
  });

  /*
   * Null, never a guess. A null falls through to the full parse, so an unfamiliar line costs one
   * extra parse; a wrong answer would drop a real bus from a real plan.
   */
  it("says nothing rather than guessing when the line is not shaped as expected", () => {
    expect(patternIdInTripLine("")).toBeNull();
    expect(patternIdInTripLine("{}")).toBeNull();
    expect(patternIdInTripLine('{"j":"t1","t":[1]}')).toBeNull();
    expect(patternIdInTripLine('{"p":"unterminated')).toBeNull();
  });

  it("is not fooled by a pattern id appearing later in the line", () => {
    const raw = JSON.stringify({ p: "first", j: "second", t: [1] });
    expect(patternIdInTripLine(raw)).toBe("first");
  });
});

/**
 * The window test off the raw line, which has to agree with the one on the parsed row.
 *
 * The pattern test ran before the parse and the window test ran after it, on the row the parse had
 * just built — and a published shard holds an eight-hour window where a plan spans four, so about
 * half of what survived the pattern test was built into an object with two arrays of twenty-five
 * numbers and then discarded. The scan below prevents that, which only helps if it answers the
 * same question.
 */
describe("the trip window, read off the line", () => {
  const row = (times: readonly number[], arrivals?: readonly number[]) =>
    JSON.stringify({
      p: "11111111-1111-5111-8111-111111111111",
      j: "trip-1",
      t: times,
      ...(arrivals === undefined ? {} : { a: arrivals }),
    });

  it("reads the first and the last call", () => {
    expect(tripWindowInLine(row([1_000, 1_200, 1_500, 1_900]))).toEqual({
      first: 1_000,
      last: 1_900,
    });
  });

  it("reads a single-call row as beginning and ending at once", () => {
    expect(tripWindowInLine(row([4_242]))).toEqual({ first: 4_242, last: 4_242 });
  });

  it("is not confused by an arrivals array after it", () => {
    expect(tripWindowInLine(row([1_000, 2_000], [999, 1_999]))).toEqual({
      first: 1_000,
      last: 2_000,
    });
  });

  it("agrees with the test on the parsed row, over a window either side of a plan", () => {
    const from = 10_000;
    const to = 24_400;
    /* Wholly before, overlapping the start, inside, overlapping the end, wholly after. */
    const candidates = [
      [1_000, 2_000],
      [9_000, 11_000],
      [12_000, 14_000],
      [24_000, 26_000],
      [30_000, 32_000],
    ];
    for (const times of candidates) {
      const line = row(times);
      const scanned = tripWindowInLine(line);
      expect(scanned, `no window read from ${line}`).not.toBeNull();
      const keptByScan = !(scanned!.last < from || scanned!.first > to);
      /* The test the parsed row gets, written out: last call not before, first call not after. */
      const parsed = JSON.parse(line) as { t: number[] };
      const keptByRow = parsed.t[parsed.t.length - 1]! >= from && parsed.t[0]! <= to;
      expect(keptByScan, `disagreed on ${line}`).toBe(keptByRow);
    }
  });

  it("gives up rather than guessing when the shape is not recognised", () => {
    /* Null means "parse it anyway", which is the safe answer: a bus is never dropped on a scan. */
    expect(tripWindowInLine('{"p":"x","j":"y"}')).toBeNull();
    expect(tripWindowInLine('{"t":[')).toBeNull();
    expect(tripWindowInLine('{"t":[notanumber]}')).toBeNull();
  });
});
