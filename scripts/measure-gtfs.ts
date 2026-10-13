#!/usr/bin/env node
/**
 * Measures the BODS GTFS timetable downloads, so the pipeline is designed from figures.
 *
 * The static network currently takes the first 60 of 945 published TransXChange datasets, which
 * is why a stop in Manchester has no routes. The replacement is BODS's own GTFS extract, and the
 * choice between the national file and the regional ones — and whether a two-day horizon is
 * enough — should be made from what they actually contain, not from what they are assumed to
 * contain. So this downloads them, reads them with the streaming reader the pipeline will use,
 * and prints sizes, row counts, service-date coverage and throughput.
 *
 * Nothing is held in memory but the indexes it reports on; `stop_times.txt` is streamed and
 * counted, never collected.
 *
 *   npx tsx scripts/measure-gtfs.ts [--regions all,yorkshire] [--json report.json]
 */

import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { annotateReport } from "@busstops/pipeline-core";
import {
  readZipDirectory,
  type ZipDirectoryEntry,
} from "../pipelines/static-network/src/gtfs-zip.js";
import { streamGtfsTable } from "../pipelines/static-network/src/gtfs-csv.js";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

const BODS_KEY = process.env.BODS_API_KEY;
const JSON_OUT = arg("json");
const REGIONS = (arg("regions") ?? "all")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);
const KEEP = args.includes("--keep");

const GTFS_BASE = "https://data.bus-data.dft.gov.uk/timetable/download/gtfs-file";

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const rss = (): string => `${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MiB`;

function serviceDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Downloads to disk. The file is never held in memory, only streamed through to storage. */
async function download(url: string, destination: string): Promise<{ bytes: number; ms: number }> {
  const started = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(900_000) });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} for ${url.replace(/api_key=[^&]*/, "api_key=***")}`);
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
  const { size } = await stat(destination);
  return { bytes: size, ms: Date.now() - started };
}

function entry(entries: ZipDirectoryEntry[], name: string): ZipDirectoryEntry | undefined {
  return entries.find((candidate) => candidate.name.replace(/^.*\//, "") === name);
}

interface RegionReport {
  region: string;
  url: string;
  downloadBytes?: number;
  downloadMs?: number;
  entries?: Array<{ name: string; compressed: number; uncompressed: number }>;
  counts?: Record<string, number>;
  activeServiceIds?: { today: number; tomorrow: number };
  tripsOnHorizon?: number;
  stopTimesTotal?: number;
  stopTimesOnHorizon?: number;
  stopTimesMs?: number;
  peakRssMib?: number;
  error?: string;
}

async function measureRegion(region: string): Promise<RegionReport> {
  const url = new URL(`${GTFS_BASE}/${region}/`);
  if (BODS_KEY) url.searchParams.set("api_key", BODS_KEY);
  const destination = join(tmpdir(), `gtfs-${region}.zip`);
  const report: RegionReport = { region, url: `${GTFS_BASE}/${region}/` };

  try {
    console.log("");
    console.log("-".repeat(72));
    console.log(`Region: ${region}`);
    const downloaded = await download(url.toString(), destination);
    report.downloadBytes = downloaded.bytes;
    report.downloadMs = downloaded.ms;
    console.log(
      `  download: ${mib(downloaded.bytes)} in ${(downloaded.ms / 1000).toFixed(1)}s  (rss ${rss()})`,
    );

    const directory = await readZipDirectory(destination);
    report.entries = directory.entries.map((e) => ({
      name: e.name,
      compressed: e.compressedSize,
      uncompressed: e.uncompressedSize,
    }));
    console.log("  entries:");
    for (const e of directory.entries) {
      console.log(
        `    ${e.name.padEnd(22)} ${mib(e.compressedSize).padStart(11)} compressed  ${mib(e.uncompressedSize).padStart(11)} inflated`,
      );
    }

    const counts: Record<string, number> = {};
    const today = serviceDate(new Date());
    const tomorrow = serviceDate(new Date(Date.now() + 86_400_000));
    const weekdayColumn = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ][new Date().getUTCDay()]!;
    const tomorrowColumn = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ][new Date(Date.now() + 86_400_000).getUTCDay()]!;

    // calendar.txt: which service_ids run on the two dates in the horizon.
    const activeToday = new Set<string>();
    const activeTomorrow = new Set<string>();
    const calendar = entry(directory.entries, "calendar.txt");
    if (calendar) {
      const result = await streamGtfsTable(destination, calendar, (row) => {
        const from = row.start_date ?? "";
        const to = row.end_date ?? "";
        const id = row.service_id ?? "";
        if (from <= today && today <= to && row[weekdayColumn] === "1") activeToday.add(id);
        if (from <= tomorrow && tomorrow <= to && row[tomorrowColumn] === "1") {
          activeTomorrow.add(id);
        }
      });
      counts["calendar.txt"] = result.rows;
    }

    // calendar_dates.txt: the exceptions, which add and remove service on specific dates.
    const calendarDates = entry(directory.entries, "calendar_dates.txt");
    if (calendarDates) {
      const result = await streamGtfsTable(destination, calendarDates, (row) => {
        const id = row.service_id ?? "";
        const date = row.date ?? "";
        const added = row.exception_type === "1";
        if (date === today) {
          if (added) activeToday.add(id);
          else activeToday.delete(id);
        }
        if (date === tomorrow) {
          if (added) activeTomorrow.add(id);
          else activeTomorrow.delete(id);
        }
      });
      counts["calendar_dates.txt"] = result.rows;
    }
    report.activeServiceIds = { today: activeToday.size, tomorrow: activeTomorrow.size };

    for (const name of [
      "agency.txt",
      "routes.txt",
      "stops.txt",
      "feed_info.txt",
      "frequencies.txt",
      "shapes.txt",
      "transfers.txt",
    ]) {
      const table = entry(directory.entries, name);
      if (!table) continue;
      const result = await streamGtfsTable(destination, table, () => {}, {
        columns: [],
      });
      counts[name] = result.rows;
    }

    /*
     * What `agency.txt` is actually keyed by — the measurement Pro's route join waits on.
     *
     * The network build records `row.agency_id ?? row.agency_name` as an operator's registry id,
     * and the analytics batch then maps 0 of 20,033 observed vehicles to a route because not one
     * of 295 `OperatorRef` codes from SIRI-VM matches any of 631 published operators. A *total*
     * miss means the two sides use different identifiers, and there are only two ways that
     * happens: `agency_id` is present but is not a National Operator Code, or it is absent and
     * the operator's *name* became its registry id.
     *
     * Nothing in this repository can distinguish those. The SIRI fixture is built from the
     * published schema rather than captured, and there is no captured BODS GTFS fixture at all.
     * One real row settles it, and this job already has the archive open.
     *
     * Values are sampled, not dumped: a handful of ids and names is the evidence, and the rest of
     * the file is somebody's licensed data.
     */
    const agency = entry(directory.entries, "agency.txt");
    if (agency) {
      const ids: string[] = [];
      const names: string[] = [];
      let withId = 0;
      let rows = 0;
      /*
       * The header, before anything else.
       *
       * `agency_id` turned out to be a BODS-internal id, which leaves the operator join needing a
       * National Operator Code from somewhere. Before reaching for a third dataset it is worth
       * knowing whether the feed already carries one in a column nobody read: GTFS permits
       * publisher extensions, and the sampling above only asked for `agency_id` and `agency_name`
       * because those are the two the build uses. A `noc` column here would make this a one-line
       * fix instead of a new adapter.
       */
      const agencyColumns = await streamGtfsTable(destination, agency, () => {}, { columns: [] });
      await streamGtfsTable(
        destination,
        agency,
        (row) => {
          rows += 1;
          if (row.agency_id !== undefined && row.agency_id.length > 0) {
            withId += 1;
            if (ids.length < 12) ids.push(row.agency_id);
          }
          if (names.length < 6 && row.agency_name) names.push(row.agency_name);
        },
        { columns: ["agency_id", "agency_name"] },
      );
      /*
       * A National Operator Code is four alphanumerics, conventionally upper case. Shape-matching
       * is not proof, but "every sampled id is NOC-shaped" and "none of them is" are the two
       * answers that decide where the fix goes, and either is clear at a glance.
       */
      const nocShaped = ids.filter((id) => /^[A-Z0-9]{4}$/.test(id)).length;
      report.agency = {
        rows,
        // Every column the publisher actually ships, so a NOC hiding in an extension is visible.
        columns: agencyColumns.header,
        withAgencyId: withId,
        // Zero here means `agency_name` became the registry id, which is the other candidate cause.
        sampleIds: ids,
        sampleNames: names,
        nocShapedSampleIds: nocShaped,
      };
      console.log(`  agency.txt columns: [${agencyColumns.header.join(", ")}]`);
      console.log(
        `  agency.txt: ${rows} row(s), ${withId} with an agency_id, ` +
          `${nocShaped} of ${ids.length} sampled id(s) NOC-shaped — ids [${ids.join(", ")}] ` +
          `names [${names.join(", ")}]`,
      );
    }

    /*
     * And the other side of a possible line-level join.
     *
     * With `agency_id` settled as a BODS-internal id, the operator hop needs a third dataset. The
     * line hop might not: if SIRI-VM's `LineRef` is a TransXchange line identifier and `route_id`
     * here is the same identifier, an observation can be attributed to a published route directly.
     * Both sides have to be seen to know, and this is the side the archive holds.
     */
    const routesTable = entry(directory.entries, "routes.txt");
    if (routesTable) {
      const routeIds: string[] = [];
      const shortNames: string[] = [];
      await streamGtfsTable(
        destination,
        routesTable,
        (row) => {
          if (routeIds.length < 10 && row.route_id) routeIds.push(row.route_id);
          if (shortNames.length < 10 && row.route_short_name) shortNames.push(row.route_short_name);
        },
        { columns: ["route_id", "route_short_name"] },
      );
      report.routeKeys = { sampleRouteIds: routeIds, sampleShortNames: shortNames };
      console.log(
        `  routes.txt: ids [${routeIds.join(", ")}] short names [${shortNames.join(", ")}]`,
      );
    }

    // trips.txt: which trips belong to a service running in the horizon.
    const horizon = new Set([...activeToday, ...activeTomorrow]);
    const tripsOnHorizon = new Set<string>();
    const trips = entry(directory.entries, "trips.txt");
    if (trips) {
      const result = await streamGtfsTable(
        destination,
        trips,
        (row) => {
          if (horizon.has(row.service_id ?? "")) tripsOnHorizon.add(row.trip_id ?? "");
        },
        { columns: ["trip_id", "service_id"] },
      );
      counts["trips.txt"] = result.rows;
    }
    report.tripsOnHorizon = tripsOnHorizon.size;

    // stop_times.txt: the whole cost of the pipeline, measured rather than guessed at.
    const stopTimes = entry(directory.entries, "stop_times.txt");
    if (stopTimes) {
      const started = Date.now();
      let onHorizon = 0;
      const result = await streamGtfsTable(
        destination,
        stopTimes,
        (row) => {
          if (tripsOnHorizon.has(row.trip_id ?? "")) onHorizon += 1;
        },
        { columns: ["trip_id"] },
      );
      report.stopTimesTotal = result.rows;
      report.stopTimesOnHorizon = onHorizon;
      report.stopTimesMs = Date.now() - started;
      counts["stop_times.txt"] = result.rows;
    }

    report.counts = counts;
    report.peakRssMib = Math.round(process.memoryUsage().rss / 1024 / 1024);

    console.log(`  rows: ${JSON.stringify(counts)}`);
    console.log(
      `  services active today ${activeToday.size}, tomorrow ${activeTomorrow.size}; trips on that horizon ${tripsOnHorizon.size}`,
    );
    console.log(
      `  stop_times: ${report.stopTimesTotal} rows total, ${report.stopTimesOnHorizon} on the horizon, ` +
        `read in ${((report.stopTimesMs ?? 0) / 1000).toFixed(1)}s  (rss ${rss()})`,
    );
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.log(`  FAILED: ${report.error}`);
  } finally {
    if (!KEEP) await rm(destination, { force: true });
  }

  return report;
}

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("BODS GTFS timetable downloads, measured");
  console.log("=".repeat(72));
  console.log(`BODS_API_KEY present: ${BODS_KEY ? "yes" : "NO"}`);
  console.log(`Regions: ${REGIONS.join(", ")}`);
  console.log(`Node heap limit: ${process.env.NODE_OPTIONS ?? "(default)"}`);

  const regions: RegionReport[] = [];
  for (const region of REGIONS) regions.push(await measureRegion(region));

  console.log("");
  console.log("=".repeat(72));
  console.log("Summary");
  console.log("=".repeat(72));
  for (const region of regions) {
    if (region.error) {
      console.log(`${region.region.padEnd(14)} FAILED ${region.error}`);
      continue;
    }
    console.log(
      `${region.region.padEnd(14)} ${mib(region.downloadBytes ?? 0).padStart(11)} zip · ` +
        `${String(region.counts?.["stops.txt"] ?? 0).padStart(8)} stops · ` +
        `${String(region.counts?.["routes.txt"] ?? 0).padStart(6)} routes · ` +
        `${String(region.counts?.["trips.txt"] ?? 0).padStart(8)} trips · ` +
        `${String(region.stopTimesTotal ?? 0).padStart(10)} stop_times · ` +
        `${String(region.stopTimesOnHorizon ?? 0).padStart(9)} on a 2-day horizon`,
    );
  }

  if (JSON_OUT)
    writeFileSync(
      JSON_OUT,
      JSON.stringify({ measuredAt: new Date().toISOString(), regions }, null, 2),
    );

  /*
   * The agency finding, through the one channel readable from outside the runner.
   *
   * Only the agency rows, not the whole measurement: this is a diagnosis of a specific join
   * failure, and the rest of the report is already summarised into the job's step summary. A job
   * log and an uploaded artifact are both served from a host this project's container cannot
   * reach, so a measurement nobody can read is a measurement that has to be taken twice.
   */
  annotateReport("gtfs agency keys", {
    outcome: "measured",
    agency: regions.map((region) => ({ region: region.region, ...(region.agency ?? {}) })),
    routeKeys: regions.map((region) => ({ region: region.region, ...(region.routeKeys ?? {}) })),
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
