#!/usr/bin/env node
/**
 * Whether the published route grouping actually answers for the shards being served.
 *
 * Two deployed CPU samples reported `shardsGrouped: 0` with `shardsBinary` non-zero on every
 * journey: the grouping artifact exists — 5,574 objects were published and verified — and the
 * request grouped the long way regardless. On a runner that long way measures 11.73 ms in Leeds
 * and 7.43 in Bristol against 4.86 and 3.37 from the artifact, which makes it the largest single
 * stage the published families were supposed to have removed and have not.
 *
 * There are only two ways that happens, and the fix differs:
 *
 *   - the object is not there for the service date being served, because the rolling refresh
 *     publishes new dates and the grouping was published once, for the dates of that moment; or
 *   - the object is there and describes a different shard, because a grouping names trips by their
 *     index in the shard it was built from and carries that shard's fingerprint, and the refresh
 *     republishes the shard three times a day.
 *
 * So this reads both and says which. It is read-only: no publishes, no deletes, no deploys. The
 * reader's own check is used — `RouteGrouping.describes` — rather than a reimplementation, so a
 * verdict here means what the Worker would decide.
 *
 *   npx tsx scripts/prove-grouping.ts [--limit 400] [--json grouping-proof.json]
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  objectKeyForBytes,
  r2StoreFromEnv,
  versionInObjectKey,
} from "@busstops/pipeline-core";
import {
  PATTERN_TRIPS_PREFIX,
  PatternTripShard,
  RouteGrouping,
  SHARDED,
  journeyRoutesDataset,
  type NetworkIndexRecord,
} from "@busstops/pipeline-static-network";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
/** Shards to open, newest dates first. Enough to decide, not the whole country. */
const LIMIT = Number(flag("limit") ?? "400");
const JSON_OUT = flag("json");

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

interface DateVerdict {
  serviceDate: string;
  shards: number;
  opened: number;
  groupingAbsent: number;
  groupingStale: number;
  groupingAgrees: number;
  unreadableShard: number;
  unreadableGrouping: number;
}

async function main(): Promise<number> {
  const resolved = r2StoreFromEnv(process.env);
  if (!resolved.ok) {
    annotateReport("grouping proof", { outcome: "not_configured", missing: resolved.missing });
    return 2;
  }
  const store = resolved.store;
  const index = (await new ArtifactStore(store).readCurrent<NetworkIndexRecord>(SHARDED.index))
    .records[0];
  if (!index) {
    annotateReport("grouping proof", { outcome: "failed", reason: "no index record" });
    return 1;
  }

  const shards = (await store.list(`data/${PATTERN_TRIPS_PREFIX}/`)).filter(
    (key) => key.endsWith(".bin") && versionInObjectKey(key) === index.version,
  );
  if (shards.length === 0) {
    annotateReport("grouping proof", {
      outcome: "failed",
      reason: "no binary trip shards at the live version",
      version: index.version,
    });
    return 1;
  }

  /* Newest service date first: the dates a passenger is being served today are the ones that
   * matter, and an older date nobody plans on proves nothing about them. */
  const byDate = new Map<string, string[]>();
  for (const key of shards) {
    const parts = shardParts(key);
    if (parts === null) continue;
    const list = byDate.get(parts.serviceDate) ?? [];
    list.push(key);
    byDate.set(parts.serviceDate, list);
  }
  const dates = [...byDate.keys()].sort().reverse();

  const verdicts: DateVerdict[] = [];
  const examples: Array<{ shard: string; verdict: string; detail?: string }> = [];
  let opened = 0;

  for (const serviceDate of dates) {
    const keys = (byDate.get(serviceDate) ?? []).sort();
    const verdict: DateVerdict = {
      serviceDate,
      shards: keys.length,
      opened: 0,
      groupingAbsent: 0,
      groupingStale: 0,
      groupingAgrees: 0,
      unreadableShard: 0,
      unreadableGrouping: 0,
    };
    for (const key of keys) {
      if (opened >= LIMIT) break;
      const parts = shardParts(key)!;
      opened += 1;
      verdict.opened += 1;

      let shard: PatternTripShard;
      try {
        const bytes = await store.getBytes(key);
        if (bytes === null) {
          verdict.unreadableShard += 1;
          continue;
        }
        shard = new PatternTripShard(bytes);
      } catch {
        verdict.unreadableShard += 1;
        continue;
      }

      const target = objectKeyForBytes(
        journeyRoutesDataset(parts.serviceDate, parts.tile, parts.window),
        index.version,
      );
      let groupingBytes: Uint8Array | null;
      try {
        groupingBytes = await store.getBytes(target);
      } catch {
        verdict.unreadableGrouping += 1;
        continue;
      }
      if (groupingBytes === null) {
        verdict.groupingAbsent += 1;
        if (examples.length < 12) examples.push({ shard: key, verdict: "grouping absent" });
        continue;
      }
      try {
        const grouping = new RouteGrouping(groupingBytes);
        if (grouping.describes(shard.fingerprint())) {
          verdict.groupingAgrees += 1;
        } else {
          verdict.groupingStale += 1;
          if (examples.length < 12) {
            examples.push({
              shard: key,
              verdict: "grouping describes a different shard",
              detail: `shard trips ${String(shard.tripCount)}, grouping routes ${String(grouping.routeCount)}`,
            });
          }
        }
      } catch (error) {
        verdict.unreadableGrouping += 1;
        if (examples.length < 12) {
          examples.push({
            shard: key,
            verdict: "grouping will not open",
            detail: String(error).slice(0, 100),
          });
        }
      }
    }
    verdicts.push(verdict);
    if (opened >= LIMIT) break;
  }

  const totals = verdicts.reduce(
    (sum, verdict) => ({
      opened: sum.opened + verdict.opened,
      groupingAbsent: sum.groupingAbsent + verdict.groupingAbsent,
      groupingStale: sum.groupingStale + verdict.groupingStale,
      groupingAgrees: sum.groupingAgrees + verdict.groupingAgrees,
      unreadableShard: sum.unreadableShard + verdict.unreadableShard,
      unreadableGrouping: sum.unreadableGrouping + verdict.unreadableGrouping,
    }),
    {
      opened: 0,
      groupingAbsent: 0,
      groupingStale: 0,
      groupingAgrees: 0,
      unreadableShard: 0,
      unreadableGrouping: 0,
    },
  );

  /* The one sentence the deployed `shardsGrouped: 0` needs explaining by. */
  const cause =
    totals.opened === 0
      ? "nothing was opened"
      : totals.groupingAgrees === totals.opened
        ? "every grouping opened agrees with its shard, so a zero in the request is not the artifact"
        : totals.groupingAbsent > totals.groupingStale
          ? "the grouping is mostly not published for the dates being served"
          : "the grouping is mostly published but describes a different shard than the one served";

  const report = {
    outcome: "measured",
    version: index.version,
    shardsAtVersion: shards.length,
    serviceDates: dates.length,
    limit: LIMIT,
    ...totals,
    cause,
    perDate: verdicts,
    examples,
    note:
      "Read-only. The verdict per shard is the reader's own `RouteGrouping.describes` against the " +
      "shard's fingerprint, so 'stale' means the Worker would ignore it and group the long way.",
  };

  console.log(JSON.stringify(report, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("grouping proof", report);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    annotateReport("grouping proof", { outcome: "failed", error: String(error) });
    process.exitCode = 1;
  });
