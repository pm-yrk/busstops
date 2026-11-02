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
 * It also checks the pair the other way round, over the five areas a passenger walk uses: for each
 * of Leeds, Manchester, Birmingham, Bristol and York, every shard of every service date in that
 * area is opened and asked four things — is the binary form there, is the superseded text form
 * gone, is there a grouping, and does that grouping describe this shard. A refresh that produces a
 * coherent trip-and-grouping pair answers yes to all four on dates it has just written, which is
 * the only proof that the artifact no longer expires.
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
  TRIP_TILE_DEGREES,
  journeyRoutesDataset,
  patternTripsDataset,
  type NetworkIndexRecord,
} from "@busstops/pipeline-static-network";
import { objectKeyFor, tilesForBoundingBox } from "@busstops/pipeline-core";

/**
 * The five areas a passenger walk covers, as the trip grid files them.
 *
 * Named areas rather than a sample of keys, because "400 shards sorted by key" is 400 shards of
 * whichever corner of the country sorts first — it proved the defect but it cannot prove the fix
 * for the places anyone actually asks about.
 */
const AREAS: Array<{
  name: string;
  bbox: { west: number; south: number; east: number; north: number };
}> = [
  { name: "Leeds", bbox: { west: -1.62, south: 53.75, east: -1.46, north: 53.85 } },
  { name: "Manchester", bbox: { west: -2.32, south: 53.42, east: -2.18, north: 53.52 } },
  { name: "Birmingham", bbox: { west: -1.96, south: 52.42, east: -1.8, north: 52.52 } },
  { name: "Bristol", bbox: { west: -2.68, south: 51.4, east: -2.52, north: 51.5 } },
  { name: "York", bbox: { west: -1.14, south: 53.92, east: -1.0, north: 54.0 } },
];

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

  /*
   * And the pair over the five probe areas, on every date the horizon holds.
   *
   * Four questions per shard, which together are the whole of "did the refresh produce a coherent
   * trip and grouping": the binary form a request reads, the absence of the text form it
   * supersedes, the grouping, and whether that grouping describes this shard rather than one the
   * refresh has replaced.
   */
  const byArea: Array<{
    area: string;
    tiles: number;
    serviceDates: string[];
    shards: number;
    binaryPresent: number;
    textRemaining: number;
    groupingPresent: number;
    groupingAgrees: number;
    groupingStale: number;
    coherentPairs: number;
  }> = [];
  for (const area of AREAS) {
    const tiles = tilesForBoundingBox(area.bbox, TRIP_TILE_DEGREES);
    const tileSet = new Set(tiles);
    const mine = shards.filter((key) => {
      const parts = shardParts(key);
      return parts !== null && tileSet.has(parts.tile);
    });
    const verdict = {
      area: area.name,
      tiles: tiles.length,
      serviceDates: [...new Set(mine.map((key) => shardParts(key)!.serviceDate))].sort(),
      shards: mine.length,
      binaryPresent: 0,
      textRemaining: 0,
      groupingPresent: 0,
      groupingAgrees: 0,
      groupingStale: 0,
      coherentPairs: 0,
    };
    for (const key of mine) {
      const parts = shardParts(key)!;
      let shard: PatternTripShard | null = null;
      try {
        const bytes = await store.getBytes(key);
        if (bytes !== null) {
          shard = new PatternTripShard(bytes);
          verdict.binaryPresent += 1;
        }
      } catch {
        shard = null;
      }
      /* The superseded text sibling, which must not remain beside the bytes: every reader prefers
       * the bytes, so a shard with both is a shard whose reader may serve the older timetable. */
      const asText = await store.get(
        objectKeyFor(
          patternTripsDataset(parts.serviceDate, parts.tile, parts.window),
          index.version,
        ),
      );
      if (asText !== null) verdict.textRemaining += 1;

      let agrees = false;
      const groupingBytes = await store.getBytes(
        objectKeyForBytes(
          journeyRoutesDataset(parts.serviceDate, parts.tile, parts.window),
          index.version,
        ),
      );
      if (groupingBytes !== null) {
        verdict.groupingPresent += 1;
        try {
          agrees =
            shard !== null && new RouteGrouping(groupingBytes).describes(shard.fingerprint());
        } catch {
          agrees = false;
        }
        if (agrees) verdict.groupingAgrees += 1;
        else verdict.groupingStale += 1;
      }
      if (shard !== null && asText === null && agrees) verdict.coherentPairs += 1;
    }
    byArea.push(verdict);
  }

  const areasCoherent = byArea.every(
    (area) => area.shards > 0 && area.coherentPairs === area.shards,
  );

  const report = {
    outcome: "measured",
    version: index.version,
    shardsAtVersion: shards.length,
    byArea,
    areasCoherent,
    serviceDates: dates.length,
    limit: LIMIT,
    ...totals,
    cause,
    perDate: verdicts,
    examples,
    note:
      "Read-only. The verdict per shard is the reader's own `RouteGrouping.describes` against the " +
      "shard's fingerprint, so 'stale' means the Worker would ignore it and group the long way. " +
      "`areasCoherent` is true only when every shard in all five probe areas has the binary form, " +
      "no text form beside it, and a grouping that describes it.",
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
