#!/usr/bin/env node
/**
 * Publish the walking transfers of a static network, one object per tile.
 *
 * Stops do not move, so the walk between two of them belongs to the publish and not to a
 * passenger's request — and yet `/v1/journeys` was computing a corridor's from scratch every time:
 * 108,284 edges over 2,063 stops in Manchester, 126,952 in Birmingham, measured at 21 to 25
 * milliseconds against the ten a Workers Free invocation gets for everything. After the trip parse
 * moved into the published binary form this was the largest single item left in the endpoint.
 *
 * What it writes, per 0.25-degree tile — the grid the stops and trips are already filed on:
 *
 *   - every stop whose coordinate falls in the tile, with its complete neighbour list;
 *   - the stops outside the tile that are within the walking cap of one of those, as targets only.
 *
 * That halo is what makes the partitioning exact: a corridor reads the tiles its stops are in, and
 * every edge it can use is in one of them, whichever side of a boundary the other end sits on.
 *
 * It is idempotent and resumable — a tile already published at this version is skipped — and
 * bounded by `--minutes`, so a capped run can simply be run again. `--dry-run` writes nothing and
 * reports the bytes the family would cost, which is the number the storage budget is decided on.
 *
 *   npx tsx scripts/publish-journey-transfers.ts [--apply] [--minutes 30] [--limit 500]
 *                                                [--json journey-transfers.json]
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  canHoldBytes,
  objectKeyFor,
  objectKeyForBytes,
  r2StoreFromEnv,
  tileIdFor,
} from "@busstops/pipeline-core";
import {
  SHARDED,
  STOP_TILE_DEGREES,
  TransferTile,
  encodeTransferTile,
  journeyTransfersDataset,
  stopTileDataset,
  type NetworkIndexRecord,
} from "@busstops/pipeline-static-network";
import { buildTransferTiles } from "@busstops/journey";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const APPLY = argv.includes("--apply");
const MINUTES = Number(flag("minutes") ?? "30");
const LIMIT = Number(flag("limit") ?? "100000");
const JSON_OUT = flag("json");
/**
 * The most this family may cost, in bytes. Checked before anything is written.
 *
 * R2's free allowance is account-wide and this bucket has about a gigabyte of headroom even after
 * the trip conversion gives some back. A publisher that discovers its size by filling the bucket
 * is how a free tier stops being free, so the whole family is measured first and the run refuses
 * rather than part-publishes if the total is more than it was allowed.
 */
const MAX_BYTES = Number(flag("max-bytes") ?? String(400 * 1024 * 1024));

/**
 * The walking cap the artifact is built for.
 *
 * One number, in the header of every tile, because an adjacency is only valid for the cap it was
 * built under. The planner's own cap is 600 seconds; a request asking for a different one must
 * fall back to building its own rather than quietly using these.
 */
const CAP_SECONDS = 600;

interface Stops {
  ids: string[];
  lat: Float64Array;
  lon: Float64Array;
  tile: string[];
}

/** Every published stop, read once. A national set is about 350,000 of them. */
async function readStops(
  store: { get(key: string): Promise<string | null> },
  index: NetworkIndexRecord,
): Promise<Stops> {
  const ids: string[] = [];
  const lats: number[] = [];
  const lons: number[] = [];
  const tiles: string[] = [];
  for (const tile of index.stopTiles) {
    const body = await store.get(objectKeyFor(stopTileDataset(tile), index.version));
    if (body === null) continue;
    for (const line of body.split("\n")) {
      if (line.length === 0) continue;
      const stop = JSON.parse(line) as {
        id: string;
        locationCoordinate?: { lat: number; lon: number };
      };
      const at = stop.locationCoordinate;
      if (!at || !Number.isFinite(at.lat) || !Number.isFinite(at.lon)) continue;
      ids.push(stop.id);
      lats.push(at.lat);
      lons.push(at.lon);
      /*
       * The tile from the coordinate, not from the object it was read out of.
       *
       * A stop can be filed in a tile it is not strictly inside — the publisher files by the
       * tiles a route's shape runs through, among other things — and the halo argument only holds
       * if "the tile a stop is in" means the one its coordinate falls in. Deriving it here makes
       * the reader's tile enumeration and the publisher's agree by construction.
       */
      tiles.push(tileIdFor(at, STOP_TILE_DEGREES));
    }
  }
  return { ids, lat: Float64Array.from(lats), lon: Float64Array.from(lons), tile: tiles };
}

