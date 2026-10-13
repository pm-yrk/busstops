/**
 * What a real stop board actually pays to resolve its services, measured on the deployment.
 *
 * The bucketed family was built to answer one specific cost: a board shows a handful of
 * departures, each naming a service id, and resolving those names used to fetch and UTF-8 decode
 * the whole `network/services` object — about 4.7 MiB and 13,000 records — inside a 10 ms CPU
 * budget. The claim that buckets fix that is only worth making with both numbers measured on the
 * same deployment, so this asks the Worker what it did rather than reasoning about it.
 *
 * The Worker reports, per board, either
 *   { servicesPath: "buckets", servicesWanted, servicesFound, serviceBucketsRead, serviceBucketChars }
 * or, where the ids spread too widely or no bucket is published,
 *   { servicesPath: "whole_object", servicesWanted, servicesObjectChars }
 * which is the old path, still in place, and therefore still measurable. A run that produces both
 * shapes gives the comparison directly; the whole-object figure is also what the proof step reads
 * out of R2 as `sourceBytes`.
 *
 * Real stops, found by asking what is near four city centres rather than by hard-coded ids, so
 * this keeps working across rebuilds. Several boards, several passes, reported as a distribution:
 * one board on one isolate is not evidence about a deployment.
 *
 *   node scripts/measure-board-services.mjs <worker-url> [--passes 4] [--pace 500]
 *
 * It asserts nothing and cannot fail a run. The passenger probe is the gate.
 */

import { annotate } from "./annotate.mjs";

const [workerArg, ...rest] = process.argv.slice(2);
if (!workerArg) {
  console.error("Usage: measure-board-services.mjs <worker url> [--passes N] [--pace MS]");
  process.exit(1);
}
const worker = workerArg.replace(/\/+$/, "");
const flag = (name, fallback) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 && rest[at + 1] !== undefined ? Number(rest[at + 1]) : fallback;
};
const PASSES = flag("passes", 4);
const PACE_MS = flag("pace", 500);

/** Four places with dense boards, spread across the country and across operators. */
const PLACES = [
  { name: "Manchester", lat: 53.4808, lon: -2.2426 },
  { name: "Leeds", lat: 53.79648, lon: -1.54785 },
  { name: "Bristol", lat: 51.4545, lon: -2.5879 },
  { name: "Norwich", lat: 52.6309, lon: 1.2974 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(path) {
  const began = Date.now();
  try {
    const response = await fetch(`${worker}${path}`, { signal: AbortSignal.timeout(25_000) });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Cloudflare's 1102 page is HTML. Counted, not parsed.
    }
    return { ok: response.ok, status: response.status, ms: Date.now() - began, body, text };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - began,
      body: null,
      text: String(error?.message ?? error),
    };
  }
}

/** One stop per place, named, so a reported figure can be checked by hand afterwards. */
async function findStops() {
  const stops = [];
  for (const place of PLACES) {
    const near = await get(`/v1/nearby?lat=${place.lat}&lon=${place.lon}&radius=600`);
    const results = Array.isArray(near.body?.data?.results) ? near.body.data.results : [];
    const stop = results.find((result) => result.kind === "stop" && typeof result.id === "string");
    if (stop) {
      stops.push({ place: place.name, id: stop.id, title: stop.title ?? "(unnamed)" });
    } else {
      console.log(`${place.name}: nothing near it answered, HTTP ${near.status}`);
    }
    await sleep(PACE_MS);
  }
  return stops;
}

function summarise(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
}

