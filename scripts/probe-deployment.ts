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
import { annotate } from "./annotate.mjs";
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
  /*
   * What the isolate was holding, carried out of here.
   *
   * `/v1/map` reports its own residency in `meta.diagnostics` — how much shard text the isolate
   * held when the request began, and whether the national service and place tables had been
   * parsed into it. That is the single most useful number for the 1102s, and the only check that
   * printed it is one of the ones that keeps dying, so it was unreadable exactly when it mattered.
   * Collected from every viewport that answers, so one surviving request is enough.
   */
  const mapDiagnostics: unknown[] = [];

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

    const mapDiag = at(map.json, "meta", "diagnostics");
    if (mapDiag !== undefined && mapDiag !== null) {
      mapDiagnostics.push({
        area: area.name,
        status: map.status,
        ms: map.ms,
        diagnostics: mapDiag,
      });
    } else {
      mapDiagnostics.push({ area: area.name, status: map.status, ms: map.ms, diagnostics: null });
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

  /*
   * The route page, from the board that named it, in the job that survives.
   *
   * The deployed verification already asks this and it keeps answering Cloudflare's error page —
   * but it asks after ninety other requests against one isolate, and this job asks a passenger's
   * handful. Whether a route page works for a person clicking one link, and whether it works on
   * the hundredth rapid request, are two different questions and only the first one is the
   * product. So the question is asked here too, serially, and the answer written in the form a
   * reader can check: the route, its operator, the direction, the ordered stops, and the stop
   * from the middle of that list opened on its own board.
   */
  head("Route pages: the ordered stops a passenger follows");

  const routePages: unknown[] = [];
  for (const area of stopsByArea.slice(0, 5)) {
    const withRoutes = area.stops
      .slice(0, 6)
      .find((candidate) => asArray(at(candidate, "routePublicNames")).length > 0);
    const atcoCode = withRoutes ? asText(at(withRoutes, "atcoCode")) : "";
    if (!atcoCode) {
      console.log(`  ${area.name.padEnd(20)} no stop in this viewport names a route`);
      continue;
    }

    const board = await ask(`/v1/stops/${encodeURIComponent(atcoCode)}`);
    const routeId = asText(at(board.json, "data", "routes", 0, "id"));
    if (!routeId) {
      console.log(
        `  ${area.name.padEnd(20)} HTTP ${board.status}, ${asArray(at(board.json, "data", "routes")).length} route(s), none with an id`,
      );
      routePages.push({ area: area.name, atcoCode, boardStatus: board.status, routeId: null });
      continue;
    }

    const page = await ask(`/v1/routes/${encodeURIComponent(routeId)}`);
    const variants = asArray(at(page.json, "data", "variants"));
    if (page.status !== 200 || variants.length === 0) {
      console.log(
        `  ${area.name.padEnd(20)} HTTP ${page.status}, ${variants.length} variant(s)` +
          (page.text ? ` — ${page.text.slice(0, 80)}` : ""),
      );
      routePages.push({
        area: area.name,
        routeId,
        status: page.status,
        variants: variants.length,
      });
      continue;
    }

    // The dominant pattern: the one a reader means by "the route", and the one the page opens on.
    const variant = variants.reduce((best, candidate) =>
      asArray(at(candidate, "stops")).length > asArray(at(best, "stops")).length ? candidate : best,
    );
    const stops = asArray(at(variant, "stops"));
    const names = stops.map((stop) => asText(at(stop, "name")));
    const sequences = stops.map((stop) => Number(at(stop, "sequence")));
    const ordered = sequences.every((value, i) =>
      i === 0 ? value === 0 : value > sequences[i - 1]!,
    );
    /*
     * Whether the order could have come from the names rather than the timetable. A sequence that
     * happens to be alphabetical is not proof of a bug, but it is the one coincidence that would
     * make a geographic or alphabetical sort look like a travel order, so it is always printed.
     */
    const alphabetical = names.every(
      (name, i) => i === 0 || names[i - 1]!.localeCompare(name) <= 0,
    );

    const middle = stops[Math.floor(stops.length / 2)];
    const middleAtco = asText(at(middle, "atcoCode"));
    const middleBoard = middleAtco
      ? await ask(`/v1/stops/${encodeURIComponent(middleAtco)}`)
      : null;
    const middleDue = asArray(at(middleBoard?.json, "data", "departures")).length;

    console.log("");
    console.log(`  ${asText(at(page.json, "data", "route", "publicName"))} — ${area.name}`);
    console.log(`  ${names[0]} → ${names[names.length - 1]}`);
    console.log(
      `  ${stops.length} stops, ${variants.length} variant(s) [${[...new Set(variants.map((v) => asText(at(v, "direction")))).values()].join("/")}]` +
        (asText(at(page.json, "data", "operator", "name"))
          ? `, ${asText(at(page.json, "data", "operator", "name"))}`
          : ""),
    );
    console.log(
      `  Stop sequence ${ordered ? "verified from timetable pattern" : "IS NOT IN TRAVEL ORDER"}` +
        (alphabetical ? " [WARNING: the names are also in alphabetical order]" : "") +
        (at(page.json, "data", "complete") === false ? " [the read was truncated]" : ""),
    );
    console.log(
      `  Stop #${Math.floor(stops.length / 2) + 1} (${asText(at(middle, "name"))}) ` +
        `opens its live board ${middleBoard?.status === 200 ? "successfully" : `with HTTP ${middleBoard?.status}`}` +
        `, ${middleDue} due`,
    );

    if (!ordered) {
      failures.push(
        `Route ${asText(at(page.json, "data", "route", "publicName"))} in ${area.name}: the stop sequence is not in travel order.`,
      );
    }

    /*
     * Whether the page can say anything about the route beyond its code.
     *
     * Some feeds publish a `route_short_name` that is an internal designation — `UK002` — with no
     * `route_long_name` beside it, and a heading of "Route UK002" tells a passenger nothing. The
     * answer is not to invent a name: it is to use what the timetable already knows, which is
     * where the service starts and ends. So the check is that at least one of the two exists, a
     * published description or an origin and destination from the pattern itself. Both missing is
     * a page that can only repeat the code back.
     */
    const described = asText(at(page.json, "data", "route", "description"));
    const firstStop = names[0] ?? "";
    const lastStop = names[names.length - 1] ?? "";
    const canSayWhereItGoes = firstStop.length > 0 && lastStop.length > 0 && firstStop !== lastStop;
    if (described.length === 0 && !canSayWhereItGoes) {
      notes.push(
        `Route ${asText(at(page.json, "data", "route", "publicName"))} in ${area.name} has no ` +
          `description and no distinct origin and destination, so its page can only say ` +
          `"Route ${asText(at(page.json, "data", "route", "publicName"))}".`,
      );
    }
    routePages.push({
      area: area.name,
      route: asText(at(page.json, "data", "route", "publicName")),
      operator: asText(at(page.json, "data", "operator", "name")),
      variants: variants.length,
      stops: stops.length,
      origin: names[0],
      destination: names[names.length - 1],
      ordered,
      alphabetical,
      complete: at(page.json, "data", "complete"),
      middleStop: asText(at(middle, "name")),
      middleStopNumber: Math.floor(stops.length / 2) + 1,
      middleBoardStatus: middleBoard?.status ?? null,
      middleDue,
    });
  }
  report.routePages = routePages;

  const workingRoutePages = routePages.filter(
    (entry) => (entry as { ordered?: boolean }).ordered === true,
  );
  if (workingRoutePages.length === 0) {
    failures.push("Route pages: not one city produced an ordered stop sequence.");
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

  /*
   * A town name on its own — the first thing a visitor types, and the check this gate did not have.
   *
   * Both searches above ask something the index is known to hold: a curated landmark, and a word
   * lifted from a stop the API had just returned. Neither asks the obvious question, and the cost
   * of that gap was the largest user-facing fault of the week going unseen: "Leeds" returned
   * twenty results and every one was a place, so the first step of the core flow — search, then
   * open a stop, then read its board — had nowhere to go, while the probe reported no failures.
   *
   * What is asserted is a stop, not a result count. Places and areas are legitimate answers to a
   * town name; a board is the one a passenger standing in Leeds needs.
   */
  const townSearches: Array<{ town: string; results: number; stops: number; first: string }> = [];
  for (const town of ["Leeds", "Manchester", "Birmingham"]) {
    const townSearch = await ask(`/v1/search?q=${encodeURIComponent(town)}`);
    const townResults = asArray(at(townSearch.json, "data", "results"));
    const stops = townResults.filter((result) => at(result, "kind") === "stop");
    console.log(
      `GET /v1/search?q=${town.padEnd(12)}: HTTP ${townSearch.status} · ${townResults.length} results · ` +
        `${stops.length} stop(s)` +
        (townResults[0] ? ` · first "${asText(at(townResults[0], "title"))}"` : ""),
    );
    townSearches.push({
      town,
      results: townResults.length,
      stops: stops.length,
      first: townResults[0] ? asText(at(townResults[0], "title")) : "",
    });
  }
  report.townSearches = townSearches;

  const townsWithNoStop = townSearches.filter((entry) => entry.stops === 0);
  if (townsWithNoStop.length === townSearches.length) {
    failures.push(
      `Search: not one of ${townSearches.length} town name(s) returned a single bus stop ` +
        `(${townSearches.map((entry) => `${entry.town}: ${entry.results} result(s), 0 stops`).join("; ")}). ` +
        `A visitor typing a town name has nowhere to go, which breaks the first step of the core flow.`,
    );
  } else if (townsWithNoStop.length > 0) {
    notes.push(
      `Search: ${townsWithNoStop.map((entry) => entry.town).join(", ")} returned no stop, though ` +
        `other towns did.`,
    );
  }

  /*
   * A postcode, which is how a great many people would start, walked the whole way.
   *
   * It matched nothing at all before the index existed: stops, routes, operators and landmarks are
   * what search held, and a postcode is none of them. The first deployed attempt then matched
   * nothing for a different reason — the reader composed its keys from the network index's
   * version rather than the postcode family's own — which is why this does not stop at "a result
   * came back".
   *
   * Four real postcodes from four regions; the ways people actually type them (lower case, and
   * without the space); one that cannot exist, which must come back empty rather than wrong; and
   * then the rest of the journey from the first one that resolved — its coordinate into `/v1/nearby`,
   * the nearest stop opened, and that stop's board read. A postcode that resolves to a position
   * nobody can catch a bus from is not a feature.
   */
  const postcodeSearches: Array<Record<string, unknown>> = [];
  const postcodeQueries = [
    { q: "LS1 4DY", expect: "LS1 4DY" },
    { q: "M1 1AE", expect: "M1 1AE" },
    { q: "BS1 4DJ", expect: "BS1 4DJ" },
    { q: "NR1 3DY", expect: "NR1 3DY" },
    // The same postcode in the two other forms people type it in.
    { q: "ls1 4dy", expect: "LS1 4DY" },
    { q: "M11AE", expect: "M1 1AE" },
    // Not a postcode that exists. An empty answer is correct; a confident wrong one is not.
    { q: "ZZ99 9ZZ", expect: null },
  ];

  let firstResolved: { postcode: string; lat: number; lon: number } | null = null;

  for (const { q, expect } of postcodeQueries) {
    const search = await ask(`/v1/search?q=${encodeURIComponent(q)}`);
    const results = asArray(at(search.json, "data", "results"));
    const hits = results.filter((result) => at(result, "kind") === "postcode");
    const first = hits[0];
    const coordinate = first === undefined ? undefined : at(first, "coordinate");
    const lat = coordinate === undefined ? undefined : Number(at(coordinate, "lat"));
    const lon = coordinate === undefined ? undefined : Number(at(coordinate, "lon"));
    const title = first ? asText(at(first, "title")) : "";

    console.log(
      `GET /v1/search?q=${q.padEnd(9)}: HTTP ${search.status} · ${results.length} result(s) · ` +
        `${hits.length} postcode(s)` +
        (title ? ` · "${title}"` : "") +
        (lat === undefined ? "" : ` at ${lat.toFixed(5)}, ${lon!.toFixed(5)}`),
    );

    postcodeSearches.push({
      asked: q,
      expected: expect,
      status: search.status,
      results: results.length,
      postcodes: hits.length,
      led: title,
      ...(lat === undefined ? {} : { lat, lon }),
    });

    if (expect === null) {
      if (hits.length > 0) {
        failures.push(
          `Search: "${q}" is not a real postcode and the index answered with "${title}". An ` +
            `invented match is worse than no match.`,
        );
      }
      continue;
    }

    if (hits.length === 0) {
      /*
       * A note rather than a failure: the index is published separately from the Worker, so "the
       * reader is deployed and the artifact is not" is a real and recoverable sequencing state and
       * must not turn the gate red for every other check that passed.
       */
      notes.push(`Search: "${q}" matched no postcode, so the index may not be published here.`);
      continue;
    }
    if (lat === undefined || !Number.isFinite(lat)) {
      failures.push(
        `Search: "${q}" returned a postcode with no coordinate. A postcode row with no position ` +
          `cannot open anything.`,
      );
      continue;
    }
    if (title !== expect) {
      failures.push(`Search: asked for "${q}", led with "${title}" rather than "${expect}".`);
      continue;
    }
    if (firstResolved === null) firstResolved = { postcode: title, lat, lon: lon! };
  }

  /*
   * And the rest of the walk. A position is only useful if something can be caught from it, so
   * this follows the first resolved postcode out to its stops and reads one of their boards.
   */
  if (firstResolved !== null) {
    const near = await ask(
      `/v1/nearby?lat=${firstResolved.lat.toFixed(5)}&lon=${firstResolved.lon.toFixed(5)}&radius=600`,
    );
    const nearbyStops = asArray(at(near.json, "data", "results")).filter(
      (result) => at(result, "kind") === "stop",
    );

    /*
     * The first three, not the first.
     *
     * Taking `results[0]` found "Station A" near LS1 4DY: a real stop whose board opens and which
     * no service in our data calls at — 0 departures, 0 routes. That is a weaker test than the
     * product, because a postcode result opens the *map* around the position and a passenger sees
     * all twenty-five stops, not just the nearest. So this asks a few of them, reports each, and
     * judges on whether any of them is somewhere a bus actually goes.
     */
    const tried: Array<{ stop: string; status: number; departures: number; routes: number }> = [];
    for (const candidate of nearbyStops.slice(0, 3)) {
      const stopId = asText(at(candidate, "id"));
      if (!stopId) continue;
      const attempt = await ask(`/v1/stops/${encodeURIComponent(stopId)}`);
      tried.push({
        stop: asText(at(candidate, "title")),
        status: attempt.status,
        departures: asArray(at(attempt.json, "data", "departures")).length,
        routes: asArray(at(attempt.json, "data", "routes")).length,
      });
    }

    const opened = tried.filter((entry) => entry.status === 200);
    const useful = opened.find((entry) => entry.departures > 0 || entry.routes > 0);
    const walk = {
      from: firstResolved.postcode,
      nearbyStatus: near.status,
      stopsNearby: nearbyStops.length,
      tried,
      openedStop: useful?.stop ?? opened[0]?.stop ?? "",
      boardStatus: opened[0]?.status ?? 0,
      departures: useful?.departures ?? 0,
      routes: useful?.routes ?? 0,
    };
    report.postcodeWalk = walk;
    console.log(
      `  ${walk.from} → ${walk.stopsNearby} stop(s) nearby → "${walk.openedStop}" ` +
        `board HTTP ${walk.boardStatus}, ${walk.departures} due, ${walk.routes} route(s)`,
    );

    if (nearbyStops.length === 0) {
      failures.push(
        `Search: ${firstResolved.postcode} resolved but no stop is within 600 m of it, so the ` +
          `result leads nowhere a passenger can catch a bus.`,
      );
    } else if (opened.length === 0) {
      failures.push(
        `Search: none of the ${tried.length} stop(s) tried near ${firstResolved.postcode} opened ` +
          `(${tried.map((entry) => `${entry.stop} HTTP ${entry.status}`).join("; ")}). The stops a ` +
          `postcode leads to must open.`,
      );
    } else if (useful === undefined) {
      /*
       * Not a failure. A stop can legitimately have nothing due, and the coverage cap means some
       * real stops have no service in our data at all — which the stop page now says outright
       * rather than claiming nothing is due in the next hour.
       */
      notes.push(
        `Search: the ${opened.length} stop(s) tried near ${firstResolved.postcode} all opened with ` +
          `nothing due and no routes (${opened.map((entry) => entry.stop).join("; ")}).`,
      );
    }
  }

  report.postcodeSearches = postcodeSearches;
  /*
   * Its own annotation, because GitHub keeps ten per level per step and the probe's full payload
   * runs to hundreds of parts — the postcode rows fell outside the ten that were kept, so the
   * evidence existed and could not be read. A short second annotation is the whole fix.
   */
  annotate(
    "notice",
    "postcode search",
    JSON.stringify({ searches: postcodeSearches, walk: report.postcodeWalk ?? null }, null, 1),
  );

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

  /*
   * A plan a passenger cannot act on is half a feature, so the probe follows it.
   *
   * The journey strip turns a bus leg's route number into a link to the route and its named stops
   * into links to their boards, and it does that from the ids the planner returns — never from the
   * names, because several operators run a "36" and the ends of a journey are a dropped pin. Which
   * means the ids have to be there and have to resolve. A plan with 3 options and a leg carrying no
   * `routeId` renders as plain text and nothing fails, which is exactly how the stop page came to
   * have no route links at all for weeks.
   */
  const busLegs = options
    .flatMap((option) => asArray(at(option, "legs")))
    .filter((leg) => at(leg, "mode") === "bus");
  const legIds = busLegs.map((leg) => ({
    routeId: at(leg, "routeId"),
    fromStopId: at(leg, "fromStopId"),
    toStopId: at(leg, "toStopId"),
    routeName: asText(at(leg, "routeName")),
  }));
  const navigable = legIds.filter(
    (leg) => typeof leg.routeId === "string" && typeof leg.fromStopId === "string",
  );
  console.log(
    `  journey legs                  : ${busLegs.length} bus leg(s), ${navigable.length} carrying ` +
      `both a routeId and a boarding stop`,
  );
  report.journeyLegs = { busLegs: busLegs.length, navigable: navigable.length, sample: legIds[0] };

  if (busLegs.length > 0 && navigable.length === 0) {
    failures.push(
      `Journey legs: ${busLegs.length} bus leg(s) and not one carries both a routeId and a ` +
        `fromStopId, so every leg renders as plain text and the plan is a dead end.`,
    );
  }

  /*
   * And the ids are followed, because an id that is present and does not resolve is worse than an
   * absent one: it renders as a link and takes the passenger to an error.
   */
  const first = navigable[0];
  if (first) {
    const legRoute = await ask(`/v1/routes/${encodeURIComponent(String(first.routeId))}`);
    const legStop = await ask(`/v1/stops/${encodeURIComponent(String(first.fromStopId))}`);
    const routeName = asText(at(legRoute.json, "data", "route", "publicName"));
    const stopName = asText(at(legStop.json, "data", "stop", "name"));
    /*
     * Stops live under each variant, not at the top of the response — which the route-page check
     * above has always read correctly and this one did not, so it reported `routeStops: null`
     * against a route that has stops. A probe that misreads a healthy response is a probe that
     * will one day be believed about an unhealthy one.
     */
    const legVariants = asArray(at(legRoute.json, "data", "variants"));
    const legStops = legVariants.reduce(
      (most, variant) => Math.max(most, asCount(at(variant, "stops")) ?? 0),
      0,
    );
    console.log(
      `  journey leg → route           : HTTP ${legRoute.status} · ${routeName || "(no name)"} · ` +
        `${legVariants.length} variant(s), ${legStops} stop(s)`,
    );
    console.log(
      `  journey leg → boarding board  : HTTP ${legStop.status} · ${stopName || "(no name)"}`,
    );
    report.journeyLegNavigation = {
      routeStatus: legRoute.status,
      routeName,
      routeVariants: legVariants.length,
      routeStops: legStops,
      stopStatus: legStop.status,
      stopName,
      legRouteName: first.routeName,
    };
    if (legRoute.status !== 200 || !routeName) {
      failures.push(
        `Journey leg navigation: the route a leg names (${first.routeName || first.routeId}) ` +
          `answered HTTP ${legRoute.status} with no route name, so the link on the plan is dead.`,
      );
    } else if (legStops === 0) {
      // A link that opens a page with nothing on it is worse than no link.
      failures.push(
        `Journey leg navigation: route ${routeName} answered 200 but carries no stop in any of ` +
          `${legVariants.length} variant(s), so the link on the plan opens an empty page.`,
      );
    }
    if (legStop.status !== 200 || !stopName) {
      failures.push(
        `Journey leg navigation: the boarding stop a leg names answered HTTP ${legStop.status} ` +
          `with no stop name, so the link on the plan is dead.`,
      );
    }
  }

  /*
   * Nearby, which the probe has never asked for and which the stop page's practical help depends
   * on entirely: "other stops near here" is the one suggestion in "Bus not come?" that cannot be
   * answered from the stop's own response.
   */
  const nearby = await ask(`/v1/nearby?lat=53.79648&lon=-1.54785&radius=500`);
  const nearbyResults = asArray(at(nearby.json, "data", "results"));
  const nearbyStops = nearbyResults.filter((result) => at(result, "kind") === "stop");
  console.log(
    `GET /v1/nearby Leeds centre     : HTTP ${nearby.status} · ${nearbyResults.length} result(s), ` +
      `${nearbyStops.length} stop(s)` +
      (nearbyStops[0] ? ` · nearest ${asText(at(nearbyStops[0], "title"))}` : ""),
  );
  report.nearby = {
    status: nearby.status,
    results: nearbyResults.length,
    stops: nearbyStops.length,
    nearest: nearbyStops[0] ? asText(at(nearbyStops[0], "title")) : null,
  };
  if (nearby.status !== 200) {
    failures.push(`Nearby: /v1/nearby answered HTTP ${nearby.status} in Leeds city centre.`);
  } else if (nearbyStops.length === 0) {
    failures.push(
      "Nearby: no stop within 500 m of Leeds city centre, which is not a property of Leeds.",
    );
  }

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
  /*
   * The whole report as an annotation. This job's log and its uploaded JSON are both served from a
   * host this project's container cannot reach, so the one job that has passed on every run was
   * also the one whose findings nobody working on it could read. See scripts/annotate.mjs.
   */
  /*
   * Named explicitly, and kept in step with what the probe measures.
   *
   * This used to carry `{failures, notes, routePages, mapDiagnostics}` and nothing else, so two
   * checks added to the probe — journey-leg navigation and nearby — would have reported into a
   * payload that never included them: the whole run would have said "no failures" and shown no
   * sign the questions had been asked. The map diagnostics are by far the largest field here, so
   * they go last, where the annotation splitter puts them in a part of their own.
   */
  annotate(
    failures.length === 0 ? "notice" : "error",
    `passenger probe (${failures.length} failure(s), ${notes.length} note(s))`,
    JSON.stringify(
      {
        failures,
        notes,
        routePages: report.routePages,
        townSearches: report.townSearches,
        journeyLegs: report.journeyLegs,
        journeyLegNavigation: report.journeyLegNavigation,
        nearby: report.nearby,
        search: report.search,
        journey: report.journey,
        disruptions: report.disruptions,
        health: report.health,
        mapDiagnostics,
      },
      null,
      2,
    ),
  );

  console.log("");
  console.log(`PROBE_FAILURES=${failures.length}`);
}

/* Wrapped, not top level: tsx resolves this file as CommonJS, where top-level await is a
 * transform error rather than a runtime one — a script that never ran once reported success. */
main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
