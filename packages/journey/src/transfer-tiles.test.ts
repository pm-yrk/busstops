import { describe, expect, it } from "vitest";
import { tileIdFor } from "@busstops/pipeline-core";
import {
  buildTransferAdjacency,
  buildTransferTiles,
  mergeTransferTiles,
  walkSecondsBetween,
  type JourneyStopLike,
  type TransferAdjacency,
} from "./transfers.js";

/**
 * The published transfers must be the transfers.
 *
 * Walking transfers move out of the request and into the publish because stops do not move, and
 * the saving is worth nothing if the artifact disagrees with what the request would have computed.
 * The risks are specific and all of them are about the tiling: an edge lost because its two ends
 * are in different tiles, an edge offered to a corridor that does not hold its far end, a cost
 * that changed, or a cap that means something different on one side of a boundary.
 *
 * So the oracle here is not the grid — it is every pair, measured directly. The grid is itself
 * held to that oracle in `route-scan.test.ts`; this file holds the *published tiles plus the
 * reader's merge* to it, which is the path a passenger's journey actually takes.
 */

const CAP = 600;
/* A quarter of a degree: the grid the stops, the trips and the transfers are all filed on. */
const TILE_DEGREES = 0.25;
const tileOf = (stop: JourneyStopLike): string => tileIdFor(stop.coordinate, TILE_DEGREES);

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
 * Stops scattered across several tiles, deliberately clustered on the boundaries.
 *
 * A uniform scatter would mostly test interiors, and the interiors are not where a tiled artifact
 * goes wrong. Half of these sit within a few hundred metres of a tile edge, which is where an edge
 * has one end in one tile and the other in the next.
 */
function scatter(count: number, seed: number): JourneyStopLike[] {
  const random = mulberry32(seed);
  const stops: JourneyStopLike[] = [];
  for (let at = 0; at < count; at += 1) {
    const onBoundary = random() < 0.5;
    /* Tile edges fall on multiples of a quarter degree. */
    const lat = onBoundary
      ? 53.5 + Math.floor(random() * 3) * TILE_DEGREES + (random() - 0.5) * 0.01
      : 53.5 + random() * 3 * TILE_DEGREES;
    const lon = onBoundary
      ? -2.5 + Math.floor(random() * 3) * TILE_DEGREES + (random() - 0.5) * 0.01
      : -2.5 + random() * 3 * TILE_DEGREES;
    stops.push({ id: `s${String(at).padStart(4, "0")}`, coordinate: { lat, lon } });
  }
  return stops;
}

/** Every pair, measured. The oracle. */
function allPairs(stops: readonly JourneyStopLike[], cap: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const from of stops) {
    const list: string[] = [];
    for (const to of stops) {
      if (to.id === from.id) continue;
      const seconds = walkSecondsBetween(from.coordinate, to.coordinate);
      if (seconds <= cap) list.push(`${to.id}@${String(seconds)}`);
    }
    out.set(from.id, list.sort());
  }
  return out;
}

/** What one stop reaches, as the search would read it. */
function reaches(adjacency: TransferAdjacency, stopId: string): string[] {
  const at = adjacency.indexOf(stopId);
  if (at < 0) return [];
  const out: string[] = [];
  for (let edge = adjacency.offsets[at]!; edge < adjacency.offsets[at + 1]!; edge += 1) {
    out.push(
      `${adjacency.stopIds[adjacency.neighbours[edge]!]!}@${String(adjacency.seconds[edge]!)}`,
    );
  }
  return out;
}

