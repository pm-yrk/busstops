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
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
