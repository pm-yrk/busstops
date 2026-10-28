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
  searchIndex as rankSearch,
  searchPrefixDataset,
  patternTilesForBoundingBox,
  patternTileDataset,
  tripTilesForBoundingBox,
  tripWindowsFor,
  type MapStopRow,
  type NetworkIndexRecord,
  type PatternTripRow,
  type SearchIndexEntry,
} from "@busstops/pipeline-static-network";
import { normalizeSiriVm, scanSiriVehicles } from "@busstops/adapters";
import { NearestLines, tileFloorMetres } from "../apps/worker/src/nearest-lines.js";
import { searchLineFilter } from "../apps/worker/src/network-reader.js";
import { tripWindowInLine } from "../apps/worker/src/journey-service.js";
import { readTripShard } from "./lib/read-trip-shard.js";
import { haversineMetres } from "@busstops/pipeline-core";
import { buildGraph, plan, type Trip } from "@busstops/journey";

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

/**
 * The median of several runs, after a warm-up, for comparing two forms of the same answer.
 *
 * The single-run timer above is right for a stage that happens once in a request and whose cost is
 * dominated by the bytes it touches. It is wrong for a comparison, and it said so: the first run of
 * this script's two viewport forms reported the one that reads a third of the bytes as the *slower*
 * of the two, because the eager form ran on code paths that two earlier stages had already warmed
 * and the selected form ran cold on a heap, a haversine and a tile bound the process had never
 * executed. Cloudflare's own tail measured the same pair at 38 ms and 16.
 *
 * So a comparison warms both and takes a median, and the two are interleaved rather than run in
 * sequence, because a long first run also leaves a different garbage-collection state behind.
 */
