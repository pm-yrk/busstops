#!/usr/bin/env node
/**
 * Where a passenger request's CPU actually goes, stage by stage, on real published data.
 *
 * Cloudflare's tail says what kills these requests and the limit it kills them at: `exceededCpu`,
 * ten milliseconds, with the surviving invocations spending between seventy-four and 1,198 of
 * them. What it does not say is *which part* of a request spends them, and a Worker cannot measure
 * that from inside — `Date.now()` in Workers advances only across I/O, so every one of these
 * stages has always reported zero milliseconds while costing a hundred times the budget. That is
 * most of why five diagnoses in a row looked at bytes instead of compute.
 *
 * So the stages are timed here, in Node, against the objects the live artifact actually holds and
 * the feed the live upstream actually serves. A GitHub runner's CPU is not Cloudflare's and this
 * does not pretend otherwise: what it establishes is the **ratio** between stages and the rough
 * order of magnitude, which is what decides where a hundredfold reduction could come from. It is
 * the same method that produced this project's "about 100 ms per mebibyte of SIRI-VM" figure.
 *
 * It writes nothing and deploys nothing.
 *
 *   npx tsx scripts/measure-serving-cpu.ts [--json serving-cpu.json]
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  objectKeyFor,
  r2StoreFromEnv,
  tileIdFor,
} from "@busstops/pipeline-core";
import {
  SHARDED,
  TRIP_TILE_DEGREES,
  mapStopTilesForBoundingBox,
  mapStopsDataset,
  patternTripsDataset,
  patternIndexTileDataset,
  patternTilesForBoundingBox,
  patternTileDataset,
  tripTilesForBoundingBox,
  tripWindowsFor,
  type MapStopRow,
  type NetworkIndexRecord,
  type PatternTripRow,
} from "@busstops/pipeline-static-network";
import { normalizeSiriVm } from "@busstops/adapters";

const JSON_OUT = (() => {
  const index = process.argv.indexOf("--json");
  return index === -1 ? undefined : process.argv[index + 1];
})();

/** Manchester: the viewport and the corridor every one of the measured failures came from. */
const VIEWPORT = { west: -2.32, south: 53.42, east: -2.16, north: 53.52 };
const FROM = { lat: 53.4794, lon: -2.2453 };
const TO = { lat: 53.5044, lon: -2.2453 };

/** Milliseconds of CPU, taken as wall time in a process doing nothing else. */
function timed<T>(run: () => T): { ms: number; value: T } {
  const began = process.hrtime.bigint();
  const value = run();
  return { ms: Number(process.hrtime.bigint() - began) / 1e6, value };
}

/** Walk every line and keep the ones a predicate wants, without splitting the body. */
function walk(body: string, keep?: (body: string, start: number, end: number) => boolean): number {
  let kept = 0;
  for (let start = 0; start < body.length;) {
    const newline = body.indexOf("\n", start);
    const end = newline < 0 ? body.length : newline;
    if (end > start && (keep === undefined || keep(body, start, end))) kept += 1;
    if (newline < 0) break;
    start = newline + 1;
  }
  return kept;
}

interface Stage {
  stage: string;
  ms: number;
  chars?: number;
  records?: number;
  /** Milliseconds per mebibyte, which is the figure that transfers between machines. */
  msPerMiB?: number;
}

function stage(name: string, ms: number, chars?: number, records?: number): Stage {
  return {
    stage: name,
    ms: Number(ms.toFixed(2)),
    ...(chars === undefined ? {} : { chars }),
    ...(records === undefined ? {} : { records }),
    ...(chars === undefined || chars === 0
      ? {}
      : { msPerMiB: Number(((ms * 1024 * 1024) / chars).toFixed(2)) }),
  };
}

