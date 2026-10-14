#!/usr/bin/env node
/**
 * Scheduled collection of official disruption notices.
 *
 * Runs every few minutes, asks each publisher what it is currently saying, and publishes one
 * small artifact the Worker reads whole. It is deliberately separate from the analytics pipeline:
 * a passenger must not have to wait for a statistical baseline before an operator's own "this
 * route is suspended" reaches them.
 *
 * `allowEmpty` is on. A quiet network is a real answer, and refusing an empty publish would leave
 * yesterday's notices on screen until something went wrong again.
 */

import { writeFileSync } from "node:fs";
import { ArtifactStore, annotateReport, r2StoreFromEnv } from "@busstops/pipeline-core";
import { collectDisruptions } from "./src/index.js";

const DATASET = "disruptions/notices";
const SCHEMA_VERSION = "1";

async function main(): Promise<number> {
  const startedAt = new Date();
  const report: Record<string, unknown> = { startedAt: startedAt.toISOString(), dataset: DATASET };

  const result = await collectDisruptions({
    bodsApiKey: process.env.BODS_API_KEY,
    tflAppKey: process.env.TFL_APP_KEY,
    retrievedAt: startedAt.toISOString(),
    now: startedAt,
  });

  report.sources = result.sources;
  report.notices = result.notices.length;
  report.dropped = result.dropped;

  for (const source of result.sources) {
    console.log(
      `${source.source.padEnd(18)} ${source.outcome.padEnd(15)} ${String(source.records).padStart(5)} notices` +
        (source.offered === undefined ? "" : ` of ${source.offered} offered`) +
        (source.bytes === undefined ? "" : ` · ${(source.bytes / 1024 / 1024).toFixed(2)} MiB`) +
        (source.ms === undefined ? "" : ` · ${source.ms}ms`) +
        (source.error === undefined ? "" : ` · ${source.error}`),
    );
  }
  console.log(`Published set: ${result.notices.length} notices, ${result.dropped} over the cap.`);

  /*
   * Every source failing is not an empty network, it is a blind pipeline, and publishing an empty
   * artifact then would replace real notices with silence. The previous version stays live.
   */
  const usable = result.sources.filter((source) => source.outcome === "ok");
  const attempted = result.sources.filter((source) => source.outcome !== "not_configured");
  if (attempted.length > 0 && usable.length === 0 && result.notices.length === 0) {
    report.outcome = "no_source_answered";
    console.error("No source returned a notice; leaving the previous publish live.");
    writeReport(report);
    return 1;
  }

  const storage = r2StoreFromEnv(process.env);
  if (!storage.ok) {
    // Exit zero: a schedule that crashes on missing configuration disappears from view, and the
    // gap is more useful reported than fatal.
    report.outcome = "storage_not_configured";
    report.missing = storage.missing;
    console.error(`R2 is not configured (${storage.missing.join(", ")}); nothing published.`);
    writeReport(report);
    return 0;
  }

  const artifacts = new ArtifactStore(storage.store);
  const manifest = await artifacts.publish({
    dataset: DATASET,
    version: startedAt.toISOString().replace(/[:.]/g, "-"),
    records: result.notices,
    schemaVersion: SCHEMA_VERSION,
    sources: result.sources.map((source) => source.source),
    allowEmpty: true,
    /*
     * No shrink guard, because here the size *is* the news.
     *
     * The default refuses a publish that is more than a quarter smaller than the last one, which
     * is right for a national timetable and wrong for live disruption notices: a road reopens and
     * its notice goes away. Three of the five scheduled runs since the schedules came back failed
     * with `ArtifactValidationError: Artifact disruptions/notices shrank by 27.2% versus version
     * 2026-10-14T05-16-23-389Z`, so the deployment served notices hours older than the ones that
     * had just been collected — the guard was causing the staleness it exists to prevent.
     *
     * What actually protects this dataset is above: if every source that was attempted failed and
     * nothing came back, the collector returns before this line and the previous publish stays
     * live. That is the case worth refusing. "Fewer roads are closed than this morning" is not.
     */
    maximumShrinkFraction: 1,
    notes: JSON.stringify({ sources: result.sources, dropped: result.dropped }),
  });

  report.outcome = "published";
  report.version = manifest.version;
  console.log(`Published ${DATASET} version ${manifest.version}.`);
  writeReport(report);
  return 0;
}

function writeReport(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("disruptions-report.json", JSON.stringify(report, null, 2));
  // Readable from outside the runner, for the same reason as every other pipeline here.

  annotateReport("disruptions", report);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  /*
   * A crash has to leave something readable behind.
   *
   * This run failed from `main` with "Process completed with exit code 1" and nothing else: the
   * only deliberate failure path writes a report and annotates it, so a bare exit code means the
   * collector threw and this handler swallowed the reason. Job logs are not reachable from the
   * build container, so an un-annotated crash is a failure that cannot be diagnosed without
   * running it again and hoping.
   */
  .catch((error: unknown) => {
    const described = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(described);
    const crash: Record<string, unknown> = { outcome: "threw", error: described };
    if (error instanceof Error && error.stack) {
      // The first few frames only: enough to name the module, short enough for an annotation.
      crash.stack = error.stack.split("\n").slice(1, 5).join(" | ");
    }
    try {
      writeReport(crash);
    } catch {
      // A report that cannot be written must not replace the exit code with its own failure.
    }
    process.exitCode = 1;
  });
