#!/usr/bin/env node
/**
 * Publish the pattern stop sequences a journey needs, one object per pattern index tile.
 *
 * A journey reads its trips, the trips name their patterns, and then it has to find those
 * patterns' stop sequences. Today it finds them by reading every line of every pattern index tile
 * the corridor crosses: measured on a real request, 2,098,153 of the journey's 2,316,100 decoded
 * characters and 5,123 lines scanned to keep 1,090. The isolate pattern cache took the repeat
 * journey through a city from 170 ms of reading to 74 and cannot help the first one, which still
 * measures 39 to 41 ms against a budget of ten.
 *
 * So the same patterns are published in a form a reader can take by id: sixteen-byte keys in
 * ascending order, binary-searchable, with each tile's stops and service routes listed once and
 * referenced by index. Three fields per pattern — id, service route, stop sequence — because three
 * are what a plan uses. Direction, distance and shape stay in the text index, which is not
 * replaced: the route and line endpoints read those fields, and this family exists for the planner.
 *
 * It is idempotent and resumable — a tile already published at this version is skipped — bounded by
 * `--minutes` and `--limit`, and refuses outright rather than part-publishing if the whole family
 * would come to more than `--max-bytes`. Without `--apply` it writes nothing and reports what the
 * family would cost, which is the number the storage budget is decided on. `--remove` deletes the
 * family at the live version, which is the rollback: a reader that cannot find a tile reads the
 * text index instead.
 *
 *   npx tsx scripts/publish-journey-pattern-stops.ts [--apply] [--minutes 30] [--limit 5000]
 *                                                    [--max-bytes N] [--remove]
 *                                                    [--json pattern-stops.json]
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  canHoldBytes,
  objectKeyFor,
  objectKeyForBytes,
  r2StoreFromEnv,
  versionInObjectKey,
} from "@busstops/pipeline-core";
import {
  SHARDED,
  encodePatternStops,
  journeyPatternStopsDataset,
  patternIndexTileDataset,
  tileHoldsEveryPattern,
  type NetworkIndexRecord,
  type PatternIndexRow,
  type PatternStopSequence,
} from "@busstops/pipeline-static-network";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const APPLY = argv.includes("--apply");
const REMOVE = argv.includes("--remove");
const MINUTES = Number(flag("minutes") ?? "30");
const LIMIT = Number(flag("limit") ?? "100000");
const JSON_OUT = flag("json");
/**
 * The most this family may cost, in bytes. Checked against the whole family before anything is
 * written, because a publisher that discovers its size by filling the bucket is how a free tier
 * stops being free. Costed at 48,872,144 bytes plus about a megabyte of route table against a
 * bucket with roughly 863 MB of headroom; the default refuses anything near an order out.
 */
const MAX_BYTES = Number(flag("max-bytes") ?? String(120 * 1024 * 1024));

/** One tile's patterns, out of the published text index. */
function patternsIn(body: string): { patterns: PatternStopSequence[]; unparsed: number } {
  const patterns: PatternStopSequence[] = [];
  let unparsed = 0;
  for (const line of body.split("\n")) {
    if (line.length === 0 || !line.startsWith("[")) continue;
    let row: [string, PatternIndexRow];
    try {
      row = JSON.parse(line) as [string, PatternIndexRow];
    } catch {
      unparsed += 1;
      continue;
    }
    const pattern = row[1];
    if (
      typeof pattern?.id !== "string" ||
      typeof pattern.serviceRouteId !== "string" ||
      !Array.isArray(pattern.stopSequence)
    ) {
      unparsed += 1;
      continue;
    }
    patterns.push({
      id: pattern.id,
      serviceRouteId: pattern.serviceRouteId,
      stopSequence: pattern.stopSequence,
    });
  }
  return { patterns, unparsed };
}

