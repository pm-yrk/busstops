#!/usr/bin/env node
/**
 * Cloudflare's own CPU figure for each passenger endpoint, city by city.
 *
 * The absence of a 1102 is not proof. Cloudflare extends each isolate "some built-in flexibility
 * to allow for cases where your Worker infrequently runs over the configured limit" and enforces
 * the limit once a Worker overspends consistently — so whether a request is terminated depends on
 * what the isolate has recently done, and a walk that passes today can fail tomorrow on identical
 * code. Three acceptance samples of one frozen build measured 13 to 32 platform errors per pass
 * where two earlier deployments of near-identical code had measured none, which is that effect
 * and not a code change.
 *
 * The figure that does not drift is the CPU an invocation actually spent. `wrangler tail` reports
 * it per invocation with the outcome beside it, so this attaches a tail, walks the passenger
 * endpoints across the five probe cities one request at a time, and reports the distribution.
 *
 * Paced on purpose. The point is to measure what one passenger request costs, not to find the
 * concurrency at which the platform sheds work — `classify-worker-outcomes.ts` does that.
 *
 *   npx tsx scripts/measure-worker-cpu.ts --worker https://... [--json worker-cpu.json]
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { annotate } from "./annotate.mjs";

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

const WORKER = (arg("worker") ?? process.env.WORKER_URL ?? "").replace(/\/+$/, "");
const WORKER_ENV = arg("env") ?? process.env.WORKER_ENV ?? "preview";
const JSON_OUT = arg("json");
const ROUNDS = Number(arg("rounds") ?? "3");

/** The five probe cities, with a viewport and a journey inside each. */
const CITIES = [
  {
    name: "Leeds",
    bbox: "-1.62000,53.75000,-1.46000,53.84000",
    stop: { lat: 53.7996, lon: -1.5491 },
    journey: "fromLat=53.79600&fromLon=-1.54900&toLat=53.80400&toLon=-1.56000",
    search: "leeds",
  },
  {
    name: "Manchester",
    bbox: "-2.32000,53.42000,-2.16000,53.52000",
    stop: { lat: 53.4794, lon: -2.2453 },
    journey: "fromLat=53.47940&fromLon=-2.24530&toLat=53.50440&toLon=-2.24530",
    search: "manchester",
  },
  {
    name: "Birmingham",
    bbox: "-1.96000,52.42000,-1.80000,52.52000",
    stop: { lat: 52.4751, lon: -1.8986 },
    journey: "fromLat=52.47510&fromLon=-1.89860&toLat=52.49000&toLon=-1.88000",
    search: "birmingham",
  },
  {
    name: "Bristol",
    bbox: "-2.65000,51.42000,-2.49000,51.52000",
    stop: { lat: 51.455, lon: -2.5879 },
    journey: "fromLat=51.45500&fromLon=-2.58790&toLat=51.46500&toLon=-2.60000",
    search: "bristol",
  },
  {
    name: "York",
    bbox: "-1.15000,53.92000,-1.01000,54.00000",
    stop: { lat: 53.958, lon: -1.0803 },
    journey: "fromLat=53.95800&fromLon=-1.08030&toLat=53.96500&toLon=-1.09000",
    search: "york",
  },
] as const;

interface Reading {
  endpoint: string;
  city: string;
  path: string;
  status: number | null;
  platform: boolean;
  cfRay: string | null;
  ms: number;
  /** What the response itself said, where it lived to say anything. */
  vehicles?: number;
  sourceAgeSeconds?: number | null;
  charsDecoded?: number;
  degradation?: string | null;
}

interface TailRecord {
  outcome?: string;
  cpuTime?: number;
  wallTime?: number;
  eventTimestamp?: number;
  event?: { request?: { url?: string }; response?: { status?: number } };
}

const readings: Reading[] = [];

