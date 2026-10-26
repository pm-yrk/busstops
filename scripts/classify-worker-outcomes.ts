#!/usr/bin/env node
/**
 * Asks Cloudflare what a 1102 actually was: out of memory, or out of CPU.
 *
 * Error 1102 is "Worker exceeded resource limits" and covers both. From outside they are
 * identical — the same status, the same HTML page, no header to tell them apart — and four
 * diagnoses of this project's failures were made from request behaviour alone before anybody
 * asked the platform. Cloudflare does distinguish them. Two places carry the distinction:
 *
 *   - **`wrangler tail`**, which streams one record per invocation with an `outcome` field whose
 *     values include `exceededMemory`, `exceededCpu`, `canceled`, `exception` and `ok`. This is
 *     the one that can classify a *single named invocation*, which is what the question asks for,
 *     and it runs under the same Workers permission the deploy already uses.
 *   - **`workersInvocationsAdaptive`** in the GraphQL analytics API, which aggregates the same
 *     `outcome` dimension and adds CPU and wall-time quantiles. Account Analytics is a separate
 *     token scope, so it is asked second, as a cross-check, and its absence is reported rather
 *     than worked around.
 *
 * Retention is why this provokes rather than looks back: Workers analytics keeps invocations for
 * days, not weeks, and tail only shows what happens while it is attached. So a short burst of the
 * heaviest passenger reads runs against the deployed Worker with the tail open, and the window it
 * creates is the window that gets classified.
 *
 * If neither source answers, that is the finding, and it is reported as "unavailable" with the
 * reason. "We could not retrieve the invocation outcome" is a real result; inventing either answer
 * from request behaviour is what this script exists to stop.
 *
 *   npx tsx scripts/classify-worker-outcomes.ts --worker https://... [--json out.json]
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { annotate } from "./annotate.mjs";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

const WORKER = (arg("worker") ?? process.env.WORKER_URL ?? "").replace(/\/+$/, "");
const SCRIPT_NAME = arg("script") ?? process.env.WORKER_NAME ?? "busstops-api-preview";
const WORKER_ENV = arg("env") ?? process.env.WORKER_ENV ?? "preview";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const JSON_OUT = arg("json");

/** Enough concurrent heavy reads to put an isolate under real pressure, for long enough to log. */
const BURSTS = Number(arg("bursts") ?? "14");
const CONCURRENCY = Number(arg("concurrency") ?? "6");

interface Attempt {
  path: string;
  label: string;
  status: number | null;
  platform: boolean;
  cfRay: string | null;
  ms: number;
  served: number | null;
  chars: number | null;
  subrequests: number | null;
  note?: string;
}

const attempts: Attempt[] = [];

/**
 * The heaviest passenger reads, in the cities where they are heaviest.
 *
 * Deliberately the same shapes the acceptance walk uses, so a failure provoked here is the same
 * failure a passenger meets rather than a synthetic one.
 */
const HEAVY: Array<[string, string]> = [
  ["/v1/map?bbox=-2.32000,53.42000,-2.16000,53.52000&zoom=15", "map (Manchester)"],
  ["/v1/map?bbox=-1.62000,53.75000,-1.46000,53.84000&zoom=15", "map (Leeds)"],
  ["/v1/map?bbox=-1.96000,52.42000,-1.80000,52.52000&zoom=15", "map (Birmingham)"],
  ["/v1/journeys?fromLat=53.47940&fromLon=-2.24530&toLat=53.50440&toLon=-2.24530", "journey"],
  ["/v1/search?q=Birmingham", "search"],
  ["/v1/nearby?lat=53.47940&lon=-2.24530&radius=600", "nearby"],
];

