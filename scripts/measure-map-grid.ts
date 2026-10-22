#!/usr/bin/env node
/**
 * What each candidate map-projection grid would cost, measured against the published artifact.
 *
 * The map projection is the family `/v1/map`, `/v1/journeys`, `/v1/routes/:id` and `/v1/nearby`
 * all read, and at a quarter of a degree a Manchester viewport walks 2.18 MiB of it to draw four
 * hundred markers. The over-read is geometric — a quarter-degree tile is about 28km by 17km here
 * and a city viewport is a tenth of that — so the lever is the size of the square, and the cost of
 * a smaller one is objects to write against a publish that is already the longest step in its
 * workflow.
 *
 * Both sides of that trade had been estimated and neither had been measured. Three national builds
 * were spent finding out, two of them dying at a step limit with nothing published at all, which
 * is the most expensive way to ask a question that a single pass over 460 objects can answer. This
 * is that pass. It reads the live projection, re-files every row onto each candidate grid in
 * memory, and reports what the family would occupy and — the number that actually matters — what
 * each probe city's viewport would decode.
 *
 * It writes nothing. Retiling the published artifact is a separate act with its own safeguards;
 * this exists so that act is decided by a measurement.
 *
 *   npx tsx scripts/measure-map-grid.ts [--json map-grid.json]
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  mapWithConcurrency,
  objectKeyFor,
  r2StoreFromEnv,
  tileIdFor,
  annotateReport,
} from "@busstops/pipeline-core";
import {
  MAP_STOP_TILE_DEGREES,
  STOP_TILE_DEGREES,
  SHARDED,
  mapStopsDataset,
  mapStopTilesForBoundingBox,
  type MapStopRow,
  type NetworkIndexRecord,
} from "@busstops/pipeline-static-network";

const JSON_OUT = (() => {
  const index = process.argv.indexOf("--json");
  return index === -1 ? undefined : process.argv[index + 1];
})();

/** The grids a build may be asked for: the stop grid and the two squares that nest inside it. */
const CANDIDATES = [STOP_TILE_DEGREES, STOP_TILE_DEGREES / 2, STOP_TILE_DEGREES / 4];

/**
 * The same five cities the cold-serving walk uses, so the two measurements are comparable.
 *
 * Their viewports are what the probe asks for, which is what a phone asks for. A grid is not
 * better because it divides the country more evenly; it is better because the box a passenger is
 * looking at costs less text.
 */
const VIEWPORTS: Array<{
  name: string;
  bbox: { west: number; south: number; east: number; north: number };
}> = [
  { name: "Leeds", bbox: { west: -1.62, south: 53.75, east: -1.46, north: 53.84 } },
  { name: "Manchester", bbox: { west: -2.32, south: 53.42, east: -2.16, north: 53.52 } },
  { name: "Birmingham", bbox: { west: -1.96, south: 52.42, east: -1.8, north: 52.52 } },
  { name: "Bristol", bbox: { west: -2.66, south: 51.42, east: -2.5, north: 51.51 } },
  { name: "York", bbox: { west: -1.12, south: 53.94, east: -1.03, north: 53.99 } },
];

/** A 600-metre box, which is what `/v1/nearby` asks for and the read that gains most from a small square. */
const NEARBY_POINTS: Array<{ name: string; lat: number; lon: number }> = [
  { name: "Leeds", lat: 53.7965, lon: -1.5478 },
  { name: "Manchester", lat: 53.4794, lon: -2.2453 },
  { name: "York", lat: 53.9583, lon: -1.0803 },
];

const READ_CONCURRENCY = 8;

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** `boxAround`, as the Worker computes it, so the nearby figure is the one the endpoint would pay. */
function boxAround(lat: number, lon: number, metres: number) {
  const latDelta = metres / 111_320;
  const lonDelta = metres / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return {
    west: lon - lonDelta,
    south: lat - latDelta,
    east: lon + lonDelta,
    north: lat + latDelta,
  };
}