async function ask(endpoint: string, city: string, path: string): Promise<void> {
  const began = Date.now();
  try {
    const response = await fetch(`${WORKER}${path}`, { signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    const reading: Reading = {
      endpoint,
      city,
      path,
      status: response.status,
      platform: false,
      cfRay: response.headers.get("cf-ray"),
      ms: Date.now() - began,
    };
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const meta = body.meta as Record<string, unknown> | undefined;
      const data = body.data as Record<string, unknown> | undefined;
      const diagnostics = meta?.diagnostics as Record<string, unknown> | undefined;
      reading.charsDecoded =
        typeof diagnostics?.charsDecoded === "number" ? diagnostics.charsDecoded : undefined;
      reading.degradation = typeof meta?.degradation === "string" ? meta.degradation : null;
      const vehicles = data?.vehicles;
      if (Array.isArray(vehicles)) reading.vehicles = vehicles.length;
      const observedAt = meta?.observedAt;
      reading.sourceAgeSeconds =
        typeof observedAt === "string"
          ? Math.round((Date.now() - Date.parse(observedAt)) / 1000)
          : null;
    } catch {
      reading.platform = /error 10\d\d|exceeded resource limits|<html/i.test(text);
    }
    readings.push(reading);
  } catch (error) {
    readings.push({
      endpoint,
      city,
      path,
      status: null,
      platform: true,
      cfRay: null,
      ms: Date.now() - began,
      degradation: `request failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** A live tail, attached before the walk. See `classify-worker-outcomes.ts` for the record shape. */
function startTail() {
  const child = spawn(
    "npx",
    [
      "--no-install",
      "wrangler",
      "tail",
      "--config",
      "apps/worker/wrangler.toml",
      "--env",
      WORKER_ENV,
      "--format",
      "json",
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: true },
  );

  const records: TailRecord[] = [];
  const notes: string[] = [];
  /* `--format json` pretty-prints, so a record is `{` at column zero to the matching `}`. */
  let pending: string[] | null = null;
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (pending === null) {
      if (line.startsWith("{")) pending = [line];
      else if (line.trim().length > 0) notes.push(line.trim().slice(0, 160));
      return;
    }
    pending.push(line);
    if (!line.startsWith("}")) return;
    const document = pending.join("\n");
    pending = null;
    try {
      records.push(JSON.parse(document) as TailRecord);
    } catch {
      notes.push(`unparseable tail record: ${document.slice(0, 120)}`);
    }
  });
  createInterface({ input: child.stderr }).on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !/Proxy environment variables/i.test(trimmed)) {
      notes.push(trimmed.slice(0, 200));
    }
  });

  return {
    records,
    notes,
    stop: async () => {
      const signal = (what: "SIGINT" | "SIGKILL") => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, what);
        } catch {
          /* Already gone, which is the outcome being asked for. */
        }
      };
      signal("SIGINT");
      await new Promise<void>((resolve) => {
        const give = setTimeout(() => {
          signal("SIGKILL");
          resolve();
        }, 5_000);
        child.on("exit", () => {
          clearTimeout(give);
          resolve();
        });
      });
    },
  };
}

/** Which endpoint a tail record belongs to, from the URL it carries. */
function endpointOfUrl(url: string | undefined): string {
  if (url === undefined) return "(unknown)";
  if (url.includes("/v1/map")) return "map";
  if (url.includes("/v1/journeys")) return "journey";
  if (url.includes("/v1/stops/")) return "stop";
  if (url.includes("/v1/nearby")) return "nearby";
  if (url.includes("/v1/search")) return "search";
  if (url.includes("/v1/routes/")) return "route";
  if (url.includes("/v1/sources/health")) return "health";
  return "(other)";
}

const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

async function main(): Promise<number> {
  if (!WORKER) {
    console.error("Usage: measure-worker-cpu.ts --worker <url>");
    return 2;
  }

  console.log(`Attaching a tail, then walking ${String(ROUNDS)} round(s)`);
  const tail = startTail();
  /* Long enough for wrangler to negotiate the tail before the first request arrives. */
  await new Promise((resolve) => setTimeout(resolve, 12_000));

  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const city of CITIES) {
      await ask("map", city.name, `/v1/map?bbox=${city.bbox}&zoom=14`);
      await ask("journey", city.name, `/v1/journeys?${city.journey}`);
      await ask(
        "nearby",
        city.name,
        `/v1/nearby?lat=${String(city.stop.lat)}&lon=${String(city.stop.lon)}&radius=600`,
      );
      await ask("search", city.name, `/v1/search?q=${city.search}`);
    }
    console.log(`round ${String(round)} of ${String(ROUNDS)} done`);
  }

  /* Tail delivery lags the response the client already holds. */
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  await tail.stop();

  const byEndpoint = new Map<
    string,
    { cpu: number[]; wall: number[]; outcomes: Record<string, number> }
  >();
  for (const record of tail.records) {
    const endpoint = endpointOfUrl(record.event?.request?.url);
    const entry = byEndpoint.get(endpoint) ?? { cpu: [], wall: [], outcomes: {} };
    if (typeof record.cpuTime === "number") entry.cpu.push(record.cpuTime);
    if (typeof record.wallTime === "number") entry.wall.push(record.wallTime);
    const outcome = record.outcome ?? "(none)";
    entry.outcomes[outcome] = (entry.outcomes[outcome] ?? 0) + 1;
    byEndpoint.set(endpoint, entry);
  }

  const table = [...byEndpoint]
    .map(([endpoint, entry]) => ({
      endpoint,
      invocations: entry.cpu.length,
      p50CpuMs: percentile(entry.cpu, 50),
      p95CpuMs: percentile(entry.cpu, 95),
      maxCpuMs: entry.cpu.length === 0 ? null : Math.max(...entry.cpu),
      maxWallMs: entry.wall.length === 0 ? null : Math.max(...entry.wall),
      exceededCpu: entry.outcomes.exceededCpu ?? 0,
      exceededMemory: entry.outcomes.exceededMemory ?? 0,
      outcomes: entry.outcomes,
      /* The bar: the configured limit, not whatever the platform tolerated today. */
      withinBudget: (percentile(entry.cpu, 95) ?? Number.POSITIVE_INFINITY) <= 10,
    }))
    .sort((a, b) => (b.maxCpuMs ?? 0) - (a.maxCpuMs ?? 0));

  console.log("");
  console.log("endpoint   invocations   p50 CPU   p95 CPU   max CPU   exceededCpu");
  for (const row of table) {
    console.log(
      `${row.endpoint.padEnd(10)} ${String(row.invocations).padStart(11)}   ` +
        `${String(row.p50CpuMs ?? "-").padStart(7)}   ${String(row.p95CpuMs ?? "-").padStart(7)}   ` +
        `${String(row.maxCpuMs ?? "-").padStart(7)}   ${String(row.exceededCpu).padStart(11)}`,
    );
  }

  /* Per city, which is what the map's own acceptance table asks for. */
  const cities = CITIES.map((city) => {
    const maps = readings.filter((r) => r.endpoint === "map" && r.city === city.name);
    return {
      city: city.name,
      requests: maps.length,
      answered: maps.filter((r) => !r.platform && r.status === 200).length,
      platformErrors: maps.filter((r) => r.platform).length,
      vehicles: Math.max(0, ...maps.map((r) => r.vehicles ?? 0)),
      sourceAgeSeconds: Math.max(0, ...maps.map((r) => r.sourceAgeSeconds ?? 0)),
      maxCharsDecoded: Math.max(0, ...maps.map((r) => r.charsDecoded ?? 0)),
      degradation: [...new Set(maps.map((r) => r.degradation ?? "null"))],
    };
  });

  const report = {
    outcome: "measured",
    worker: WORKER,
    rounds: ROUNDS,
    freeCpuBudgetMs: 10,
    requests: readings.length,
    platformErrors: readings.filter((r) => r.platform).length,
    tailRecords: tail.records.length,
    tailNotes: tail.notes.slice(0, 8),
    byEndpoint: table,
    cities,
    worstOffenders: readings
      .filter((r) => r.platform)
      .slice(0, 10)
      .map((r) => ({ endpoint: r.endpoint, city: r.city, cfRay: r.cfRay, ms: r.ms })),
  };

  console.log("");
  console.log(JSON.stringify({ cities, byEndpoint: table }, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotate("notice", "worker cpu", JSON.stringify(report, null, 1));
  return 0;
}

main()
  .then((code) => {
    /* Exited rather than returned: a readline over a live child's stdout keeps the loop alive. */
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error("Measuring the Worker's CPU failed:", error);
    process.exit(1);
  });
