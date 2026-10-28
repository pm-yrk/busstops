#!/usr/bin/env node
/**
 * What a published trip shard costs to open, as text and as bytes, on real data.
 *
 * The stage attribution says where a journey request's CPU goes (scripts/measure-serving-cpu.ts,
 * Manchester corridor): walking the shards 0.47 ms, parsing every trip row 24.26 ms, building the
 * graph 10.29 ms, searching it 3.24 ms. The search is the cheapest part. What does not fit in ten
 * milliseconds is `JSON.parse` over eight megabytes, and filtering before the parse — which both
 * read paths now do — only removes the rows a plan does not want. The rows it does want still have
 * to become objects.
 *
 * So this measures the alternative before anything is built on it: the same shard encoded
 * columnar, opened through typed-array views, with the horizon test and the call times read
 * straight out of the bytes. Three numbers decide whether publishing that form is worth it:
 *
 *   1. bytes — binary against text, which is the storage question (the bucket has about a
 *      gigabyte of headroom, so a form that is *larger* is not available at any speed).
 *   2. open — the request-side cost of getting from a body to usable times, both ways.
 *   3. encode — the publish-side cost, which is a daily GitHub job's problem and nobody's budget.
 *
 * It writes nothing and deploys nothing.
 *
 *   npx tsx scripts/measure-binary-trip-shard.ts [--json binary-trip-shard.json]
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  objectKeyFor,
  r2StoreFromEnv,
} from "@busstops/pipeline-core";
import {
  PatternTripShard,
  SHARDED,
  encodePatternTripShard,
  patternTripsDataset,
  tripTilesForBoundingBox,
  tripWindowsFor,
  type NetworkIndexRecord,
  type PatternTripRow,
} from "@busstops/pipeline-static-network";
import { tripWindowInLine } from "../apps/worker/src/journey-service.js";

const JSON_OUT = (() => {
  const index = process.argv.indexOf("--json");
  return index === -1 ? undefined : process.argv[index + 1];
})();

/** The Manchester corridor every measured failure came from. */
const FROM = { lat: 53.4794, lon: -2.2453 };
const TO = { lat: 53.5044, lon: -2.2453 };

function timed<T>(run: () => T): { ms: number; value: T } {
  const began = process.hrtime.bigint();
  const value = run();
  return { ms: Number(process.hrtime.bigint() - began) / 1e6, value };
}

/**
 * The median of interleaved runs, because this is a comparison.
 *
 * Measuring two forms in sequence measures the second one's luck with a warm heap: the serving-CPU
 * script learned that the hard way, reporting the form that reads a third of the bytes as the
 * slower of the two. Both forms are warmed, then run alternately, and each takes its own median.
 */
function compare<A, B>(
  a: () => A,
  b: () => B,
  runs = 5,
): { aMs: number; bMs: number; aValue: A; bValue: B } {
  let aValue = a();
  let bValue = b();
  const aTimes: number[] = [];
  const bTimes: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const one = timed(a);
    const two = timed(b);
    aTimes.push(one.ms);
    bTimes.push(two.ms);
    aValue = one.value;
    bValue = two.value;
  }
  const median = (times: number[]): number =>
    Number(times.sort((x, y) => x - y)[Math.floor(times.length / 2)]!.toFixed(2));
  return { aMs: median(aTimes), bMs: median(bTimes), aValue, bValue };
}