async function main(): Promise<number> {
  const resolved = r2StoreFromEnv(process.env);
  if (!resolved.ok) {
    annotateReport("journey pattern stops", {
      outcome: "not_configured",
      missing: resolved.missing,
    });
    return 2;
  }
  const store = resolved.store;
  if (!canHoldBytes(store)) {
    annotateReport("journey pattern stops", {
      outcome: "failed",
      reason: "this store cannot hold bytes",
    });
    return 1;
  }

  const index = (await new ArtifactStore(store).readCurrent<NetworkIndexRecord>(SHARDED.index))
    .records[0];
  if (!index) {
    annotateReport("journey pattern stops", { outcome: "failed", reason: "no index record" });
    return 1;
  }

  if (REMOVE) {
    /*
     * The rollback: every object of this family at the live version, and nothing else. Other
     * versions are left alone — a rollback is not a prune — and a reader that finds nothing goes
     * back to the text index, which is the behaviour this family makes cheaper rather than
     * replaces. There is no manifest flag to unset and no mixed state to leave behind.
     */
    const mine = (await store.list(`data/${SHARDED.journeyPatternStops}/`)).filter(
      (key) => versionInObjectKey(key) === index.version,
    );
    let removed = 0;
    if (APPLY) {
      for (const key of mine) {
        await store.delete(key);
        removed += 1;
      }
    }
    const report = {
      outcome: APPLY ? "removed" : "dry_run_remove",
      version: index.version,
      objects: mine.length,
      removed,
      note:
        "A reader that cannot find a tile of this family reads the text pattern index instead, " +
        "so removing it at the live version is a complete rollback. Other versions are untouched.",
    };
    console.log(JSON.stringify(report, null, 1));
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
    annotateReport("journey pattern stops", report);
    return 0;
  }

  const tiles = index.patternIndexTiles ?? [];
  if (tiles.length === 0) {
    annotateReport("journey pattern stops", {
      outcome: "failed",
      reason: "the index names no pattern tiles",
      version: index.version,
    });
    return 1;
  }

  const already = new Set(
    (await store.list(`data/${SHARDED.journeyPatternStops}/`)).filter((key) =>
      key.endsWith(`/${index.version}.bin`),
    ),
  );

  const deadline = Date.now() + MINUTES * 60 * 1000;
  const counts = {
    tiles: tiles.length,
    tilesPublished: 0,
    tilesSkipped: 0,
    tilesUnreadable: 0,
    tilesEmpty: 0,
    tilesUnkeyable: 0,
    patterns: 0,
    calls: 0,
    routes: 0,
    stops: 0,
    patternsSkipped: 0,
    unparsedLines: 0,
    textChars: 0,
    bytes: 0,
    largestObjectBytes: 0,
    stoppedBy: null as "limit" | "clock" | null,
  };
  const failures: Array<{ tile: string; reason: string }> = [];
  let largestTile = "";

  /*
   * One pass, encoding every tile whether or not it is written.
   *
   * The family's total has to be known before the first write — the free allowance is account-wide
   * and this is a fourth family in a bucket with under a gigabyte spare — but reading the text
   * index twice to learn it would double a thirty-minute run. So each tile is encoded, measured,
   * and only written once the running total is still inside the allowance; a tile that would take
   * the family past `--max-bytes` stops the run with nothing further written, and the report says
   * the family was refused rather than published. A `--dry-run` pass (no `--apply`) measures the
   * whole family and is what the budget decision is made on.
   */
  for (const tile of tiles) {
    const key = objectKeyForBytes(journeyPatternStopsDataset(tile), index.version);
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

    const body = await store.get(objectKeyFor(patternIndexTileDataset(tile), index.version));
    if (body === null) {
      counts.tilesUnreadable += 1;
      continue;
    }
    counts.textChars += body.length;
    const { patterns, unparsed } = patternsIn(body);
    counts.unparsedLines += unparsed;
    if (patterns.length === 0) {
      /* A tile with no pattern rows publishes nothing: a reader finds no object and falls back. */
      counts.tilesEmpty += 1;
      continue;
    }

    let encoded;
    try {
      encoded = encodePatternStops(patterns);
    } catch (error) {
      failures.push({ tile, reason: String(error).slice(0, 140) });
      continue;
    }

    if (encoded.skipped > 0) {
      /*
       * A tile is published only if it holds every pattern its text tile holds.
       *
       * The reader's whole saving depends on that: having opened every tile of a corridor it skips
       * the text scan, rather than skipping only the patterns it happened to find. A tile missing
       * one pattern would make that unsound, so a tile with an id this format cannot key is not
       * published and the reader falls back to the text index for it.
       */
      counts.tilesUnkeyable += 1;
      counts.patternsSkipped += encoded.skipped;
      continue;
    }

    if (counts.bytes + encoded.bytes.byteLength > MAX_BYTES) {
      const report = {
        outcome: "refused",
        reason: "the family is larger than this run was allowed to publish",
        version: index.version,
        maxBytes: MAX_BYTES,
        bytesSoFar: counts.bytes,
        tileThatWouldExceed: tile,
        ...counts,
      };
      console.log(JSON.stringify(report, null, 1));
      if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
      annotateReport("journey pattern stops", report);
      return 1;
    }

    counts.patterns += encoded.patterns;
    counts.calls += encoded.calls;
    counts.routes += encoded.routes;
    counts.stops += encoded.stops;
    counts.patternsSkipped += encoded.skipped;
    counts.bytes += encoded.bytes.byteLength;
    if (encoded.bytes.byteLength > counts.largestObjectBytes) {
      counts.largestObjectBytes = encoded.bytes.byteLength;
      largestTile = tile;
    }
    counts.tilesPublished += 1;
    if (!APPLY) continue;

    await store.putBytes(key, encoded.bytes);
    /*
     * Read back as a reader will before it counts as published, for the same reason the trip
     * conversion does it: an upload that answered 200 and stored something else is the failure
     * that cannot be noticed later. Every pattern in the tile is checked, by id, out of the bytes
     * that came back — not against the encoder's own state.
     */
    const stored = await store.getBytes(key);
    if (stored === null) {
      failures.push({ tile, reason: "what was written is not there" });
      continue;
    }
    const held = tileHoldsEveryPattern(
      stored instanceof Uint8Array ? stored : new Uint8Array(stored),
      patterns,
    );
    if (!held.ok) failures.push({ tile, reason: held.reason });
  }

  const report = {
    outcome: APPLY ? "published" : "dry_run",
    version: index.version,
    ...counts,
    maxBytes: MAX_BYTES,
    largestObject: { tile: largestTile, bytes: counts.largestObjectBytes },
    averageObjectBytes:
      counts.tilesPublished === 0 ? null : Math.round(counts.bytes / counts.tilesPublished),
    ratioOfText:
      counts.textChars === 0 ? null : Number((counts.bytes / counts.textChars).toFixed(3)),
    callsPerPattern:
      counts.patterns === 0 ? null : Number((counts.calls / counts.patterns).toFixed(1)),
    failures: failures.slice(0, 20),
    note:
      "One object per pattern index tile, holding each pattern's id, service route and stop " +
      "sequence, keyed so a reader takes the patterns its trips named without reading the rest. " +
      "The text pattern index is not replaced: the route and line endpoints read fields this " +
      "family leaves out, and a missing tile falls back to it.",
  };

  console.log(JSON.stringify(report, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("journey pattern stops", report);
  return failures.length > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    annotateReport("journey pattern stops", { outcome: "failed", error: String(error) });
    process.exitCode = 1;
  });
