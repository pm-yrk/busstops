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
import { readClosedWindow, SETTLE_SECONDS } from "./src/closed-window.js";

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

  /*
   * Aggregate a settled window, not the one just collected.
   *
   * This read `readCurrent`, which is the observations the collector published seconds ago. A
   * five-minute bucket stays open for a further ten minutes so late data can revise it, and
   * `publish.ts` publishes only closed buckets — so every run produced buckets that were all
   * open, published nothing, and rolled back. Run 67 is the proof: 47 samples, 43 buckets, "43
   * buckets are still open and were not published", `no records produced`, `rolled_back`.
   *
   * Lowering the grace or publishing open buckets would have made the dashboard populate by
   * giving up a guarantee — a figure that is still being revised is exactly what an open bucket
   * is. Reaching back to the windows that have settled costs nothing but a few more reads.
   */
  const window = await readClosedWindow(artifacts, OBSERVATION_DATASET, startedAt);
  report.window = {
    settleSeconds: SETTLE_SECONDS,
    closedBefore: window.closedBefore,
    versionsAvailable: window.versionsAvailable,
    versionsRead: window.versionsRead,
    recordsRead: window.recordsRead,
    recordsInClosedWindow: window.recordsInClosedWindow,
    earliestObservedAt: window.earliestObservedAt,
    latestObservedAt: window.latestObservedAt,
    notes: window.notes,
  };

  const observations = {
    records: window.observations,
    manifest: (await artifacts.readManifest(OBSERVATION_DATASET)) ?? null,
  };

  if (observations.records.length === 0) {
    /*
     * An empty window is a state, not a fault.
     *
     * This exited 1, so the hourly schedule went red whenever the collector had nothing — at
     * four in the morning, after a suspended run, after any collection gap — and a wall of red
     * runs is how a real failure goes unnoticed. The gap is reported and the previous
     * intelligence publish is left exactly as it was, which is what Pro should keep serving.
     *
     * "Nothing has settled yet" is now one of the ways this happens, and it is the expected one
     * on a bucket that has only ever been collected into once — so the window report above says
     * which of the two it was.
     */
    report.outcome = "no_input";
    console.error(
      window.recordsRead > 0
        ? `Read ${window.recordsRead} observation(s) across ${window.versionsRead} version(s), ` +
            `but none is older than the settle horizon ${window.closedBefore}; nothing to process.`
        : "No collected observations available; nothing to process.",
    );
    writeReport(report);
    return 0;
  }

  console.error(
    `Aggregating ${window.recordsInClosedWindow} settled observation(s) of ` +
      `${window.recordsRead} read across ${window.versionsRead} of ${window.versionsAvailable} ` +
      `version(s), covering ${window.earliestObservedAt ?? "?"} to ` +
      `${window.latestObservedAt ?? "?"} (closed before ${window.closedBefore}).`,
  );

  const segments = await artifacts.readCurrent<RoadSegment>(SEGMENT_DATASET);
  if (segments.records.length === 0) {
    /*
     * This one is a fault, and it was the standing one.
     *
     * `network/segments` had no producer anywhere in the repository — one constant naming a
     * dataset nothing wrote — so every run reached here and stopped, and Bus Stops Pro has only
     * ever been able to serve its dated demonstration snapshot. `pipelines/road-network` is the
     * producer; until it has run against this bucket, there is nothing to sample traces against
     * and saying so loudly is right.
     */
    report.outcome = "no_segments";
    console.error(
      "No road segments published. Run pipelines/road-network/run-extract.ts against this " +
        "bucket — the analytics batch samples vehicle traces against segment geometry and " +
        "cannot produce anything without it.",
    );
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
    /*
     * A job that throws still has to say so in its report.
     *
     * Every ordinary exit writes one; an exception wrote nothing at all, and the workflow step runs
     * with `continue-on-error`, which marks a failed step "success" in the job's own step list. So a
     * collection that threw looked from the outside like a collection that had worked and simply
     * chosen not to report — which is how run 47's "no collection-report.json was written" read for
     * three runs. The report is the only thing that distinguishes them.
     */
    try {
      writeFileSync(
        "batch-report.json",
        JSON.stringify(
          {
            outcome: "threw",
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            finishedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // A report we cannot write is not worth failing twice over; the console still carries it.
    }
    process.exitCode = 1;
  });
