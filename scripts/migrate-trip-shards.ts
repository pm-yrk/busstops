#!/usr/bin/env node
/**
 * Convert the live version's trip shards from JSON lines to the published binary form.
 *
 * The journey endpoint's CPU is not spent searching. On real published data a Manchester corridor
 * spends 0.47 ms walking its shards, 24.26 ms parsing every trip row, 10.29 ms building a graph
 * and 3.24 ms searching it — against the ten milliseconds a Workers Free invocation is allowed.
 * The parse is the largest item and the search is the smallest, so the shard's *form* is the thing
 * to change: columnar bytes the reader opens through typed arrays rather than lines it parses.
 *
 * This is the migration, not the publisher. A national rebuild takes about forty-five minutes and
 * writes a whole second copy of England, and the bucket has roughly a gigabyte of headroom against
 * an account-wide free allowance — so republishing to change a format is not available. Converting
 * in place is, and it *frees* space: the binary form measures about 46% of the text it replaces.
 *
 * Three rules, because this deletes published timetable:
 *
 *   1. Nothing is deleted until the bytes written in its place have been read back and found to
 *      hold every row the text held — pattern, trip id, every departure, every arrival.
 *   2. Only the version the index names. The rollback version is left exactly as it is: a
 *      rollback has to stay a thing that works.
 *   3. Resumable and idempotent. A shard that already has its binary sibling is skipped, and the
 *      run stops on its own budget rather than on the job's timeout, so a capped run can simply
 *      be run again.
 *
 * Dry by default: without `--apply` it reads, encodes, verifies in memory and reports what it
 * would have saved, writing nothing and deleting nothing.
 *
 *   npx tsx scripts/migrate-trip-shards.ts [--apply] [--limit 500] [--minutes 30]
 *                                          [--json trip-shard-migration.json]
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  objectKeyFor,
  objectKeyForBytes,
  r2StoreFromEnv,
  versionInObjectKey,
  canHoldBytes,
} from "@busstops/pipeline-core";
import {
  PATTERN_TRIPS_PREFIX,
  SHARDED,
  encodePatternTripShard,
  shardHoldsEveryRow,
  type NetworkIndexRecord,
  type PatternTripRow,
} from "@busstops/pipeline-static-network";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const APPLY = argv.includes("--apply");
const LIMIT = Number(flag("limit") ?? "100000");
const MINUTES = Number(flag("minutes") ?? "30");
const JSON_OUT = flag("json");

/** Every row the text shard held, in order. */
function rowsOf(text: string): PatternTripRow[] {
  const rows: PatternTripRow[] = [];
  for (const line of text.split("\n")) {
    if (line.length > 0) rows.push(JSON.parse(line) as PatternTripRow);
  }
  return rows;
}

