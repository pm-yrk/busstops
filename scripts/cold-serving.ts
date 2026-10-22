#!/usr/bin/env node
/**
 * What a first-contact request costs, city by city, and what the same request costs warm.
 *
 * Cloudflare answers a Worker that runs out of CPU with error 1102 and its own HTML page, and
 * that page carries no CORS header — so a browser reports it as a CORS failure and a probe reports
 * it as HTTP 503. Neither description names the limit, and neither says which stage spent the
 * compute. The deployed runs that *survive* carry a read ledger in `meta.diagnostics`, and this
 * collects them.
 *
 * The defect is first contact, so the shape of the walk is the measurement. Thirty requests to one
 * endpoint prove warm behaviour and nothing else: by the second one the isolate is holding the
 * tiles and the parse never happens again. So each city is visited once, in turn, and no city is
 * revisited until every other has been seen — every reading is against artifacts the isolate has
 * not touched. The warm pass follows, deliberately repeating the first city, so the two numbers
 * sit side by side.
 *
 *   npx tsx scripts/cold-serving.ts --worker https://... [--json report.json] [--peak 50]
 */

import { writeFileSync } from "node:fs";
import { annotate } from "./annotate.mjs";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

const WORKER = (arg("worker") ?? process.env.WORKER_URL ?? "").replace(/\/+$/, "");
const JSON_OUT = arg("json");
/*
 * How many requests the peak passes must make, twice over. Zero skips them.
 *
 * Fifty-plus because that is the number that failed: one isolate served 53 and started answering
 * 1102 at request 26. A pass that stops short of it proves the thing that already passed.
 */
const PEAK_REQUESTS = Math.max(0, Number(arg("peak") ?? process.env.PEAK_REQUESTS ?? "0"));

if (!WORKER) {
  console.error("Usage: cold-serving.ts --worker <worker url> [--json <file>]");
  process.exit(2);
}

interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Five cities far enough apart that no two share a tile on any grid this project uses.
 *
 * The stop and pattern grids are quarter and eighth of a degree; these are whole degrees apart in
 * places. A walk through them cannot accidentally warm the next one.
 */
const CITIES: Array<{ name: string; bbox: Bbox; centre: { lat: number; lon: number } }> = [
  {
    name: "Leeds",
    bbox: { west: -1.62, south: 53.75, east: -1.46, north: 53.84 },
    centre: { lat: 53.7965, lon: -1.5478 },
  },
  {
    name: "Manchester",
    bbox: { west: -2.32, south: 53.42, east: -2.16, north: 53.52 },
    centre: { lat: 53.4794, lon: -2.2453 },
  },
  {
    name: "Birmingham",
    bbox: { west: -1.96, south: 52.42, east: -1.8, north: 52.52 },
    centre: { lat: 52.4797, lon: -1.8996 },
  },
  {
    name: "Bristol",
    bbox: { west: -2.66, south: 51.42, east: -2.5, north: 51.51 },
    centre: { lat: 51.4545, lon: -2.5879 },
  },
  {
    name: "York",
    bbox: { west: -1.12, south: 53.94, east: -1.03, north: 53.99 },
    centre: { lat: 53.9583, lon: -1.0803 },
  },
];

const bboxParam = (b: Bbox): string =>
  [b.west, b.south, b.east, b.north].map((v) => v.toFixed(5)).join(",");

