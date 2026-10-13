#!/usr/bin/env node
/**
 * Scheduled collection of stop weather.
 *
 * Asks Open-Meteo about every cell that has a bus stop in it and publishes one small artifact per
 * degree square. The Worker reads one square to show one stop, and never asks Open-Meteo anything
 * itself — which is what keeps the upstream cost a property of this schedule rather than of how
 * many people are looking at the site.
 *
 * Exits zero when there is nothing to publish. A schedule that fails loudly on missing
 * configuration disappears into a wall of red runs; the gap is more useful reported than fatal.
 */

import { writeFileSync } from "node:fs";
import { r2StoreFromEnv } from "@busstops/pipeline-core";
import { collectStopWeather } from "./src/index.js";

/** Must match the workflow's cron. Passed in so the budget check is against the real interval. */
const REFRESH_MINUTES = Number(process.env.WEATHER_REFRESH_MINUTES ?? "30");

async function main(): Promise<number> {
  const startedAt = new Date();
  const report: Record<string, unknown> = {
    startedAt: startedAt.toISOString(),
    refreshMinutes: REFRESH_MINUTES,
  };

  const storage = r2StoreFromEnv(process.env);
  if (!storage.ok) {
    report.outcome = "storage_not_configured";
    report.missing = storage.missing;
    console.error(`R2 is not configured (${storage.missing.join(", ")}); nothing published.`);
    writeReport(report);
    return 0;
  }

  const result = await collectStopWeather({
    store: storage.store,
    refreshMinutes: REFRESH_MINUTES,
    now: startedAt,
  });

  Object.assign(report, result);

  console.log(
    `Cells: ${result.requested} requested, ${result.answered} answered, ${result.missing} missing.`,
  );
  console.log(
    `Budget: ${result.budget.requestsPerRefresh} requests per refresh, ` +
      `${result.budget.requestsPerDay} a day against an allowance of ${result.budget.dailyAllowance} ` +
      `(${result.budget.withinAllowance ? "within" : "OVER"}).`,
  );
  for (const batch of result.batches) {
    console.log(
      `  batch ${String(batch.cells).padStart(3)} cells → ${String(batch.answered).padStart(3)} answered` +
        ` · ${batch.ms}ms${batch.error === undefined ? "" : ` · ${batch.error}`}`,
    );
  }
  console.log(`Shards: ${result.shards.length}. Outcome: ${result.outcome}.`);

  writeReport(report);

  /*
   * "Published" and "the network is not there yet" are both fine. Everything else means this run
   * spent upstream requests and has nothing to show for it, which should be visible as a failure.
   */
  return result.outcome === "published" || result.outcome === "network_not_published" ? 0 : 1;
}

function writeReport(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("weather-report.json", JSON.stringify(report, null, 2));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  });