async function main(): Promise<number> {
  const resolved = r2StoreFromEnv(process.env);
  if (!resolved.ok) {
    annotateReport("trip shard migration", {
      outcome: "not_configured",
      missing: resolved.missing,
    });
    return 2;
  }
  const store = resolved.store;
  if (!canHoldBytes(store)) {
    annotateReport("trip shard migration", {
      outcome: "failed",
      reason: "this store cannot hold bytes",
    });
    return 1;
  }

  const index = (await new ArtifactStore(store).readCurrent<NetworkIndexRecord>(SHARDED.index))
    .records[0];
  if (!index) {
    annotateReport("trip shard migration", { outcome: "failed", reason: "no index record" });
    return 1;
  }
  const version = index.version;

  const inventory = await store.listDetailed(`data/${PATTERN_TRIPS_PREFIX}/`);
  const binaryKeys = new Set(inventory.filter((o) => o.key.endsWith(".bin")).map((o) => o.key));
  const pending = inventory.filter(
    (object) =>
      object.key.endsWith(".jsonl") &&
      versionInObjectKey(object.key) === version &&
      !binaryKeys.has(`${object.key.slice(0, -".jsonl".length)}.bin`),
  );

  const deadline = Date.now() + MINUTES * 60 * 1000;
  const counts = {
    shardsAtVersion: inventory.filter((o) => versionInObjectKey(o.key) === version).length,
    alreadyBinary: binaryKeys.size,
    pending: pending.length,
    converted: 0,
    verified: 0,
    failedVerification: 0,
    unreadable: 0,
    textDeleted: 0,
    bytesText: 0,
    bytesBinary: 0,
    stoppedBy: null as "limit" | "clock" | null,
  };
  const failures: Array<{ key: string; reason: string }> = [];

  for (const object of pending) {
    if (counts.converted >= LIMIT) {
      counts.stoppedBy = "limit";
      break;
    }
    if (Date.now() > deadline) {
      counts.stoppedBy = "clock";
      break;
    }

    let text: string | null;
    try {
      text = await store.get(object.key);
    } catch (error) {
      counts.unreadable += 1;
      failures.push({ key: object.key, reason: String(error).slice(0, 120) });
      continue;
    }
    if (text === null) continue;

    let bytes: Uint8Array;
    try {
      bytes = encodePatternTripShard(rowsOf(text)).bytes;
    } catch (error) {
      counts.unreadable += 1;
      failures.push({ key: object.key, reason: `encode: ${String(error).slice(0, 100)}` });
      continue;
    }

    const held = shardHoldsEveryRow(bytes, rowsOf(text));
    if (!held.ok) {
      counts.failedVerification += 1;
      failures.push({ key: object.key, reason: held.reason });
      continue;
    }

    counts.converted += 1;
    counts.verified += 1;
    counts.bytesText += text.length;
    counts.bytesBinary += bytes.byteLength;
    if (!APPLY) continue;

    const binaryKey = `${object.key.slice(0, -".jsonl".length)}.bin`;
    await store.putBytes(binaryKey, bytes);
    /*
     * And read it back from the bucket before the text goes, because an upload that answered 200
     * and stored something else is exactly the failure this deletion cannot survive.
     */
    const stored = await store.getBytes(binaryKey);
    const readBack = stored === null ? null : shardHoldsEveryRow(stored, rowsOf(text));
    if (readBack === null || !readBack.ok) {
      counts.failedVerification += 1;
      counts.verified -= 1;
      failures.push({
        key: binaryKey,
        reason:
          readBack === null
            ? "what was written is not there"
            : `what came back from the bucket was not the shard: ${readBack.reason}`,
      });
      continue;
    }
    await store.delete(object.key);
    counts.textDeleted += 1;
  }

  const report = {
    outcome: APPLY ? "migrated" : "dry_run",
    version,
    /* Proof the keys this walks are the ones a request reads. */
    exampleTextKey: pending[0]?.key ?? null,
    exampleBinaryKey:
      pending[0] === undefined ? null : `${pending[0].key.slice(0, -".jsonl".length)}.bin`,
    sameDatasetAsTheReader:
      pending[0] === undefined
        ? null
        : objectKeyForBytes(
            pending[0].key.slice("data/".length, pending[0].key.lastIndexOf("/")),
            version,
          ) === `${pending[0].key.slice(0, -".jsonl".length)}.bin` &&
          objectKeyFor(
            pending[0].key.slice("data/".length, pending[0].key.lastIndexOf("/")),
            version,
          ) === pending[0].key,
    ...counts,
    bytesSaved: counts.bytesText - counts.bytesBinary,
    ratio:
      counts.bytesText === 0 ? null : Number((counts.bytesBinary / counts.bytesText).toFixed(3)),
    failures: failures.slice(0, 20),
    note:
      "Nothing is deleted until the bytes written in its place have been read back out of the " +
      "bucket and found to hold every row. Only the version the index names is touched.",
  };

  console.log(JSON.stringify(report, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("trip shard migration", report);
  return counts.failedVerification > 0 || counts.unreadable > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    annotateReport("trip shard migration", { outcome: "failed", error: String(error) });
    process.exitCode = 1;
  });