async function ask(path: string, label: string): Promise<void> {
  const began = Date.now();
  try {
    const response = await fetch(`${WORKER}${path}`, { signal: AbortSignal.timeout(45_000) });
    const text = await response.text();
    const cfRay = response.headers.get("cf-ray");
    let served: number | null = null;
    let chars: number | null = null;
    let subrequests: number | null = null;
    let platform = false;
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const meta = body.meta as Record<string, unknown> | undefined;
      const diagnostics = meta?.diagnostics as Record<string, unknown> | undefined;
      const residency = diagnostics?.residency as Record<string, unknown> | undefined;
      served = typeof residency?.requestsServed === "number" ? residency.requestsServed : null;
      chars = typeof diagnostics?.charsDecoded === "number" ? diagnostics.charsDecoded : null;
      subrequests = typeof diagnostics?.subrequests === "number" ? diagnostics.subrequests : null;
    } catch {
      /* Cloudflare's own error page is HTML, which is the signature being hunted. */
      platform = /error 1102|exceeded resource limits|<html/i.test(text);
    }
    attempts.push({
      path,
      label,
      status: response.status,
      platform,
      cfRay,
      ms: Date.now() - began,
      served,
      chars,
      subrequests,
    });
  } catch (error) {
    attempts.push({
      path,
      label,
      status: null,
      platform: true,
      cfRay: null,
      ms: Date.now() - began,
      served: null,
      chars: null,
      subrequests: null,
      note: `the request itself failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** Heavy reads, several at a time, repeatedly: the shape that has produced 1102 before. */
async function provoke(): Promise<{ startedAt: string; endedAt: string }> {
  const startedAt = new Date().toISOString();
  for (let round = 0; round < BURSTS; round += 1) {
    const batch: Array<Promise<void>> = [];
    for (let i = 0; i < CONCURRENCY; i += 1) {
      const [path, label] = HEAVY[(round * CONCURRENCY + i) % HEAVY.length]!;
      batch.push(ask(path, label));
    }
    await Promise.all(batch);
  }
  return { startedAt, endedAt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ wrangler tail */

interface TailEvent {
  outcome?: string;
  scriptName?: string | null;
  eventTimestamp?: number;
  cpuTime?: number;
  wallTime?: number;
  exceptions?: Array<{ name?: string; message?: string }>;
  event?: {
    request?: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      cf?: Record<string, unknown>;
    };
    response?: { status?: number };
  };
}

interface Tail {
  events: TailEvent[];
  lines: number;
  stderr: string[];
  stop: () => Promise<void>;
}

/**
 * A live tail on the deployed Worker, attached before the burst starts.
 *
 * `--format json` writes one record per invocation to stdout; wrangler's own banner goes to
 * stderr, which is kept because "you do not have permission to tail" belongs in the report.
 */
function startTail(): Tail {
  const child: ChildProcessWithoutNullStreams = spawn(
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
    { stdio: ["ignore", "pipe", "pipe"], env: process.env },
  ) as ChildProcessWithoutNullStreams;

  const tail: Tail = {
    events: [],
    lines: 0,
    stderr: [],
    stop: async () => {
      child.kill("SIGINT");
      await new Promise<void>((resolve) => {
        const give = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.on("exit", () => {
          clearTimeout(give);
          resolve();
        });
      });
    },
  };

  createInterface({ input: child.stdout }).on("line", (line) => {
    tail.lines += 1;
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      tail.stderr.push(`stdout: ${trimmed.slice(0, 200)}`);
      return;
    }
    try {
      tail.events.push(JSON.parse(trimmed) as TailEvent);
    } catch {
      tail.stderr.push(`unparseable tail line: ${trimmed.slice(0, 200)}`);
    }
  });
  createInterface({ input: child.stderr }).on("line", (line) => {
    const trimmed = line.trim();
    /* wrangler's proxy warning says nothing about whether the tail attached. */
    if (trimmed.length > 0 && !/Proxy environment variables/i.test(trimmed)) {
      tail.stderr.push(trimmed.slice(0, 300));
    }
  });

  return tail;
}

/* ------------------------------------------------------------------ GraphQL cross-check */

interface GraphQlResult {
  errors?: Array<{ message?: string }>;
  data?: {
    viewer?: {
      accounts?: Array<{
        workersInvocationsAdaptive?: Array<{
          sum?: { requests?: number; errors?: number };
          dimensions?: { outcome?: string; scriptName?: string };
          quantiles?: { cpuTimeP99?: number; wallTimeP99?: number };
        }>;
      }>;
    };
  };
}

type Rows = NonNullable<
  NonNullable<NonNullable<GraphQlResult["data"]>["viewer"]>["accounts"]
>[number]["workersInvocationsAdaptive"];

/**
 * The invocation outcomes for one script and one window.
 *
 * `outcome` is the field that separates the two meanings of 1102. `cpuTimeP99` is asked for in the
 * same breath because a CPU verdict with a P99 well inside the limit would be a contradiction
 * worth seeing rather than a number to quote.
 */
async function outcomes(
  startedAt: string,
  endedAt: string,
): Promise<{ ok: true; rows: Rows } | { ok: false; reason: string }> {
  const query = `
    query Outcomes($accountTag: string!, $start: Time!, $end: Time!, $script: string!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            limit: 100
            filter: { datetime_geq: $start, datetime_leq: $end, scriptName: $script }
          ) {
            sum { requests errors }
            dimensions { outcome scriptName }
            quantiles { cpuTimeP99 wallTimeP99 }
          }
        }
      }
    }`;

  let response: Response;
  try {
    response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { accountTag: ACCOUNT, start: startedAt, end: endedAt, script: SCRIPT_NAME },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ok: false, reason: `the analytics request failed: ${String(error)}` };
  }

  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      reason: `HTTP ${String(response.status)} from the analytics API: ${text.slice(0, 300)}`,
    };
  }
  let parsed: GraphQlResult;
  try {
    parsed = JSON.parse(text) as GraphQlResult;
  } catch {
    return { ok: false, reason: `the analytics API did not return JSON: ${text.slice(0, 200)}` };
  }
  if (parsed.errors && parsed.errors.length > 0) {
    /*
     * Almost always a permission: the deploy token carries Workers Scripts, R2 and Pages, and
     * Account Analytics is a separate grant. Reported rather than retried, because no number of
     * retries adds a scope.
     */
    return {
      ok: false,
      reason: `the analytics API refused the query: ${parsed.errors
        .map((e) => e.message ?? "(no message)")
        .join("; ")}`,
    };
  }
  return { ok: true, rows: parsed.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [] };
}

/* ------------------------------------------------------------------ */

function endpointOf(event: TailEvent): string {
  const url = event.event?.request?.url;
  if (url === undefined) return "(no request)";
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search.slice(0, 60)}`;
  } catch {
    return url.slice(0, 80);
  }
}

