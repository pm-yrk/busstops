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
import {
  ArtifactStore,
  annotateReport,
  buildRecentTraceBuckets,
  r2StoreFromEnv,
  numberFromEnv,
  positiveNumberFromEnv,
} from "@busstops/pipeline-core";
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
  const utilization = numberFromEnv(process.env.BUDGET_UTILIZATION, 0);
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
      maxRequestsPerRun: positiveNumberFromEnv(process.env.MAX_PARTITIONS_PER_RUN, 12),
      /*
       * Derived from the published interval rather than invented: one request every five seconds
       * is 17,280 a day at most, and the registry's self-imposed half of that is the default.
       * BODS publishes no daily quota, so a larger number here would be a number nobody stated.
       */
      dailyRequestBudget: positiveNumberFromEnv(process.env.BODS_DAILY_REQUEST_BUDGET, 8640),
    },
    governorState,
    fetchPartition: collector.fetchPartition,
    window,
    budgetMs: positiveNumberFromEnv(process.env.COLLECTION_BUDGET_MS, 240000),
    // The publisher's stated interval, honoured at the point of request rather than assumed.
    minimumRequestIntervalMs: BODS_MINIMUM_REQUEST_INTERVAL_MS,
    // Several snapshots per run: one position per vehicle cannot yield a traversal or a speed.
    passes: positiveNumberFromEnv(process.env.COLLECTION_PASSES, 3),
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
    /*
     * This artifact's record count is a measurement of the world, not a proxy for how well the
     * feed was read — so the default shrink guard is measuring the wrong thing.
     *
     * `publish` refuses a 25% shrink to stop a half-read upstream replacing a good artifact. A
     * snapshot of buses currently on the road legitimately collapses in the evening: the 20:04 run
     * on 14 October threw `ArtifactValidationError: intelligence/observations shrank by 57.0%
     * versus version 2026-10-14T15:55:22.997Z`, which is not a bad read — it is a Wednesday at
     * nine in the evening having fewer buses out than four in the afternoon. The run collected its
     * observations, could not publish them, and exited 1.
     *
     * Refusing it is also the worse outcome for the product, not the safer one. The previous good
     * version is kept, so Pro would keep presenting an afternoon snapshot as the current picture —
     * a fuller number that is no longer true. Thin real data beats fake precision, and
     * `partialCoverage` already carries the honest signal when the feed itself was incomplete.
     */
    maximumShrinkFraction: 1,
  });

  /*
   * And the same observations again, bucketed so one bus tap costs one small read.
   *
   * The artifact above is the whole national window — thirteen to thirty-nine thousand records on
   * the runs measured — and the passenger map needs "where has this one bus just been" inside a
   * 10ms CPU budget. Reading that artifact to answer it is the national read a tap must not cost.
   *
   * 64 objects at fixed keys, overwritten every run: ~256 writes a day against an allowance of
   * roughly 33,000, and 64 objects in R2 forever rather than a growing family. One object per
   * vehicle was the obvious alternative and the arithmetic rules it out — about 6,500 vehicles a
   * run is 26,000 writes a day, three quarters of the whole project's allowance, for a decoration.
   *
   * Reported rather than silent, because a trail that stops appearing should be visible here
   * before it is visible as an absence on the map.
   */
  const traces = buildRecentTraceBuckets(
    result.observations.map((observation) => ({
      vehicleRef: observation.vehicleRef,
      observedAt: observation.observedAt,
      lat: observation.coordinate.lat,
      lon: observation.coordinate.lon,
    })),
    startedAt,
  );

  let traceBytes = 0;
  let traceFailures = 0;
  for (const [key, body] of traces) {
    try {
      await storeResult.store.put(key, body);
      traceBytes += body.length;
    } catch {
      /*
       * A failed bucket costs that bus its trail and nothing else. Collection's job is the
       * observations, which are already published above, and losing a decoration must not fail the
       * run that gathered the data.
       */
      traceFailures += 1;
    }
  }
  report.recentTraces = {
    buckets: traces.size,
    bytes: traceBytes,
    meanBucketBytes: traces.size > 0 ? Math.round(traceBytes / traces.size) : 0,
    vehiclesWithATrail: [...traces.values()].reduce(
      // Every line but the header is one vehicle with at least two points.
      (total, body) => total + Math.max(0, body.split("\n").length - 1),
      0,
    ),
    failures: traceFailures,
  };

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
  /*
   * And through the one channel that can be read from outside the runner. Without this a failed
   * collection is silent: the step is marked "success" by `continue-on-error`, the report goes to
   * an unreachable artifact host, and the first visible symptom is the analytics batch reporting
   * `no_input` two steps later — which says nothing about why.
   */
  annotateReport("live collection", report);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Intelligence collection job failed:", error);
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
      const thrown = {
        outcome: "threw",
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        stack: error instanceof Error ? (error.stack ?? "").slice(0, 1200) : undefined,
        finishedAt: new Date().toISOString(),
      };
      writeFileSync("collection-report.json", JSON.stringify(thrown, null, 2));
      annotateReport("live collection", thrown);
    } catch {
      // A report we cannot write is not worth failing twice over; the console still carries it.
    }
    process.exitCode = 1;
  });
