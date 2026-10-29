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

/**
 * Which endpoints to ask, so one question can be isolated.
 *
 * The map's CPU is the sum of its projection read, its live feed and its response, and Cloudflare
 * reports one number for all three. The only way to split them from outside is to take the same
 * walk with one of them switched off — `FEATURE_FLAGS_JSON` turns the live feed off without a code
 * change — and compare. That walk only wants the map.
 */
const ENDPOINTS = (arg("endpoints") ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const wanted = (endpoint: string): boolean =>
  ENDPOINTS.length === 0 || ENDPOINTS.includes(endpoint);

/**
 * The five probe cities, with a viewport and the four journey shapes in each.
 *
 * One journey per city was not enough to accept a planner on. The corpus asks four shapes of each
 * city — a neighbourhood hop, a cross-town trip, a cross-city trip and an awkward pair no single
 * route joins — because a planner's cost and its correctness both vary with them, and the whole
 * question here is Cloudflare's CPU per invocation rather than one city's median. These are the
 * corpus's own coordinates, so the deployed walk and the golden corpus ask the same questions.
 */
const CITIES = [
  {
    name: "Leeds",
    bbox: "-1.62000,53.75000,-1.46000,53.84000",
    stop: { lat: 53.7996, lon: -1.5491 },
    journeys: [
      { shape: "direct", query: "fromLat=53.7996&fromLon=-1.5491&toLat=53.8035&toLon=-1.5555" },
      { shape: "one change", query: "fromLat=53.7965&fromLon=-1.5478&toLat=53.8198&toLon=-1.5811" },
      { shape: "cross-city", query: "fromLat=53.7955&fromLon=-1.5491&toLat=53.8441&toLon=-1.6151" },
      { shape: "awkward", query: "fromLat=53.7742&fromLon=-1.5678&toLat=53.8231&toLon=-1.4593" },
    ],
    search: "leeds",
  },
  {
    name: "Manchester",
    bbox: "-2.32000,53.42000,-2.16000,53.52000",
    stop: { lat: 53.4794, lon: -2.2453 },
    journeys: [
      { shape: "direct", query: "fromLat=53.4794&fromLon=-2.2453&toLat=53.4839&toLon=-2.2446" },
      { shape: "one change", query: "fromLat=53.4794&fromLon=-2.2309&toLat=53.5044&toLon=-2.2453" },
      { shape: "cross-city", query: "fromLat=53.4794&fromLon=-2.2453&toLat=53.4702&toLon=-2.2914" },
      { shape: "awkward", query: "fromLat=53.4186&fromLon=-2.2311&toLat=53.5316&toLon=-2.2819" },
    ],
    search: "manchester",
  },
  {
    name: "Birmingham",
    bbox: "-1.96000,52.42000,-1.80000,52.52000",
    stop: { lat: 52.4751, lon: -1.8986 },
    journeys: [
      { shape: "direct", query: "fromLat=52.4797&fromLon=-1.8996&toLat=52.4836&toLon=-1.8936" },
      { shape: "one change", query: "fromLat=52.4751&fromLon=-1.8986&toLat=52.5106&toLon=-1.8601" },
      { shape: "cross-city", query: "fromLat=52.4797&fromLon=-1.8996&toLat=52.4408&toLon=-1.9342" },
      { shape: "awkward", query: "fromLat=52.5245&fromLon=-1.8396&toLat=52.4601&toLon=-1.9537" },
    ],
    search: "birmingham",
  },
  {
    name: "Bristol",
    bbox: "-2.65000,51.42000,-2.49000,51.52000",
    stop: { lat: 51.455, lon: -2.5879 },
    journeys: [
      { shape: "direct", query: "fromLat=51.455&fromLon=-2.5879&toLat=51.4583&toLon=-2.5918" },
      { shape: "one change", query: "fromLat=51.455&fromLon=-2.5879&toLat=51.4805&toLon=-2.6" },
      { shape: "cross-city", query: "fromLat=51.4518&fromLon=-2.5906&toLat=51.4341&toLon=-2.5942" },
      { shape: "awkward", query: "fromLat=51.4878&fromLon=-2.6022&toLat=51.4383&toLon=-2.5465" },
    ],
    search: "bristol",
  },
  {
    name: "York",
    bbox: "-1.15000,53.92000,-1.01000,54.00000",
    stop: { lat: 53.958, lon: -1.0803 },
    journeys: [
      { shape: "direct", query: "fromLat=53.958&fromLon=-1.0803&toLat=53.9609&toLon=-1.0859" },
      { shape: "one change", query: "fromLat=53.958&fromLon=-1.0803&toLat=53.9512&toLon=-1.0231" },
      { shape: "cross-city", query: "fromLat=53.9579&fromLon=-1.0934&toLat=53.9497&toLon=-1.1236" },
      { shape: "awkward", query: "fromLat=53.9733&fromLon=-1.0931&toLat=53.9303&toLon=-1.0493" },
    ],
    search: "york",
  },
] as const;

/**
 * Journeys in thinly served country, which is the shape the adaptive horizon exists for.
 *
 * The planner reads two hours of timetable and widens to four only when the narrow pass found
 * nothing. In a city that never happens; on a rural pair it is the normal case, and it is the one
 * that costs twice. Two of them, and a pair far enough apart that the planner refuses rather than
 * plans — the honest "no journey" answer, which has to be cheap as well as honest.
 */
const SPARSE = [
  {
    name: "North Yorkshire",
    shape: "sparse (widens)",
    query: "fromLat=54.0820&fromLon=-1.3410&toLat=54.1370&toLon=-1.5230",
  },
  {
    name: "Somerset",
    shape: "sparse (widens)",
    query: "fromLat=51.1290&fromLon=-2.7140&toLat=51.0810&toLon=-2.5920",
  },
  {
    name: "Leeds to Bristol",
    shape: "no journey",
    query: "fromLat=53.7996&fromLon=-1.5491&toLat=51.4550&toLon=-2.5879",
  },
] as const;

interface Reading {
  endpoint: string;
  city: string;
  path: string;
  /** Which journey shape this was, for the per-shape table. Absent for other endpoints. */
  shape?: string;
  status: number | null;
  platform: boolean;
  cfRay: string | null;
  ms: number;
  /** What the response itself said, where it lived to say anything. */
  vehicles?: number;
  sourceAgeSeconds?: number | null;
  charsDecoded?: number;
  degradation?: string | null;
  /**
   * The isolate's own tally of requests it has answered, including this one.
   *
   * One is the first request an isolate ever serves, and it pays for everything the module level
   * does once: the index record — a single 144,948-character line — and an empty shard cache. A
   * p95 that is four times a p50 is either one expensive branch or the cold request, and these
   * two numbers side by side are what tell them apart.
   */
  requestsServed?: number;
  /**
   * What a journey said about where its timetable came from.
   *
   * The point of publishing the transfers, the grouping and the binary trips is that a request
   * reads them instead of computing them — and a walk that reports `transfersFromArtifact: false`
   * or `shardsBinaryFallback` above zero is measuring the old path and saying nothing about the
   * new one, however good its milliseconds look.
   */
  journey?: {
    options: number | null;
    shardsBinary: number | null;
    shardsBinaryFallback: number | null;
    shardsGrouped: number | null;
    transfersFromArtifact: boolean | null;
    horizonHours: number | null;
    code: string | null;
  };
}

interface TailRecord {
  outcome?: string;
  cpuTime?: number;
  wallTime?: number;
  eventTimestamp?: number;
  event?: { request?: { url?: string }; response?: { status?: number } };
}

const readings: Reading[] = [];

async function ask(endpoint: string, city: string, path: string, shape?: string): Promise<void> {
  if (!wanted(endpoint)) return;
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
      ...(shape === undefined ? {} : { shape }),
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
      const residency = diagnostics?.residency as Record<string, unknown> | undefined;
      reading.requestsServed =
        typeof residency?.requestsServed === "number" ? residency.requestsServed : undefined;
      if (endpoint === "journey") {
        const options = (data?.options ?? data?.journeys) as unknown;
        const number = (value: unknown): number | null =>
          typeof value === "number" ? value : null;
        reading.journey = {
          options: Array.isArray(options) ? options.length : null,
          shardsBinary: number(diagnostics?.shardsBinary),
          shardsBinaryFallback: number(diagnostics?.shardsBinaryFallback),
          shardsGrouped: number(diagnostics?.shardsGrouped),
          transfersFromArtifact:
            typeof diagnostics?.transfersFromArtifact === "boolean"
              ? diagnostics.transfersFromArtifact
              : null,
          horizonHours: number(diagnostics?.horizonHours),
          code: typeof diagnostics?.code === "string" ? diagnostics.code : null,
        };
      }
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
      ...(shape === undefined ? {} : { shape }),
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

  /*
   * A stop and a route in each city, discovered before the tail is attached.
   *
   * The final CPU table wants every passenger endpoint, and `/v1/stops/:id` and `/v1/routes/:id`
   * need real identifiers rather than coordinates. Hardcoding them would rot with the next
   * national publish, so they are found the way a passenger finds them — the nearest stops, then
   * the first route on that stop's board — with plain fetches that are deliberately *not*
   * recorded, so the discovery traffic is not in the measurement.
   */
  const targets = new Map<string, { stopId: string | null; routeId: string | null }>();
  for (const city of CITIES) {
    const found: { stopId: string | null; routeId: string | null } = {
      stopId: null,
      routeId: null,
    };
    try {
      const near = await fetch(
        `${WORKER}/v1/nearby?lat=${String(city.stop.lat)}&lon=${String(city.stop.lon)}&radius=800`,
        { signal: AbortSignal.timeout(30_000) },
      );
      const body = (await near.json()) as {
        data?: { results?: Array<{ kind?: string; id?: string }> };
      };
      for (const result of body.data?.results ?? []) {
        if (result.kind !== "stop" || typeof result.id !== "string") continue;
        const board = await fetch(`${WORKER}/v1/stops/${encodeURIComponent(result.id)}`, {
          signal: AbortSignal.timeout(30_000),
        });
        const page = (await board.json()) as {
          data?: { routes?: Array<{ id?: string }>; departures?: unknown[] };
        };
        const routeId = page.data?.routes?.[0]?.id;
        /* A stop no service calls at opens fine and measures nothing, so keep looking. */
        if (typeof routeId === "string" && routeId.length > 0) {
          found.stopId = result.id;
          found.routeId = routeId;
          break;
        }
        if (found.stopId === null) found.stopId = result.id;
      }
    } catch {
      /* A city whose stop could not be found is reported as such rather than guessed at. */
    }
    targets.set(city.name, found);
    console.log(
      `${city.name.padEnd(12)} stop ${found.stopId ?? "(none)"} route ${found.routeId ?? "(none)"}`,
    );
  }

  console.log(`Attaching a tail, then walking ${String(ROUNDS)} round(s)`);
  const tail = startTail();
  /* Long enough for wrangler to negotiate the tail before the first request arrives. */
  await new Promise((resolve) => setTimeout(resolve, 12_000));

  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const city of CITIES) {
      await ask("map", city.name, `/v1/map?bbox=${city.bbox}&zoom=14`);
      for (const journey of city.journeys) {
        await ask("journey", city.name, `/v1/journeys?${journey.query}`, journey.shape);
      }
      await ask(
        "nearby",
        city.name,
        `/v1/nearby?lat=${String(city.stop.lat)}&lon=${String(city.stop.lon)}&radius=600`,
      );
      await ask("search", city.name, `/v1/search?q=${city.search}`);
      const target = targets.get(city.name);
      if (target?.stopId) {
        await ask("stop", city.name, `/v1/stops/${encodeURIComponent(target.stopId)}`);
      }
      if (target?.routeId) {
        await ask("route", city.name, `/v1/routes/${encodeURIComponent(target.routeId)}`);
      }
    }
    for (const sparse of SPARSE) {
      await ask("journey", sparse.name, `/v1/journeys?${sparse.query}`, sparse.shape);
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

  /*
   * Which invocation was which, joined on the URL and the order it was asked in.
   *
   * A tail record carries the request's URL but not its `cf-ray`, and a reading carries the ray
   * but not the CPU — so neither alone can say whether the expensive invocations were the cold
   * ones. Each (endpoint, city) pair is asked for exactly once per round, so for one URL the tail
   * records in timestamp order line up with the readings in request order, and the pairing is
   * sound rather than approximate. A killed request appears in both sequences, so they stay
   * aligned.
   */
  const pathOf = (url: string | undefined): string => {
    if (!url) return "";
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  };
  const tailByPath = new Map<string, TailRecord[]>();
  for (const record of tail.records) {
    const path = pathOf(record.event?.request?.url);
    const list = tailByPath.get(path) ?? [];
    list.push(record);
    tailByPath.set(path, list);
  }
  for (const list of tailByPath.values()) {
    list.sort((a, b) => (a.eventTimestamp ?? 0) - (b.eventTimestamp ?? 0));
  }
  const seenPerPath = new Map<string, number>();
  const paired: Array<{
    endpoint: string;
    cpuMs: number;
    requestsServed: number | null;
    shape: string | null;
    city: string;
    outcome: string | null;
    journey: Reading["journey"] | null;
  }> = [];
  for (const reading of readings) {
    const at = seenPerPath.get(reading.path) ?? 0;
    seenPerPath.set(reading.path, at + 1);
    const record = tailByPath.get(reading.path)?.[at];
    if (!record || typeof record.cpuTime !== "number") continue;
    paired.push({
      endpoint: reading.endpoint,
      cpuMs: record.cpuTime,
      requestsServed: reading.requestsServed ?? null,
      shape: reading.shape ?? null,
      city: reading.city,
      outcome: record.outcome ?? null,
      journey: reading.journey ?? null,
    });
  }
  /*
   * CPU by how many requests the isolate had already served, in buckets.
   *
   * The first version of this split them in two — first request, and everything after — and that
   * was too blunt to answer the question it was built for. Two walks of the same endpoint reported
   * a "warm" median of 15 ms and 27 ms, and the second was a shorter walk against a Worker that
   * had just been deployed, so a larger share of its invocations were second or third in their
   * isolate rather than fiftieth. Lumping the second request in with the fiftieth hides exactly
   * the gradient that explains the difference — and that gradient was the conclusion drawn from
   * the blunt version.
   */
  const BUCKETS: ReadonlyArray<{ label: string; from: number; to: number }> = [
    { label: "first", from: 1, to: 1 },
    { label: "2nd-5th", from: 2, to: 5 },
    { label: "6th-20th", from: 6, to: 20 },
    { label: "21st+", from: 21, to: Number.POSITIVE_INFINITY },
  ];
  const coldWarm = (endpoint: string) => {
    const rows = paired.filter((row) => row.endpoint === endpoint);
    /* A request the platform killed reports no ledger, so its age is unknown rather than cold. */
    const unknown = rows.filter((row) => row.requestsServed === null).map((row) => row.cpuMs);
    const byIsolateAge: Record<
      string,
      { n: number; p50CpuMs: number | null; maxCpuMs: number | null }
    > = {};
    for (const bucket of BUCKETS) {
      const cpu = rows
        .filter(
          (row) =>
            row.requestsServed !== null &&
            row.requestsServed >= bucket.from &&
            row.requestsServed <= bucket.to,
        )
        .map((row) => row.cpuMs);
      byIsolateAge[bucket.label] = {
        n: cpu.length,
        p50CpuMs: percentile(cpu, 50),
        maxCpuMs: cpu.length === 0 ? null : Math.max(...cpu),
      };
    }
    return {
      pairedInvocations: rows.length,
      byIsolateAge,
      noLedger: { n: unknown.length, maxCpuMs: unknown.length === 0 ? null : Math.max(...unknown) },
    };
  };

  /*
   * Journeys by shape, which is what a journey acceptance is actually judged on.
   *
   * An endpoint median mixes a neighbourhood hop with a cross-city trip and a rural pair that
   * widens its horizon, and those are different amounts of timetable — so one journey figure
   * cannot say whether the endpoint fits. This splits them, and carries what each one said about
   * where its timetable came from: a shape measured on the text fallback is not evidence about
   * the published form, however good its milliseconds look.
   */
  const journeyShapes = (() => {
    const shapes = new Map<string, typeof paired>();
    for (const row of paired) {
      if (row.endpoint !== "journey") continue;
      const key = row.shape ?? "(unlabelled)";
      const list = shapes.get(key) ?? [];
      list.push(row);
      shapes.set(key, list);
    }
    return [...shapes]
      .map(([shape, rows]) => {
        const cpu = rows.map((row) => row.cpuMs);
        const answered = rows.filter((row) => (row.journey?.options ?? 0) > 0).length;
        const onBinary = rows.filter((row) => (row.journey?.shardsBinary ?? 0) > 0).length;
        const fellBack = rows.filter((row) => (row.journey?.shardsBinaryFallback ?? 0) > 0).length;
        const grouped = rows.filter((row) => (row.journey?.shardsGrouped ?? 0) > 0).length;
        const fromTiles = rows.filter((row) => row.journey?.transfersFromArtifact === true).length;
        const widened = rows.filter((row) => (row.journey?.horizonHours ?? 0) > 2).length;
        return {
          shape,
          invocations: rows.length,
          p50CpuMs: percentile(cpu, 50),
          p95CpuMs: percentile(cpu, 95),
          maxCpuMs: cpu.length === 0 ? null : Math.max(...cpu),
          exceededCpu: rows.filter((row) => row.outcome === "exceededCpu").length,
          answered,
          /* Which path served it, counted rather than assumed. */
          onBinaryShards: onBinary,
          fellBackToText: fellBack,
          groupingRead: grouped,
          transfersFromTiles: fromTiles,
          widenedToFourHours: widened,
          withinBudget: (percentile(cpu, 95) ?? Number.POSITIVE_INFINITY) <= 10,
        };
      })
      .sort((a, b) => (b.maxCpuMs ?? 0) - (a.maxCpuMs ?? 0));
  })();

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
      byIsolateAge: coldWarm(endpoint),
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

  if (journeyShapes.length > 0) {
    console.log("");
    console.log(
      "journey shape      n   p50 CPU   p95 CPU   max CPU   killed   answered   bytes   grouped   tiles   widened",
    );
    for (const row of journeyShapes) {
      console.log(
        `${row.shape.padEnd(17)} ${String(row.invocations).padStart(2)}   ` +
          `${String(row.p50CpuMs ?? "-").padStart(7)}   ${String(row.p95CpuMs ?? "-").padStart(7)}   ` +
          `${String(row.maxCpuMs ?? "-").padStart(7)}   ${String(row.exceededCpu).padStart(6)}   ` +
          `${String(row.answered).padStart(8)}   ${String(row.onBinaryShards).padStart(5)}   ` +
          `${String(row.groupingRead).padStart(7)}   ${String(row.transfersFromTiles).padStart(5)}   ` +
          `${String(row.widenedToFourHours).padStart(7)}`,
      );
    }
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
    endpoints: ENDPOINTS.length === 0 ? "all" : ENDPOINTS.join(","),
    freeCpuBudgetMs: 10,
    requests: readings.length,
    platformErrors: readings.filter((r) => r.platform).length,
    tailRecords: tail.records.length,
    tailNotes: tail.notes.slice(0, 8),
    byEndpoint: table,
    /* The journey endpoint split by the shape of the question, which is the acceptance table. */
    journeyShapes,
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
