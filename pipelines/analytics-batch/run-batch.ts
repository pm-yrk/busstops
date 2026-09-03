#!/usr/bin/env node
/**
 * Scheduled intelligence batch: segment sampling, interval aggregation, incident lifecycle and
 * atomic publication, followed by the storage inventory and quota projection.
 *
 * Retention pruning runs as its own job (run-retention.ts) and is deliberately not chained to
 * this one: raw expiry must not be able to fail because an analytics stage did.
 */

import { writeFileSync } from "node:fs";
import type { VehicleObservation } from "@busstops/contracts";
import { ArtifactStore, r2StoreFromEnv } from "@busstops/pipeline-core";
import { classify } from "@busstops/governor";
import { runAnalyticsBatch } from "./src/run.js";
import type { RoadSegment } from "./src/segments.js";
import type { SegmentIntervalBucket } from "./src/aggregates.js";
import { bucketKey } from "./src/aggregates.js";
import { INTELLIGENCE_DATASETS, rollbackIntelligence } from "./src/publish.js";

const OBSERVATION_DATASET = "intelligence/observations";
const SEGMENT_DATASET = "network/segments";

async function main(): Promise<number> {
  const startedAt = new Date();
  const report: Record<string, unknown> = { startedAt: startedAt.toISOString() };

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

  const observations = await artifacts.readCurrent<VehicleObservation>(OBSERVATION_DATASET);
  if (observations.records.length === 0) {
    report.outcome = "no_input";
    console.error("No collected observations available; nothing to process.");
    writeReport(report);
    return 1;
  }

  const segments = await artifacts.readCurrent<RoadSegment>(SEGMENT_DATASET);
  if (segments.records.length === 0) {
    report.outcome = "no_segments";
    console.error("No road segments published; run the static network build first.");
    writeReport(report);
    return 1;
  }

  const existing = await artifacts.readCurrent<SegmentIntervalBucket>(
    INTELLIGENCE_DATASETS.segmentMetrics,
  );

  const traces = new Map<string, VehicleObservation[]>();
  for (const observation of observations.records) {
    const trace = traces.get(observation.vehicleRef);
    if (trace) trace.push(observation);
    else traces.set(observation.vehicleRef, [observation]);
  }
  for (const trace of traces.values()) {
    trace.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  }

  const utilization = Number(process.env.BUDGET_UTILIZATION ?? "0");
  const result = await runAnalyticsBatch(
    {
      runId: startedAt.toISOString(),
      traces,
      routeByVehicle: new Map(),
      segments: segments.records,
      existingBuckets: new Map(
        existing.records.map((bucket) => [
          bucketKey(bucket.segmentId, bucket.intervalStart),
          bucket,
        ]),
      ),
      existingIncidents: [],
      detections: [],
      coverage: observations.manifest?.partialCoverage ? 0.5 : 1,
      sources: ["bods"],
      governorState: classify(utilization, utilization),
    },
    {
      store,
      budgetMs: Number(process.env.BATCH_BUDGET_MS ?? "300000"),
      version: startedAt.toISOString(),
    },
  );

  report.stages = result.report.stages.map((stage) => ({
    name: stage.name,
    status: stage.status,
    durationMs: stage.durationMs,
    metrics: stage.metrics,
  }));
  report.notes = [...result.notes, ...result.report.stages.flatMap((stage) => stage.notes)];
  report.samples = result.samples.length;
  report.incidents = result.incidents.length;

  if (result.publish && !result.publish.complete) {
    const rolledBack = await rollbackIntelligence(store);
    report.outcome = "rolled_back";
    report.rolledBack = rolledBack;
    report.failed = result.publish.failed;
    console.error(
      `Publish incomplete; rolled back: ${rolledBack.join(", ") || "(nothing to restore)"}`,
    );
    writeReport(report);
    return 1;
  }

  if (!result.report.complete) {
    report.outcome = "partial";
    report.failedStages = result.report.failedStages;
    report.skippedStages = result.report.skippedStages;
    console.error(
      `Batch completed partially. Failed: ${result.report.failedStages.join(", ") || "none"}; skipped: ${result.report.skippedStages.join(", ") || "none"}.`,
    );
    writeReport(report);
    return 1;
  }

  report.outcome = "published";
  console.log(
    `Processed ${traces.size} traces into ${result.samples.length} segment samples and ${result.incidents.length} tracked incidents.`,
  );
  writeReport(report);
  return 0;
}

function writeReport(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("batch-report.json", JSON.stringify(report, null, 2));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Analytics batch job failed:", error);
    process.exitCode = 1;
  });
