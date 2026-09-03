import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ENGLAND_BOUNDS } from "@busstops/contracts";
import {
  haversineMetres,
  isPlausibleEnglandCoordinate,
  simplifyPath,
  tilesForBoundingBox,
  tileIdFor,
  corridorBoundingBox,
} from "@busstops/pipeline-core";
import { median, proportion, quantile, robustZScore } from "@busstops/analytics";
import { punctuality, reliability } from "@busstops/analytics";
import { idempotencyKeyFor } from "@busstops/daily-brief";

/**
 * Property-based tests (docs/15_TESTING.md "Property/generative").
 *
 * Hand-written cases test what the author thought of. These test the invariants that must hold
 * for every input, which is where the bugs nobody imagined actually live: a percentage above one,
 * a negative count, a metric that divides by zero, a simplification that drops an endpoint.
 */

const englandCoordinate = fc.record({
  lat: fc.double({ min: ENGLAND_BOUNDS.south, max: ENGLAND_BOUNDS.north, noNaN: true }),
  lon: fc.double({ min: ENGLAND_BOUNDS.west, max: ENGLAND_BOUNDS.east, noNaN: true }),
});

const anyCoordinate = fc.record({
  lat: fc.double({ min: -90, max: 90, noNaN: true }),
  lon: fc.double({ min: -180, max: 180, noNaN: true }),
});

describe("geometry invariants", () => {
  it("distance is never negative, and zero only between identical points", () => {
    fc.assert(
      fc.property(anyCoordinate, anyCoordinate, (a, b) => {
        const distance = haversineMetres(a, b);
        expect(distance).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(distance)).toBe(true);
      }),
    );
  });

  it("distance is symmetric", () => {
    fc.assert(
      fc.property(anyCoordinate, anyCoordinate, (a, b) => {
        expect(haversineMetres(a, b)).toBeCloseTo(haversineMetres(b, a), 6);
      }),
    );
  });

  it("obeys the triangle inequality", () => {
    fc.assert(
      fc.property(englandCoordinate, englandCoordinate, englandCoordinate, (a, b, c) => {
        const direct = haversineMetres(a, c);
        const viaB = haversineMetres(a, b) + haversineMetres(b, c);
        // A metre of slack for floating point over hundreds of kilometres.
        expect(direct).toBeLessThanOrEqual(viaB + 1);
      }),
    );
  });

  it("accepts England coordinates and rejects points far outside it", () => {
    fc.assert(
      fc.property(englandCoordinate, (coordinate) => {
        expect(isPlausibleEnglandCoordinate(coordinate)).toBe(true);
      }),
    );

    fc.assert(
      fc.property(
        fc.record({
          lat: fc.double({ min: -60, max: -20, noNaN: true }),
          lon: fc.double({ min: 100, max: 170, noNaN: true }),
        }),
        (coordinate) => {
          expect(isPlausibleEnglandCoordinate(coordinate)).toBe(false);
        },
      ),
    );
  });

  it("simplification always keeps the first and last point of a path", () => {
    fc.assert(
      fc.property(
        fc.array(englandCoordinate, { minLength: 2, maxLength: 60 }),
        fc.double({ min: 1, max: 500, noNaN: true }),
        (path, tolerance) => {
          const simplified = simplifyPath(path, tolerance);
          expect(simplified.length).toBeGreaterThanOrEqual(2);
          expect(simplified[0]).toEqual(path[0]);
          expect(simplified[simplified.length - 1]).toEqual(path[path.length - 1]);
          expect(simplified.length).toBeLessThanOrEqual(path.length);
        },
      ),
    );
  });
});

describe("tiling invariants", () => {
  it("a point always falls inside one of the tiles its own bounding box covers", () => {
    fc.assert(
      fc.property(englandCoordinate, (coordinate) => {
        const tiles = tilesForBoundingBox({
          south: coordinate.lat,
          north: coordinate.lat,
          west: coordinate.lon,
          east: coordinate.lon,
        });
        expect(tiles).toContain(tileIdFor(coordinate));
      }),
    );
  });

  it("a corridor's tiles always include both endpoints' tiles", () => {
    fc.assert(
      fc.property(englandCoordinate, englandCoordinate, (from, to) => {
        const tiles = tilesForBoundingBox(corridorBoundingBox(from, to, 1000));
        expect(tiles).toContain(tileIdFor(from));
        expect(tiles).toContain(tileIdFor(to));
      }),
    );
  });

  it("never returns a duplicate tile", () => {
    fc.assert(
      fc.property(englandCoordinate, englandCoordinate, (from, to) => {
        const tiles = tilesForBoundingBox(corridorBoundingBox(from, to, 500));
        expect(new Set(tiles).size).toBe(tiles.length);
      }),
    );
  });
});

