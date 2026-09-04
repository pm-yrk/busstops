#!/usr/bin/env node
/**
 * What the upstreams actually return, right now, from this runner.
 *
 * The deployed preview reported zero live buses and zero departures while every structural check
 * passed. That can mean four different things — the request never left, the request was refused,
 * the body was empty, or the body was full and we rejected all of it — and the Worker's
 * `catch {}` collapsed all four into "bods failed". This asks each upstream directly and prints
 * which one it is.
 *
 * Nothing here prints a credential or a source vehicle identifier. Keys are redacted from every
 * URL before logging and vehicle references are counted, never echoed.
 *
 *   npx tsx scripts/diagnose-upstreams.ts [--json report.json]
 */

import { writeFileSync } from "node:fs";
import { normalizeSiriVm, parseSiriVm } from "@busstops/adapters";

const BODS_KEY = process.env.BODS_API_KEY;
const TFL_KEY = process.env.TFL_APP_KEY;

/** Viewports chosen to be busy on a weekday, plus one London box for the TfL comparison. */
const AREAS = [
  { name: "Leeds", bbox: { west: -1.62, south: 53.75, east: -1.46, north: 53.84 } },
  { name: "Manchester", bbox: { west: -2.32, south: 53.42, east: -2.16, north: 53.52 } },
  { name: "Birmingham", bbox: { west: -1.96, south: 52.42, east: -1.8, north: 52.52 } },
  { name: "Bristol", bbox: { west: -2.66, south: 51.42, east: -2.5, north: 51.51 } },
  { name: "Newcastle", bbox: { west: -1.68, south: 54.94, east: -1.54, north: 55.02 } },
  { name: "Nottingham", bbox: { west: -1.22, south: 52.92, east: -1.08, north: 53.0 } },
  { name: "London (Westminster)", bbox: { west: -0.17, south: 51.48, east: -0.09, north: 51.53 } },
];

interface Probe {
  label: string;
  url: string;
  method: string;
  status?: number;
  contentType?: string | null;
  contentLength?: string | null;
  bytes?: number;
  text?: string;
  head?: string;
  ms?: number;
  error?: string;
}

const report: {
  startedAt: string;
  areas: Record<string, unknown>[];
  endpoints: Record<string, unknown>[];
} = { startedAt: new Date().toISOString(), areas: [], endpoints: [] };

/** Never let a key reach the log, whichever query parameter a producer chose to call it. */
function redact(url: string): string {
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) {
    if (/key|token|secret|password/i.test(key)) u.searchParams.set(key, "***");
  }
  return u.toString();
}

