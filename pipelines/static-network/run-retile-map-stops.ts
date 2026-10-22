#!/usr/bin/env node
/**
 * Re-files the published map projection onto a smaller square, without rebuilding the country.
 *
 * ## Why this is not a job for the national build
 *
 * The projection is the family `/v1/map`, `/v1/journeys`, `/v1/routes/:id` and `/v1/nearby` all
 * read, and the square it is filed on is the only lever on a city viewport's over-read. Changing
 * that square in the national build means paying for the whole build to change one family's
 * partitioning: the GTFS archive, the NaPTAN parse, a million journeys, every other family. That
 * build takes between 99 and 165 minutes — measured, on the same inputs, ten hours apart — and the
 * extra objects a finer grid writes have twice pushed it past its step limit, publishing nothing
 * at all. Three runs were spent that way.
 *
 * None of that work is needed. A finer grid is a *repartition of rows that are already published*:
 * each row carries its own position, so the fine tiles can be computed from the coarse ones with
 * no timetable, no archive and no build. Measured on the live artifact, the whole projection is
 * 460 objects and 50 MB, and the family occupies the same 50 MB on every candidate grid — the same
 * rows, in more and smaller objects. So this is a minutes-long job that risks one family, instead
 * of a two-and-a-half-hour job that risks the artifact.
 *
 * ## How it refuses
 *
 * Everything is arranged so the failure mode is "changed nothing" rather than "published a map
 * with holes in it".
 *
 *   - It reads the live version from the index manifest, and cross-checks it against the version
 *     the index record itself names. They are set from one value at publish time, so disagreement
 *     means the assumption this rests on is wrong.
 *   - It requires every tile the index lists to be present and every line in them to parse. A
 *     repartition that loses rows is not a repartition.
 *   - It conserves rows exactly, and says so: every input row must land in exactly one output
 *     tile, and the counts are compared rather than trusted.
 *   - It refuses a grid that does not nest inside a stop tile, and any output tile that would
 *     exceed the publisher's own byte cap, because the publisher's answer to that is truncation
 *     and truncation here means stops that vanish from the map.
 *   - It writes every new tile and reads every one of them back before the index is touched.
 *     Until that one write, the artifact serves exactly what it served before.
 *   - It never deletes the tiles it replaces. They stop being referenced, which makes them
 *     removable by a later explicit pass; leaving them means a rollback is one index write away.
 *
 *   npx tsx pipelines/static-network/run-retile-map-stops.ts            # report only
 *   npx tsx pipelines/static-network/run-retile-map-stops.ts --apply    # and publish
 *
 * The grid comes from `MAP_STOP_TILE_DEGREES`, the same variable the national build reads, so the
 * two cannot be asked for different things by different means.
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  mapWithConcurrency,
  manifestKey,
  objectKeyFor,
  r2StoreFromEnv,
  tileIdFor,
} from "@busstops/pipeline-core";
import {
  MAP_STOP_TILE_DEGREES,
  MAX_SHARD_BYTES,
  MAX_SHARD_RECORDS,
  SHARDED,
  STOP_TILE_DEGREES,
  mapStopsDataset,
  type MapStopRow,
  type NetworkIndexRecord,
} from "./src/shards.js";
import { NETWORK_SCHEMA_VERSION } from "./src/publish.js";

const APPLY = process.argv.includes("--apply");
const JSON_OUT = (() => {
  const index = process.argv.indexOf("--json");
  return index === -1 ? undefined : process.argv[index + 1];
})();

/** Eight at a time, the same as the publisher: enough to be quick, below what earns a 429. */
const CONCURRENCY = 8;

const encoder = new TextEncoder();
function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

interface Report {
  outcome: string;
  [key: string]: unknown;
}

function report(body: Report): void {
  console.log("--- retile report ---");
  console.log(JSON.stringify(body, null, 2));
  console.log("--- end retile report ---");
  annotateReport("map projection retile", body);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(body, null, 1));
}