async function main(): Promise<number> {
  const resolved = r2StoreFromEnv(process.env);
  if (!resolved.ok) {
    annotateReport("serving cpu", { outcome: "not_configured", missing: resolved.missing });
    return 2;
  }
  const store = resolved.store;
  const artifacts = new ArtifactStore(store);
  const index = (await artifacts.readCurrent<NetworkIndexRecord>(SHARDED.index)).records[0];
  if (!index) {
    annotateReport("serving cpu", { outcome: "failed", reason: "no index record" });
    return 1;
  }

  const stages: Stage[] = [];
  /*
   * The grid the artifact declares, not this process's default.
   *
   * The coarse tiles the retiling replaced are still in the bucket as a rollback, so a reader that
   * fell back to a default would open them and time the wrong objects — and report a figure for a
   * projection no passenger request reads.
   */
  const grid = index.layout?.mapStopTileDegrees;
  if (grid === undefined) {
    stages.push(stage("map: the artifact declares no grid; using this build's default", 0));
  }

  /* ---------------------------------------------------------- the map's projection read */
  const mapTiles = mapStopTilesForBoundingBox(VIEWPORT, grid).slice(0, 8);
  let mapChars = 0;
  const mapBodies: string[] = [];
  for (const tile of mapTiles) {
    const body = await store.get(objectKeyFor(mapStopsDataset(tile), index.version));
    if (body === null) continue;
    mapBodies.push(body);
    mapChars += body.length;
  }
  const inBox = (body: string, start: number, end: number) => {
    const at = body.indexOf('"y":', start);
    if (at < 0 || at > end) return false;
    const lat = Number.parseFloat(body.slice(at + 4, Math.min(end, at + 16)));
    return lat >= VIEWPORT.south && lat <= VIEWPORT.north;
  };
  const mapScan = timed(() => mapBodies.reduce((total, body) => total + walk(body, inBox), 0));
  stages.push(stage("map: walk the projection lines", mapScan.ms, mapChars, mapScan.value));

  const mapParse = timed(() => {
    const rows: MapStopRow[] = [];
    for (const body of mapBodies) {
      for (let start = 0; start < body.length;) {
        const newline = body.indexOf("\n", start);
        const end = newline < 0 ? body.length : newline;
        if (end > start && inBox(body, start, end)) {
          rows.push(JSON.parse(body.slice(start, end)) as MapStopRow);
        }
        if (newline < 0) break;
        start = newline + 1;
      }
    }
    return rows.length;
  });
  stages.push(stage("map: parse the rows it keeps", mapParse.ms, mapChars, mapParse.value));

  /* ---------------------------------------------------------- the live feed */
  const bodsKey = process.env.BODS_API_KEY;
  if (bodsKey) {
    const url =
      `https://data.bus-data.dft.gov.uk/api/v1/datafeed/?api_key=${bodsKey}` +
      `&boundingBox=${String(VIEWPORT.west)},${String(VIEWPORT.east)},` +
      `${String(VIEWPORT.south)},${String(VIEWPORT.north)}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const xml = await response.text();
      const parsed = timed(() =>
        normalizeSiriVm(xml, {
          retrievedAt: new Date().toISOString(),
          /* A throwaway salt: this measures the parse, and the salt only affects the output's ids. */
          vehicleSalt: "measurement",
        }),
      );
      stages.push(
        stage(
          "map: normalise the SIRI-VM feed",
          parsed.ms,
          xml.length,
          parsed.value.observations.length,
        ),
      );
    } catch (error) {
      stages.push(stage(`map: SIRI-VM unavailable (${String(error).slice(0, 60)})`, 0));
    }
  } else {
    stages.push(stage("map: SIRI-VM not measured (no BODS_API_KEY)", 0));
  }

  /* ---------------------------------------------------------- the journey's trip read */
  const corridor = {
    west: Math.min(FROM.lon, TO.lon) - 0.1,
    east: Math.max(FROM.lon, TO.lon) + 0.1,
    south: Math.min(FROM.lat, TO.lat) - 0.1,
    north: Math.max(FROM.lat, TO.lat) + 0.1,
  };
  const serviceDate = new Date().toISOString().slice(0, 10);
  const midnight = Date.parse(`${serviceDate}T00:00:00Z`) / 1000;
  const from = midnight + 9 * 3600;
  const windows = tripWindowsFor(from, from + 4 * 3600, serviceDate);
  const tripTiles = tripTilesForBoundingBox(corridor).slice(0, 4);

  let tripChars = 0;
  const tripBodies: string[] = [];
  for (const tile of tripTiles) {
    for (const window of windows) {
      const body = await store.get(
        objectKeyFor(patternTripsDataset(serviceDate, tile, window), index.version),
      );
      if (body === null) continue;
      tripBodies.push(body);
      tripChars += body.length;
    }
  }
  const tripScan = timed(() => tripBodies.reduce((total, body) => total + walk(body), 0));
  stages.push(stage("journey: walk the trip shards", tripScan.ms, tripChars, tripScan.value));

  const tripParse = timed(() => {
    const rows: PatternTripRow[] = [];
    for (const body of tripBodies) {
      for (let start = 0; start < body.length;) {
        const newline = body.indexOf("\n", start);
        const end = newline < 0 ? body.length : newline;
        if (end > start) rows.push(JSON.parse(body.slice(start, end)) as PatternTripRow);
        if (newline < 0) break;
        start = newline + 1;
      }
    }
    return rows.length;
  });
  stages.push(stage("journey: parse every trip row", tripParse.ms, tripChars, tripParse.value));

  /* ---------------------------------------------------------- the journey's pattern read */
  const patternTiles = patternTilesForBoundingBox(corridor).slice(0, 4);
  let patternChars = 0;
  const patternBodies: string[] = [];
  for (const tile of patternTiles) {
    for (const dataset of [patternIndexTileDataset(tile), patternTileDataset(tile)]) {
      const body = await store.get(objectKeyFor(dataset, index.version));
      if (body === null) continue;
      patternBodies.push(body);
      patternChars += body.length;
      break;
    }
  }
  const patternScan = timed(() => patternBodies.reduce((total, b) => total + walk(b), 0));
  stages.push(
    stage("journey: walk the pattern rows", patternScan.ms, patternChars, patternScan.value),
  );
  const patternParse = timed(() => {
    let built = 0;
    for (const body of patternBodies) {
      for (let start = 0; start < body.length;) {
        const newline = body.indexOf("\n", start);
        const end = newline < 0 ? body.length : newline;
        if (end > start) {
          JSON.parse(body.slice(start, end));
          built += 1;
        }
        if (newline < 0) break;
        start = newline + 1;
      }
    }
    return built;
  });
  stages.push(
    stage("journey: parse every pattern row", patternParse.ms, patternChars, patternParse.value),
  );

  const total = stages.reduce((sum, one) => sum + one.ms, 0);
  const report = {
    outcome: "measured",
    version: index.version,
    mapStopTileDegrees: grid ?? null,
    note:
      "A GitHub runner's CPU is not Cloudflare's. What transfers is the ratio between stages " +
      "and the order of magnitude against the 10 ms a Workers Free invocation is allowed.",
    freeCpuBudgetMs: 10,
    totalMs: Number(total.toFixed(2)),
    stages,
    tileIdOfFrom: tileIdFor(FROM, TRIP_TILE_DEGREES),
  };

  console.log(JSON.stringify(report, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("serving cpu", report);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Measuring serving CPU failed:", error);
    annotateReport("serving cpu", { outcome: "threw", error: String(error) });
    process.exitCode = 1;
  });
