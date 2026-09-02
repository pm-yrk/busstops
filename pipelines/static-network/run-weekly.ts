#!/usr/bin/env node
/**
 * Weekly full reconciliation: rebuild the whole national network regardless of fingerprints and
 * compare it with what is currently published, producing a Network Changes report.
 *
 * A reconciliation that finds a mass disappearance does not publish: that pattern is far more
 * likely to be a broken upstream release than thousands of real withdrawals.
 */

import { writeFileSync } from "node:fs";
import { ArtifactStore, r2StoreFromEnv } from "@busstops/pipeline-core";
import type { Operator, RoutePattern, ServiceRoute, Stop } from "@busstops/contracts";
import { buildNetwork } from "./src/build-network.js";
import { DATASETS, publishNetwork } from "./src/publish.js";
import { reconcileNetwork, summariseNetworkChanges } from "./src/reconcile.js";
import { fetchStaticSources } from "./src/sources.js";

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
  if (!sources.naptanCsv) {
    report.outcome = "source_unavailable";
    report.sourceErrors = sources.errors;
    console.error("NaPTAN could not be fetched; reconciliation cannot run.");
    writeReport(report);
    return 1;
  }

  const network = buildNetwork({
    naptanCsv: sources.naptanCsv,
    transXChangeDocuments: sources.transXChangeDocuments,
    retrievedAt: startedAt.toISOString(),
    serviceDate: startedAt.toISOString().slice(0, 10),
  });

  const [stops, operators, services, patterns] = await Promise.all([
    artifacts.readCurrent<Stop>(DATASETS.stops),
    artifacts.readCurrent<Operator>(DATASETS.operators),
    artifacts.readCurrent<ServiceRoute>(DATASETS.services),
    artifacts.readCurrent<RoutePattern>(DATASETS.patterns),
  ]);

  const changes = reconcileNetwork(
    {
      stops: stops.records,
      operators: operators.records,
      services: services.records,
      patterns: patterns.records,
    },
    network,
    { generatedAt: startedAt.toISOString() },
  );

  const summary = summariseNetworkChanges(changes);
  console.log(summary);

  report.summary = summary;
  report.anomalies = changes.anomalies;
  report.counts = network.counts;

  if (changes.anomalies.length > 0) {
    report.outcome = "anomalies_detected";
    console.error("Reconciliation found anomalies; not publishing this build.");
    writeReport(report);
    return 1;
  }

  const result = await publishNetwork(store, network, { version: startedAt.toISOString() });
  report.outcome = result.complete ? "published" : "incomplete";
  report.failed = result.failed;
  writeReport(report);
  return result.complete ? 0 : 1;
}

function writeReport(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("network-changes.json", JSON.stringify(report, null, 2));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Weekly reconciliation failed:", error);
    process.exitCode = 1;
  });