describe("walking transfers, published per tile", () => {
  it("gives a corridor exactly what measuring every pair gives it", () => {
    for (const seed of [1, 5, 23, 77]) {
      const stops = scatter(500, seed);
      const tiles = buildTransferTiles(stops, { capSeconds: CAP, tileOf });
      expect(tiles.length, `seed ${String(seed)}`).toBeGreaterThan(1);

      /* A corridor: every stop in two neighbouring tiles, which is where the halo has to work. */
      const corridorTiles = tiles.slice(0, 2).map((plan) => plan.tile);
      const corridor = stops.filter((stop) => corridorTiles.includes(tileOf(stop)));
      expect(corridor.length).toBeGreaterThan(10);

      const fromArtifact = mergeTransferTiles(
        corridor.map((stop) => stop.id),
        tiles
          .filter((plan) => corridorTiles.includes(plan.tile))
          .map((plan) => ({ ...plan, capSeconds: CAP })),
        CAP,
      );
      expect(fromArtifact).not.toBeNull();

      const oracle = allPairs(corridor, CAP);
      for (const stop of corridor) {
        expect(
          [...reaches(fromArtifact!, stop.id)].sort(),
          `seed ${String(seed)} at ${stop.id}`,
        ).toEqual(oracle.get(stop.id));
      }
    }
  });

  it("agrees with the corridor's own builder, edge for edge and in the same order", () => {
    const stops = scatter(600, 11);
    const tiles = buildTransferTiles(stops, { capSeconds: CAP, tileOf });
    /* The whole set as one corridor, so every tile is read. */
    const ids = stops.map((stop) => stop.id);
    const fromArtifact = mergeTransferTiles(
      ids,
      tiles.map((plan) => ({ ...plan, capSeconds: CAP })),
      CAP,
    )!;
    const built = buildTransferAdjacency(stops, CAP);

    expect(fromArtifact.edgeCount).toBe(built.edgeCount);
    for (const id of ids) {
      /* Order included: the search's tie-breaking must not depend on which one answered. */
      expect(reaches(fromArtifact, id), `at ${id}`).toEqual(reaches(built, id));
    }
  });

  it("loses nothing to a tile boundary", () => {
    /* Two stops 200 m apart with the boundary between them: one tile must carry the edge. */
    const west: JourneyStopLike = { id: "west", coordinate: { lat: 53.5001, lon: -2.2501 } };
    const east: JourneyStopLike = { id: "east", coordinate: { lat: 53.5001, lon: -2.2499 } };
    expect(tileOf(west)).not.toBe(tileOf(east));

    const tiles = buildTransferTiles([west, east], { capSeconds: CAP, tileOf });
    const merged = mergeTransferTiles(
      ["west", "east"],
      tiles.map((plan) => ({ ...plan, capSeconds: CAP })),
      CAP,
    )!;
    expect(reaches(merged, "west")).toHaveLength(1);
    expect(reaches(merged, "east")).toHaveLength(1);
    expect(merged.edgeCount).toBe(2);
  });

  it("offers a corridor no edge to a stop it does not hold", () => {
    const stops = scatter(400, 31);
    const tiles = buildTransferTiles(stops, { capSeconds: CAP, tileOf });
    const corridorTile = tiles[0]!.tile;
    const corridor = stops.filter((stop) => tileOf(stop) === corridorTile);
    const held = new Set(corridor.map((stop) => stop.id));

    const merged = mergeTransferTiles(
      corridor.map((stop) => stop.id),
      tiles
        .filter((plan) => plan.tile === corridorTile)
        .map((plan) => ({ ...plan, capSeconds: CAP })),
      CAP,
    )!;
    for (let edge = 0; edge < merged.edgeCount; edge += 1) {
      expect(held.has(merged.stopIds[merged.neighbours[edge]!]!)).toBe(true);
    }
  });

  it("refuses tiles built for a different walking cap", () => {
    const stops = scatter(120, 41);
    const tiles = buildTransferTiles(stops, { capSeconds: 300, tileOf });
    const merged = mergeTransferTiles(
      stops.map((stop) => stop.id),
      tiles.map((plan) => ({ ...plan, capSeconds: 300 })),
      CAP,
    );
    /* An adjacency built for a five-minute walk cannot answer a ten-minute question. */
    expect(merged).toBeNull();
  });

  it("holds the cap exactly, at the second", () => {
    /* Two stops whose walk is one second inside the cap, and two one second outside. */
    const metres = CAP * 1.3;
    const degrees = (metres - 2) / 111_320;
    const near: JourneyStopLike[] = [
      { id: "a", coordinate: { lat: 53.5, lon: -2.3 } },
      { id: "b", coordinate: { lat: 53.5 + degrees, lon: -2.3 } },
    ];
    const far: JourneyStopLike[] = [
      { id: "a", coordinate: { lat: 53.5, lon: -2.3 } },
      { id: "b", coordinate: { lat: 53.5 + (metres + 20) / 111_320, lon: -2.3 } },
    ];
    expect(walkSecondsBetween(near[0]!.coordinate, near[1]!.coordinate)).toBeLessThanOrEqual(CAP);
    expect(walkSecondsBetween(far[0]!.coordinate, far[1]!.coordinate)).toBeGreaterThan(CAP);

    for (const [stops, expected] of [
      [near, 2],
      [far, 0],
    ] as const) {
      const tiles = buildTransferTiles(stops, { capSeconds: CAP, tileOf });
      const merged = mergeTransferTiles(
        stops.map((stop) => stop.id),
        tiles.map((plan) => ({ ...plan, capSeconds: CAP })),
        CAP,
      )!;
      expect(merged.edgeCount).toBe(expected);
    }
  });

  it("files a stop by where it is, so its tile is the one a corridor reads", () => {
    const stops = scatter(300, 53);
    const tiles = buildTransferTiles(stops, { capSeconds: CAP, tileOf });
    const own = new Map<string, number>();
    for (const plan of tiles) own.set(plan.tile, plan.ownStops);
    for (const stop of stops) {
      expect(own.get(tileOf(stop)) ?? 0, `${stop.id} in ${tileOf(stop)}`).toBeGreaterThan(0);
    }
    /* Every stop's own tile carries its complete list, which is the halo argument. */
    expect([...own.values()].reduce((total, count) => total + count, 0)).toBe(stops.length);
  });
});
