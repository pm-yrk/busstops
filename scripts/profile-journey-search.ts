#!/usr/bin/env node
/**
 * Why a search over 250 stops and 1,390 trips takes 183 milliseconds.
 *
 * Cloudflare recorded `/v1/journeys` at 243 ms of CPU against a ten-millisecond free limit, and
 * the stage breakdown put 183 of them inside the round-based search and 17 more in building the
 * graph it searches. Those are not large inputs. A figure that size over a set that small is a
 * question about data structures and repeated work rather than about the choice of algorithm — the
 * search is already RAPTOR-shaped, which is the family suited to scheduled transport — so before
 * replacing anything this counts how many times the inner work actually runs.
 *
 * It reads a real corridor from the published artifact and runs the real planner, so the counts
 * are of this dataset rather than of a sketch. A runner's CPU is not Cloudflare's; the ratios and
 * the counts are what transfer.
 *
 *   npx tsx scripts/profile-journey-search.ts [--json journey-profile.json]
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  objectKeyFor,
  r2StoreFromEnv,
} from "@busstops/pipeline-core";
import {
  SHARDED,
  mapStopTilesForBoundingBox,
  mapStopsDataset,
  patternIndexTileDataset,
  patternTilesForBoundingBox,
  patternTripsDataset,
  tripTilesForBoundingBox,
  tripWindowsFor,
  type MapStopRow,
  type NetworkIndexRecord,
  type PatternIndexRow,
  type PatternTripRow,
} from "@busstops/pipeline-static-network";
import {
  buildGraph,
  newSearchCounters,
  plan,
  runRaptor,
  type JourneyStop,
  type Trip,
} from "@busstops/journey";

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const JSON_OUT = arg("json");

/**
 * The four shapes B2 asks for, across the probe cities.
 *
 * A planner's cost is mostly a function of how much timetable the corridor contains, so a
 * neighbourhood hop and a cross-city trip with two plausible changes are different measurements
 * and both have to fit.
 */
const QUERIES = [
  {
    name: "small (neighbourhood, Leeds)",
    from: { lat: 53.7996, lon: -1.5491 },
    to: { lat: 53.8035, lon: -1.5555 },
  },
  {
    name: "normal urban (Manchester)",
    from: { lat: 53.4794, lon: -2.2453 },
    to: { lat: 53.5044, lon: -2.2453 },
  },
  {
    name: "cross-city (Birmingham)",
    from: { lat: 52.4751, lon: -1.8986 },
    to: { lat: 52.5106, lon: -1.8601 },
  },
  {
    name: "difficult (Bristol, several changes plausible)",
    from: { lat: 51.455, lon: -2.5879 },
    to: { lat: 51.4805, lon: -2.6 },
  },
  {
    name: "cross-city (York to its park and ride)",
    from: { lat: 53.958, lon: -1.0803 },
    to: { lat: 53.9512, lon: -1.0231 },
  },
] as const;

