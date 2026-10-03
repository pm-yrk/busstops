import { describe, expect, it } from "vitest";
import type { PatternGeometry } from "@busstops/matching";
import {
  distinguishVariantDescriptions,
  routeVariants,
  type RouteStop,
} from "./network-queries.js";

/**
 * A route page's whole job is the ordered sequence of stops, and the selector that chooses between
 * sequences has to be honest about what it is offering.
 *
 * A description is built from the first and last stop, so a short working, a branch and the full
 * route often come out identically — the same words three times over, from patterns that call at
 * very different sets of stops. A selector offering the same words three times tells a passenger
 * the choice does not matter, when it decides whether their stop is on the list at all.
 */
function stop(id: string, name: string): RouteStop {
  return {
    id,
    atcoCode: `ATCO${id}`,
    name,
    locationCoordinate: { lat: 53.8, lon: -1.5 },
  } as RouteStop;
}

function pattern(id: string, stopIds: readonly string[], direction = "outbound"): PatternGeometry {
  return {
    pattern: {
      id,
      serviceRouteId: "service-1",
      direction,
      stopSequence: [...stopIds],
      distanceMetres: stopIds.length * 400,
    },
  } as unknown as PatternGeometry;
}

const stopsById = new Map<string, RouteStop>([
  ["a", stop("a", "Leeds City Bus Station")],
  ["b", stop("b", "Hunslet")],
  ["c", stop("c", "Middleton")],
  ["d", stop("d", "Beeston")],
]);

describe("the stop sequence a route page shows", () => {
  it("keeps the timetable's own order, not the stops' names or positions", () => {
    const [variant] = routeVariants([pattern("p1", ["a", "d", "b", "c"])], stopsById);
    expect(variant?.stops.map((entry) => entry.name)).toEqual([
      "Leeds City Bus Station",
      "Beeston",
      "Hunslet",
      "Middleton",
    ]);
    // Numbered from zero, strictly increasing: the claim the deployed check also makes.
    expect(variant?.stops.map((entry) => entry.sequence)).toEqual([0, 1, 2, 3]);
  });

  it("names the route by where it starts and ends", () => {
    const [variant] = routeVariants([pattern("p1", ["a", "b", "d"])], stopsById);
    expect(variant?.description).toBe("Leeds City Bus Station to Beeston");
  });
});

describe("telling two variants apart", () => {
  it("adds the stop count when the words alone would be identical", () => {
    const variants = distinguishVariantDescriptions(
      routeVariants(
        [pattern("full", ["a", "b", "c", "d"]), pattern("short", ["a", "d"])],
        stopsById,
      ),
    );
    expect(variants.map((variant) => variant.description)).toEqual([
      "Leeds City Bus Station to Beeston · 4 stops",
      "Leeds City Bus Station to Beeston · 2 stops",
    ]);
  });

  it("leaves a route with one pattern per direction in plain words", () => {
    const variants = distinguishVariantDescriptions(
      routeVariants(
        [pattern("out", ["a", "b", "d"]), pattern("back", ["d", "b", "a"], "inbound")],
        stopsById,
      ),
    );
    expect(variants.map((variant) => variant.description)).toEqual([
      "Beeston to Leeds City Bus Station",
      "Leeds City Bus Station to Beeston",
    ]);
  });

  /*
   * Same words, different directions, is not a collision: the direction already tells them apart,
   * and a passenger reading "outbound" and "inbound" is not confused by the termini repeating.
   */
  it("does not count a shared description across directions as a collision", () => {
    const variants = distinguishVariantDescriptions(
      routeVariants(
        [pattern("out", ["a", "d"]), pattern("back", ["a", "d"], "inbound")],
        stopsById,
      ),
    );
    expect(variants.every((variant) => !variant.description.includes("·"))).toBe(true);
  });
});