async function main(): Promise<number> {
  if (!WORKER) {
    console.error("Usage: classify-worker-outcomes.ts --worker <url>");
    return 2;
  }

  console.log(`Attaching a tail to ${SCRIPT_NAME} (${WORKER_ENV})`);
  const tail = startTail();
  /* Long enough for wrangler to negotiate the tail before the first request arrives. */
  await new Promise((resolve) => setTimeout(resolve, 12_000));

  console.log(`Provoking the deployed Worker: ${WORKER}`);
  const probeWindow = await provoke();

  /* Tail delivery lags the response the client already has. */
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  await tail.stop();

  const platformFailures = attempts.filter((a) => a.platform);
  const servedMax = Math.max(0, ...attempts.map((a) => a.served ?? 0));

  const byOutcome = new Map<string, number>();
  for (const event of tail.events) {
    const outcome = event.outcome ?? "(none)";
    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
  }
  const notOk = tail.events.filter((event) => (event.outcome ?? "ok") !== "ok");

  console.log(
    `${String(attempts.length)} request(s), ${String(platformFailures.length)} answered by the ` +
      `platform; isolate served up to ${String(servedMax)}.`,
  );
  console.log(
    `tail: ${String(tail.events.length)} invocation record(s), ` +
      `${[...byOutcome].map(([k, v]) => `${k}=${String(v)}`).join(" ") || "none"}`,
  );
  for (const failure of platformFailures.slice(0, 8)) {
    console.log(
      `  FAIL ${failure.label} status=${String(failure.status)} ms=${String(failure.ms)} ` +
        `cf-ray=${failure.cfRay ?? "(none)"}`,
    );
  }

  const report: Record<string, unknown> = {
    worker: WORKER,
    script: SCRIPT_NAME,
    window: probeWindow,
    requests: attempts.length,
    platformFailures: platformFailures.length,
    isolateServedMax: servedMax,
    failures: platformFailures.slice(0, 10).map((a) => ({
      endpoint: a.label,
      status: a.status,
      cfRay: a.cfRay,
      ms: a.ms,
      note: a.note,
    })),
    heaviestSuccess: attempts
      .filter((a) => !a.platform)
      .sort((a, b) => (b.chars ?? 0) - (a.chars ?? 0))
      .slice(0, 3)
      .map((a) => ({
        endpoint: a.label,
        chars: a.chars,
        served: a.served,
        subrequests: a.subrequests,
      })),
    tail: {
      records: tail.events.length,
      byOutcome: Object.fromEntries(byOutcome),
      /* The named invocations. This is the part of the report the question actually asks for. */
      notOk: notOk.slice(0, 12).map((event) => ({
        outcome: event.outcome,
        endpoint: endpointOf(event),
        status: event.event?.response?.status ?? null,
        cfRay: event.event?.request?.headers?.["cf-ray"] ?? null,
        at: event.eventTimestamp ? new Date(event.eventTimestamp).toISOString() : null,
        cpuTimeMs: event.cpuTime ?? null,
        wallTimeMs: event.wallTime ?? null,
        exception: event.exceptions?.[0]?.message ?? null,
      })),
      diagnostics: tail.stderr.slice(0, 12),
    },
  };

  if (tail.events.length === 0) {
    report.tailClassification = "unavailable";
    report.tailReason =
      "wrangler tail delivered no invocation records; see tail.diagnostics for what it said";
  } else if (notOk.length > 0) {
    report.tailClassification = "retrieved";
  } else {
    report.tailClassification = "all-ok";
    report.tailReason = "every invocation in the window reported outcome=ok";
  }

  if (!ACCOUNT || !TOKEN) {
    report.classification = "unavailable";
    report.reason = "no Cloudflare account id or API token in the environment";
  } else {
    /*
     * Analytics lags ingestion, so this waits rather than concluding from an empty answer — an
     * empty result and a refused query mean very different things and must not read the same.
     */
    let attemptsLeft = 6;
    while (attemptsLeft > 0) {
      const last = await outcomes(probeWindow.startedAt, new Date().toISOString());
      if (last.ok) {
        const rows = last.rows ?? [];
        if (rows.length > 0) {
          report.classification = "retrieved";
          report.outcomes = rows.map((row) => ({
            outcome: row.dimensions?.outcome,
            requests: row.sum?.requests,
            errors: row.sum?.errors,
            cpuTimeP99: row.quantiles?.cpuTimeP99,
            wallTimeP99: row.quantiles?.wallTimeP99,
          }));
          break;
        }
        report.classification = "empty";
        report.reason =
          "the analytics API answered with no invocations for this window; it may still be " +
          "ingesting, or the script name may not match";
      } else {
        report.classification = "unavailable";
        report.reason = last.reason;
        /* A refusal is a scope, not a delay. Retrying it would only make the log longer. */
        if (/refused the query|HTTP 40/.test(last.reason)) break;
      }
      attemptsLeft -= 1;
      if (attemptsLeft > 0) await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }

  console.log("");
  console.log(`tail classification: ${String(report.tailClassification)}`);
  console.log(`analytics classification: ${String(report.classification)}`);
  if (report.tailReason) console.log(`tail reason: ${String(report.tailReason)}`);
  if (report.reason) console.log(`analytics reason: ${String(report.reason)}`);
  console.log(JSON.stringify(report.tail, null, 1));
  if (report.outcomes) console.log(JSON.stringify(report.outcomes, null, 1));

  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotate("notice", "1102 classification", JSON.stringify(report, null, 1));
  /*
   * Zero whatever happened. "We could not retrieve the invocation outcome" is a finding this task
   * explicitly asks for, and a red step would bury it next to the real failures.
   */
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Classifying the Worker's outcomes failed:", error);
    process.exitCode = 1;
  });
