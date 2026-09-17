#!/usr/bin/env node
/**
 * What the deployed API returns, next to what the upstream returns at the same moment.
 *
 * The preview reported zero live buses. The runner-side diagnosis proved BODS was healthy at the
 * time, which leaves the deployment itself: either the request never left the Worker, or it was
 * refused there, or the body came back and we rejected it. Only a request made *through the
 * deployment* can tell those apart, so this asks the Worker and the upstream the same question
 * about the same viewport within a second of each other, and prints both answers side by side.
 *
 * It also walks the passenger surfaces that depend on that data — a real stop's departure board,
 * a place search, a journey, the disruption list — because "the API answered 200" and "a
 * passenger got something useful" are different claims and only the second one matters.
 *
 * No credential and no source vehicle reference is ever printed.
 *
 *   npx tsx scripts/probe-deployment.ts --worker https://... [--json report.json]
 */

import { writeFileSync } from "node:fs";
import { normalizeSiriVm } from "@busstops/adapters";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

const WORKER = (arg("worker") ?? process.env.WORKER_URL ?? "").replace(/\/+$/, "");
const JSON_OUT = arg("json");
const BODS_KEY = process.env.BODS_API_KEY;

if (!WORKER) {
  console.error("Usage: probe-deployment.ts --worker <worker url> [--json <file>]");
  process.exit(2);
}

/** The same viewports the upstream diagnosis uses, so the two reports can be laid side by side. */
const AREAS = [
  { name: "Leeds", bbox: { west: -1.62, south: 53.75, east: -1.46, north: 53.84 } },
  { name: "Manchester", bbox: { west: -2.32, south: 53.42, east: -2.16, north: 53.52 } },
  { name: "Birmingham", bbox: { west: -1.96, south: 52.42, east: -1.8, north: 52.52 } },
  { name: "Bristol", bbox: { west: -2.66, south: 51.42, east: -2.5, north: 51.51 } },
  // York, because the journey this product is meant to plan ends at York Minster.
  { name: "York", bbox: { west: -1.12, south: 53.94, east: -1.03, north: 53.99 } },
  { name: "London (Westminster)", bbox: { west: -0.17, south: 51.48, east: -0.09, north: 51.53 } },
];

interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

const bboxParam = (b: Bbox): string =>
  [b.west, b.south, b.east, b.north].map((v) => v.toFixed(5)).join(",");