function at(value: unknown, ...path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asText = (value: unknown): string =>
  value === undefined || value === null ? "" : String(value);
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Which walk a reading belongs to.
 *
 * `peak` is a third shape and not a longer warm pass. Cold and warm each make about thirty
 * requests, which is fewer than one isolate is asked to serve on a real evening — and the run
 * that failed did so at request 26 of 53 on a single isolate, so a walk that stops at thirty
 * cannot see the failure at all. A peak pass keeps going, round-robin across the cities at the
 * same human pace, until it has made at least as many requests as the number that broke.
 */
type Pass = "cold" | "warm" | "peak-1" | "peak-2";

/** One stage line of a read ledger, flattened so a table can be printed from it. */
interface Reading {
  city: string;
  endpoint: string;
  path: string;
  pass: Pass;
  status: number | null;
  ms: number;
  /** Cloudflare's own words when the Worker did not answer. */
  platform?: string;
  /** The ledger, when the request lived long enough to report one. */
  charsDecoded?: number;
  objectsRead?: number;
  objectsCached?: number;
  records?: number;
  families?: Record<string, { chars: number; read: number; cached: number; records: number }>;
  stages?: Record<string, number>;
  budgetStopped?: boolean;
  degradationReason?: string | null;
  residentCharsBefore?: number;
  /** Parsed records the isolate was already holding. This is the memory, not the characters. */
  residentRecordsBefore?: number;
  requestsServed?: number;
}

const readings: Reading[] = [];

async function ask(city: string, endpoint: string, path: string, pass: Pass): Promise<unknown> {
  const started = Date.now();
  let status: number | null = null;
  let body = "";
  try {
    const response = await fetch(`${WORKER}${path}`, { signal: AbortSignal.timeout(45_000) });
    status = response.status;
    body = await response.text();
  } catch (error) {
    readings.push({
      city,
      endpoint,
      path,
      pass,
      status: null,
      ms: Date.now() - started,
      platform: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return null;
  }

  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* Cloudflare's error page, whose title is the only part that names the limit. */
    const cleaned = body.replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ");
    const named =
      cleaned.match(/error\s+\d{4}[^<]*/i)?.[0] ??
      cleaned.match(/<title>\s*([^<]{0,160})<\/title>/i)?.[1] ??
      "unparseable body";
    readings.push({
      city,
      endpoint,
      path,
      pass,
      status,
      ms: Date.now() - started,
      platform: named.trim().slice(0, 90),
    });
    return null;
  }

  const diagnostics = at(json, "meta", "diagnostics");
  const families: Record<string, { chars: number; read: number; cached: number; records: number }> =
    {};
  const raw = at(diagnostics, "families");
  if (raw && typeof raw === "object") {
    for (const [name, cost] of Object.entries(raw as Record<string, unknown>)) {
      families[name] = {
        chars: asNumber(at(cost, "chars")) ?? 0,
        read: asNumber(at(cost, "read")) ?? 0,
        cached: asNumber(at(cost, "cached")) ?? 0,
        records: asNumber(at(cost, "records")) ?? 0,
      };
    }
  }

  readings.push({
    city,
    endpoint,
    path,
    pass,
    status,
    ms: Date.now() - started,
    ...(diagnostics === undefined
      ? {}
      : {
          charsDecoded: asNumber(at(diagnostics, "charsDecoded")) ?? 0,
          objectsRead: asNumber(at(diagnostics, "objectsRead")) ?? 0,
          objectsCached: asNumber(at(diagnostics, "objectsCached")) ?? 0,
          records: asNumber(at(diagnostics, "records")) ?? 0,
          families,
          stages: (at(diagnostics, "stages") as Record<string, number>) ?? {},
          budgetStopped: at(diagnostics, "budgetStopped") === true,
          degradationReason: (at(diagnostics, "degradationReason") as string | null) ?? null,
          residentCharsBefore: asNumber(at(diagnostics, "residency", "charsBefore")) ?? 0,
          residentRecordsBefore: asNumber(at(diagnostics, "residency", "recordsBefore")) ?? 0,
          requestsServed: asNumber(at(diagnostics, "residency", "requestsServed")) ?? 0,
        }),
  });
  return json;
}

/**
 * One city's passenger sequence, at a human pace.
 *
 * Paced because this is a measurement of what a person meets, not a load test — the repeated
 * endpoint instrument lives in `verify-deployment` and stays there. The ids are taken from each
 * city's own answers, so nothing is hard coded and a city whose search fails is reported as such
 * rather than skipped.
 */
async function walk(city: (typeof CITIES)[number], pass: Pass): Promise<void> {
  const pace = () => new Promise((resolve) => setTimeout(resolve, 1_000));
  const bbox = encodeURIComponent(bboxParam(city.bbox));

  await pace();
  const search = await ask(
    city.name,
    "search",
    `/v1/search?q=${encodeURIComponent(city.name)}`,
    pass,
  );

  await pace();
  const nearby = await ask(
    city.name,
    "nearby",
    `/v1/nearby?lat=${city.centre.lat.toFixed(5)}&lon=${city.centre.lon.toFixed(5)}&radius=600`,
    pass,
  );

  await pace();
  const map = await ask(city.name, "map", `/v1/map?bbox=${bbox}&zoom=13`, pass);

  /* A stop this city actually has, preferring the viewport's own over a name match elsewhere. */
  const stopId =
    asText(
      at(
        asArray(at(nearby, "data", "results")).find((row) => at(row, "kind") === "stop"),
        "id",
      ),
    ) ||
    asText(
      at(
        asArray(at(search, "data", "results")).find((row) => at(row, "kind") === "stop"),
        "id",
      ),
    );

  let routeId = "";
  if (stopId) {
    await pace();
    const stop = await ask(city.name, "stop", `/v1/stops/${encodeURIComponent(stopId)}`, pass);
    routeId = asText(at(asArray(at(stop, "data", "routes"))[0], "id"));
  }

  if (routeId) {
    await pace();
    await ask(city.name, "route", `/v1/routes/${encodeURIComponent(routeId)}`, pass);
  }

  const vehicleRef = asText(at(asArray(at(map, "data", "vehicles"))[0], "vehicleRef"));
  if (vehicleRef) {
    await pace();
    await ask(
      city.name,
      "vehicle",
      `/v1/vehicles/${encodeURIComponent(vehicleRef)}?bbox=${bbox}`,
      pass,
    );
  }

  await pace();
  await ask(
    city.name,
    "journey",
    `/v1/journeys?fromLat=${city.centre.lat.toFixed(5)}&fromLon=${city.centre.lon.toFixed(5)}` +
      `&toLat=${(city.centre.lat + 0.025).toFixed(5)}&toLon=${city.centre.lon.toFixed(5)}`,
    pass,
  );
}

function summarise(pass: Pass): Array<Record<string, unknown>> {
  const byEndpoint = new Map<string, Reading[]>();
  for (const reading of readings.filter((row) => row.pass === pass)) {
    byEndpoint.set(reading.endpoint, [...(byEndpoint.get(reading.endpoint) ?? []), reading]);
  }
  return [...byEndpoint].map(([endpoint, rows]) => {
    const decoded = rows.map((row) => row.charsDecoded ?? 0);
    const platform = rows.filter((row) => row.platform !== undefined);
    return {
      endpoint,
      requests: rows.length,
      ok: rows.filter((row) => row.status === 200).length,
      platformErrors: platform.length,
      platformSaid: [...new Set(platform.map((row) => row.platform))].slice(0, 2),
      medianMs: median(rows.map((row) => row.ms)),
      maxMs: Math.max(0, ...rows.map((row) => row.ms)),
      medianCharsDecoded: median(decoded),
      maxCharsDecoded: Math.max(0, ...decoded),
      /* Which family paid for it, across the cities that answered. */
      byFamily: familyTotals(rows),
    };
  });
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length === 0) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? Math.round((ordered[middle - 1]! + ordered[middle]!) / 2)
    : ordered[middle]!;
}

function familyTotals(rows: Reading[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) {
    for (const [name, cost] of Object.entries(row.families ?? {})) {
      totals[name] = Math.max(totals[name] ?? 0, cost.chars);
    }
  }
  return totals;
}

/**
 * A busy evening's worth of requests, in one sequence, with nothing warmed first.
 *
 * The acceptance criterion is not a cheaper ledger, it is a Worker that does not run out of
 * resources during normal peak use — and the two came apart once already. A run that went 66 of
 * 66 was served by an isolate that recycled at request 26; the run that failed had one isolate
 * serve all 53, and it started answering 1102 partway through. So what this pass measures is not
 * the per-request cost but how far a *single* isolate gets, and the number that matters is the
 * largest `requestsServed` any reading reported alongside the errors at that point.
 *
 * Round-robin rather than city by city, because that is the honest shape: a real isolate serves
 * whoever arrives, so its residency is the union of everywhere, not one city's tiles.
 */
async function peak(pass: Pass, atLeast: number): Promise<void> {
  let made = 0;
  let round = 0;
  while (made < atLeast) {
    const city = CITIES[round % CITIES.length]!;
    const before = readings.length;
    await walk(city, pass);
    made += readings.length - before;
    round += 1;
    /*
     * A guard against a walk that answers nothing. `walk` derives its stop and route ids from the
     * city's own answers, so an artifact that cannot answer search makes each round shorter — and
     * without this the loop would spin asking two questions at a time for a very long while.
     */
    if (round > atLeast) break;
  }
}

/** What one isolate was asked to do, and whether it stayed up while doing it. */
function isolateReach(pass: Pass): Record<string, unknown> {
  const rows = readings.filter((row) => row.pass === pass);
  const served = rows.map((row) => row.requestsServed ?? 0);
  const failures = rows.filter((row) => row.platform !== undefined);
  /*
   * How many isolates answered, counted from the residency counter rather than guessed.
   *
   * `requestsServed` is the isolate's own tally, so it climbs while one isolate is answering and
   * drops back when a new one takes over. Counting the drops counts the handovers, and a walk
   * spread over several isolates is a weaker result than the same walk on one — the whole point
   * is to find out what happens when it is *not* spread.
   */
  let handovers = 0;
  for (let i = 1; i < served.length; i += 1) {
    if (served[i]! < served[i - 1]!) handovers += 1;
  }
  return {
    pass,
    requests: rows.length,
    cities: [...new Set(rows.map((row) => row.city))].length,
    ok: rows.filter((row) => row.status === 200).length,
    platformErrors: failures.length,
    platformSaid: [...new Set(failures.map((row) => row.platform))].slice(0, 3),
    isolateServedMax: Math.max(0, ...served),
    isolates: handovers + 1,
    maxCharsDecoded: Math.max(0, ...rows.map((row) => row.charsDecoded ?? 0)),
    maxResidentChars: Math.max(0, ...rows.map((row) => row.residentCharsBefore ?? 0)),
    maxResidentRecords: Math.max(0, ...rows.map((row) => row.residentRecordsBefore ?? 0)),
  };
}

async function main(): Promise<void> {
  console.log(`Deployed API: ${WORKER}`);
  console.log("");
  console.log("=".repeat(78));
  console.log("Cold: each city once, in turn, nothing revisited");
  console.log("=".repeat(78));

  for (const city of CITIES) await walk(city, "cold");

  console.log("");
  console.log("=".repeat(78));
  console.log("Warm: the same walk again, against an isolate that has now seen it");
  console.log("=".repeat(78));

  for (const city of CITIES) await walk(city, "warm");

  const peaks: Array<Record<string, unknown>> = [];
  if (PEAK_REQUESTS > 0) {
    for (const pass of ["peak-1", "peak-2"] as const) {
      /*
       * Idle first, so the pass starts on an isolate that has not been warmed for it.
       *
       * Cloudflare evicts an idle isolate within a minute or so, and the walk that precedes this
       * has just touched five cities' tiles — measuring peak behaviour on *that* isolate would
       * be measuring the warm pass again with a longer tail. Forty-five seconds of nothing is
       * the cheapest way to ask for a fresh one, and if the platform hands back the same isolate
       * the reading says so: `requestsServed` carries on from where it left off.
       */
      await new Promise((resolve) => setTimeout(resolve, 45_000));
      console.log("");
      console.log("=".repeat(78));
      console.log(
        `${pass}: ${PEAK_REQUESTS}+ requests in one sequence, round-robin, nothing prewarmed`,
      );
      console.log("=".repeat(78));
      await peak(pass, PEAK_REQUESTS);
      const reach = isolateReach(pass);
      peaks.push(reach);
      console.log(
        `${pass}: ${String(reach.ok)}/${String(reach.requests)} ok across ` +
          `${String(reach.cities)} cities, ${String(reach.platformErrors)} platform error(s); ` +
          `one isolate served up to ${String(reach.isolateServedMax)} request(s) over ` +
          `${String(reach.isolates)} isolate(s)`,
      );
    }
  }

  const cold = summarise("cold");
  const warm = summarise("warm");

  console.log("");
  console.log("endpoint      pass   ok      1102  median ms   max chars decoded");
  for (const pass of ["cold", "warm"] as const) {
    for (const row of pass === "cold" ? cold : warm) {
      console.log(
        `${String(row.endpoint).padEnd(12)}  ${pass.padEnd(5)}  ` +
          `${String(row.ok)}/${String(row.requests)}`.padEnd(7) +
          ` ${String(row.platformErrors).padStart(4)}  ` +
          `${String(row.medianMs).padStart(9)}  ${String(row.maxCharsDecoded).padStart(18)}`,
      );
    }
  }

  console.log("");
  console.log("pass  city        endpoint   served  residentBefore  recordsBefore  chars  status");
  for (const row of readings) {
    console.log(
      `${row.pass.padEnd(5)} ${row.city.padEnd(11)} ${row.endpoint.padEnd(9)} ` +
        `${String(row.requestsServed ?? "-").padStart(6)}  ` +
        `${String(row.residentCharsBefore ?? "-").padStart(14)}  ` +
        `${String(row.residentRecordsBefore ?? "-").padStart(13)}  ` +
        `${String(row.charsDecoded ?? "-").padStart(8)}  ${String(row.status ?? "-")}` +
        (row.platform === undefined ? "" : `  ${row.platform.slice(0, 40)}`),
    );
  }

  const failures = readings.filter((row) => row.platform !== undefined);
  console.log("");
  for (const row of failures) {
    console.log(`  ${row.pass} ${row.city} ${row.endpoint}: ${row.platform}`);
  }

  /*
   * The trace, because the summary cannot answer the question the first run raised.
   *
   * That run found nought platform errors on the cold walk and seventeen on the warm one, which
   * is the opposite of a first-contact failure and points at what an isolate accumulates rather
   * than at what a request decodes. `requestsServed` and the residency it started against are the
   * two numbers that separate those, and they are per request.
   */
  const trace = readings.map((row) => ({
    pass: row.pass,
    city: row.city,
    endpoint: row.endpoint,
    status: row.status,
    ms: row.ms,
    chars: row.charsDecoded ?? null,
    served: row.requestsServed ?? null,
    residentBefore: row.residentCharsBefore ?? null,
    recordsBefore: row.residentRecordsBefore ?? null,
    ...(row.platform === undefined ? {} : { platform: row.platform.slice(0, 40) }),
  }));

  const report = {
    startedAt: new Date().toISOString(),
    worker: WORKER,
    cold,
    warm,
    peaks,
    trace,
    readings,
  };
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotate("notice", "cold serving", JSON.stringify({ cold, warm }, null, 1));
  if (peaks.length > 0) {
    // Its own annotation: this is the acceptance measurement, and it must not be the part that
    // GitHub truncates away when the per-endpoint summary happens to be long.
    annotate("notice", "peak passenger walk", JSON.stringify(peaks, null, 1));
  }
  /*
   * One row per line, because the splitter divides on line boundaries.
   *
   * A single `JSON.stringify` of the whole trace is one very long line, and GitHub cuts an
   * annotation off at about four kibibytes — so the first attempt at this arrived truncated
   * mid-number and would not parse, which is the same failure the splitter was written for.
   */
  annotate("notice", "cold serving trace", trace.map((row) => JSON.stringify(row)).join("\n"));
  if (failures.length > 0) {
    annotate(
      "failure",
      `cold serving (${failures.length} platform error(s))`,
      failures.map((row) => `${row.pass} ${row.city} ${row.endpoint}: ${row.platform}`).join("\n"),
    );
  }

  console.log("");
  console.log(`COLD_PLATFORM_ERRORS=${failures.filter((row) => row.pass === "cold").length}`);
  console.log(`WARM_PLATFORM_ERRORS=${failures.filter((row) => row.pass === "warm").length}`);
  const peakFailures = failures.filter((row) => row.pass.startsWith("peak"));
  console.log(`PEAK_PLATFORM_ERRORS=${peakFailures.length}`);
  console.log(`PEAK_REQUESTS=${readings.filter((row) => row.pass.startsWith("peak")).length}`);
  console.log(
    `PEAK_ISOLATE_SERVED_MAX=${Math.max(0, ...peaks.map((row) => Number(row.isolateServedMax ?? 0)))}`,
  );
}

/* Called rather than awaited at the top level, so a transform error is a transform error. */
main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
