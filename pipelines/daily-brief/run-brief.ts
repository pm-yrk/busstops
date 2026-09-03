#!/usr/bin/env node
/**
 * Daily Brief job.
 *
 * Builds one frozen snapshot from the published intelligence artifacts, publishes it so the
 * browser view reads exactly what the email said, then sends. If no email provider is configured
 * the snapshot is still built and published: the browser Daily Brief must work without email.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { DailyBriefSendRecord, Incident, Recipient } from "@busstops/contracts";
import { ArtifactStore, r2StoreFromEnv, londonParts, serviceDate } from "@busstops/pipeline-core";
import { classify } from "@busstops/governor";
import { buildSnapshot } from "@busstops/daily-brief";
import { providerFromEnv } from "./src/email-provider.js";
import { runDailyBriefSend } from "./src/run-brief.js";

const SNAPSHOT_DATASET = "brief/snapshots";
const RECIPIENTS_DATASET = "brief/recipients";
const SEND_RECORDS_DATASET = "brief/send-records";
const INCIDENTS_DATASET = "intelligence/incidents";

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

  const artifacts = new ArtifactStore(storeResult.store);
  const incidents = await artifacts.readCurrent<Incident>(INCIDENTS_DATASET);

  // Yesterday's service date, which is what the brief describes.
  const yesterday = serviceDate(new Date(now.getTime() - 86_400_000));
  const coverage = incidents.manifest === null ? 0 : incidents.manifest.partialCoverage ? 0.5 : 1;

  const snapshot = buildSnapshot({
    organisationId: null,
    scopeAreaIds: [],
    localDate: yesterday,
    generatedAt: now,
    artifactVersion: incidents.manifest?.version ?? "none",
    yesterday: {
      // Published analysis only. Where none exists the snapshot says so rather than inventing it.
      networkHealth: null,
      networkHealthBaseline: null,
      punctuality: null,
      reliability: null,
      medianDelaySeconds: null,
      denominator: 0,
      topPerformingRouteIds: [],
      requiresAttentionRouteIds: [],
      biggestDelayBurdenIncident: null,
      biggestAbnormalIncident:
        incidents.records.find(
          (incident) => incident.severity === "abnormal" || incident.severity === "highly_abnormal",
        ) ?? null,
      keyEvents: incidents.records.slice(0, 5),
      dataQualityIssues:
        incidents.manifest === null
          ? ["No intelligence artifact has been published, so nothing could be measured."]
          : [],
    },
    today: {
      riskBand: "low",
      confidence: {
        level: "low",
        score: 0.2,
        reasons: ["no published risk forecast for this period"],
      },
      weatherWindowSummary: "No weather forecast has been published for this scope.",
      activeFloodNoticeIds: [],
      plannedRoadworksIds: [],
      highestRiskCorridors: [],
    },
    sourceHealth: [],
    coverage,
  });

  // Published before sending, so the link in the email resolves to the same figures.
  await artifacts.publish({
    dataset: SNAPSHOT_DATASET,
    version: `${yesterday}-${now.toISOString()}`,
    records: [snapshot],
    schemaVersion: "1.0.0",
    sources: ["bods"],
    partialCoverage: coverage < 1,
  });
  report.snapshotId = snapshot.id;
  report.localDate = snapshot.localDate;
  report.coverage = coverage;

  const provider = providerFromEnv(process.env);
  report.provider = provider.name;

  const recipients = await artifacts.readCurrent<Recipient>(RECIPIENTS_DATASET);
  if (recipients.records.length === 0) {
    report.outcome = "no_recipients";
    console.log("Snapshot published; no recipients are configured, so nothing was sent.");
    writeReport(report);
    return 0;
  }

  const sendRecords = await artifacts.readCurrent<DailyBriefSendRecord>(SEND_RECORDS_DATASET);
  const today = serviceDate(now);
  const todaysRecords = sendRecords.records.filter((record) =>
    record.attemptedAt.startsWith(today),
  );

  const utilization = Number(process.env.BUDGET_UTILIZATION ?? "0");

  const result = await runDailyBriefSend({
    snapshot,
    coverage,
    recipients: recipients.records,
    todaysRecords,
    governorState: classify(utilization, utilization),
    provider,
    baseUrl: process.env.PUBLIC_BASE_URL ?? "https://busstops.example",
    organisationName: null,
    unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET ?? "",
    localTimeFor: (recipient) => {
      const parts = londonParts(now);
      void recipient;
      return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
    },
    now: () => new Date(),
    generateToken: () => randomUUID(),
  });

  report.attempted = result.attempted;
  report.sent = result.sent;
  report.suppressed = result.suppressed;
  report.failed = result.failed;
  report.skipped = result.skipped;
  report.notes = result.notes;

  // Every attempt is recorded, including the refusals, so an absence of email is explainable.
  await artifacts.publish({
    dataset: SEND_RECORDS_DATASET,
    version: now.toISOString(),
    records: [...sendRecords.records.slice(-500), ...result.records],
    schemaVersion: "1.0.0",
    sources: ["internal"],
    allowEmpty: true,
    minimumRecordCount: 0,
    maximumShrinkFraction: 1,
  });

  report.outcome = result.failed > 0 ? "partial" : "completed";
  console.log(
    `Daily Brief ${snapshot.localDate}: ${result.sent} sent, ${result.suppressed} suppressed, ` +
      `${result.skipped} skipped, ${result.failed} failed.`,
  );
  writeReport(report);
  return result.failed > 0 ? 1 : 0;
}

function writeReport(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("brief-report.json", JSON.stringify(report, null, 2));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Daily Brief job failed:", error);
    process.exitCode = 1;
  });