async function main(): Promise<number> {
  const configured = r2StoreFromEnv(process.env);
  if (!configured.ok) {
    report({ outcome: "not_configured", missing: configured.missing });
    console.error(`Object storage is not configured: ${configured.missing.join(", ")}`);
    return 1;
  }
  const store = configured.store;
  const artifacts = new ArtifactStore(store);

  const target = MAP_STOP_TILE_DEGREES;
  const nests = [STOP_TILE_DEGREES, STOP_TILE_DEGREES / 2, STOP_TILE_DEGREES / 4].some(
    (size) => Math.abs(size - target) < 1e-9,
  );
  if (!nests) {
    report({ outcome: "grid_does_not_nest", target });
    console.error(
      `::error::${String(target)}° does not nest inside a ${String(STOP_TILE_DEGREES)}° stop ` +
        `tile. A grid that does not divide it files stops in squares no viewport asks for.`,
    );
    return 1;
  }

  /*
   * The live version, from the pointer rather than from the shape of the keys — and then a second
   * opinion from the record itself, exactly as retention does. Shards carry no manifest; what
   * makes them reachable is that the index names their version, so the index is the only
   * authority on what is being served.
   */
  const manifest = await artifacts.readManifest(SHARDED.index);
  if (!manifest) {
    report({ outcome: "no_manifest" });
    console.error(`::error::No manifest at ${manifestKey(SHARDED.index)}; nothing is live.`);
    return 1;
  }
  const current = await artifacts.readCurrent<NetworkIndexRecord>(SHARDED.index);
  const record = current.records[0];
  if (!record) {
    report({ outcome: "no_index_record", version: manifest.version });
    console.error("::error::The index manifest names a version with no record in it.");
    return 1;
  }
  if (record.version !== manifest.version) {
    report({
      outcome: "version_disagreement",
      manifestVersion: manifest.version,
      recordVersion: record.version,
    });
    console.error(
      `::error::The manifest says ${manifest.version} and the index record says ` +
        `${record.version}. They are set from one value at publish time, so this job stops.`,
    );
    return 1;
  }

  /*
   * An artifact that declares no layout at all is one published before the layout was recorded,
   * and this job will not write one for it. The swap below changes a single field of a
   * declaration the build made; inventing the rest from this process's own constants would be
   * claiming that artifact matches grids nobody checked it against, which is the exact confusion
   * the declaration exists to prevent.
   */
  if (!record.layout) {
    report({ outcome: "no_declared_layout", version: record.version });
    console.error(
      "::error::This artifact declares no layout, so there is no declaration to amend. Publish " +
        "a full build, which writes one, before re-filing anything.",
    );
    return 1;
  }

  const publishedGrid = record.layout.mapStopTileDegrees ?? STOP_TILE_DEGREES;
  const tiles = record.mapStopTiles ?? [];
  if (tiles.length === 0) {
    report({ outcome: "no_projection", version: record.version });
    console.error("::error::The published artifact carries no map projection to re-file.");
    return 1;
  }
  if (Math.abs(publishedGrid - target) < 1e-9) {
    report({
      outcome: "already_on_this_grid",
      version: record.version,
      grid: target,
      tiles: tiles.length,
    });
    console.log(`Already filed on ${String(target)}°; nothing to do.`);
    return 0;
  }

  console.log(
    `Artifact ${record.version}: ${String(tiles.length)} tile(s) on ${String(publishedGrid)}°, ` +
      `re-filing onto ${String(target)}°.`,
  );

  /*
   * Every line, kept as written. The rows are re-filed, never re-serialised: a repartition that
   * rebuilt the JSON could change a number's formatting, and then a later full build at the same
   * grid would not produce byte-identical objects for data that had not changed.
   */
  const lines: Array<{ tile: string; text: string; bytes: number }> = [];
  let absent = 0;
  let unparseable = 0;
  let positionless = 0;

  const sourceTiles = await mapWithConcurrency(tiles, CONCURRENCY, async (tile) => {
    const body = await store.get(objectKeyFor(mapStopsDataset(tile), record.version));
    if (body === null) {
      absent += 1;
      return { tile, rows: 0, bytes: 0 };
    }
    let rows = 0;
    for (const text of body.split("\n")) {
      if (text.length === 0) continue;
      rows += 1;
      let row: MapStopRow;
      try {
        row = JSON.parse(text) as MapStopRow;
      } catch {
        unparseable += 1;
        continue;
      }
      if (typeof row.y !== "number" || typeof row.x !== "number") {
        positionless += 1;
        continue;
      }
      lines.push({
        tile: tileIdFor({ lat: row.y, lon: row.x }, target),
        text,
        bytes: utf8Bytes(text) + 1,
      });
    }
    return { tile, rows, bytes: utf8Bytes(body) };
  });

  const sourceRows = sourceTiles.reduce((total, tile) => total + tile.rows, 0);
  const sourceBytes = sourceTiles.reduce((total, tile) => total + tile.bytes, 0);

  /*
   * A row that could not be read is a row this job would delete from the map, so it is a refusal
   * and not a statistic. The one thing worse than a map that costs too much is a map with stops
   * missing from it that reports no degradation at all.
   */
  if (absent > 0 || unparseable > 0 || positionless > 0) {
    report({
      outcome: "source_incomplete",
      version: record.version,
      sourceTiles: tiles.length,
      absent,
      unparseable,
      positionless,
      rowsRead: lines.length,
    });
    console.error(
      `::error::${String(absent)} tile(s) absent, ${String(unparseable)} line(s) unparseable and ` +
        `${String(positionless)} without a position. Re-filing would lose them, so nothing is written.`,
    );
    return 1;
  }

  /* Grouped, and ordered exactly as the publisher orders a shard, so a later build agrees. */
  const byTile = new Map<string, string[]>();
  for (const line of lines) {
    const existing = byTile.get(line.tile);
    if (existing) existing.push(line.text);
    else byTile.set(line.tile, [line.text]);
  }
  for (const rows of byTile.values()) rows.sort((a, b) => (a < b ? -1 : 1));

  const outputs = [...byTile]
    .map(([tile, rows]) => ({
      tile,
      rows,
      bytes: rows.reduce((total, text) => total + utf8Bytes(text) + 1, 0) - 1,
    }))
    .sort((a, b) => (a.tile < b.tile ? -1 : 1));

  const outputRows = outputs.reduce((total, tile) => total + tile.rows.length, 0);
  const outputBytes = outputs.reduce((total, tile) => total + tile.bytes, 0);
  const oversized = outputs.filter(
    (tile) => tile.bytes > MAX_SHARD_BYTES || tile.rows.length > MAX_SHARD_RECORDS,
  );
  const largest = outputs.reduce((worst, tile) => (tile.bytes > worst.bytes ? tile : worst));

  const plan = {
    version: record.version,
    from: publishedGrid,
    to: target,
    sourceTiles: tiles.length,
    sourceRows,
    sourceBytes,
    outputTiles: outputs.length,
    outputRows,
    outputBytes,
    largestOutputTile: { tile: largest.tile, bytes: largest.bytes, rows: largest.rows.length },
    /* Both families live at once between the writes and the index swap, which is the peak. */
    peakExtraBytes: outputBytes,
    removableAfterwards: { tiles: tiles.length, bytes: sourceBytes },
  };

  console.log(
    `${String(sourceRows)} row(s) in ${String(tiles.length)} tile(s) become ` +
      `${String(outputRows)} row(s) in ${String(outputs.length)} tile(s); largest ` +
      `${(largest.bytes / 1024).toFixed(0)} KiB (was up to ` +
      `${(Math.max(...sourceTiles.map((t) => t.bytes)) / 1024).toFixed(0)} KiB).`,
  );

  /*
   * Row conservation, compared rather than assumed. Every line read has to land in exactly one
   * output tile; the two totals are computed from different structures, so an equality here means
   * the repartition is lossless and a difference means it is not.
   */
  if (outputRows !== sourceRows) {
    report({ outcome: "rows_not_conserved", ...plan });
    console.error(
      `::error::${String(sourceRows)} row(s) read and ${String(outputRows)} re-filed. A ` +
        `repartition that does not conserve rows is not a repartition.`,
    );
    return 1;
  }
  if (oversized.length > 0) {
    report({
      outcome: "output_over_cap",
      ...plan,
      oversized: oversized.slice(0, 5).map((tile) => ({ tile: tile.tile, bytes: tile.bytes })),
    });
    console.error(
      `::error::${String(oversized.length)} output tile(s) exceed the publisher's cap. Its ` +
        `answer to that is truncation, and truncation here is stops missing from the map.`,
    );
    return 1;
  }

  if (!APPLY) {
    report({ outcome: "reported", applied: false, ...plan });
    console.log("Report only. Pass --apply to write the tiles and swap the index.");
    return 0;
  }

  /*
   * Write everything, then read all of it back, and only then move the pointer.
   *
   * The new tiles are invisible until the index lists them, so writing them is not a change to
   * what anyone is served. Verifying them before the swap is the whole point of doing it in that
   * order: an object that failed to write, or wrote short, must be found while the old artifact is
   * still the live one.
   */
  const writeFailures: Array<{ tile: string; reason: string }> = [];
  const writeBegan = Date.now();
  await mapWithConcurrency(outputs, CONCURRENCY, async (tile) => {
    try {
      await store.put(
        objectKeyFor(mapStopsDataset(tile.tile), record.version),
        tile.rows.join("\n"),
      );
    } catch (error) {
      writeFailures.push({
        tile: tile.tile,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
  const writeMs = Date.now() - writeBegan;

  if (writeFailures.length > 0) {
    report({
      outcome: "writes_failed",
      ...plan,
      writeMs,
      failures: writeFailures.slice(0, 5),
      failureCount: writeFailures.length,
    });
    console.error(
      `::error::${String(writeFailures.length)} tile(s) could not be written. The index was not ` +
        `touched, so the previous projection is still the live one.`,
    );
    return 1;
  }

  const verifyFailures: Array<{ tile: string; expected: number; found: number | null }> = [];
  await mapWithConcurrency(outputs, CONCURRENCY, async (tile) => {
    const body = await store.get(objectKeyFor(mapStopsDataset(tile.tile), record.version));
    const found = body === null ? null : body.split("\n").filter((line) => line.length > 0).length;
    if (found !== tile.rows.length) {
      verifyFailures.push({ tile: tile.tile, expected: tile.rows.length, found });
    }
  });

  if (verifyFailures.length > 0) {
    report({
      outcome: "verification_failed",
      ...plan,
      writeMs,
      failures: verifyFailures.slice(0, 5),
      failureCount: verifyFailures.length,
    });
    console.error(
      `::error::${String(verifyFailures.length)} tile(s) did not read back as written. The index ` +
        `was not touched.`,
    );
    return 1;
  }

  /*
   * One write, and it is the whole change.
   *
   * The record is republished at its own version, so the object and its manifest are rewritten in
   * place and there is no second pointer to keep in step. The grid and the tile list move together
   * because a reader that paired one artifact's tile names with another's grid would ask for
   * objects that were never written and report an empty viewport as a normal one.
   */
  const swapped: NetworkIndexRecord = {
    ...record,
    layout: { ...record.layout, mapStopTileDegrees: target },
    mapStopTiles: outputs.map((tile) => tile.tile),
  };
  try {
    await artifacts.publish({
      dataset: SHARDED.index,
      version: record.version,
      records: [swapped],
      schemaVersion: NETWORK_SCHEMA_VERSION,
      sources: ["naptan", "bods"],
      minimumRecordCount: 1,
    });
  } catch (error) {
    report({
      outcome: "index_swap_failed",
      ...plan,
      writeMs,
      reason: error instanceof Error ? error.message : String(error),
    });
    console.error(
      "::error::The tiles are written and verified but the index could not be republished, so " +
        "the previous projection is still the live one. Re-running is safe: the writes repeat.",
    );
    return 1;
  }

  report({ outcome: "applied", applied: true, ...plan, writeMs });
  console.log(
    `Published: the map projection is now ${String(outputs.length)} tile(s) on ` +
      `${String(target)}°, written in ${(writeMs / 1000).toFixed(0)}s. The ` +
      `${String(tiles.length)} tile(s) it replaced are no longer referenced and can be removed ` +
      `by a later pass; they are left in place so a rollback is one index write away.`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Re-filing the map projection failed:", error);
    process.exitCode = 1;
  });