async function main(): Promise<number> {
  const configured = r2StoreFromEnv(process.env);
  if (!configured.ok) {
    console.error(`Object storage is not configured: ${configured.missing.join(", ")}`);
    return 1;
  }
  const artifacts = new ArtifactStore(configured.store);

  const index = await artifacts.readCurrent<NetworkIndexRecord>(SHARDED.index);
  const record = index?.records[0];
  if (!record) {
    console.error(`No published index at ${SHARDED.index}; there is no projection to measure.`);
    return 1;
  }
  const tiles = record.mapStopTiles ?? [];
  if (tiles.length === 0) {
    console.error("The published artifact carries no map projection.");
    return 1;
  }
  const publishedGrid = record.layout?.mapStopTileDegrees ?? STOP_TILE_DEGREES;
  console.log(
    `Artifact ${record.version}: ${String(tiles.length)} projection tile(s) on a ` +
      `${String(publishedGrid)}° grid. This process would publish on ${String(MAP_STOP_TILE_DEGREES)}°.`,
  );

  /*
   * Every row, with the exact bytes of the line it was written as.
   *
   * Measured rather than estimated from a record count: the rows differ by a factor of three
   * between a pole with one route and an interchange with twenty, and a tile's cost is bytes.
   */
  const rows: Array<{ lat: number; lon: number; bytes: number }> = [];
  let unreadable = 0;
  let missing = 0;
  const read = await mapWithConcurrency(tiles, READ_CONCURRENCY, async (tile) => {
    const body = await configured.store.get(objectKeyFor(mapStopsDataset(tile), record.version));
    if (body === null) return { tile, lines: 0, bytes: 0, absent: true };
    let lines = 0;
    for (const line of body.split("\n")) {
      if (line.length === 0) continue;
      lines += 1;
      try {
        const row = JSON.parse(line) as MapStopRow;
        if (typeof row.y !== "number" || typeof row.x !== "number") {
          unreadable += 1;
          continue;
        }
        rows.push({ lat: row.y, lon: row.x, bytes: utf8Bytes(line) + 1 });
      } catch {
        unreadable += 1;
      }
    }
    return { tile, lines, bytes: utf8Bytes(body), absent: false };
  });
  for (const tile of read) if (tile.absent) missing += 1;

  const publishedBytes = read.reduce((total, tile) => total + tile.bytes, 0);
  console.log(
    `Read ${String(rows.length)} row(s), ${(publishedBytes / 1024 / 1024).toFixed(1)} MiB, ` +
      `${String(missing)} tile(s) absent, ${String(unreadable)} line(s) unreadable.`,
  );
  /*
   * A row that could not be placed is a row a retiling would lose, so it is a refusal and not a
   * footnote. The measurement is only useful if it is a measurement of all of it.
   */
  if (unreadable > 0 || missing > 0) {
    console.log(
      `::warning title=map grid measurement::${String(missing)} tile(s) absent and ` +
        `${String(unreadable)} line(s) unreadable; the figures below are of what could be read.`,
    );
  }

  const candidates = CANDIDATES.map((grid) => {
    const byTile = new Map<string, { rows: number; bytes: number }>();
    for (const row of rows) {
      const tile = tileIdFor({ lat: row.lat, lon: row.lon }, grid);
      const existing = byTile.get(tile);
      if (existing) {
        existing.rows += 1;
        existing.bytes += row.bytes;
      } else byTile.set(tile, { rows: 1, bytes: row.bytes });
    }
    const sizes = [...byTile.values()].map((tile) => tile.bytes);
    const bytesOf = (bbox: { west: number; south: number; east: number; north: number }) =>
      mapStopTilesForBoundingBox(bbox, grid).reduce(
        (total, tile) => total + (byTile.get(tile)?.bytes ?? 0),
        0,
      );

    return {
      grid,
      objects: byTile.size,
      bytes: [...sizes].reduce((a, b) => a + b, 0),
      largestTileBytes: Math.max(0, ...sizes),
      medianTileBytes: sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)] ?? 0,
      /* What each endpoint would decode, per city, from this grid. */
      viewports: Object.fromEntries(
        VIEWPORTS.map((city) => [
          city.name,
          { tiles: mapStopTilesForBoundingBox(city.bbox, grid).length, chars: bytesOf(city.bbox) },
        ]),
      ),
      nearby: Object.fromEntries(
        NEARBY_POINTS.map((point) => {
          const bbox = boxAround(point.lat, point.lon, 600);
          return [
            point.name,
            { tiles: mapStopTilesForBoundingBox(bbox, grid).length, chars: bytesOf(bbox) },
          ];
        }),
      ),
    };
  });

  console.log("");
  console.log(
    "grid      objects   family MiB   largest KiB   worst viewport MiB   worst nearby KiB",
  );
  for (const row of candidates) {
    const worstViewport = Math.max(...Object.values(row.viewports).map((city) => city.chars));
    const worstNearby = Math.max(...Object.values(row.nearby).map((city) => city.chars));
    console.log(
      `${String(row.grid).padEnd(8)}  ${String(row.objects).padStart(7)}   ` +
        `${(row.bytes / 1024 / 1024).toFixed(1).padStart(10)}   ` +
        `${(row.largestTileBytes / 1024).toFixed(0).padStart(11)}   ` +
        `${(worstViewport / 1024 / 1024).toFixed(2).padStart(18)}   ` +
        `${(worstNearby / 1024).toFixed(0).padStart(16)}`,
    );
  }

  console.log("");
  for (const row of candidates) {
    for (const [city, cost] of Object.entries(row.viewports)) {
      console.log(
        `${String(row.grid).padEnd(8)} ${city.padEnd(11)} map    ` +
          `${String(cost.tiles).padStart(3)} tile(s)  ${String(cost.chars).padStart(9)} chars`,
      );
    }
    for (const [city, cost] of Object.entries(row.nearby)) {
      console.log(
        `${String(row.grid).padEnd(8)} ${city.padEnd(11)} nearby ` +
          `${String(cost.tiles).padStart(3)} tile(s)  ${String(cost.chars).padStart(9)} chars`,
      );
    }
  }

  const report = {
    measuredAt: new Date().toISOString(),
    version: record.version,
    publishedGrid,
    publishedTiles: tiles.length,
    publishedBytes,
    rows: rows.length,
    missingTiles: missing,
    unreadableLines: unreadable,
    candidates,
  };
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("map projection grid", report);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Measuring the map grid failed:", error);
    process.exitCode = 1;
  });
