import { describe, expect, it } from "vitest";
import {
  ArtifactStore,
  InMemoryObjectStore,
  haversineMetres,
  objectKeyFor,
} from "@busstops/pipeline-core";
import {
  MAP_STOP_TILE_DEGREES,
  currentArtifactLayout,
  SHARDED,
  mapStopsDataset,
  type MapStopRow,
  type NetworkIndexRecord,
} from "@busstops/pipeline-static-network";
import { NetworkReader } from "./network-reader.js";
import { ReadLedger } from "./read-ledger.js";

/**
 * What a city viewport costs, asserted on access rather than on a clock.
 *
 * A Manchester viewport holds 3,006 projection rows inside the box and the map draws four hundred
 * of them. The read that this replaces was proportional to the first number: it fetched every tile
 * the box covered, walked 878,854 characters, built a row object for each, took a haversine to all
 * of them and sorted the lot before discarding five sixths. Cloudflare measured `/v1/map` at 38 ms
 * against a ten-millisecond limit, and no byte budget addresses that, because the bytes are what
 * the viewport genuinely contains.
 *
 * So what is asserted here is the shape: the same four hundred markers, out of a read that does
 * not open the tiles it cannot use and does not parse the rows it will not draw. A change that
 * reintroduced the proportional read would still return the right markers and would fail here.
 */

const GRID = MAP_STOP_TILE_DEGREES;
const VERSION = "v1";

/** Twenty rows per tile over a square of tiles, so the box genuinely spans many objects. */
async function syntheticProjection(tilesAcross: number, rowsPerTile: number) {
  const store = new InMemoryObjectStore();
  const fetched: string[] = [];
  const baseLat = Math.floor(53.48 / GRID);
  const baseLon = Math.floor(-2.24 / GRID);
  const rows: MapStopRow[] = [];
  const tiles: string[] = [];

  for (let dLat = 0; dLat < tilesAcross; dLat++) {
    for (let dLon = 0; dLon < tilesAcross; dLon++) {
      const tile = `${String(baseLat + dLat)}_${String(baseLon + dLon)}`;
      tiles.push(tile);
      const lines: string[] = [];
      for (let n = 0; n < rowsPerTile; n++) {
        /* Spread inside the tile, deterministically, and never on its edge. */
        const fLat = ((n * 7 + 3) % 19) / 19;
        const fLon = ((n * 11 + 5) % 17) / 17;
        const row: MapStopRow = {
          i: `stop-${tile}-${String(n).padStart(3, "0")}`,
          a: `ATCO${tile}${String(n)}`,
          n: `Stop ${String(n)} in ${tile}`,
          y: (baseLat + dLat + 0.02 + fLat * 0.96) * GRID,
          x: (baseLon + dLon + 0.02 + fLon * 0.96) * GRID,
          r: ["1", "42A"],
        };
        rows.push(row);
        lines.push(JSON.stringify(row));
      }
      await store.put(objectKeyFor(mapStopsDataset(tile), VERSION), `${lines.join("\n")}\n`);
    }
  }

  const index: NetworkIndexRecord = {
    version: VERSION,
    layout: { ...currentArtifactLayout(), mapStopTileDegrees: GRID },
    publishedAt: "2026-10-27T00:00:00.000Z",
    partialCoverage: false,
    stopTiles: [],
    patternTiles: [],
    searchTiles: [],
    searchPrefixes: [],
    mapStopTiles: tiles,
    counts: { stops: rows.length, patterns: 0, services: 0, searchEntries: 0 },
  };
  await new ArtifactStore(store).publish({
    dataset: SHARDED.index,
    version: VERSION,
    records: [index],
    schemaVersion: "1",
  });

  const recording = {
    async get(key: string) {
      fetched.push(key);
      return store.get(key);
    },
    async getStream(key: string) {
      fetched.push(key);
      return store.getStream(key);
    },
    put: store.put.bind(store),
    delete: store.delete.bind(store),
    list: store.list.bind(store),
    listDetailed: store.listDetailed?.bind(store),
  };

  return { store: recording, fetched, rows, tiles };
}

/** The ranking the selection replaces: every row in the box, haversined, sorted and cut. */
function oracle(
  rows: readonly MapStopRow[],
  bbox: { west: number; south: number; east: number; north: number },
  limit: number,
): string[] {
  const centre = { lat: (bbox.north + bbox.south) / 2, lon: (bbox.east + bbox.west) / 2 };
  return rows
    .filter((row) => row.y >= bbox.south && row.y <= bbox.north)
    .filter((row) => row.x >= bbox.west && row.x <= bbox.east)
    .map((row) => ({ row, metres: haversineMetres(centre, { lat: row.y, lon: row.x }) }))
    .sort((a, b) => (a.metres === b.metres ? (a.row.i < b.row.i ? -1 : 1) : a.metres - b.metres))
    .slice(0, limit)
    .map((entry) => entry.row.i);
}

function boxOf(tilesAcross: number) {
  const baseLat = Math.floor(53.48 / GRID);
  const baseLon = Math.floor(-2.24 / GRID);
  /*
   * A hair inside the far edges, so the box covers exactly `tilesAcross` squares per axis rather
   * than one more. Landing on a boundary would ask for thirty-six tiles against the
   * thirty-two-per-request cap, and the viewport would report itself too wide for a reason that
   * has nothing to do with what is being tested.
   */
  const inside = 1e-9;
  return {
    south: baseLat * GRID,
    north: (baseLat + tilesAcross) * GRID - inside,
    west: baseLon * GRID,
    east: (baseLon + tilesAcross) * GRID - inside,
  };
}