// Everything the deployment returns is untyped JSON from outside this process, so it is read
// through accessors rather than asserted into a shape it might not have.
function at(value: unknown, ...path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asCount = (value: unknown): number | null => (Array.isArray(value) ? value.length : null);
const asText = (value: unknown): string =>
  value === undefined || value === null ? "" : String(value);

interface Answer {
  status: number | null;
  ms: number;
  bytes: number;
  json: unknown;
  error?: string;
  text?: string;
}

async function ask(path: string, timeoutMs = 45_000): Promise<Answer> {
  const started = Date.now();
  try {
    const response = await fetch(`${WORKER}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let parsed: unknown = null;
    let parseable = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      parseable = false;
    }
    return {
      status: response.status,
      ms: Date.now() - started,
      bytes: text.length,
      json: parsed,
      ...(parseable ? {} : { text: text.slice(0, 300).replace(/\s+/g, " ") }),
    };
  } catch (error) {
    return {
      status: null,
      ms: Date.now() - started,
      bytes: 0,
      json: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

/** The independent request. Same box, same second, straight to the source, from this runner. */
async function askBodsDirectly(bbox: Bbox): Promise<{
  status: number | null;
  bytes: number;
  accepted: number;
  rejected: number;
  error?: string;
}> {
  if (!BODS_KEY) return { status: null, bytes: 0, accepted: 0, rejected: 0, error: "no key" };
  const url = new URL("https://data.bus-data.dft.gov.uk/api/v1/datafeed/");
  url.searchParams.set("boundingBox", bboxParam(bbox));
  url.searchParams.set("api_key", BODS_KEY);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const xml = await response.text();
    if (!response.ok) {
      return { status: response.status, bytes: xml.length, accepted: 0, rejected: 0 };
    }
    const now = new Date();
    const normalized = normalizeSiriVm(xml, {
      retrievedAt: now.toISOString(),
      vehicleSalt: "probe",
      now,
    });
    return {
      status: response.status,
      bytes: xml.length,
      accepted: normalized.observations.length,
      rejected: normalized.rejected.length,
    };
  } catch (error) {
    return {
      status: null,
      bytes: 0,
      accepted: 0,
      rejected: 0,
      error: error instanceof Error ? error.name : "error",
    };
  }
}

const report: Record<string, unknown> = { startedAt: new Date().toISOString(), worker: WORKER };
const failures: string[] = [];
const notes: string[] = [];

function head(title: string): void {
  console.log("");
  console.log("=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

async function main(): Promise<void> {
  console.log(`Deployed API: ${WORKER}`);
  console.log(`Runner BODS key present: ${BODS_KEY ? "yes" : "NO"}`);

  head("Live vehicles: the deployment and the upstream, asked at the same moment");

  const areaReports: unknown[] = [];
  let areasWithBusesOutsideLondon = 0;
  /*
   * Every non-London area's stops, not just the busiest one's. A departure board sweep confined to
   * one city cannot tell "the timetable covers England" from "the timetable covers Leeds", which
   * is precisely the question the GTFS rebuild exists to answer.
   */
  const stopsByArea: Array<{ name: string; stops: unknown[] }> = [];

  for (const area of AREAS) {
    const param = bboxParam(area.bbox);
    // Deliberately concurrent: the two answers then describe the same second.
    const [map, diagnostics, direct] = await Promise.all([
      ask(`/v1/map?bbox=${encodeURIComponent(param)}&zoom=15`),
      ask(`/v1/diagnostics/live?bbox=${encodeURIComponent(param)}`),
      askBodsDirectly(area.bbox),
    ]);

    const vehicles = asCount(at(map.json, "data", "vehicles"));
    const stops = asArray(at(map.json, "data", "stops"));
    const degradation = asText(at(map.json, "meta", "degradation"));
    const diag = asArray(at(diagnostics.json, "data", "diagnostics"));

    console.log("");
    console.log(`--- ${area.name}  [${param}]`);
    console.log(
      `  upstream, direct from this runner : HTTP ${direct.status ?? direct.error} · ${direct.bytes} bytes · ${direct.accepted} accepted · ${direct.rejected} rejected`,
    );
    console.log(
      `  GET /v1/map                       : HTTP ${map.status ?? map.error} · ${map.ms}ms · ${vehicles} vehicles · ${stops.length} stops · degradation=${degradation}`,
    );
    const mapError = at(map.json, "error");
    if (mapError !== undefined) console.log(`      error: ${JSON.stringify(mapError)}`);
    if (map.text) console.log(`      body: ${map.text}`);
    console.log(
      `  GET /v1/diagnostics/live          : HTTP ${diagnostics.status ?? diagnostics.error} · ${diagnostics.ms}ms`,
    );
    if (diagnostics.text) console.log(`      body: ${diagnostics.text}`);
    for (const entry of diag) {
      console.log(
        `      ${asText(at(entry, "source"))}: ${asText(at(entry, "outcome"))}` +
          ` · raw ${asText(at(entry, "rawRecords"))} · accepted ${asText(at(entry, "accepted"))}` +
          (at(entry, "error") === undefined ? "" : ` · error ${asText(at(entry, "error"))}`) +
          ` · ages ${asText(at(entry, "newestRecordAgeSeconds"))}..${asText(at(entry, "oldestRecordAgeSeconds"))}s`,
      );
      const rejectedBy = at(entry, "rejectedBy");
      if (rejectedBy !== null && typeof rejectedBy === "object") {
        for (const [reason, count] of Object.entries(rejectedBy)) {
          console.log(`        rejected ${asText(count)} × ${reason}`);
        }
      }
    }

    const isLondon = area.name.startsWith("London");
    if (!isLondon) stopsByArea.push({ name: area.name, stops });
    if (!isLondon && (vehicles ?? 0) > 0) areasWithBusesOutsideLondon += 1;

    areaReports.push({
      area: area.name,
      bbox: param,
      upstreamDirect: direct,
      map: { status: map.status, ms: map.ms, vehicles, stops: stops.length, degradation },
      diagnostics: diag,
    });
  }
  report.areas = areaReports;

  const nonLondonAreas = AREAS.filter((area) => !area.name.startsWith("London")).length;
  if (areasWithBusesOutsideLondon < 2) {
    failures.push(
      `Live vehicles: ${areasWithBusesOutsideLondon} of ${nonLondonAreas} non-London areas returned a bus through the deployment (at least 2 are required).`,
    );
  }

  head("Real departure boards");

  /*
   * Several stops in every city, not six stops in one.
   *
   * A single board proves nothing either way: an empty one may be a stop with no service at this
   * hour, and a working one may be the only stop in the country whose operator happened to be
   * inside the old timetable cap. Sweeping each city separately is what distinguishes a national
   * timetable from a regional one — which is the whole point of the GTFS rebuild.
   *
   * Two different failures are separated here, because they have different causes and different
   * fixes. A stop with **no routes at all** means the published timetable knows nothing about it:
   * that is a coverage failure and it is a failure at any hour of the day or night. A stop with
   * routes but **no departures right now** is what a quiet early morning genuinely looks like, so
   * it is reported as a note rather than counted as a broken product.
   */
  const boardsByArea: unknown[] = [];
  const citiesWithNoTimetable: string[] = [];
  const citiesQuiet: string[] = [];

  for (const area of stopsByArea) {
    const candidates = area.stops.slice(0, 4);
    console.log("");
    console.log(`--- ${area.name}`);

    if (candidates.length === 0) {
      console.log("  no stops in this viewport at all");
      citiesWithNoTimetable.push(`${area.name} (no stops published)`);
      boardsByArea.push({ area: area.name, boards: [], stops: 0 });
      continue;
    }

    const boards: unknown[] = [];
    let withRows = 0;
    let withRoutes = 0;

    for (const candidate of candidates) {
      const atcoCode = asText(at(candidate, "atcoCode"));
      if (!atcoCode) continue;
      const answer = await ask(`/v1/stops/${encodeURIComponent(atcoCode)}`);
      const departures = asArray(at(answer.json, "data", "departures"));
      const routes = asArray(at(answer.json, "data", "routes"));
      const statuses = [...new Set(departures.map((d) => asText(at(d, "status"))))];
      const weather = at(answer.json, "data", "weather");
      const notices = asArray(at(answer.json, "data", "disruptions"));
      if (departures.length > 0) withRows += 1;
      if (routes.length > 0) withRoutes += 1;

      console.log(
        `  ${atcoCode.padEnd(14)} ${asText(at(candidate, "name")).slice(0, 24).padEnd(24)}` +
          ` HTTP ${answer.status} · ${String(departures.length).padStart(2)} departures` +
          ` · ${String(routes.length).padStart(2)} routes` +
          ` · ${notices.length} notices` +
          ` · weather ${weather === null || weather === undefined ? "none" : "yes"}` +
          ` · ${asText(at(answer.json, "meta", "degradation"))}`,
      );
      if (answer.json !== null && at(answer.json, "error") !== undefined) {
        console.log(`                 error: ${JSON.stringify(at(answer.json, "error"))}`);
      }
      for (const departure of departures.slice(0, 3)) {
        console.log(
          `                 ${asText(at(departure, "routePublicName")).padEnd(6)}` +
            ` ${asText(at(departure, "destination")).slice(0, 24).padEnd(24)}` +
            ` ${asText(at(departure, "status"))}` +
            ` ${asText(at(departure, "expectedDepartureTime") ?? at(departure, "scheduledDepartureTime"))}`,
        );
      }

      boards.push({
        atcoCode,
        name: asText(at(candidate, "name")),
        status: answer.status,
        departures: departures.length,
        routes: routes.length,
        hasWeather: weather !== null && weather !== undefined,
        notices: notices.length,
        statuses,
        meta: at(answer.json, "meta"),
      });
    }

    boardsByArea.push({ area: area.name, boards, stops: candidates.length });
    if (withRoutes === 0) citiesWithNoTimetable.push(area.name);
    else if (withRows === 0) citiesQuiet.push(area.name);
  }

  report.departureBoards = boardsByArea;

  if (citiesWithNoTimetable.length > 0) {
    failures.push(
      `Departures: the published timetable knows no route at any sampled stop in ${citiesWithNoTimetable.join(", ")}.`,
    );
  }
  if (citiesQuiet.length > 0) {
    notes.push(
      `Departures: ${citiesQuiet.join(", ")} had routes but no departure due at the moment of the probe — plausible off-peak, worth re-checking in service hours.`,
    );
  }

  head("Search, journey, disruptions, health");

  const search = await ask(`/v1/search?q=${encodeURIComponent("York Minster")}`);
  const results = asArray(at(search.json, "data", "results"));
  const kinds = [...new Set(results.map((r) => asText(at(r, "kind"))))];
  console.log(
    `GET /v1/search?q=York Minster : HTTP ${search.status} · ${results.length} results · kinds ${JSON.stringify(kinds)}`,
  );
  for (const result of results.slice(0, 5)) {
    console.log(`  ${asText(at(result, "kind"))}  ${asText(at(result, "name"))}`);
  }
  report.search = { status: search.status, count: results.length, kinds };
  if (results.length === 0) failures.push(`Search: "York Minster" returned nothing.`);
  if (!kinds.includes("place")) {
    notes.push(`Search: "York Minster" returned no result of kind "place".`);
  }

  // Leeds city centre to Leeds Bradford Airport: two points a passenger would actually pick.
  const journey = await ask(
    `/v1/journeys?fromLat=53.79648&fromLon=-1.54785&toLat=53.86590&toLon=-1.66030`,
  );
  const options = asArray(
    at(journey.json, "data", "options") ?? at(journey.json, "data", "journeys"),
  );
  console.log(
    `GET /v1/journeys Leeds → LBA    : HTTP ${journey.status} · ${options.length} options` +
      (at(journey.json, "error") === undefined
        ? ""
        : ` · ${JSON.stringify(at(journey.json, "error"))}`),
  );
  report.journey = { status: journey.status, options: options.length };
  if (options.length === 0)
    failures.push("Journey: Leeds → Leeds Bradford Airport gave 0 options.");

  const disruptions = await ask(`/v1/disruptions`);
  const disruptionData = at(disruptions.json, "data");
  const official = at(disruptionData, "official");
  console.log(
    `GET /v1/disruptions             : HTTP ${disruptions.status}` +
      ` · keys ${JSON.stringify(Object.keys((disruptionData as object | undefined) ?? {}))}` +
      ` · official ${official === undefined ? "absent" : asCount(official)}`,
  );
  report.disruptions = { status: disruptions.status, data: disruptionData };
  if (official === undefined) notes.push("Disruptions: the response carries no official notices.");

  const health = await ask(`/v1/sources/health`);
  console.log(`GET /v1/sources/health          : HTTP ${health.status}`);
  console.log(`  ${JSON.stringify(at(health.json, "data") ?? health.text ?? null)}`);
  report.health = at(health.json, "data");

  head("Verdict");
  for (const note of notes) console.log(`NOTE  ${note}`);
  for (const failure of failures) console.log(`FAIL  ${failure}`);
  if (failures.length === 0) console.log("PASS  Every passenger check above returned real data.");

  report.failures = failures;
  report.notes = notes;
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));

  // Reporting, not gating: this exists to show what the deployment does, and a red exit here
  // would stop the run before the evidence is uploaded. The workflow reads the verdict.
  console.log("");
  console.log(`PROBE_FAILURES=${failures.length}`);
}

/* Wrapped, not top level: tsx resolves this file as CommonJS, where top-level await is a
 * transform error rather than a runtime one — a script that never ran once reported success. */
main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
