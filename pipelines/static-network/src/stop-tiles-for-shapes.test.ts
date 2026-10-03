import { describe, expect, it } from "vitest";
import type { Coordinate } from "@busstops/contracts";
import { STOP_TILE_DEGREES, stopTilesForShape, stopTilesForShapes } from "./shards.js";

/**
 * The tiles a route's shapes reach, and the claim that skipping points does not change them.
 *
 * Route detail asks this question and run 95 measured it killing the endpoint: the breadcrumb
 * reached `route:patterns:done@115` with six patterns resolved and never reached the next stage.
 * The old version did four `tileIdFor` calls per shape point, each building a string and inserting
 * it into a set, over every point of every pattern — a few hundred thousand of them for a long
 * interurban service, inside a Worker with ten milliseconds of CPU.
 *
 * A tile is a quarter of a degree and consecutive points are metres apart, so a point is skipped
 * while it is within half the margin of the last one used. These tests are the argument for why
 * that is safe, checked rather than asserted in prose: the sampled answer is compared against the
 * exhaustive one on shapes built to be awkward.
 */

/** Every point visited, four corners each — what the function used to do, kept as the oracle. */
function exhaustive(shapes: readonly (readonly Coordinate[])[], marginDegrees = 0.01): string[] {
  const tiles = new Set<string>();
  for (const shape of shapes) {
    for (const point of shape) {
      for (const lat of [point.lat - marginDegrees, point.lat + marginDegrees]) {
        for (const lon of [point.lon - marginDegrees, point.lon + marginDegrees]) {
          // The same arithmetic `tileIdFor` performs, through the public function on one point.
          tiles.add(stopTilesForShape([{ lat, lon }], 0)[0]!);
        }
      }
    }
  }
  return [...tiles].sort();
}

/** A dense line between two points, at roughly the spacing a published polyline has. */
function denseLine(from: Coordinate, to: Coordinate, points: number): Coordinate[] {
  return Array.from({ length: points }, (_, index) => {
    const at = index / (points - 1);
    return { lat: from.lat + (to.lat - from.lat) * at, lon: from.lon + (to.lon - from.lon) * at };
  });
}

describe("the stop tiles a route's shapes reach", () => {
  it("agrees with visiting every point, on a long dense cross-country line", () => {
    // Leeds to Scarborough, 4,000 points: about the shape of a Coastliner pattern.
    const shape = denseLine({ lat: 53.7965, lon: -1.5478 }, { lat: 54.2838, lon: -0.4053 }, 4_000);
    expect(stopTilesForShapes([shape])).toEqual(exhaustive([shape]));
  });

  it("agrees across several patterns of one service", () => {
    const shapes = [
      denseLine({ lat: 53.7965, lon: -1.5478 }, { lat: 53.9591, lon: -1.0815 }, 1_500),
      denseLine({ lat: 53.9591, lon: -1.0815 }, { lat: 53.7965, lon: -1.5478 }, 1_500),
      denseLine({ lat: 53.8, lon: -1.55 }, { lat: 53.81, lon: -1.52 }, 300),
    ];
    expect(stopTilesForShapes(shapes)).toEqual(exhaustive(shapes));
  });

  /*
   * The case sampling could get wrong: a shape that steps straight across a tile boundary. Built
   * so the crossing falls between two points that are far enough apart to both be used, and again
   * so it falls between points close enough that one is skipped.
   */
  it("does not lose a tile the route only just enters", () => {
    const boundary = Math.ceil(53.8 / STOP_TILE_DEGREES) * STOP_TILE_DEGREES;
    for (const spacing of [0.0001, 0.001, 0.004, 0.02]) {
      const shape = Array.from({ length: 200 }, (_, index) => ({
        lat: boundary - 0.05 + index * spacing,
        lon: -1.5,
      }));
      expect(stopTilesForShapes([shape]), `spacing ${spacing}`).toEqual(exhaustive([shape]));
    }
  });

  it("keeps the ends of a shape, where a route reaches furthest", () => {
    // Two points far apart: the ends are all there is, and both must count.
    const shape = [
      { lat: 53.0, lon: -1.0 },
      { lat: 54.9, lon: -2.9 },
    ];
    expect(stopTilesForShapes([shape])).toEqual(exhaustive([shape]));
  });

  it("answers for an empty shape without inventing a tile", () => {
    expect(stopTilesForShapes([[]])).toEqual([]);
    expect(stopTilesForShapes([])).toEqual([]);
  });

  /*
   * And the saving, as the measurement it actually is rather than the one I guessed.
   *
   * On this shape — Leeds to Scarborough at 4,000 points, about a Coastliner pattern — the sampled
   * walk uses **224** of them. That is a factor of eighteen, not the twenty I first asserted here,
   * and the bound below is the measured figure with room rather than a round number the code has
   * to live up to. A long service has several such patterns, so the saving multiplies.
   */
  it("visits a small fraction of a published polyline's points", () => {
    const shape = denseLine({ lat: 53.7965, lon: -1.5478 }, { lat: 54.2838, lon: -0.4053 }, 4_000);
    let used = 0;
    let last: Coordinate | null = null;
    const step = 0.01 / 2;
    for (let at = 0; at < shape.length; at += 1) {
      const point = shape[at]!;
      if (
        at === 0 ||
        at === shape.length - 1 ||
        last === null ||
        Math.abs(point.lat - last.lat) >= step ||
        Math.abs(point.lon - last.lon) >= step
      ) {
        used += 1;
        last = point;
      }
    }
    expect(used).toBeLessThan(shape.length / 10);
    // The measured number, so a change that quietly stopped sampling fails rather than passing a
    // threshold it happens to clear.
    expect(used).toBeLessThan(400);
  });
});