async function probe(
  label: string,
  url: string,
  {
    method = "GET",
    accept,
    maxBody = 400,
  }: { method?: string; accept?: string; maxBody?: number } = {},
): Promise<Probe> {
  const started = Date.now();
  const entry: Probe = { label, url: redact(url), method };
  try {
    const response = await fetch(url, {
      method,
      headers: accept ? { accept } : {},
      signal: AbortSignal.timeout(60_000),
    });
    entry.status = response.status;
    entry.contentType = response.headers.get("content-type");
    entry.contentLength = response.headers.get("content-length");
    if (method === "GET") {
      const body = await response.arrayBuffer();
      entry.bytes = body.byteLength;
      entry.text = Buffer.from(body).toString("utf8");
      entry.head = entry.text.slice(0, maxBody).replace(/\s+/g, " ");
    }
    entry.ms = Date.now() - started;
  } catch (error) {
    entry.ms = Date.now() - started;
    entry.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return entry;
}

console.log("=".repeat(72));
console.log("BODS SIRI-VM by viewport");
console.log("=".repeat(72));
console.log(`BODS_API_KEY present: ${BODS_KEY ? "yes" : "NO"}`);
console.log(`TFL_APP_KEY present: ${TFL_KEY ? "yes" : "NO"}`);

for (const area of AREAS) {
  const url = new URL("https://data.bus-data.dft.gov.uk/api/v1/datafeed/");
  const b = area.bbox;
  url.searchParams.set(
    "boundingBox",
    [b.west, b.south, b.east, b.north].map((v) => v.toFixed(5)).join(","),
  );
  if (BODS_KEY) url.searchParams.set("api_key", BODS_KEY);

  const probeResult = await probe(`siri-vm ${area.name}`, url.toString(), {
    maxBody: 300,
  });
  const row: Record<string, unknown> = {
    area: area.name,
    status: probeResult.status ?? null,
    contentType: probeResult.contentType ?? null,
    bytes: probeResult.bytes ?? 0,
    ms: probeResult.ms,
    error: probeResult.error ?? null,
  };

  if (probeResult.text && probeResult.status === 200) {
    const now = new Date();
    const parsed = parseSiriVm(probeResult.text);
    row.rawActivities = parsed.activities.length;
    row.parseRejected = parsed.rejected.length;
    row.responseTimestamp = parsed.responseTimestamp;

    const normalized = normalizeSiriVm(probeResult.text, {
      retrievedAt: now.toISOString(),
      vehicleSalt: "diagnostic-salt-not-published",
      now,
    });
    row.accepted = normalized.observations.length;
    const reasons: Record<string, number> = {};
    for (const r of normalized.rejected) {
      // Bucket by shape, not by value: "observation 812s old" would be a thousand distinct keys.
      const key = r.reason.replace(/\d+/g, "N");
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
    row.rejectedBy = reasons;
    const times = normalized.observations
      .map((o) => Date.parse(o.observedAt))
      .sort((a, b) => a - b);
    if (times.length > 0) {
      row.oldestObservation = new Date(times[0]!).toISOString();
      row.newestObservation = new Date(times[times.length - 1]!).toISOString();
      row.oldestAgeSeconds = Math.round((now.getTime() - times[0]!) / 1000);
      row.newestAgeSeconds = Math.round((now.getTime() - times[times.length - 1]!) / 1000);
    }
    // Every activity's age, including the ones the normaliser dropped, so a feed that is simply
    // stale is distinguishable from a feed that is empty.
    const allAges = parsed.activities
      .map((a) => (now.getTime() - Date.parse(a.RecordedAtTime)) / 1000)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (allAges.length > 0) {
      row.rawAgeSeconds = {
        min: Math.round(allAges[0]!),
        median: Math.round(allAges[Math.floor(allAges.length / 2)]!),
        max: Math.round(allAges[allAges.length - 1]!),
      };
    }
  } else if (probeResult.text) {
    row.head = probeResult.head;
  }

  report.areas.push(row);
  console.log(
    `\n${area.name}: HTTP ${row.status ?? "-"} ${row.contentType ?? ""} ${row.bytes} bytes in ${row.ms}ms` +
      (row.error ? `\n  error: ${row.error}` : ""),
  );
  if (row.rawActivities !== undefined) {
    console.log(
      `  activities ${row.rawActivities}, accepted ${row.accepted}, parse-rejected ${row.parseRejected}`,
    );
    console.log(`  responseTimestamp ${row.responseTimestamp ?? "-"}`);
    if (row.rawAgeSeconds)
      console.log(
        `  raw observation age s: min ${row.rawAgeSeconds.min} median ${row.rawAgeSeconds.median} max ${row.rawAgeSeconds.max}`,
      );
    if (row.oldestObservation)
      console.log(
        `  accepted age s: newest ${row.newestAgeSeconds} oldest ${row.oldestAgeSeconds}`,
      );
    const rejected = Object.entries((row.rejectedBy ?? {}) as Record<string, number>);
    if (rejected.length > 0)
      console.log(`  rejected: ${rejected.map(([k, v]) => `${v}x ${k}`).join(", ")}`);
  } else if (row.head) {
    console.log(`  body: ${row.head}`);
  }
}

console.log(`\n${"=".repeat(72)}`);
console.log("Other BODS endpoints named in the brief");
console.log("=".repeat(72));

const key = BODS_KEY ? `?api_key=${BODS_KEY}` : "";
const ENDPOINTS: Array<[string, string, { method?: string; accept?: string }]> = [
  [
    "national GTFS timetable (HEAD)",
    "https://data.bus-data.dft.gov.uk/timetable/download/gtfs-file/all/",
    { method: "HEAD" },
  ],
  [
    "regional GTFS: yorkshire (HEAD)",
    "https://data.bus-data.dft.gov.uk/timetable/download/gtfs-file/yorkshire/",
    { method: "HEAD" },
  ],
  [
    "regional GTFS: north_west (HEAD)",
    "https://data.bus-data.dft.gov.uk/timetable/download/gtfs-file/north_west/",
    { method: "HEAD" },
  ],
  [
    "GTFS-RT vehicle positions",
    `https://data.bus-data.dft.gov.uk/api/v1/gtfsrtdatafeed/${key}`,
    {},
  ],
  [
    "disruptions API",
    `https://data.bus-data.dft.gov.uk/api/v1/disruptions/${key}`,
    { accept: "application/json" },
  ],
  ["cancellations (siri-sx)", `https://data.bus-data.dft.gov.uk/api/v1/siri-sx/${key}`, {}],
  [
    "datasets index",
    `https://data.bus-data.dft.gov.uk/api/v1/dataset/${key}${key ? "&" : "?"}limit=1`,
    { accept: "application/json" },
  ],
];

for (const [label, url, options] of ENDPOINTS) {
  const result = await probe(label, url, options);
  report.endpoints.push({
    label,
    url: result.url,
    status: result.status ?? null,
    contentType: result.contentType ?? null,
    contentLength: result.contentLength ?? null,
    bytes: result.bytes ?? null,
    ms: result.ms,
    error: result.error ?? null,
    head: result.head ?? null,
  });
  console.log(
    `\n${label}\n  ${result.url}\n  HTTP ${result.status ?? "-"} ${result.contentType ?? ""} ` +
      `len=${result.contentLength ?? result.bytes ?? "-"} in ${result.ms}ms` +
      (result.error ? `\n  error: ${result.error}` : "") +
      (result.head ? `\n  body: ${result.head}` : ""),
  );
}

if (TFL_KEY) {
  console.log(`\n${"=".repeat(72)}`);
  console.log("TfL");
  console.log("=".repeat(72));
  for (const [label, path] of [
    ["arrivals at a Westminster stop", "/StopPoint/490008660N/Arrivals"],
    ["bus line status", "/Line/Mode/bus/Status"],
    ["bus disruption", "/Line/Mode/bus/Disruption"],
  ]) {
    const url = new URL(`https://api.tfl.gov.uk${path}`);
    url.searchParams.set("app_key", TFL_KEY);
    const result = await probe(label, url.toString(), { accept: "application/json", maxBody: 260 });
    let count: number | null = null;
    try {
      const body: unknown = JSON.parse(result.text ?? "null");
      count = Array.isArray(body) ? body.length : null;
    } catch {
      /* reported through head instead */
    }
    report.endpoints.push({
      label: `tfl ${label}`,
      url: result.url,
      status: result.status ?? null,
      bytes: result.bytes ?? null,
      ms: result.ms,
      records: count,
      error: result.error ?? null,
    });
    console.log(
      `\ntfl ${label}: HTTP ${result.status ?? "-"} ${result.bytes ?? 0} bytes in ${result.ms}ms` +
        (count === null ? "" : `, ${count} records`) +
        (result.error ? `\n  error: ${result.error}` : ""),
    );
    if (count === 0 || count === null) console.log(`  body: ${result.head ?? "-"}`);
  }
}

const jsonAt = process.argv.indexOf("--json");
if (jsonAt !== -1 && process.argv[jsonAt + 1]) {
  // The captured bodies are dropped: they are large and can contain source vehicle references.
  writeFileSync(process.argv[jsonAt + 1], JSON.stringify(report, null, 2));
  console.log(`\nreport -> ${process.argv[jsonAt + 1]}`);
}