async function main(): Promise<number> {
  const resolved = r2StoreFromEnv(process.env);
  if (!resolved.ok) {
    annotateReport("binary trip shard", { outcome: "not_configured", missing: resolved.missing });
    return 2;
  }
  const store = resolved.store;
  const index = (await new ArtifactStore(store).readCurrent<NetworkIndexRecord>(SHARDED.index))
    .records[0];
  if (!index) {
    annotateReport("binary trip shard", { outcome: "failed", reason: "no index record" });
    return 1;
  }

  const corridor = {
    west: Math.min(FROM.lon, TO.lon) - 0.1,
    east: Math.max(FROM.lon, TO.lon) + 0.1,
    south: Math.min(FROM.lat, TO.lat) - 0.1,
    north: Math.max(FROM.lat, TO.lat) + 0.1,
  };
  const serviceDate = new Date().toISOString().slice(0, 10);
  const midnight = Date.parse(`${serviceDate}T00:00:00Z`) / 1000;
  const from = midnight + 9 * 3600;
  const to = from + 4 * 3600;
  const windows = tripWindowsFor(from, to, serviceDate);

  const bodies: { key: string; text: string }[] = [];
  for (const tile of tripTilesForBoundingBox(corridor).slice(0, 4)) {
    for (const window of windows) {
      const key = objectKeyFor(patternTripsDataset(serviceDate, tile, window), index.version);
      const text = await store.get(key);
      if (text !== null && text.length > 0) bodies.push({ key, text });
    }
  }
  if (bodies.length === 0) {
    annotateReport("binary trip shard", {
      outcome: "failed",
      reason: "no published trip shards for this corridor and service date",
      serviceDate,
    });
    return 1;
  }

  /* The rows, once, as the publish side has them. */
  const rows: PatternTripRow[] = [];
  for (const body of bodies) {
    for (const line of body.text.split("\n")) {
      if (line.length > 0) rows.push(JSON.parse(line) as PatternTripRow);
    }
  }

  const encoded = timed(() => encodePatternTripShard(rows));
  const textBytes = bodies.reduce((total, body) => total + body.text.length, 0);
  const binaryBytes = encoded.value.bytes.byteLength;

  /*
   * The request-side comparison, with both forms doing the same job: keep the trips inside the
   * plan's horizon and read every call time of the ones kept. The JSON side tests the window off
   * the raw text first, exactly as the endpoint does, so this is the current best text path and
   * not a straw man.
   */
  const texts = bodies.map((body) => body.text);
  const bytes = encoded.value.bytes;

  const fromText = (): { trips: number; calls: number; sum: number } => {
    let trips = 0;
    let calls = 0;
    let sum = 0;
    for (const text of texts) {
      for (let start = 0; start < text.length;) {
        const newline = text.indexOf("\n", start);
        const end = newline < 0 ? text.length : newline;
        if (end > start) {
          const line = text.slice(start, end);
          const window = tripWindowInLine(line);
          if (window === null || (window.last >= from && window.first <= to)) {
            const row = JSON.parse(line) as PatternTripRow;
            trips += 1;
            calls += row.t.length;
            for (const time of row.t) sum += time;
          }
        }
        if (newline < 0) break;
        start = newline + 1;
      }
    }
    return { trips, calls, sum };
  };

  const fromBytes = (): { trips: number; calls: number; sum: number } => {
    const shard = new PatternTripShard(bytes);
    let trips = 0;
    let calls = 0;
    let sum = 0;
    for (let trip = 0; trip < shard.tripCount; trip += 1) {
      if (shard.lastDeparture(trip) < from || shard.firstDeparture(trip) > to) continue;
      trips += 1;
      const inTrip = shard.callsIn(trip);
      calls += inTrip;
      for (let call = 0; call < inTrip; call += 1) sum += shard.departure(trip, call);
    }
    return { trips, calls, sum };
  };

  const open = compare(fromText, fromBytes);

  const report = {
    outcome: "measured",
    version: index.version,
    serviceDate,
    shards: bodies.length,
    note:
      "A GitHub runner's CPU is not Cloudflare's. What transfers is the ratio between the two " +
      "forms and the order of magnitude against the 10 ms a Workers Free invocation is allowed.",
    freeCpuBudgetMs: 10,
    bytes: {
      text: textBytes,
      binary: binaryBytes,
      ratio: Number((binaryBytes / textBytes).toFixed(3)),
    },
    openMs: {
      text: open.aMs,
      binary: open.bMs,
      speedup: open.bMs === 0 ? null : Number((open.aMs / open.bMs).toFixed(1)),
    },
    /* Both forms have to answer the same question, or the milliseconds mean nothing. */
    agrees:
      open.aValue.trips === open.bValue.trips &&
      open.aValue.calls === open.bValue.calls &&
      open.aValue.sum === open.bValue.sum,
    selected: open.bValue,
    encodeMs: Number(encoded.ms.toFixed(2)),
    stats: encoded.value.stats,
  };

  console.log(JSON.stringify(report, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("binary trip shard", report);
  return report.agrees ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    annotateReport("binary trip shard", { outcome: "failed", error: String(error) });
    process.exitCode = 1;
  });
