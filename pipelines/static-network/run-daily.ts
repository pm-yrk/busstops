#!/usr/bin/env node
/**
 * Daily static-network job: fingerprint each source, rebuild only on change, publish atomically.
 *
 * Exits non-zero only on a real failure. A missing credential is reported as a configuration
 * outcome, not a crash, so the schedule keeps running and the gap stays visible in the report.
 */

import { writeFileSync } from "node:fs";
import { ArtifactStore, r2StoreFromEnv } from "@busstops/pipeline-core";
import { buildNetwork } from "./src/build-network.js";
import {
  compareFingerprints,
  fingerprintFromBody,
  fingerprintFromParts,
  type SourceFingerprint,
} from "./src/fingerprint.js";
import { publishJourneyTiles, publishNetwork, rollbackNetwork } from "./src/publish.js";
import { publishNetworkShards } from "./src/publish-shards.js";
import { fetchStaticSources } from "./src/sources.js";

const FINGERPRINT_DATASET = "network/fingerprints";

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

  const sources = await fetchStaticSources({
    bodsApiKey: process.env.BODS_API_KEY,
    ...(process.env.BODS_MAX_TIMETABLE_DATASETS
      ? { maxTimetableDatasets: Number(process.env.BODS_MAX_TIMETABLE_DATASETS) }
      : {}),
  });
  report.sourceHealth = sources.health;
  report.sourceErrors = sources.errors;
  /*
   * How much of England has a timetable, as a number.
   *
   * NaPTAN gives every stop in the country whatever happens here; services, routes and departures
   * come only from the datasets this run took. A build that fetched a fraction of them produces a
   * complete map with a departure board at some of its stops and none at others, which looks like
   * a defect at the stop and is really a coverage figure — so the figure is published.
   */
  report.timetableCoverage = sources.timetableCoverage;
  if (sources.timetableCoverage) {
    const { fetched, published } = sources.timetableCoverage;
    console.log(
      `Timetable coverage: ${fetched} of ${published ?? "an unstated number of"} published ` +
        `BODS datasets. Stops are national either way; services are not.`,
    );
  }

  if (!sources.naptanCsv) {
    report.outcome = "source_unavailable";
    console.error("NaPTAN could not be fetched; keeping the previous good network.");
    writeReport(report);
    return 1;
  }

  const currentFingerprints: SourceFingerprint[] = [
    fingerprintFromBody("naptan", sources.naptanCsv, startedAt.toISOString()),
    // Hashed in place rather than joined: the decompressed timetable documents are hundreds of
    // megabytes together, and concatenating them to fingerprint them is a second copy the heap
    // cannot afford.
    fingerprintFromParts("bods", sources.transXChangeDocuments, startedAt.toISOString()),
  ];

  const previous = await artifacts.readCurrent<SourceFingerprint>(FINGERPRINT_DATASET);
  const previousBySource = new Map(previous.records.map((f) => [f.source, f]));

  const comparisons = currentFingerprints.map((current) =>
    compareFingerprints(previousBySource.get(current.source) ?? null, current),
  );
  report.fingerprints = comparisons.map((c) => ({
    source: c.current.source,
    changed: c.changed,
    reason: c.reason,
  }));

  const forceRebuild = process.env.FORCE_REBUILD === "true";
  const changed = comparisons.some((c) => c.changed);

  if (!changed && !forceRebuild) {
    // Record the check so "unchanged" is distinguishable from "did not run".
    await artifacts.publish({
      dataset: FINGERPRINT_DATASET,
      version: startedAt.toISOString(),
      records: currentFingerprints,
      schemaVersion: "1.0.0",
      sources: ["naptan", "bods"],
    });
    report.outcome = "unchanged";
    console.log("No source changes detected; check recorded, rebuild skipped.");
    writeReport(report);
    return 0;
  }

  const serviceDate = startedAt.toISOString().slice(0, 10);
  const network = buildNetwork({
    naptanCsv: sources.naptanCsv,
    transXChangeDocuments: sources.transXChangeDocuments,
    retrievedAt: startedAt.toISOString(),
    serviceDate,
  });
  report.counts = network.counts;
  report.warnings = network.warnings.slice(0, 50);

  const result = await publishNetwork(store, network, { version: startedAt.toISOString() });
  report.published = result.published.map((m) => ({ dataset: m.dataset, records: m.recordCount }));
  report.failed = result.failed;

  // Journeys are also published per spatial tile, so the edge can plan a journey without
  // loading the national timetable. Published after the main datasets so a tile can never point
  // at journeys the network itself does not have.
  const tileResult = await publishJourneyTiles(store, network, {
    version: startedAt.toISOString(),
  });
  report.journeyTiles = {
    published: tileResult.tiles.length,
    failed: tileResult.failed.slice(0, 10),
    journeysWithoutGeometry: tileResult.journeysWithoutGeometry,
  };
  if (tileResult.journeysWithoutGeometry > 0) {
    console.error(
      `${tileResult.journeysWithoutGeometry} journeys could not be placed in a tile because their stops are unlocatable; they will not be plannable.`,
    );
  }

  // The edge reads shards, never the national datasets: measured against real data those are
  // 292 MiB of journeys, 198 MiB of stops and 100 MiB of patterns, against a 128 MiB isolate.
  // Published after the national datasets and before the fingerprints, so a failure here is a
  // failed run rather than a live index pointing at shards that do not exist.
  const shardResult = await publishNetworkShards(store, network, {
    version: startedAt.toISOString(),
  });
  report.shards = {
    published: shardResult.published,
    failed: shardResult.failed.slice(0, 10),
    oversized: shardResult.oversized,
    truncated: shardResult.truncated.slice(0, 10),
    // The size of the biggest shard in each family, which is the number that says whether the
    // sharding key is still fine enough — a record count never did.
    largest: shardResult.largest,
    stopTiles: shardResult.index?.stopTiles.length ?? 0,
    patternTiles: shardResult.index?.patternTiles.length ?? 0,
    searchPrefixes: shardResult.index?.searchPrefixes.length ?? 0,
  };
  if (shardResult.index === null) {
    console.error(
      `Shard publish incomplete (${shardResult.failed.length} failed); the edge keeps the ` +
        `previous version rather than reading a half-written one.`,
    );
  }
  if (shardResult.truncated.length > 0) {
    const worst = shardResult.truncated.reduce((a, b) => (b.dropped > a.dropped ? b : a));
    console.error(
      `${shardResult.truncated.length} shard(s) were truncated at the byte budget, worst ` +
        `${worst.dataset} losing ${worst.dropped} record(s). Those records are not readable at ` +
        `the edge; the sharding key needs to be finer for that family.`,
    );
  }
  if (shardResult.oversized.length > 0) {
    console.error(
      `${shardResult.oversized.length} shard(s) exceeded the record cap: ` +
        `${shardResult.oversized.slice(0, 5).join(", ")}. The sharding key needs to be finer.`,
    );
  }

  if (!result.complete) {
    /*
     * A partial publish is worse than no publish: restore the previous consistent version.
     *
     * The rollback can itself fail — a run that could not write its shards is a run whose storage
     * was refusing writes — and when it did, it threw out of `main` and took the build report
     * with it. The report is the only description of why a run published nothing, so a rollback
     * that fails is recorded as part of the report rather than instead of it.
     */
    report.outcome = "rolled_back";
    try {
      const rolledBack = await rollbackNetwork(store);
      report.rolledBack = rolledBack;
      console.error(
        `Publish incomplete; rolled back: ${rolledBack.join(", ") || "(nothing to restore)"}`,
      );
    } catch (error) {
      report.outcome = "rollback_failed";
      report.rollbackError = error instanceof Error ? error.message : String(error);
      console.error(`Publish incomplete and the rollback failed too: ${report.rollbackError}`);
    }
    writeReport(report);
    return 1;
  }

  await artifacts.publish({
    dataset: FINGERPRINT_DATASET,
    version: startedAt.toISOString(),
    records: currentFingerprints,
    schemaVersion: "1.0.0",
    sources: ["naptan", "bods"],
  });

  if (shardResult.index === null) {
    report.outcome = "shards_incomplete";
    writeReport(report);
    return 1;
  }

  report.outcome = "published";
  console.log(
    `Published national network: ${network.counts.stops} stops, ${network.counts.services} services, ` +
      `${network.counts.journeys} journeys.`,
  );
  writeReport(report);
  return 0;
}

function writeReport(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("build-report.json", JSON.stringify(report, null, 2));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Daily static-network job failed:", error);
    process.exitCode = 1;
  });
