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
import { r2StoreFromEnv, positiveNumberFromEnv, annotateReport } from "@busstops/pipeline-core";
import { collectStopWeather } from "./src/index.js";

/** Must match the workflow's cron. Passed in so the budget check is against the real interval. */
const REFRESH_MINUTES = positiveNumberFromEnv(process.env.WEATHER_REFRESH_MINUTES, 30);

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
   * Which outcomes are this project's problem.
   *
   * "Published" and "the network is not there yet" were always fine. `upstream_refused` joins them
   * because it is not a defect: Open-Meteo's free tier is strict per moment and a GitHub runner
   * shares its egress address with everyone else asking at the same time, so a run that asked
   * politely, was turned away on every batch, published nothing and left the previous good shards
   * alone has behaved correctly. The schedule runs every thirty minutes and recovers by itself;
   * three such runs on 13 and 14 October were red for doing exactly the right thing, and a red
   * run that means nothing teaches whoever is watching to ignore the colour.
   *
   * Everything else is still a failure, and deliberately so: `no_answer` means a batch answered
   * and this code could not use it, `publish_failed` means the weather arrived and no square could
   * be written, and the two configuration outcomes mean the schedule does not fit its allowance.
   */
  const notOurFault = ["published", "network_not_published", "upstream_refused"];
  return notOurFault.includes(result.outcome) ? 0 : 1;
}

function writeReport(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("weather-report.json", JSON.stringify(report, null, 2));
  /*
   * And through the one channel that is readable from outside the runner, like every other
   * pipeline here. The uploaded artifact is served from a host this project's container cannot
   * reach, and the step summary is not exposed by the API at all, so an annotation is the whole
   * difference between a diagnosable failure and "Process completed with exit code 1".
   */
  annotateReport("stop weather", report);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  /*
   * A crash has to leave something readable behind.
   *
   * Three scheduled runs failed on 13 and 14 October with nothing but an exit code, and they can
   * be told apart from the deliberate failure paths by what they did not leave: every path that
   * returns a code writes `weather-report.json`, and those three runs uploaded no artifact at
   * all. So the collector threw and this handler printed the reason into a log nobody can read.
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
