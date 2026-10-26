#!/usr/bin/env node
/**
 * Does BODS honour the bounding box this Worker sends it, and how much XML comes back?
 *
 * This is the measured blocker. `scripts/measure-serving-cpu.ts` timed a passenger request's
 * stages against the live artifact and the live feed, and 956 of 996 milliseconds — ninety-six
 * per cent — went on normalising SIRI-VM. Everything else put together was forty: the whole map
 * projection read is under five, and parsing every trip row in an eight-megabyte corridor is
 * twenty-nine. Cloudflare allows ten milliseconds of CPU per request on the free plan, so the
 * live feed is the only stage whose order of magnitude matters.
 *
 * And the feed it timed was **19,272,814 characters for one Manchester viewport**, carrying 7,008
 * observations. A city-sized box cannot contain seven thousand buses, so either BODS is ignoring
 * the box or the box is being sent in an order it does not read.
 *
 * `bodsDatafeedUrl` sends `west,south,east,north`. Which order BODS actually wants is not
 * something to assert from memory or from another service's convention — bounding-box ordering is
 * inconsistent across APIs and the only reliable answer is the one the service gives. So every
 * plausible order is tried, plus no box at all as the national baseline, and each answer is
 * measured: bytes, vehicles, and — the signal that settles it — the latitude and longitude range
 * of the positions that came back. A box that was honoured returns positions inside it.
 *
 * It fetches four feeds and writes nothing.
 *
 *   npx tsx scripts/measure-bods-bbox.ts [--json bods-bbox.json]
 */

import { writeFileSync } from "node:fs";
import { annotateReport } from "@busstops/pipeline-core";

const JSON_OUT = (() => {
  const index = process.argv.indexOf("--json");
  return index === -1 ? undefined : process.argv[index + 1];
})();

const KEY = process.env.BODS_API_KEY ?? "";
const FEED = "https://data.bus-data.dft.gov.uk/api/v1/datafeed/";

/** The Manchester viewport the probe and the cold walk both use. */
const BBOX = { west: -2.32, south: 53.42, east: -2.16, north: 53.52 };

/** Every ordering worth trying, named by what it would mean to a reader of the query string. */
const ORDERS: Array<{ name: string; value: string | null; note: string }> = [
  {
    name: "west,south,east,north",
    value: [BBOX.west, BBOX.south, BBOX.east, BBOX.north].map((v) => v.toFixed(5)).join(","),
    note: "what bodsDatafeedUrl sends today",
  },
  {
    name: "west,east,south,north",
    value: [BBOX.west, BBOX.east, BBOX.south, BBOX.north].map((v) => v.toFixed(5)).join(","),
    note: "minLongitude,maxLongitude,minLatitude,maxLatitude",
  },
  {
    name: "south,west,north,east",
    value: [BBOX.south, BBOX.west, BBOX.north, BBOX.east].map((v) => v.toFixed(5)).join(","),
    note: "minLatitude,minLongitude,maxLatitude,maxLongitude",
  },
  { name: "(no boundingBox)", value: null, note: "the national baseline" },
];

/** Every `<Longitude>`/`<Latitude>` pair in the body, as a range. Cheap and conclusive. */
function positionRange(xml: string): {
  vehicles: number;
  lat: [number, number] | null;
  lon: [number, number] | null;
  inside: number;
} {
  const vehicles = (xml.match(/<VehicleActivity>/g) ?? []).length;
  const lats: number[] = [];
  const lons: number[] = [];
  for (const match of xml.matchAll(/<Latitude>([-0-9.]+)<\/Latitude>/g)) {
    const value = Number.parseFloat(match[1]!);
    if (Number.isFinite(value)) lats.push(value);
  }
  for (const match of xml.matchAll(/<Longitude>([-0-9.]+)<\/Longitude>/g)) {
    const value = Number.parseFloat(match[1]!);
    if (Number.isFinite(value)) lons.push(value);
  }
  let inside = 0;
  for (let i = 0; i < Math.min(lats.length, lons.length); i += 1) {
    const lat = lats[i]!;
    const lon = lons[i]!;
    if (lat >= BBOX.south && lat <= BBOX.north && lon >= BBOX.west && lon <= BBOX.east) {
      inside += 1;
    }
  }
  return {
    vehicles,
    lat: lats.length === 0 ? null : [Math.min(...lats), Math.max(...lats)],
    lon: lons.length === 0 ? null : [Math.min(...lons), Math.max(...lons)],
    inside,
  };
}

async function main(): Promise<number> {
  if (!KEY) {
    annotateReport("bods bounding box", {
      outcome: "not_configured",
      reason: "no BODS_API_KEY in the environment",
    });
    return 2;
  }

  const attempts: Array<Record<string, unknown>> = [];
  for (const order of ORDERS) {
    const url = new URL(FEED);
    if (order.value !== null) url.searchParams.set("boundingBox", order.value);
    url.searchParams.set("api_key", KEY);

    const began = Date.now();
    try {
      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(60_000) });
      const xml = await response.text();
      const range = positionRange(xml);
      attempts.push({
        order: order.name,
        note: order.note,
        status: response.status,
        ms: Date.now() - began,
        chars: xml.length,
        vehicles: range.vehicles,
        /* The number that settles it: positions actually inside the viewport asked for. */
        insideViewport: range.inside,
        latRange: range.lat,
        lonRange: range.lon,
      });
      console.log(
        `${order.name.padEnd(24)} HTTP ${String(response.status)} ` +
          `${String(xml.length).padStart(10)} chars  ${String(range.vehicles).padStart(6)} ` +
          `vehicles  ${String(range.inside).padStart(6)} inside  ` +
          `lat ${JSON.stringify(range.lat)} lon ${JSON.stringify(range.lon)}`,
      );
    } catch (error) {
      attempts.push({ order: order.name, note: order.note, error: String(error).slice(0, 200) });
      console.log(`${order.name.padEnd(24)} failed: ${String(error).slice(0, 120)}`);
    }
    /* Spaced out: this is somebody else's free API and four requests is enough to answer. */
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  const national = attempts.find((a) => a.order === "(no boundingBox)");
  const sized = attempts
    .filter((a) => typeof a.chars === "number" && a.order !== "(no boundingBox)")
    .sort((a, b) => (a.chars as number) - (b.chars as number));
  const smallest = sized[0];

  const report = {
    outcome: "measured",
    viewport: BBOX,
    sentToday: "west,south,east,north",
    /* Honoured when a box returns materially less than no box at all. */
    honoured:
      smallest !== undefined &&
      typeof national?.chars === "number" &&
      (smallest.chars as number) < (national.chars as number) * 0.5,
    smallestOrder: smallest?.order ?? null,
    smallestChars: smallest?.chars ?? null,
    nationalChars: national?.chars ?? null,
    /* 52 ms per mebibyte of SIRI-VM, measured by scripts/measure-serving-cpu.ts. */
    msPerMiB: 52,
    freeCpuBudgetMs: 10,
    attempts,
  };

  console.log("");
  console.log(JSON.stringify(report, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("bods bounding box", report);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Measuring the BODS bounding box failed:", error);
    annotateReport("bods bounding box", { outcome: "threw", error: String(error) });
    process.exitCode = 1;
  });
