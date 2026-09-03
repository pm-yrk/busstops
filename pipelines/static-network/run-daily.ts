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
  type SourceFingerprint,
} from "./src/fingerprint.js";
import { publishJourneyTiles, publishNetwork, rollbackNetwork } from "./src/publish.js";
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

  const sources = await fetchStaticSources({ bodsApiKey: process.env.BODS_API_KEY });
  report.sourceHealth = sources.health;
  report.sourceErrors = sources.errors;

  if (!sources.naptanCsv) {
    report.outcome = "source_unavailable";
    console.error("NaPTAN could not be fetched; keeping the previous good network.");
    writeReport(report);
    return 1;
  }

  const currentFingerprints: SourceFingerprint[] = [
    fingerprintFromBody("naptan", sources.naptanCsv, startedAt.toISOString()),
    fingerprintFromBody("bods", sources.transXChangeDocuments.join("\n"), startedAt.toISOString()),
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

  if (!result.complete) {
    // A partial publish is worse than no publish: restore the previous consistent version.
    const rolledBack = await rollbackNetwork(store);
    report.outcome = "rolled_back";
    report.rolledBack = rolledBack;
    console.error(
      `Publish incomplete; rolled back: ${rolledBack.join(", ") || "(nothing to restore)"}`,
    );
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