describe("a city viewport over a projection larger than it draws", () => {
  const ACROSS = 5;
  const PER_TILE = 60;

  it("draws exactly the markers the full ranking would", async () => {
    const { store, rows } = await syntheticProjection(ACROSS, PER_TILE);
    const bbox = boxOf(ACROSS);
    const drawn = await new NetworkReader(store).mapStopsInBoundingBox(bbox, 400);
    expect(drawn).not.toBeNull();
    expect(drawn!.stops.map((stop) => stop.id)).toEqual(oracle(rows, bbox, 400));
  });

  it("does not open the tiles that cannot hold a marker it would keep", async () => {
    const { store, fetched, tiles } = await syntheticProjection(ACROSS, PER_TILE);
    await new NetworkReader(store).mapStopsInBoundingBox(boxOf(ACROSS), 400);
    const opened = fetched.filter((key) => key.includes("map-stops")).length;
    expect(opened).toBeGreaterThan(0);
    /* Four hundred markers out of 1,500 rows: most of the box cannot contribute one. */
    expect(opened).toBeLessThan(tiles.length);
  });

  it("opens only the middle of a dense screen, which is where a city viewport lives", async () => {
    /*
     * Four hundred rows a tile, which is the density the published projection actually has: a
     * Manchester screen holds 3,006 rows across about eight tiles. The markers are all found in
     * the first tiles over the middle of the box, and everything beyond them is provably further
     * away than the worst of those markers — so it is never fetched.
     */
    const { store, fetched, rows, tiles } = await syntheticProjection(5, 400);
    const bbox = boxOf(5);
    const drawn = await new NetworkReader(store).mapStopsInBoundingBox(bbox, 400);
    expect(drawn!.stops.map((stop) => stop.id)).toEqual(oracle(rows, bbox, 400));
    const opened = fetched.filter((key) => key.includes("map-stops")).length;
    expect(opened).toBeLessThanOrEqual(4);
    expect(tiles).toHaveLength(25);
  });

  it("parses only the rows it draws, not the rows the box contains", async () => {
    const { store } = await syntheticProjection(ACROSS, PER_TILE);
    const ledger = new ReadLedger(5_000);
    const drawn = await new NetworkReader(store).mapStopsInBoundingBox(
      boxOf(ACROSS),
      400,
      Date.now(),
      ledger,
    );
    const stops = ledger.toJSON().families.stops;
    expect(drawn!.stops).toHaveLength(400);
    /*
     * The stream parses nothing at all: the selection reads each row's coordinates out of the raw
     * line and keeps the line's text, and only the four hundred survivors are ever parsed.
     */
    expect(stops?.stream?.linesParsed ?? -1).toBe(0);
    expect(stops?.records).toBe(400);
    expect(stops?.stream?.linesScanned ?? 0).toBeGreaterThan(400);
  });

  it("says it is truncated, because the cap bound the answer", async () => {
    const { store } = await syntheticProjection(ACROSS, PER_TILE);
    const drawn = await new NetworkReader(store).mapStopsInBoundingBox(boxOf(ACROSS), 400);
    expect(drawn!.truncated).toBe(true);
    expect(drawn!.tooWide).toBe(false);
  });

  it("reads every tile and reports no truncation when the box fits under the cap", async () => {
    const { store, fetched, rows, tiles } = await syntheticProjection(3, 10);
    const bbox = boxOf(3);
    const drawn = await new NetworkReader(store).mapStopsInBoundingBox(bbox, 400);
    expect(drawn!.stops.map((stop) => stop.id)).toEqual(oracle(rows, bbox, 400));
    expect(drawn!.stops).toHaveLength(rows.length);
    expect(drawn!.truncated).toBe(false);
    const opened = fetched.filter((key) => key.includes("map-stops")).length;
    expect(opened).toBe(tiles.length);
  });

  it("keeps the passenger fields on every marker it builds", async () => {
    const { store } = await syntheticProjection(2, 5);
    const drawn = await new NetworkReader(store).mapStopsInBoundingBox(boxOf(2), 400);
    for (const stop of drawn!.stops) {
      expect(stop.id).toMatch(/^stop-/);
      expect(stop.atcoCode).toMatch(/^ATCO/);
      expect(stop.name.length).toBeGreaterThan(0);
      expect(stop.routePublicNames).toEqual(["1", "42A"]);
      expect(Number.isFinite(stop.locationCoordinate.lat)).toBe(true);
      expect(Number.isFinite(stop.locationCoordinate.lon)).toBe(true);
    }
  });

  it("still reads the whole corridor for a caller whose limit is a safety bound", async () => {
    const { store, fetched, rows, tiles } = await syntheticProjection(ACROSS, PER_TILE);
    const bbox = boxOf(ACROSS);
    const drawn = await new NetworkReader(store).mapStopsInBoundingBox(bbox, 20_000);
    expect(drawn!.stops).toHaveLength(rows.length);
    expect(drawn!.truncated).toBe(false);
    const opened = fetched.filter((key) => key.includes("map-stops")).length;
    expect(opened).toBe(tiles.length);
  });
});
