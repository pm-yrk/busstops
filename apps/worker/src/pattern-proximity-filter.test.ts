import { describe, expect, it } from "vitest";
import { ArtifactStore, InMemoryObjectStore, objectKeyFor } from "@busstops/pipeline-core";
import {
  SHARDED,
  patternTileDataset,
  patternTilesForBoundingBox,
  type NetworkIndexRecord,
  type PatternTileLine,
} from "@busstops/pipeline-static-network";
import { NetworkReader } from "./network-reader.js";
import { ReadLedger } from "./read-ledger.js";

/**
 * Building one pattern out of a tile instead of all of them.
 *
 * `/v1/vehicles/:ref` wants the pattern its bus is on. The read that identifies it opened a
 * pattern tile with no filter, so every shape and every pattern in that tile became objects:
 * 3,156,408 characters measured on the deployment for a tap in a dense city, three and a half
 * times the next largest passenger read and the biggest single allocation any request makes.
 *
 * Why the allocation and not the bytes is the thing to cut: identical requests pass on a fresh
 * isolate and fail on one that has served ninety, with nothing resident in any cache. Work that
 * is the same cannot explain that; a heap that has had a hundred multi-megabyte object graphs
 * through it can.
 *
 * These assert what is *built*, which is the part that matters and the part a test can see. The
 * characters walked are unchanged — the filter still reads the line to decide about it.
 */

const VERSION = "v1";
const BUS = { lat: 53.8, lon: -1.55 };

/** A polyline of `count` points marching north-east from a corner. */
function shapeFrom(corner: { lat: number; lon: number }, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    lat: Number((corner.lat + i * 0.001).toFixed(4)),
    lon: Number((corner.lon + i * 0.001).toFixed(4)),
  }));
}

function lines(): PatternTileLine[] {
  const near = shapeFrom({ lat: 53.79, lon: -1.56 }, 40);
  /*
   * Far enough to be outside any sane margin, and deliberately at a whole degree: an earlier
   * sketch of this filter matched `"lat":54.0` as a string prefix, and `JSON.stringify(54)` has
   * no decimal point at all — so a textual test would have dropped this shape for the wrong
   * reason and passed the test for the wrong reason too.
   */
  const far = shapeFrom({ lat: 54, lon: -2.6 }, 40);

  const pattern = (id: string, shapeRef: string): PatternTileLine => ({
    kind: "pattern",
    shapeRef,
    stopDistancesMetres: [0, 100],
    pattern: {
      id,
      serviceRouteId: `service-${id}`,
      direction: "outbound",
      stopSequence: [`stop-${id}-a`, `stop-${id}-b`],
    } as unknown as PatternTileLine extends { pattern: infer P } ? P : never,
  });

  return [
    { kind: "shape", shapeRef: "near", points: near },
    pattern("near-1", "near"),
    pattern("near-2", "near"),
    { kind: "shape", shapeRef: "far", points: far },
    pattern("far-1", "far"),
    pattern("far-2", "far"),
    pattern("far-3", "far"),
  ];
}

async function published() {
  const store = new InMemoryObjectStore();
  const artifacts = new ArtifactStore(store);
  const tiles = patternTilesForBoundingBox({
    west: -2.7,
    south: 53.7,
    east: -1.5,
    north: 54.1,
  });

  await artifacts.publish({
    dataset: SHARDED.index,
    version: VERSION,
    records: [
      {
        version: VERSION,
        publishedAt: "2026-10-22T00:00:00.000Z",
        partialCoverage: false,
        stopTiles: [],
        patternTiles: tiles,
        searchTiles: [],
        searchPrefixes: [],
      } as unknown as NetworkIndexRecord,
    ],
    schemaVersion: "1.0.0",
  });

  /*
   * Every tile gets the same lines. A shape is written into each tile its geometry crosses, so
   * this is the shape of the real family rather than a simplification of it.
   */
  const body = lines()
    .map((line) => JSON.stringify(line))
    .join("\n");
  for (const tile of tiles) {
    await store.put(objectKeyFor(patternTileDataset(tile), VERSION), body);
  }

  return { reader: new NetworkReader(store) };
}

const boxAround = (centre: { lat: number; lon: number }, degrees: number) => ({
  west: centre.lon - degrees,
  east: centre.lon + degrees,
  south: centre.lat - degrees,
  north: centre.lat + degrees,
});

describe("identifying one bus's pattern out of a tile", () => {
  it("builds only the patterns whose geometry passes near it", async () => {
    const { reader } = await published();
    const ledger = new ReadLedger(5_000);

    const built = await reader.patternsInBoundingBox(
      boxAround(BUS, 0.02),
      Date.now(),
      ledger,
      false,
      true,
    );

    const ids = [...new Set(built.map((geometry) => geometry.pattern.id))].sort();
    expect(ids, "the near shape's patterns, and nothing from the far one").toEqual([
      "near-1",
      "near-2",
    ]);
    /* And the geometry came with them: a match needs the line, not just the id. */
    expect(built[0]!.shape.length).toBeGreaterThan(1);
  });

  it("builds every pattern when the caller has not asked for one", async () => {
    const { reader } = await published();

    /*
     * The other caller is a viewport, which wants the whole slice. The filter is opt-in for
     * exactly this reason, and a default that quietly dropped patterns would take routes off the
     * map rather than making a bus tap cheaper.
     */
    const built = await reader.patternsInBoundingBox(
      boxAround(BUS, 0.02),
      Date.now(),
      new ReadLedger(5_000),
    );

    const ids = [...new Set(built.map((geometry) => geometry.pattern.id))].sort();
    expect(ids).toEqual(["far-1", "far-2", "far-3", "near-1", "near-2"]);
  });

  it("keeps a shape whose far end passes the bus, not only its first point", async () => {
    const { reader } = await published();

    /*
     * The near shape marches away from its corner, so a bus beside its *end* has to keep it too.
     * A filter that tested one point — the first, the midpoint, the bounding box of the corners —
     * would pass the test above and drop a bus three quarters of the way along its route, which
     * is where buses usually are.
     */
    const end = { lat: 53.79 + 39 * 0.001, lon: -1.56 + 39 * 0.001 };
    const built = await reader.patternsInBoundingBox(
      boxAround(end, 0.005),
      Date.now(),
      new ReadLedger(5_000),
      false,
      true,
    );

    expect([...new Set(built.map((geometry) => geometry.pattern.id))].sort()).toEqual([
      "near-1",
      "near-2",
    ]);
  });
});
