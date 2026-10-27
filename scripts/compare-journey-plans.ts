#!/usr/bin/env node
/**
 * Hold a candidate planner's answers against the deployed planner's, and report the five numbers.
 *
 * The comparison itself lives in `scripts/lib/compare-plans.ts`, where it is tested against cases
 * built by hand. This is the file reading and the reporting around it.
 *
 * It exits non-zero when a journey was lost or an answer was materially worse, so a pipeline
 * cannot report a faster planner as a success while it is quietly answering worse journeys.
 *
 *   npx tsx scripts/compare-journey-plans.ts --baseline journey-corpus.json \
 *     --candidate candidate-corpus.json [--json comparison.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { annotateReport } from "@busstops/pipeline-core";
import { comparePlans, type Corpus } from "./lib/compare-plans.js";

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

function read(path: string): Corpus {
  return JSON.parse(readFileSync(path, "utf8")) as Corpus;
}

function main(): number {
  const baselinePath = arg("baseline");
  const candidatePath = arg("candidate");
  if (!baselinePath || !candidatePath) {
    console.error("both --baseline and --candidate are required");
    return 2;
  }

  const baseline = read(baselinePath);
  const candidate = read(candidatePath);
  const comparison = comparePlans(baseline, candidate);

  const report = {
    outcome: "compared",
    baseline: { path: baselinePath, version: baseline.version, serviceDate: baseline.serviceDate },
    candidate: {
      path: candidatePath,
      version: candidate.version,
      serviceDate: candidate.serviceDate,
    },
    ...comparison,
  };

  const out = arg("json");
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
  annotateReport("journey correctness", report);

  console.log(
    `Comparable queries: ${String(comparison.comparable)} of ${String(comparison.queries)}`,
  );
  console.log(`same best itinerary  ${comparison.sameBestItinerary}`);
  console.log(`same fastest arrival ${comparison.sameFastestArrival}`);
  console.log(`same fewest changes  ${comparison.sameFewestChanges}`);
  console.log(`journey lost         ${comparison.journeyLost}`);
  console.log(`materially worse     ${comparison.materiallyWorse}`);
  console.log(`journeys gained      ${String(comparison.journeysGained)}`);

  return comparison.failed ? 1 : 0;
}

process.exit(main());
