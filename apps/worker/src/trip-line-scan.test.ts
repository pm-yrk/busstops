import { describe, expect, it } from "vitest";
import { patternIdInTripLine } from "./journey-service.js";

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