async function main() {
  const report = { worker, passes: PASSES, paceMs: PACE_MS };
  const stops = await findStops();
  report.stops = stops.map((stop) => `${stop.place}: ${stop.title} (${stop.id})`);
  if (stops.length === 0) {
    report.outcome = "no_stops_found";
    annotate("notice", "board service reads", JSON.stringify(report, null, 1));
    return;
  }

  const boards = new Map(stops.map((stop) => [stop.id, []]));

  for (let pass = 0; pass < PASSES; pass += 1) {
    for (const stop of stops) {
      const board = await get(`/v1/stops/${encodeURIComponent(stop.id)}`);
      const artifact = board.body?.meta?.diagnostics?.artifact ?? null;
      boards.get(stop.id).push({
        ok: board.ok,
        status: board.status,
        ms: board.ms,
        departures: Array.isArray(board.body?.data?.departures)
          ? board.body.data.departures.length
          : null,
        routes: Array.isArray(board.body?.data?.routes) ? board.body.data.routes.length : null,
        artifact,
      });
      if (PACE_MS > 0) await sleep(PACE_MS);
    }
  }

  const rows = {};
  const lines = [];
  /* Totals across every board, which is what answers "did the hot path get cheaper". */
  const bucketChars = [];
  const wholeObjectChars = [];

  for (const stop of stops) {
    const samples = boards.get(stop.id);
    const ok = samples.filter((sample) => sample.ok);
    const viaBuckets = ok.filter((sample) => sample.artifact?.servicesPath === "buckets");
    const viaWhole = ok.filter((sample) => sample.artifact?.servicesPath === "whole_object");
    const noRead = ok.filter((sample) => sample.artifact?.servicesPath === undefined);

    for (const sample of viaBuckets) bucketChars.push(Number(sample.artifact.serviceBucketChars));
    for (const sample of viaWhole)
      wholeObjectChars.push(Number(sample.artifact.servicesObjectChars));

    const row = {
      stop: `${stop.title} (${stop.place})`,
      id: stop.id,
      ok: ok.length,
      samples: samples.length,
      statuses: [...new Set(samples.filter((s) => !s.ok).map((s) => s.status))],
      departures: summarise(ok.map((s) => s.departures).filter((n) => typeof n === "number")),
      msMedian: summarise(ok.map((s) => s.ms))?.median ?? null,
      viaBuckets: viaBuckets.length,
      viaWholeObject: viaWhole.length,
      /*
       * A board whose departures are all already resident reads nothing at all, which is neither
       * path and must not be averaged in as a cheap bucket read.
       */
      noServiceRead: noRead.length,
      servicesWanted: summarise(
        ok.map((s) => Number(s.artifact?.servicesWanted)).filter((n) => Number.isFinite(n)),
      ),
      servicesFound: summarise(
        ok.map((s) => Number(s.artifact?.servicesFound)).filter((n) => Number.isFinite(n)),
      ),
      bucketsRead: summarise(
        viaBuckets.map((s) => Number(s.artifact.serviceBucketsRead)).filter(Number.isFinite),
      ),
      bucketChars: summarise(
        viaBuckets.map((s) => Number(s.artifact.serviceBucketChars)).filter(Number.isFinite),
      ),
      wholeObjectChars: summarise(
        viaWhole.map((s) => Number(s.artifact.servicesObjectChars)).filter(Number.isFinite),
      ),
    };
    rows[stop.id] = row;

    const kib = (n) => (n === null ? "?" : `${(n / 1024).toFixed(1)} KiB`);
    lines.push(
      `${row.stop}: ${row.ok}/${row.samples} ok, ${row.viaBuckets} via buckets / ` +
        `${row.viaWholeObject} via whole object / ${row.noServiceRead} already resident; ` +
        `wanted ${row.servicesWanted?.median ?? "?"} service(s), read ` +
        `${row.bucketsRead?.median ?? "?"} bucket(s) = ${kib(row.bucketChars?.median ?? null)} ` +
        `(whole object ${kib(row.wholeObjectChars?.median ?? null)})`,
    );
  }

  report.boards = rows;
  report.bucketCharsAcrossBoards = summarise(bucketChars.filter(Number.isFinite));
  report.wholeObjectCharsAcrossBoards = summarise(wholeObjectChars.filter(Number.isFinite));
  report.outcome = "measured";

  for (const line of lines) console.log(line);
  annotate("notice", `board service reads (${PASSES} passes)`, JSON.stringify(report, null, 1));
}

await main();
