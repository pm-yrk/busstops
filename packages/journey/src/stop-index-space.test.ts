import { describe, expect, it } from "vitest";
import { buildGraph, type JourneyStop, type Trip } from "./graph.js";
import { runRaptor } from "./raptor.js";

/**
 * The integer space the search runs in, and the three things that must be true about it.
 *
 * A round of RAPTOR is tens of thousands of label lookups — 42,924 offers and 49,179 transfer
 * edges for one Leeds plan — and each one used to hash a thirty-six character stop id. The labels
 * live in typed arrays over this space now, which is only sound if the space says what everyone
 * else says: a route's indices must name the route's stops, a stop's place in the transfer
 * adjacency must be the place the adjacency gives it, and a stop the search can reach must have
 * an index at all. Get any of them wrong and the planner answers confidently about the wrong
 * stop, which is the one failure mode worse than being slow.
 */

const DEPART = 8 * 3600;

function stop(id: string, lat: number, lon: number): JourneyStop {
  return { id, name: `Stop ${id}`, coordinate: { lat, lon } };
}

function trip(id: string, stopIds: readonly string[], first: number): Trip {
  return {
    id,
    routeId: "route-1",
    patternId: "pattern-1",
    routeName: "1",
    headsign: "Test",
    wholePatternSequence: true,
    stopTimes: stopIds.map((stopId, at) => ({
      stopId,
      arrivalSeconds: first + at * 300,
      departureSeconds: first + at * 300,
    })),
  };
}

describe("the stop space the search indexes", () => {
  const stops = [stop("a", 53.796, -1.549), stop("b", 53.799, -1.549), stop("c", 53.802, -1.549)];
  const trips = [
    trip("t-1", ["a", "b", "c"], DEPART + 600),
    trip("t-2", ["a", "b", "c"], DEPART + 1800),
  ];

  it("gives every stop one index, and every index its stop", () => {
    const graph = buildGraph({ stops, trips });
    expect(graph.stopIndexOf.size).toBe(graph.stopIdByIndex.length);
    graph.stopIdByIndex.forEach((stopId, index) => {
      expect(graph.stopIndexOf.get(stopId)).toBe(index);
    });
  });

  it("names the same stops in a route's indices as in its ids", () => {
    const graph = buildGraph({ stops, trips });
    expect(graph.routes.length).toBeGreaterThan(0);
    for (const route of graph.routes) {
      expect(route.stopIndices.length).toBe(route.stopIds.length);
      route.stopIds.forEach((stopId, at) => {
        expect(graph.stopIdByIndex[route.stopIndices[at]!]).toBe(stopId);
      });
    }
  });

  it("resolves each stop's place in the transfer adjacency once, and correctly", () => {
    const graph = buildGraph({ stops, trips });
    expect(graph.transferIndexByStop.length).toBe(graph.stopIdByIndex.length);
    graph.stopIdByIndex.forEach((stopId, index) => {
      expect(graph.transferIndexByStop[index]).toBe(graph.transfers.indexOf(stopId));
    });
  });

  it("indexes a stop a route calls at that the corridor never listed", () => {
    /*
     * The extension case. A caller can hand `buildGraph` trips that call somewhere its stop list
     * does not mention — a test fixture does it, and so would a corridor whose stop projection was
     * read short — and such a stop is still reachable by riding to it. Left out of the space, its
     * label would have nowhere to go.
     */
    const graph = buildGraph({ stops: stops.slice(0, 2), trips });
    expect(graph.stopIndexOf.has("c")).toBe(true);
    /* It has no walking edges, because it was not in the set the transfers were built over. */
    expect(graph.transferIndexByStop[graph.stopIndexOf.get("c")!]).toBe(-1);

    /* And it is reachable: the search labels it, by riding rather than by walking. */
    const result = runRaptor(graph, [{ stopId: "a", accessSeconds: 0 }], {
      departAtSeconds: DEPART,
    });
    expect(result.best.get("c")?.arrivalSeconds).toBe(DEPART + 600 + 600);
  });

  it("labels an origin with no index as unreachable rather than throwing", () => {
    /* A caller can ask to start from a stop the graph has never heard of. */
    const graph = buildGraph({ stops, trips });
    const result = runRaptor(graph, [{ stopId: "nowhere", accessSeconds: 0 }], {
      departAtSeconds: DEPART,
    });
    expect(result.best.size).toBe(0);
    expect(result.labelsByRound[0]?.size).toBe(0);
  });
});
