#!/usr/bin/env node
/**
 * Retention, roll-up and storage inventory.
 *
 * This job is separate from the analytics batch on purpose. Raw expiry outranks every optional
 * analytical workload, so it must not be able to fail because a sampling or aggregation stage
 * did — and it runs in every governor state, including critical.
 *
 * Order is enforced: roll up first, then delete. Deleting first would destroy the only copy of
 * information no upstream feed will serve again.
 */

import { writeFileSync } from "node:fs";
import { ArtifactStore, r2StoreFromEnv, RETENTION_CLASSES } from "@busstops/pipeline-core";
import { rollUpBuckets, planPruning, type PruneCandidate } from "./src/rollup.js";
import { takeInventory, projectStorage, type StorageClassInventory } from "./src/inventory.js";
import type { SegmentIntervalBucket } from "./src/aggregates.js";
import { INTELLIGENCE_DATASETS } from "./src/publish.js";

const INVENTORY_DATASET = "intelligence/storage-inventory";
const FIFTEEN_MINUTES = 900;

async function main(): Promise<number> {
  const now = new Date();
  const report: Record<string, unknown> = { startedAt: now.toISOString() };

  const storeResult = r2StoreFromEnv(process.env);
  if (!storeResult.ok) {
    report.outcome = "not_configured";
    report.missing = storeResult.missing;
    console.error(`Artifact storage is not configured. Missing: ${storeResult.missing.join(", ")}`);
    writeReport(report);
    return 0;
  }

  const store = storeResult.store;
  const artifacts = new ArtifactStore(store);

  // 1. Roll up before pruning.
  const fine = await artifacts.readCurrent<SegmentIntervalBucket>(
    INTELLIGENCE_DATASETS.segmentMetrics,
  );
  const rolled = rollUpBuckets(fine.records, FIFTEEN_MINUTES, now);
  report.rollUp = {
    source: fine.records.length,
    produced: rolled.buckets.length,
    blocked: rolled.blocked,
    notes: rolled.notes,
  };

  if (rolled.buckets.length > 0) {
    await artifacts.publish({
      dataset: `${INTELLIGENCE_DATASETS.segmentMetrics}-15min`,
      version: now.toISOString(),
      records: rolled.buckets,
      schemaVersion: "1.0.0",
      sources: ["bods"],
    });
  }

  // 2. Prune, only what has been rolled up, plus everything with a mandatory expiry.
  const rolledUpKeys = new Set(
    fine.records
      .filter((bucket) => bucket.state === "closed")
      .map((bucket) => `${bucket.segmentId}|${bucket.intervalStart}`),
  );

  if (!store.listDetailed) {
    // Without real sizes and upload times a projection would be a guess dressed as a measurement.
    report.outcome = "inventory_unavailable";
    console.error("The configured object store cannot report object sizes; no pruning attempted.");
    writeReport(report);
    return 1;
  }

  const objects = await store.listDetailed("data/");
  const candidates: PruneCandidate[] = objects.map((object) => ({
    key: object.key,
    retentionClassKey: retentionClassForKey(object.key),
    timestamp: object.uploadedAt,
    approximateBytes: object.sizeBytes,
  }));

  const plan = planPruning(candidates, now, rolledUpKeys);
  report.pruning = {
    deletions: plan.deletions.length,
    heldForRollUp: plan.heldForRollUp.length,
    mandatoryDeletions: plan.mandatoryDeletions,
    bytesReclaimed: plan.bytesReclaimed,
    notes: plan.notes,
  };

  let deleted = 0;
  const deletionFailures: string[] = [];
  for (const candidate of plan.deletions) {
    try {
      await store.delete(candidate.key);
      deleted += 1;
    } catch (error) {
      deletionFailures.push(error instanceof Error ? error.message : String(error));
    }
  }
  report.deleted = deleted;
  report.deletionFailures = deletionFailures.slice(0, 10);

  // 3. Inventory and projection, so quota pressure is visible before it becomes a bill.
  const byClass = new Map<string, StorageClassInventory>();
  for (const object of objects) {
    const key = retentionClassForKey(object.key);
    const existing = byClass.get(key) ?? {
      retentionClassKey: key,
      objectCount: 0,
      bytes: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
    };
    existing.objectCount += 1;
    existing.bytes += object.sizeBytes;
    const timestamp = object.uploadedAt;
    if (existing.oldestTimestamp === null || timestamp < existing.oldestTimestamp) {
      existing.oldestTimestamp = timestamp;
    }
    if (existing.newestTimestamp === null || timestamp > existing.newestTimestamp) {
      existing.newestTimestamp = timestamp;
    }
    byClass.set(key, existing);
  }

  const inventory = takeInventory([...byClass.values()], now);
  const history = await artifacts.readCurrent<typeof inventory>(INVENTORY_DATASET);
  const projection = projectStorage(inventory, {
    limitBytes: Number(process.env.R2_STORAGE_LIMIT_BYTES ?? String(10 * 1024 * 1024 * 1024)),
    history: history.records,
    daysRemainingInPeriod: daysRemainingInMonth(now),
  });

  report.inventory = {
    totalBytes: inventory.totalBytes,
    totalObjects: inventory.totalObjects,
    unclassifiedKeys: inventory.unclassifiedKeys,
  };
  report.projection = projection;

  await artifacts.publish({
    dataset: INVENTORY_DATASET,
    version: now.toISOString(),
    // Keep a bounded history: enough to measure growth, not an archive in its own right.
    records: [...history.records.slice(-29), inventory],
    schemaVersion: "1.0.0",
    sources: ["cloudflare_r2"],
  });

  report.outcome = deletionFailures.length > 0 ? "partial" : "completed";
  console.log(
    `Rolled up ${rolled.buckets.length} buckets, deleted ${deleted} objects, ` +
      `${(inventory.totalBytes / 1_048_576).toFixed(1)}MB stored (${(projection.utilization * 100).toFixed(1)}% of limit, state ${projection.state}).`,
  );
  writeReport(report);
  return deletionFailures.length > 0 ? 1 : 0;
}

/**
 * Maps an object key to its retention class. Anything unrecognised is reported as unclassified
 * rather than assigned a default: silently giving unknown data a long retention is how an
 * unbounded archive appears without anyone deciding to create one.
 */
function retentionClassForKey(key: string): string {
  if (key.includes("intelligence/observations")) return "raw_trace";
  if (key.includes("segment-metrics-15min")) return "aggregate_15min";
  if (key.includes("segment-metrics")) return "aggregate_5min";
  if (key.includes("intelligence/incidents")) return "incident_summary";
  if (key.includes("storage-inventory")) return "aggregate_daily";
  return RETENTION_CLASSES.some((c) => key.includes(c.key)) ? key : "unclassified";
}

function daysRemainingInMonth(now: Date): number {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.max(1, (end.getTime() - now.getTime()) / 86_400_000);
}

function writeReport(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("retention-report.json", JSON.stringify(report, null, 2));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Retention job failed:", error);
    process.exitCode = 1;
  });
