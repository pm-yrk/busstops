#!/usr/bin/env node
/**
 * Scheduled intelligence collection.
 *
 * Bounded on every axis: a partition plan capped by the budget, a wall-clock ceiling, a rolling
 * window that expires its own contents, and no national feed pulled in one request. A missing
 * credential is reported as a configuration outcome rather than a crash, so the schedule keeps
 * running and the gap stays visible instead of the job quietly disappearing.
 */

import { writeFileSync } from "node:fs";
import { BODS_MINIMUM_REQUEST_INTERVAL_MS } from "@busstops/contracts";
import { ArtifactStore, r2StoreFromEnv } from "@busstops/pipeline-core";
import { classify } from "@busstops/governor";
import {
  RollingObservationWindow,
  createBodsPartitionFetcher,
  runCollection,
} from "./src/index.js";

const OBSERVATION_DATASET = "intelligence/observations";

async function main(): Promise<number> {
  const startedAt = new Date();
  const report: Record<string, unknown> = { startedAt: startedAt.toISOString() };

  if (!process.env.BODS_API_KEY) {
    report.outcome = "not_configured";
    report.missing = ["BODS_API_KEY"];
    console.error("BODS_API_KEY is not configured; no collection attempted.");
    writeReport(report);
    return 0;
  }
  if (!process.env.VEHICLE_SALT_SECRET) {
    report.outcome = "not_configured";
    report.missing = ["VEHICLE_SALT_SECRET"];
    console.error(
      "VEHICLE_SALT_SECRET is not configured; refusing to collect unsalted vehicle references.",
    );
    writeReport(report);
    return 0;
  }

  // The governor state is read from the environment because the job cannot itself measure
  // Cloudflare usage; the worker publishes it and the schedule passes it in.
  const utilization = Number(process.env.BUDGET_UTILIZATION ?? "0");
  const governorState = classify(utilization, utilization);
  report.governorState = governorState;

  const collector = createBodsPartitionFetcher({
    apiKey: process.env.BODS_API_KEY,
    vehicleSaltSecret: process.env.VEHICLE_SALT_SECRET,
  });

  const window = new RollingObservationWindow({ maxAgeHours: 24 });

  const result = await runCollection({
    sourceKey: "bods",
    cadence: {
      sourceKey: "bods",
      // BODS SIRI-VM publishes about every 10 seconds; a 60s cadence is well inside that and
      // is the useful floor for congestion analysis without spending the budget on duplicates.
      sourceUpdateIntervalSeconds: 10,
      baseIntervalSeconds: 60,
      maxRequestsPerRun: Number(process.env.MAX_PARTITIONS_PER_RUN ?? "12"),
      /*
       * Derived from the published interval rather than invented: one request every five seconds
       * is 17,280 a day at most, and the registry's self-imposed half of that is the default.
       * BODS publishes no daily quota, so a larger number here would be a number nobody stated.
       */
      dailyRequestBudget: Number(process.env.BODS_DAILY_REQUEST_BUDGET ?? "8640"),
    },
    governorState,
    fetchPartition: collector.fetchPartition,
    window,
    budgetMs: Number(process.env.COLLECTION_BUDGET_MS ?? "240000"),
    // The publisher's stated interval, honoured at the point of request rather than assumed.
    minimumRequestIntervalMs: BODS_MINIMUM_REQUEST_INTERVAL_MS,
    // Several snapshots per run: one position per vehicle cannot yield a traversal or a speed.
    passes: Number(process.env.COLLECTION_PASSES ?? "3"),
    health: collector.health,
  });

  report.plan = {
    intervalSeconds: result.plan.intervalSeconds,
    partitions: result.plan.entries.length,
    skipped: result.plan.skippedPartitions.length,
    projectedDailyRequests: result.plan.projectedDailyRequests,
  };
  report.passesCompleted = result.passesCompleted;
  report.rateLimitWaitMs = result.rateLimitWaitMs;
  report.totals = result.totals;
  report.coverage = result.coverage;
  report.acceptanceRate = result.acceptanceRate;
  report.truncated = result.truncated;
  report.notes = result.notes;
  report.health = result.health;

  if (result.observations.length === 0) {
    report.outcome = result.plan.suspended ? "suspended" : "no_observations";
    console.error(
      result.plan.suspended
        ? "Collection suspended by the budget governor."
        : "No observations collected; previous data is unchanged.",
    );
    writeReport(report);
    return result.plan.suspended ? 0 : 1;
  }

  const storeResult = r2StoreFromEnv(process.env);
  if (!storeResult.ok) {
    report.outcome = "not_configured";
    report.missing = storeResult.missing;
    console.error(`Artifact storage is not configured. Missing: ${storeResult.missing.join(", ")}`);
    writeReport(report);
    return 0;
  }

  const artifacts = new ArtifactStore(storeResult.store);
  await artifacts.publish({
    dataset: OBSERVATION_DATASET,
    version: startedAt.toISOString(),
    records: result.observations,
    schemaVersion: "1.0.0",
    sources: ["bods"],
    partialCoverage: result.coverage < 1,
    notes: result.notes.slice(0, 5).join("; "),
  });

  report.outcome = "collected";
  console.log(
    `Collected ${result.observations.length} observations across ${result.partitions.filter((p) => p.ok).length} partitions ` +
      `(${(result.coverage * 100).toFixed(0)}% coverage).`,
  );
  writeReport(report);
  return 0;
}

function writeReport(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("collection-report.json", JSON.stringify(report, null, 2));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Intelligence collection job failed:", error);
    process.exitCode = 1;
  });