function timed<T>(run: () => T, iterations = 5): { ms: number; value: T } {
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

function walkLines<T>(body: string, keep: (line: string) => boolean): T[] {
  const rows: T[] = [];
  for (let start = 0; start < body.length;) {
    const newline = body.indexOf("\n", start);
    const end = newline < 0 ? body.length : newline;
    if (end > start) {
      const line = body.slice(start, end);
      if (keep(line)) rows.push(JSON.parse(line) as T);
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return rows;
}

async function main(): Promise<number> {
  const resolved = r2StoreFromEnv(process.env);
  if (!resolved.ok) {
    annotateReport("journey profile", { outcome: "not_configured", missing: resolved.missing });
    return 2;
  }
  const store = resolved.store;
  const index = (await new ArtifactStore(store).readCurrent<NetworkIndexRecord>(SHARDED.index))
    .records[0];
  if (!index) {
    annotateReport("journey profile", { outcome: "failed", reason: "no index record" });
    return 1;
  }

  const grid = index.layout?.mapStopTileDegrees;
  const serviceDate = new Date().toISOString().slice(0, 10);
  const midnight = Date.parse(`${serviceDate}T00:00:00Z`) / 1000;
  const departAtSeconds = 9 * 3600;
  const from = midnight + departAtSeconds;

  const results: Array<Record<string, unknown>> = [];

  for (const query of QUERIES) {
    const corridor = {
      west: Math.min(query.from.lon, query.to.lon) - 0.05,
      east: Math.max(query.from.lon, query.to.lon) + 0.05,
      south: Math.min(query.from.lat, query.to.lat) - 0.05,
      north: Math.max(query.from.lat, query.to.lat) + 0.05,
    };

    /* The corridor's stops, from the projection the planner itself reads. */
    const stops: JourneyStop[] = [];
    for (const tile of mapStopTilesForBoundingBox(corridor, grid).slice(0, 24)) {
      const body = await store.get(objectKeyFor(mapStopsDataset(tile), index.version));
      if (body === null) continue;
      for (const row of walkLines<MapStopRow>(body, () => true)) {
        if (
          row.y >= corridor.south &&
          row.y <= corridor.north &&
          row.x >= corridor.west &&
          row.x <= corridor.east
        ) {
          stops.push({ id: row.i, name: row.n, coordinate: { lat: row.y, lon: row.x } });
        }
      }
    }

    /* The corridor's patterns, so a trip's stop sequence is the real one. */
    const stopSequenceByPattern = new Map<string, string[]>();
    for (const tile of patternTilesForBoundingBox(corridor).slice(0, 8)) {
      const body = await store.get(objectKeyFor(patternIndexTileDataset(tile), index.version));
      if (body === null) continue;
      for (const row of walkLines<[string, PatternIndexRow]>(body, (line) =>
        line.startsWith("["),
      )) {
        stopSequenceByPattern.set(row[1].id, row[1].stopSequence);
      }
    }

    /* The corridor's trips, in the windows a four-hour plan spans. */
    const trips: Trip[] = [];
    let tripChars = 0;
    const windows = tripWindowsFor(from, from + 4 * 3600, serviceDate);
    for (const tile of tripTilesForBoundingBox(corridor).slice(0, 8)) {
      for (const window of windows) {
        const body = await store.get(
          objectKeyFor(patternTripsDataset(serviceDate, tile, window), index.version),
        );
        if (body === null) continue;
        tripChars += body.length;
        for (const row of walkLines<PatternTripRow>(body, () => true)) {
          const sequence = stopSequenceByPattern.get(row.p);
          if (!sequence || sequence.length !== row.t.length) continue;
          trips.push({
            id: row.j,
            routeId: row.p,
            stopTimes: row.t.map((seconds, i) => ({
              stopId: sequence[i]!,
              arrivalSeconds: seconds - midnight,
              departureSeconds: seconds - midnight,
            })),
          } as unknown as Trip);
        }
      }
    }

    if (stops.length === 0 || trips.length === 0) {
      results.push({ query: query.name, skipped: "no corridor stops or trips published" });
      console.log(
        `${query.name}: skipped (stops ${String(stops.length)}, trips ${String(trips.length)})`,
      );
      continue;
    }

    const built = timed(() => buildGraph({ stops, trips }));
    const graph = built.value;

    let transferEdges = 0;
    for (const list of graph.transfers.values()) transferEdges += list.length;
    let stopTripEntries = 0;
    for (const list of graph.tripsByStop.values()) stopTripEntries += list.length;

    const planned = timed(() =>
      plan(graph, { origin: query.from, destination: query.to, departAtSeconds }),
    );

    /* The same search again, counted. */
    const counters = newSearchCounters();
    runRaptor(graph, [{ stopId: stops[0]!.id, accessSeconds: 0 }], { departAtSeconds }, counters);

    const row = {
      query: query.name,
      stops: stops.length,
      trips: trips.length,
      patterns: new Set(trips.map((t) => t.routeId)).size,
      transferEdges,
      stopTripEntries,
      tripChars,
      buildGraphMs: Number(built.ms.toFixed(2)),
      planMs: Number(planned.ms.toFixed(2)),
      options: planned.value.options.length,
      counters: {
        ...counters,
        improveRejected: counters.improveCalls - counters.improveAccepted,
        /* The ratio that says whether the garbage is the problem. */
        improveAcceptRate:
          counters.improveCalls === 0
            ? null
            : Number((counters.improveAccepted / counters.improveCalls).toFixed(3)),
      },
      freeCpuBudgetMs: 10,
    };
    results.push(row);
    console.log(
      `${query.name.padEnd(44)} stops ${String(stops.length).padStart(5)} trips ${String(trips.length).padStart(6)} ` +
        `transferEdges ${String(transferEdges).padStart(7)} build ${built.ms.toFixed(1).padStart(7)}ms ` +
        `plan ${planned.ms.toFixed(1).padStart(7)}ms options ${String(planned.value.options.length)}`,
    );
    console.log(
      `${"".padEnd(44)} tripScans ${String(counters.tripScans)} effectiveStopTimes ` +
        `${String(counters.effectiveStopTimesCalls)} improve ${String(counters.improveAccepted)}/${String(counters.improveCalls)} ` +
        `labelEntriesCopied ${String(counters.labelEntriesCopied)}`,
    );
  }

  const report = {
    outcome: "measured",
    version: index.version,
    serviceDate,
    freeCpuBudgetMs: 10,
    note:
      "A GitHub runner's CPU is not Cloudflare's. The counts are exact; the milliseconds are " +
      "ratios against the same machine's other stages.",
    queries: results,
  };

  console.log("");
  console.log(JSON.stringify(report, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("journey profile", report);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Profiling the journey search failed:", error);
    annotateReport("journey profile", { outcome: "threw", error: String(error) });
    process.exitCode = 1;
  });
