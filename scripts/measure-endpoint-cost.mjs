/**
 * One endpoint, asked many times, reported as a distribution.
 *
 * The verification harness counts how many of twenty-six checks survived, and that total has been
 * shown to swing 9 → 11 → 12 across runs of the *same commit*. It is useful for finding which
 * endpoint is unhappy and useless for deciding whether a change helped, because a single run's
 * total is one draw from a wide distribution. Several of this project's earlier conclusions leaned
 * on exactly that and were wrong.
 *
 * So this measures one thing properly: the same request, repeated, against a fixed deployment,
 * reporting the success rate and the cost the Worker itself reports rather than a pass count. It
 * makes no assertions — it is an instrument, not a gate. The passenger probe remains the gate.
 *
 *   node scripts/measure-endpoint-cost.mjs <worker-url> [--samples 30] [--pace 400]
 */

import { annotate } from "./annotate.mjs";

const [workerArg, ...rest] = process.argv.slice(2);
if (!workerArg) {
  console.error("Usage: measure-endpoint-cost.mjs <worker url> [--samples N] [--pace MS]");
  process.exit(1);
}
const worker = workerArg.replace(/\/+$/, "");
const flag = (name, fallback) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 && rest[at + 1] !== undefined ? Number(rest[at + 1]) : fallback;
};
const SAMPLES = flag("samples", 30);
const PACE_MS = flag("pace", 400);

/**
 * A stop board in a dense city, which is the path the service buckets exist for, plus the three
 * other heavy endpoints that have been failing. One request each per round, paced, so the shape
 * is a person browsing rather than a burst.
 */
const BBOX = "-2.26,53.46,-2.21,53.50";
const TARGETS = [
  { name: "map (Manchester)", path: `/v1/map?bbox=${encodeURIComponent(BBOX)}&zoom=15` },
  { name: "nearby (Leeds)", path: "/v1/nearby?lat=53.79648&lon=-1.54785&radius=500" },
  { name: "search (Leeds)", path: `/v1/search?q=${encodeURIComponent("Leeds")}` },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cloudflare's own error page, which is HTML and carries no CORS header. */
function isPlatformPage(status, text) {
  return status >= 500 && /<html|error 1102|exceeded resource limits/i.test(text ?? "");
}

async function sample(path) {
  const began = Date.now();
  try {
    const response = await fetch(`${worker}${path}`, { signal: AbortSignal.timeout(25_000) });
    const text = await response.text();
    const ms = Date.now() - began;
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Cloudflare's page is HTML; that is the thing being counted, not an error here.
    }
    return {
      ok: response.ok,
      ms,
      platform: isPlatformPage(response.status, text),
      status: response.status,
      diagnostics: body?.meta?.diagnostics ?? body?.data?.diagnostics ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - began,
      platform: false,
      status: 0,
      timedOut: /abort|timeout/i.test(String(error?.message ?? error)),
      diagnostics: null,
    };
  }
}

function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function main() {
  const results = new Map(TARGETS.map((target) => [target.name, []]));

  for (let round = 0; round < SAMPLES; round += 1) {
    for (const target of TARGETS) {
      results.get(target.name).push(await sample(target.path));
      if (PACE_MS > 0) await sleep(PACE_MS);
    }
  }

  const report = { worker, samples: SAMPLES, paceMs: PACE_MS, endpoints: {} };
  const lines = [];

  for (const [name, samples] of results) {
    const ok = samples.filter((s) => s.ok);
    const platform = samples.filter((s) => s.platform).length;
    const timeouts = samples.filter((s) => s.timedOut).length;
    const durations = ok.map((s) => s.ms);
    /*
     * The Worker's own account of what the successful requests cost. Averaged over the successes
     * only: a killed request reports nothing, so including it would silently mix "cheap" with
     * "never finished".
     */
    const decoded = ok
      .map((s) => Number(s.diagnostics?.charsDecoded ?? 0))
      .filter((n) => Number.isFinite(n) && n > 0);
    const objects = ok
      .map((s) => Number(s.diagnostics?.objectsRead ?? 0))
      .filter((n) => Number.isFinite(n));

    const row = {
      samples: samples.length,
      ok: ok.length,
      successRate: Number((ok.length / samples.length).toFixed(3)),
      platformErrors: platform,
      timeouts,
      medianMs: quantile(durations, 0.5),
      p90Ms: quantile(durations, 0.9),
      meanCharsDecoded:
        decoded.length > 0 ? Math.round(decoded.reduce((a, b) => a + b, 0) / decoded.length) : null,
      meanObjectsRead:
        objects.length > 0
          ? Number((objects.reduce((a, b) => a + b, 0) / objects.length).toFixed(1))
          : null,
    };
    report.endpoints[name] = row;
    lines.push(
      `${name}: ${row.ok}/${row.samples} ok (${(row.successRate * 100).toFixed(0)}%), ` +
        `${row.platformErrors} platform error(s), median ${row.medianMs}ms p90 ${row.p90Ms}ms, ` +
        `${row.meanCharsDecoded ?? "?"} chars decoded over ${row.meanObjectsRead ?? "?"} object(s)`,
    );
  }

  report.outcome = "measured";
  for (const line of lines) console.log(line);
  annotate(
    "notice",
    `endpoint cost (${SAMPLES} samples, ${PACE_MS}ms apart)`,
    JSON.stringify(report, null, 1),
  );
}

await main();
