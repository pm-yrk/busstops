#!/usr/bin/env node
/**
 * Publish the route grouping of every binary trip shard.
 *
 * Grouping trips into routes — the sets that run the same stop sequence, split so no bus overtakes
 * another — is derived entirely from the published timetable, and the request was deriving it every
 * time. On real corridors it cost more than the walking transfers did: 27.65 ms against 23.56 in
 * Manchester, 38.28 against 24.76 in Birmingham, in a request allowed ten milliseconds for
 * everything.
 *
 * A shard's rows carry their times indexed by position in the pattern's sequence, densely, so a
 * trip with fewer times runs the pattern's first *n* stops: "the same sequence" is "the same
 * pattern and the same call count", and the grouping needs no stop ids. It is therefore small —
 * four bytes a trip and eight a route — and it names trips by their index in the shard, so it
 * carries that shard's fingerprint and a reader whose shard disagrees ignores it.
 *
 * Only binary shards get one. A shard still published as lines is read by a path that has no trip
 * indices to key against, and would group in the request anyway.
 *
 * Idempotent, resumable, bounded by `--minutes`. `--dry-run` is the default and writes nothing.
 *
 *   npx tsx scripts/publish-journey-routes.ts [--apply] [--minutes 30] [--limit 2000]
 *                                             [--json journey-routes.json]
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  canHoldBytes,
  objectKeyForBytes,
  r2StoreFromEnv,
  versionInObjectKey,
} from "@busstops/pipeline-core";
import {
  PATTERN_TRIPS_PREFIX,
  PatternTripShard,
  RouteGrouping,
  SHARDED,
  encodeRouteGrouping,
  journeyRoutesDataset,
  type NetworkIndexRecord,
} from "@busstops/pipeline-static-network";
import { groupRouteIndices } from "@busstops/journey";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const APPLY = argv.includes("--apply");
const MINUTES = Number(flag("minutes") ?? "30");
const LIMIT = Number(flag("limit") ?? "1000000");
const JSON_OUT = flag("json");

/** `data/network/pattern-trips/<date>/<window>/<tile>/<version>.bin` → its three parts. */
function shardParts(key: string): { serviceDate: string; window: number; tile: string } | null {
  const marker = `data/${PATTERN_TRIPS_PREFIX}/`;
  if (!key.startsWith(marker)) return null;
  const rest = key.slice(marker.length).split("/");
  if (rest.length !== 4) return null;
  const [serviceDate, window, tile] = rest as [string, string, string, string];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) return null;
  const windowNumber = Number(window);
  if (!Number.isInteger(windowNumber)) return null;
  return { serviceDate, window: windowNumber, tile };
}

async function main(): Promise<number> {
  const resolved = r2StoreFromEnv(process.env);
  if (!resolved.ok) {
    annotateReport("journey routes", { outcome: "not_configured", missing: resolved.missing });
    return 2;
  }
  const store = resolved.store;
  if (!canHoldBytes(store)) {
    annotateReport("journey routes", {
      outcome: "failed",
      reason: "this store cannot hold bytes",
    });
    return 1;
  }

  const index = (await new ArtifactStore(store).readCurrent<NetworkIndexRecord>(SHARDED.index))
    .records[0];
  if (!index) {
    annotateReport("journey routes", { outcome: "failed", reason: "no index record" });
    return 1;
  }

  const trips = (await store.list(`data/${PATTERN_TRIPS_PREFIX}/`)).filter(
    (key) => key.endsWith(".bin") && versionInObjectKey(key) === index.version,
  );
  const already = new Set(
    (await store.list(`data/${SHARDED.journeyRoutes}/`)).filter(
      (key) => versionInObjectKey(key) === index.version,
    ),
  );

  const deadline = Date.now() + MINUTES * 60 * 1000;
  const counts = {
    shards: trips.length,
    published: 0,
    skipped: 0,
    unreadable: 0,
    routes: 0,
    tripsGrouped: 0,
    bytes: 0,
    tripBytes: 0,
    stoppedBy: null as "limit" | "clock" | null,
  };
  const failures: Array<{ key: string; reason: string }> = [];

  for (const key of trips.sort()) {
    const parts = shardParts(key);
    if (parts === null) {
      failures.push({ key, reason: "the key is not shaped like a trip shard" });
      continue;
    }
    const target = objectKeyForBytes(
      journeyRoutesDataset(parts.serviceDate, parts.tile, parts.window),
      index.version,
    );
    if (already.has(target)) {
      counts.skipped += 1;
      continue;
    }
    if (counts.published >= LIMIT) {
      counts.stoppedBy = "limit";
      break;
    }
    if (Date.now() > deadline) {
      counts.stoppedBy = "clock";
      break;
    }

    let shard: PatternTripShard;
    let shardBytes: number;
    try {
      const bytes = await store.getBytes(key);
      if (bytes === null) {
        counts.unreadable += 1;
        failures.push({ key, reason: "the shard is not there" });
        continue;
      }
      shardBytes = bytes.byteLength;
      shard = new PatternTripShard(bytes);
    } catch (error) {
      counts.unreadable += 1;
      failures.push({ key, reason: `opening the shard failed: ${String(error).slice(0, 100)}` });
      continue;
    }

    /*
     * Grouped by the same function the request-time path falls back to, which a test holds to the
     * object form over two hundred generated timetables. One implementation of the decision.
     */
    const groups = groupRouteIndices({
      tripCount: shard.tripCount,
      patternKeyOf: (trip) => shard.patternOf(trip),
      callCountOf: (trip) => shard.callsIn(trip),
      departureOf: (trip, call) => shard.departure(trip, call),
      tripIdOf: (trip) => shard.tripId(trip),
    });

    const encoded = encodeRouteGrouping({ fingerprint: shard.fingerprint(), routes: groups });
    counts.routes += encoded.stats.routes;
    counts.tripsGrouped += encoded.stats.trips;
    counts.bytes += encoded.stats.bytes;
    counts.tripBytes += shardBytes;
    counts.published += 1;
    if (!APPLY) continue;

    await store.putBytes(target, encoded.bytes);
    const stored = await store.getBytes(target);
    if (stored === null) {
      failures.push({ key: target, reason: "what was written is not there" });
      continue;
    }
    try {
      const reopened = new RouteGrouping(stored);
      if (!reopened.describes(shard.fingerprint())) {
        failures.push({ key: target, reason: "what came back does not describe this shard" });
      } else if (reopened.routeCount !== encoded.stats.routes) {
        failures.push({ key: target, reason: "what came back has a different route count" });
      }
    } catch (error) {
      failures.push({ key: target, reason: `reopening failed: ${String(error).slice(0, 100)}` });
    }
  }

  const report = {
    outcome: APPLY ? "published" : "dry_run",
    version: index.version,
    ...counts,
    /* What it costs against what it describes, which is the whole storage argument. */
    shareOfTripBytes:
      counts.tripBytes === 0 ? null : Number((counts.bytes / counts.tripBytes).toFixed(4)),
    tripsPerRoute:
      counts.routes === 0 ? null : Number((counts.tripsGrouped / counts.routes).toFixed(1)),
    failures: failures.slice(0, 20),
    note:
      "One object per binary trip shard, naming trips by their index in it and carrying that " +
      "shard's fingerprint. A reader whose shard disagrees groups in the request instead.",
  };

  console.log(JSON.stringify(report, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("journey routes", report);
  return failures.length > 0 || counts.unreadable > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    annotateReport("journey routes", { outcome: "failed", error: String(error) });
    process.exitCode = 1;
  });