function medianOf<T>(run: () => T, iterations = 7): { ms: number; value: T } {
  run();
  const times: number[] = [];
  let value!: T;
  for (let i = 0; i < iterations; i += 1) {
    const began = process.hrtime.bigint();
    value = run();
    times.push(Number(process.hrtime.bigint() - began) / 1e6);
  }
  times.sort((a, b) => a - b);
  return { ms: times[Math.floor(times.length / 2)]!, value };
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

  const mapRows: MapStopRow[] = [];
  const mapParse = timed(() => {
    const rows = mapRows;
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

  /* ------------------------------------------- the viewport, both ways, end to end */
  /*
   * The two forms of the same answer, on the same objects, in the same process.
   *
   * The stages above split the read into walking and parsing. These two time the whole selection:
   * the form that built every row in the box and then ranked them, against the one that ranks the
   * raw lines and parses only the four hundred it keeps. The second also reports how many tiles it
   * opened, which is the part no byte budget could reach — a tile it skips costs nothing at all.
   */
  const MARKERS = 400;
  const viewportCentre = {
    lat: (VIEWPORT.north + VIEWPORT.south) / 2,
    lon: (VIEWPORT.east + VIEWPORT.west) / 2,
  };
  const insideBox = (lat: number, lon: number) =>
    lat >= VIEWPORT.south && lat <= VIEWPORT.north && lon >= VIEWPORT.west && lon <= VIEWPORT.east;

  const eager = medianOf(() => {
    const rows: MapStopRow[] = [];
    for (const body of mapBodies) {
      for (let start = 0; start < body.length;) {
        const newline = body.indexOf("\n", start);
        const end = newline < 0 ? body.length : newline;
        if (end > start && inBox(body, start, end)) {
          const row = JSON.parse(body.slice(start, end)) as MapStopRow;
          if (insideBox(row.y, row.x)) rows.push(row);
        }
        if (newline < 0) break;
        start = newline + 1;
      }
    }
    return rows
      .map((row) => ({ row, metres: haversineMetres(viewportCentre, { lat: row.y, lon: row.x }) }))
      .sort((a, b) => a.metres - b.metres)
      .slice(0, MARKERS)
      .map((entry) => entry.row.i);
  });
  stages.push(
    stage("map: viewport, building every row first", eager.ms, mapChars, eager.value.length),
  );

  /*
   * The same tiles, nearest first, with the ones that cannot contribute skipped.
   *
   * Batched in twos exactly as the Worker batches them, because the skipping is only checked
   * between batches and a wider batch commits to reading further ahead than it needs to.
   */
  const nearestTiles = [...mapTiles]
    .map((tile) => ({ tile, floor: tileFloorMetres(tile, grid ?? 0.125, viewportCentre) }))
    .sort((a, b) => a.floor - b.floor);
  const bodyByTile = new Map(mapTiles.map((tile, at) => [tile, mapBodies[at] ?? ""]));

  let openedChars = 0;
  let opened = 0;
  const selected = medianOf(() => {
    /* Reset per run, so a median of seven does not report seven runs' worth of tiles. */
    openedChars = 0;
    opened = 0;
    const nearest = new NearestLines(MARKERS, viewportCentre);
    for (let at = 0; at < nearestTiles.length; at += 2) {
      const batch = nearestTiles
        .slice(at, at + 2)
        .filter((entry) => entry.floor <= nearest.admissionMetres);
      for (const entry of batch) {
        const body = bodyByTile.get(entry.tile) ?? "";
        opened += 1;
        openedChars += body.length;
        for (let start = 0; start < body.length;) {
          const newline = body.indexOf("\n", start);
          const end = newline < 0 ? body.length : newline;
          if (end > start) {
            const latAt = body.indexOf('"y":', start);
            const lonAt = body.indexOf('"x":', start);
            if (latAt >= 0 && latAt < end && lonAt >= 0 && lonAt < end) {
              const lat = Number.parseFloat(body.slice(latAt + 4, Math.min(end, latAt + 16)));
              const lon = Number.parseFloat(body.slice(lonAt + 4, Math.min(end, lonAt + 16)));
              if (insideBox(lat, lon)) {
                nearest.offer(nearest.distanceTo(lat, lon), body, start, end);
              }
            }
          }
          if (newline < 0) break;
          start = newline + 1;
        }
      }
    }
    return nearest.drain().map((kept) => (JSON.parse(kept.text) as MapStopRow).i);
  });
  stages.push(
    stage(
      "map: viewport, parsing only the markers it draws",
      selected.ms,
      openedChars,
      selected.value.length,
    ),
  );
  stages.push(
    stage(`map: tiles opened ${String(opened)} of ${String(mapBodies.length)}`, 0, openedChars),
  );
  /*
   * The two forms must agree. Reported rather than asserted, because this script measures and a
   * disagreement is a measurement too — but the structural test in the Worker is what gates it.
   */
  const agree =
    eager.value.length === selected.value.length &&
    eager.value.every((id, at) => id === selected.value[at]);
  stages.push(stage(`map: the two forms ${agree ? "agree" : "DISAGREE"}`, 0));

  /* ---------------------------------------------------------- the live feed */
  const bodsKey = process.env.BODS_API_KEY;
  if (bodsKey) {
    /*
     * `west,south,east,north`, which is the order the Worker sends and the order BODS reads.
     *
     * The first version of this script sent `west,east,south,north` — the convention several
     * other APIs use — and BODS answered with 19,254,654 characters and 18,184 vehicles spanning
     * latitude 0 to 53.5 and longitude −2.3 to 1.76. So it timed a national feed and reported the
     * SIRI parse as 956 of a request's 996 milliseconds, which was a measurement of this script's
     * own bug. `scripts/measure-bods-bbox.ts` settled it against the real feed: the order below
     * returns 563,015 characters and 437 vehicles, every one of them inside the viewport.
     */
    const url =
      `https://data.bus-data.dft.gov.uk/api/v1/datafeed/?api_key=${bodsKey}` +
      `&boundingBox=${VIEWPORT.west.toFixed(5)},${VIEWPORT.south.toFixed(5)},` +
      `${VIEWPORT.east.toFixed(5)},${VIEWPORT.north.toFixed(5)}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const xml = await response.text();
      /*
       * The scan first, because it is what the request path runs.
       *
       * This stage used to time `normalizeSiriVm` only, and kept reporting a hundred milliseconds
       * for a parse no passenger request has made since the scan replaced it — a measurement of
       * the code that was removed. Both are timed now: the scan because it is deployed, the
       * normaliser because it is still what the collector runs and because the ratio between them
       * is the claim this change was made on.
       */
      const scanned = medianOf(() =>
        scanSiriVehicles(xml, { vehicleSalt: "measurement", nowMs: Date.now() }),
      );
      stages.push(
        stage("map: scan the SIRI-VM feed", scanned.ms, xml.length, scanned.value.vehicles.length),
      );
      const parsed = medianOf(() =>
        normalizeSiriVm(xml, {
          retrievedAt: new Date().toISOString(),
          /* A throwaway salt: this measures the parse, and the salt only affects the output's ids. */
          vehicleSalt: "measurement",
        }),
      );
      stages.push(
        stage(
          "map: normalise the SIRI-VM feed (the collector's path, not the request's)",
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

  /* ---------------------------------------------------------- the search's prefix read */
  /*
   * The endpoint a visitor uses first, and the one still over its budget.
   *
   * Cloudflare puts `/v1/search` at a p50 of eleven milliseconds and a p95 of seventy-one, with
   * fourteen invocations of thirty-seven over the limit. Its own work is three stages and they
   * have different fixes, so they are measured apart: walking the prefix buckets as text with the
   * line filter in front of the parse, parsing what survives, and ranking the candidates. A
   * published bucket reaches 1,644,719 bytes and a two-word query opens two of them.
   */
  const searchWords = ["leeds", "station"];
  const searchPrefixes = searchWords.map((word) => word.slice(0, 3));
  const searchBodies: string[] = [];
  let searchChars = 0;
  for (const prefix of searchPrefixes) {
    const body = await store.get(objectKeyFor(searchPrefixDataset(prefix), index.version));
    if (body === null) continue;
    searchBodies.push(body);
    searchChars += body.length;
  }

  if (searchBodies.length === 0) {
    stages.push(stage("search: no prefix buckets published for this query", 0));
  } else {
    const filter = searchLineFilter(searchWords);
    const scanned = timed(() => {
      let kept = 0;
      for (const body of searchBodies) {
        for (let start = 0; start < body.length;) {
          const newline = body.indexOf("\n", start);
          const end = newline < 0 ? body.length : newline;
          if (end > start && (filter === undefined || filter(body, start, end))) kept += 1;
          if (newline < 0) break;
          start = newline + 1;
        }
      }
      return kept;
    });
    stages.push(
      stage(
        "search: walk the prefix buckets, filtering as text",
        scanned.ms,
        searchChars,
        scanned.value,
      ),
    );

    const searchParsed = timed(() => {
      const entries: SearchIndexEntry[] = [];
      for (const body of searchBodies) {
        for (let start = 0; start < body.length;) {
          const newline = body.indexOf("\n", start);
          const end = newline < 0 ? body.length : newline;
          if (end > start && (filter === undefined || filter(body, start, end))) {
            entries.push(JSON.parse(body.slice(start, end)) as SearchIndexEntry);
          }
          if (newline < 0) break;
          start = newline + 1;
        }
      }
      return entries;
    });
    stages.push(
      stage(
        "search: parse the lines it kept",
        searchParsed.ms,
        searchChars,
        searchParsed.value.length,
      ),
    );

    /* And the whole bucket parsed, which is what the reader did before the filter existed. */
    const searchParsedAll = timed(() => {
      let rows = 0;
      for (const body of searchBodies) {
        for (const line of body.split("\n")) {
          if (line.length > 0) {
            JSON.parse(line);
            rows += 1;
          }
        }
      }
      return rows;
    });
    stages.push(
      stage(
        "search: parse every line, as it did before the filter",
        searchParsedAll.ms,
        searchChars,
        searchParsedAll.value,
      ),
    );

    const ranked = timed(() =>
      rankSearch(
        { entries: searchParsed.value, builtAt: index.publishedAt },
        searchWords.join(" "),
        { limit: 20 },
      ),
    );
    stages.push(stage("search: rank the candidates", ranked.ms, undefined, ranked.value.length));
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
  /*
   * Either form, and the report says which.
   *
   * The shards are being converted in place, so this corridor can be part text and part bytes. A
   * converted shard's lines are rebuilt from its rows for the text stages below: the rows are the
   * same rows, and what those stages measure is the work of parsing them, not which object the
   * pipeline happened to write first. A reader that only knew the old key would instead have
   * reported a converted corridor as a corridor with no trips, and the stage that costs more than
   * the search would have quietly read zero.
   */
  const tripForms = new Set<string>();
  for (const tile of tripTiles) {
    for (const window of windows) {
      const shard = await readTripShard(
        store,
        patternTripsDataset(serviceDate, tile, window),
        index.version,
      );
      if (shard === null) continue;
      tripForms.add(shard.form);
      tripBodies.push(shard.text);
      tripChars += shard.text.length;
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

  /*
   * And the same read with both text tests in front of the parse, which is what the endpoint does.
   *
   * A shard holds an eight-hour window and a plan spans four, so roughly half of what a corridor
   * opens is outside the horizon the search looks at. The row above parses all of it; this one
   * tests each line's first and last call off the raw text and parses only what survives. The
   * difference is the whole reason the test moved in front of the parse.
   */
  const to = from + 4 * 3600;
  const tripParseFiltered = timed(() => {
    const rows: PatternTripRow[] = [];
    for (const body of tripBodies) {
      for (let start = 0; start < body.length;) {
        const newline = body.indexOf("\n", start);
        const end = newline < 0 ? body.length : newline;
        if (end > start) {
          const line = body.slice(start, end);
          const window = tripWindowInLine(line);
          if (window === null || (window.last >= from && window.first <= to)) {
            rows.push(JSON.parse(line) as PatternTripRow);
          }
        }
        if (newline < 0) break;
        start = newline + 1;
      }
    }
    return rows.length;
  });
  stages.push(
    stage(
      "journey: parse only the rows inside the plan's horizon",
      tripParseFiltered.ms,
      tripChars,
      tripParseFiltered.value,
    ),
  );

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

  /* ---------------------------------------------------------- the journey's search */
  /*
   * The two stages nothing had ever timed, and the ones the tail's numbers point at.
   *
   * Cloudflare recorded a journey spending 831ms of CPU and another invocation 1,198ms. The reads
   * above come to about thirty-five milliseconds between them and the live parse to twenty-eight,
   * so several hundred milliseconds are unaccounted for — and building a graph over a corridor's
   * trips and searching it is the only computation left that could hold them.
   *
   * **Sized to what the planner actually builds**, which the first attempt at this was not: it
   * gave every trip its own synthetic stops, produced twelve thousand of them, and `buildGraph`
   * walks every pair within transfer range — so the runner died with SIGABRT on 144 million pairs
   * and measured nothing. The deployed breadcrumbs say what a real corridor is: `slice.stops=222`
   * and `patterns.wanted=35`. So the graph is built over real stop coordinates from the projection
   * and the trips of a bounded number of patterns, and the caps are reported with the timings
   * because a graph search's cost is mostly a function of its size.
   */
  const CORRIDOR_STOPS = 250;
  const CORRIDOR_PATTERNS = 40;

  const graphStops = mapRows.slice(0, CORRIDOR_STOPS).map((row) => ({
    id: row.i,
    name: row.n,
    coordinate: { lat: row.y, lon: row.x },
  }));

  const patterns = new Set<string>();
  const trips: Trip[] = [];
  for (const body of tripBodies) {
    for (let start = 0; start < body.length && trips.length < 4_000;) {
      const newline = body.indexOf("\n", start);
      const end = newline < 0 ? body.length : newline;
      if (end > start) {
        const row = JSON.parse(body.slice(start, end)) as PatternTripRow;
        if (!patterns.has(row.p)) {
          if (patterns.size < CORRIDOR_PATTERNS) patterns.add(row.p);
        }
        if (patterns.has(row.p) && graphStops.length > 0) {
          /*
           * The times are the published ones; the stops are real stops from the corridor, walked
           * in order. This times a graph of the right shape and size, not a real itinerary.
           */
          const offset = patterns.size;
          trips.push({
            id: row.j,
            routeId: row.p,
            stopTimes: row.t.map((seconds, i) => ({
              stopId: graphStops[(offset * 7 + i) % graphStops.length]!.id,
              arrivalSeconds: seconds,
              departureSeconds: seconds,
            })),
          } as unknown as Trip);
        }
      }
      if (newline < 0) break;
      start = newline + 1;
    }
  }

  if (graphStops.length > 0 && trips.length > 0) {
    const built = timed(() => buildGraph({ stops: graphStops as never, trips }));
    stages.push(
      stage(
        `journey: build the graph (${String(graphStops.length)} stops, ${String(trips.length)} trips)`,
        built.ms,
        undefined,
        trips.length,
      ),
    );

    const planned = timed(() =>
      plan(built.value, { origin: FROM, destination: TO, departAtSeconds: from - midnight }),
    );
    stages.push(stage("journey: search it", planned.ms, undefined, planned.value.options.length));
  } else {
    stages.push(stage("journey: no corridor stops or trips to build a graph from", 0));
  }

  const total = stages.reduce((sum, one) => sum + one.ms, 0);
  const report = {
    outcome: "measured",
    version: index.version,
    mapStopTileDegrees: grid ?? null,
    /* "bytes" means the published shards are converted and the text stages were measured against
     * lines rebuilt from their rows. */
    tripShardForms: [...tripForms],
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
