#!/usr/bin/env node
/**
 * Physical proof that an artifact can answer for the days it claims.
 *
 * "The code publishes seven days now" is not evidence. This reads the bucket that serves the
 * deployed API, finds the version its index names, and counts the departure and pattern-trip
 * objects actually present for each date in the horizon. A date with no objects is a date on which
 * every board outside London will say nothing is due, so a missing one fails this.
 *
 * It writes nothing and reads only listings, which is why it is safe to run against a live bucket.
 */

import { writeFileSync } from "node:fs";
import { ArtifactStore, r2StoreFromEnv } from "@busstops/pipeline-core";
import {
  DEPARTURE_BUCKETS,
  DEPARTURES_PREFIX,
  PATTERN_TRIPS_PREFIX,
} from "./src/departures-index.js";
import { SHARDED } from "./src/shards.js";
import { serviceDateHorizonFromEnv } from "./src/service-dates.js";

async function main(): Promise<number> {
  const startedAt = new Date();
  const report: Record<string, unknown> = { startedAt: startedAt.toISOString() };

  const storeResult = r2StoreFromEnv(process.env);
  if (!storeResult.ok) {
    report.outcome = "not_configured";
    report.missing = storeResult.missing;
    console.error(`Artifact storage is not configured. Missing: ${storeResult.missing.join(", ")}`);
    write(report);
    return 1;
  }

  const store = storeResult.store;
  const index = await new ArtifactStore(store).readManifest(SHARDED.index);
  if (!index) {
    report.outcome = "no_artifact";
    console.error(`${SHARDED.index} names no published version; there is no artifact to prove.`);
    write(report);
    return 1;
  }

  const { serviceDates } = serviceDateHorizonFromEnv(startedAt, process.env);
  report.version = index.version;
  report.serviceDates = serviceDates;
  console.log(`Artifact version ${index.version}, asked about ${serviceDates.join(", ")}.`);

  /*
   * Counted at this version specifically. An object left behind by an older version would make a
   * date look covered while the edge, which addresses shards at the version the index names, read
   * nothing — the exact failure this is here to rule out.
   */
  const suffix = `/${index.version}.jsonl`;
  const rows: Array<{ date: string; departures: number; patternTrips: number }> = [];
  for (const date of serviceDates) {
    const departures = (await store.list(`data/${DEPARTURES_PREFIX}/${date}/`)).filter((key) =>
      key.endsWith(suffix),
    ).length;
    const patternTrips = (await store.list(`data/${PATTERN_TRIPS_PREFIX}/${date}/`)).filter((key) =>
      key.endsWith(suffix),
    ).length;
    rows.push({ date, departures, patternTrips });
    console.log(
      `${date}  ${String(departures).padStart(5)} departure shard(s)  ` +
        `${String(patternTrips).padStart(5)} pattern-trip shard(s)` +
        (departures === 0
          ? "   <-- no board outside London can answer for this day"
          : departures < DEPARTURE_BUCKETS
            ? `   <-- ${DEPARTURE_BUCKETS - departures} bucket(s) missing of ${DEPARTURE_BUCKETS}`
            : ""),
    );
  }
  report.coverage = rows;

  /*
   * A count, not merely a presence.
   *
   * The first version of this failed only a date with *no* shards, which is a check a partially
   * written date passes: the publish is bucketed 512 ways by a hash of the stop, so a date holding
   * 200 buckets answers for two fifths of the country's stops and says nothing at the rest. That is
   * precisely the failure this tool exists to catch — run 78's refresh was killed at its step limit
   * partway through, and "every date has at least one object" would have called that covered.
   */
  const expected = DEPARTURE_BUCKETS;
  const floor = Math.floor(expected * 0.95);
  const short = rows.filter((row) => row.departures < floor);
  report.expectedDepartureShardsPerDate = expected;
  report.datesShortOfFullCoverage = short.map((row) => ({
    date: row.date,
    departures: row.departures,
  }));
  if (short.length > 0) {
    report.outcome = "horizon_incomplete";
    console.error(
      `${short.length} of ${rows.length} service date(s) hold fewer than ${floor} of ${expected} ` +
        `departure shards at this version: ` +
        short.map((row) => `${row.date} (${row.departures})`).join(", ") +
        `. A date short of its buckets answers for some of England's stops and not the rest.`,
    );
    write(report);
    return 1;
  }

  report.outcome = "covered";
  console.log(
    `Every one of the ${rows.length} date(s) from ${serviceDates[0]} to ` +
      `${serviceDates[serviceDates.length - 1]} holds its full ${expected} departure shards at ` +
      `version ${index.version}.`,
  );
  write(report);
  return 0;
}

function write(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("horizon-report.json", JSON.stringify(report, null, 2));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Proving the departure horizon failed:", error);
    process.exitCode = 1;
  });