async function main(): Promise<number> {
  const resolved = r2StoreFromEnv(process.env);
  if (!resolved.ok) {
    annotateReport("journey transfers", { outcome: "not_configured", missing: resolved.missing });
    return 2;
  }
  const store = resolved.store;
  if (!canHoldBytes(store)) {
    annotateReport("journey transfers", {
      outcome: "failed",
      reason: "this store cannot hold bytes",
    });
    return 1;
  }

  const index = (await new ArtifactStore(store).readCurrent<NetworkIndexRecord>(SHARDED.index))
    .records[0];
  if (!index) {
    annotateReport("journey transfers", { outcome: "failed", reason: "no index record" });
    return 1;
  }

  const readBegan = Date.now();
  const stops = await readStops(store, index);
  const readMs = Date.now() - readBegan;
  if (stops.ids.length === 0) {
    annotateReport("journey transfers", {
      outcome: "failed",
      reason: "no stops with coordinates were published",
      version: index.version,
    });
    return 1;
  }

  /*
   * Built by the same function the equivalence tests hold to the all-pairs oracle, and the same
   * one a corridor falls back to when its tiles are missing. One implementation: a publisher with
   * its own copy of the grid is a publisher that can disagree with the reader.
   */
  const buildBegan = Date.now();
  const plans = buildTransferTiles(
    stops.ids.map((id, at) => ({
      id,
      coordinate: { lat: stops.lat[at]!, lon: stops.lon[at]! },
    })),
    { capSeconds: CAP_SECONDS, tileOf: (stop) => tileIdFor(stop.coordinate, STOP_TILE_DEGREES) },
  );
  const buildMs = Date.now() - buildBegan;

  const already = new Set(
    (await store.list(`data/${SHARDED.journeyTransfers}/`)).filter((key) =>
      key.endsWith(`/${index.version}.bin`),
    ),
  );

  /*
   * The whole family's size, before a single object is written.
   *
   * Encoding is cheap next to building the edges, and knowing the total is what lets this refuse
   * instead of discovering the limit halfway through — which would leave the bucket holding a
   * partial family and the free allowance spent.
   */
  let projectedBytes = 0;
  let projectedEdges = 0;
  for (const plan of plans) {
    projectedBytes += encodeTransferTile({
      stopIds: plan.stopIds,
      offsets: plan.offsets,
      neighbours: plan.neighbours,
      seconds: plan.seconds,
      capSeconds: CAP_SECONDS,
    }).stats.bytes;
    projectedEdges += plan.neighbours.length;
  }
  if (APPLY && projectedBytes > MAX_BYTES) {
    const report = {
      outcome: "refused",
      reason: "the family is larger than this run was allowed to publish",
      version: index.version,
      projectedBytes,
      maxBytes: MAX_BYTES,
      tiles: plans.length,
      stops: stops.ids.length,
      edges: projectedEdges,
    };
    console.log(JSON.stringify(report, null, 1));
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
    annotateReport("journey transfers", report);
    return 1;
  }

  const deadline = Date.now() + MINUTES * 60 * 1000;
  const counts = {
    tiles: plans.length,
    tilesPublished: 0,
    tilesSkipped: 0,
    stops: stops.ids.length,
    edges: 0,
    bytes: 0,
    clampedWalks: 0,
    largestTileBytes: 0,
    stoppedBy: null as "limit" | "clock" | null,
  };
  const failures: Array<{ tile: string; reason: string }> = [];

  for (const plan of plans) {
    const key = objectKeyForBytes(journeyTransfersDataset(plan.tile), index.version);
    if (already.has(key)) {
      counts.tilesSkipped += 1;
      continue;
    }
    if (counts.tilesPublished >= LIMIT) {
      counts.stoppedBy = "limit";
      break;
    }
    if (Date.now() > deadline) {
      counts.stoppedBy = "clock";
      break;
    }

    let encoded;
    try {
      encoded = encodeTransferTile({
        stopIds: plan.stopIds,
        offsets: plan.offsets,
        neighbours: plan.neighbours,
        seconds: plan.seconds,
        capSeconds: CAP_SECONDS,
      });
    } catch (error) {
      failures.push({ tile: plan.tile, reason: String(error).slice(0, 140) });
      continue;
    }

    /*
     * Read back as a reader will before it counts as published, for the same reason the trip
     * conversion does it: an upload that answered 200 and stored something else is the failure
     * that cannot be noticed later.
     */
    counts.edges += encoded.stats.edges;
    counts.bytes += encoded.stats.bytes;
    counts.clampedWalks += encoded.stats.clampedWalks;
    counts.largestTileBytes = Math.max(counts.largestTileBytes, encoded.stats.bytes);
    counts.tilesPublished += 1;
    if (!APPLY) continue;

    await store.putBytes(key, encoded.bytes);
    const stored = await store.getBytes(key);
    if (stored === null) {
      failures.push({ tile: plan.tile, reason: "what was written is not there" });
      continue;
    }
    try {
      const reopened = new TransferTile(stored);
      if (
        reopened.stopCount !== plan.stopIds.length ||
        reopened.edgeCount !== plan.neighbours.length ||
        reopened.capSeconds !== CAP_SECONDS
      ) {
        failures.push({ tile: plan.tile, reason: "what came back is a different tile" });
      }
    } catch (error) {
      failures.push({
        tile: plan.tile,
        reason: `reopening failed: ${String(error).slice(0, 100)}`,
      });
    }
  }

  const report = {
    outcome: APPLY ? "published" : "dry_run",
    version: index.version,
    capSeconds: CAP_SECONDS,
    projectedBytes,
    maxBytes: MAX_BYTES,
    ...counts,
    bytesPerStop: Number((counts.bytes / Math.max(1, counts.stops)).toFixed(1)),
    edgesPerStop: Number((counts.edges / Math.max(1, counts.stops)).toFixed(1)),
    readMs,
    buildMs,
    failures: failures.slice(0, 20),
    note:
      "One object per 0.25-degree tile: every stop whose coordinate falls in it with a complete " +
      "neighbour list, plus the stops within the walking cap of those as targets. A corridor " +
      "reads the tiles its stops are in and every edge it can use is in one of them.",
  };

  console.log(JSON.stringify(report, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("journey transfers", report);
  return failures.length > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    annotateReport("journey transfers", { outcome: "failed", error: String(error) });
    process.exitCode = 1;
  });