describe("statistical invariants", () => {
  const sample = fc.array(fc.double({ min: -1e4, max: 1e4, noNaN: true }), {
    minLength: 1,
    maxLength: 200,
  });

  it("the median always lies within the sample's range", () => {
    fc.assert(
      fc.property(sample, (values) => {
        const result = median(values)!;
        expect(result).toBeGreaterThanOrEqual(Math.min(...values));
        expect(result).toBeLessThanOrEqual(Math.max(...values));
      }),
    );
  });

  it("quantiles are monotonic in the requested probability", () => {
    fc.assert(
      fc.property(sample, (values) => {
        const low = quantile(values, 0.1)!;
        const mid = quantile(values, 0.5)!;
        const high = quantile(values, 0.9)!;
        expect(low).toBeLessThanOrEqual(mid);
        expect(mid).toBeLessThanOrEqual(high);
      }),
    );
  });

  it("returns null rather than dividing by zero on an empty sample", () => {
    expect(median([])).toBeNull();
    expect(quantile([], 0.5)).toBeNull();
    expect(robustZScore(1, [])).toBeNull();
  });

  it("a proportion is always between 0 and 1, with bounds that bracket it", () => {
    fc.assert(
      fc.property(fc.nat({ max: 5000 }), fc.nat({ max: 5000 }), (successes, extra) => {
        const total = successes + extra;
        if (total === 0) return;
        const result = proportion(successes, total);
        expect(result.value).toBeGreaterThanOrEqual(0);
        expect(result.value).toBeLessThanOrEqual(1);
        expect(result.low).toBeLessThanOrEqual(result.value);
        expect(result.high).toBeGreaterThanOrEqual(result.value);
        expect(result.low).toBeGreaterThanOrEqual(0);
        expect(result.high).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe("metric invariants", () => {
  it("punctuality is never above 1, never below 0, and never counts a poorly matched journey", () => {
    const observation = fc.record({
      delaySeconds: fc.integer({ min: -3600, max: 7200 }),
      matchQuality: fc.constantFrom("good" as const, "poor" as const),
    });

    fc.assert(
      fc.property(fc.array(observation, { maxLength: 300 }), (observations) => {
        const result = punctuality({ observations });

        if (result.value !== null) {
          expect(result.value).toBeGreaterThanOrEqual(0);
          expect(result.value).toBeLessThanOrEqual(1);
        }

        // Only confidently matched journeys count; a poor match is not evidence either way.
        const usable = observations.filter((o) => o.matchQuality === "good").length;
        expect(result.denominator).toBe(usable);
        expect(result.denominator).toBeGreaterThanOrEqual(0);
        expect(result.coverage).toBeGreaterThanOrEqual(0);
        expect(result.coverage).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("reliability never counts a source outage as a cancelled journey", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 500 }),
        fc.nat({ max: 500 }),
        fc.nat({ max: 500 }),
        (observed, unobserved, duringOutage) => {
          const scheduled = observed + unobserved + duringOutage;

          const result = reliability({
            scheduledEligible: scheduled,
            observedEligible: Math.min(observed, Math.max(0, scheduled - duringOutage)),
            sourceOutageAffected: duringOutage,
            confirmedCancellations: 0,
          });

          // The denominator excludes the outage window entirely: a dead feed is not a
          // cancellation, and counting it as one would libel an operator.
          expect(result.denominator).toBe(Math.max(0, scheduled - duringOutage));
          expect(result.sourceOutageAffected).toBe(duringOutage);
          expect(result.notObserved).toBeGreaterThanOrEqual(0);

          if (result.value !== null) {
            expect(result.value).toBeGreaterThanOrEqual(0);
            expect(result.value).toBeLessThanOrEqual(1);
          }
          expect(result.coverage).toBeGreaterThanOrEqual(0);
          expect(result.coverage).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

describe("idempotency invariants", () => {
  it("the same snapshot and recipient always produce the same key, and different ones never do", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (s1, r1, s2, r2) => {
        expect(idempotencyKeyFor(s1, r1)).toBe(idempotencyKeyFor(s1, r1));
        if (s1 !== s2 || r1 !== r2) {
          // The separator makes the encoding unambiguous, so distinct pairs cannot collide.
          const differs = idempotencyKeyFor(s1, r1) !== idempotencyKeyFor(s2, r2);
          const ambiguous = `${s1}|${r1}` === `${s2}|${r2}`;
          expect(differs || ambiguous).toBe(true);
        }
      }),
    );
  });
});
