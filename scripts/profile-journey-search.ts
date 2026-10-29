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
import { ArtifactStore, annotateReport, r2StoreFromEnv } from "@busstops/pipeline-core";
import {
  PatternTripShard,
  SHARDED,
  type NetworkIndexRecord,
  type PatternTripRow,
} from "@busstops/pipeline-static-network";
import {
  buildGraph,
  buildTransferAdjacency,
  buildTransferTiles,
  groupRouteIndices,
  groupRoutes,
  mergeTransferTiles,
  newSearchCounters,
  plan,
  runRaptor,
} from "@busstops/journey";
import { tileIdFor } from "@busstops/pipeline-core";
import { STOP_TILE_DEGREES } from "@busstops/pipeline-static-network";
import { loadCorridor } from "./lib/journey-corridor.js";

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

  const serviceDate = new Date().toISOString().slice(0, 10);
  const departAtSeconds = 9 * 3600;

  const results: Array<Record<string, unknown>> = [];

  for (const query of QUERIES) {
    const slice = await loadCorridor(store, index, query, serviceDate, departAtSeconds);
    const { stops, trips, tripChars } = slice;

    if (stops.length === 0 || trips.length === 0) {
      results.push({ query: query.name, skipped: "no corridor stops or trips published" });
      console.log(
        `${query.name}: skipped (stops ${String(stops.length)}, trips ${String(trips.length)})`,
      );
      continue;
    }

    /*
     * Trip preparation, both ways, over the same shards.
     *
     * The first stage of a journey request used to be `JSON.parse` on every line of every shard
     * the corridor touches — the single largest item in the old breakdown. The published form
     * replaced it with opening a header and reading the rows the corridor wants out of typed
     * arrays. Both are timed here against the same rows in the same process, because that is the
     * only comparison a runner can make honestly now the text objects are gone from the bucket:
     * two CI runs an hour apart disagree by more than this whole stage costs.
     */
    const tripParseText = timed(() => {
      const rows: PatternTripRow[] = [];
      for (const shard of slice.shards) {
        for (const line of shard.text.split("\n")) {
          if (line.length > 0) rows.push(JSON.parse(line) as PatternTripRow);
        }
      }
      return rows;
    });
    const shardBytes = slice.shards
      .map((shard) => shard.bytes)
      .filter((bytes): bytes is Uint8Array => bytes !== null);
    const tripDecodeBytes =
      shardBytes.length === 0
        ? null
        : timed(() => {
            const rows: PatternTripRow[] = [];
            for (const bytes of shardBytes) {
              const shard = new PatternTripShard(bytes);
              for (let trip = 0; trip < shard.tripCount; trip += 1) rows.push(shard.rowAt(trip));
            }
            return rows;
          });

    const built = timed(() => buildGraph({ stops, trips }));
    const graph = built.value;

    /*
     * And the build, split into the two things it does.
     *
     * With the trip parse moved into the published form, the graph build is the largest item left
     * in a journey request, and "the build" is two unrelated pieces of work: the walking transfers
     * between every pair of stops within range, and the grouping of trips into the routes the scan
     * walks. They have different fixes — transfers are the same every day and could be published,
     * grouping depends on the corridor filter and could not — so a single number for the build
     * cannot decide which to do. These two can.
     */
    const transfersOnly = timed(() => buildTransferAdjacency(stops, 600));
    const groupingOnly = timed(() => groupRoutes(trips));
    /*
     * The same grouping with the whole-pattern flag taken off, in the same process and against
     * the same trips.
     *
     * Two numbers from two CI runs cannot measure a change this size: the same unchanged corridor
     * measured 68.26 ms and 91.91 ms of graph build on two runners an hour apart. A controlled
     * pair inside one process can, and the flag's whole claim is that it does not change what the
     * grouping produces — only what it costs.
     */
    const unflagged = trips.map((trip) => ({ ...trip, wholePatternSequence: false }));
    const groupingUnflagged = timed(() => groupRoutes(unflagged));

    /*
     * And the two artifact paths, against the work they replace, in the same process.
     *
     * The grouping first: keys as the publisher assigns them — `groupRouteIndices`, the same
     * function the publisher runs — and then the grouping that a trip carrying its route costs,
     * which is a `Map` insert each and nothing else. The pair is the honest measure of what
     * publishing the grouping buys a request, and the `agrees` field is what says it bought it
     * without changing the answer.
     */
    /* Pattern keys as a shard would number them. */
    const patternKeys = new Map<string, number>();
    for (const trip of trips) {
      if (!patternKeys.has(trip.patternId)) patternKeys.set(trip.patternId, patternKeys.size);
    }
    const indexed = groupRouteIndices({
      tripCount: trips.length,
      patternKeyOf: (trip) => patternKeys.get(trips[trip]!.patternId) ?? 0,
      callCountOf: (trip) => trips[trip]!.stopTimes.length,
      departureOf: (trip, call) => trips[trip]!.stopTimes[call]!.departureSeconds,
      tripIdOf: (trip) => trips[trip]!.id,
    });
    const keyOf = new Map<string, string>();
    indexed.forEach((group, at) => {
      for (const trip of group.trips) keyOf.set(trips[trip]!.id, `r${String(at)}`);
    });
    const keyedTrips = trips.map((trip) => ({ ...trip, routeKey: keyOf.get(trip.id) }));
    const groupingFromArtifact = timed(() => groupRoutes(keyedTrips));

    /*
     * The transfers: the published tiles, built here by the same function the publisher uses, then
     * merged for this corridor the way the reader merges them. What this isolates is the
     * request-time cost — the read itself is I/O and is measured in the endpoint's own figures.
     */
    const tilePlans = buildTransferTiles(stops, {
      capSeconds: 600,
      tileOf: (stop) => tileIdFor(stop.coordinate, STOP_TILE_DEGREES),
    });
    const tilesForMerge = tilePlans.map((plan) => ({ ...plan, capSeconds: 600 }));
    const corridorStopIds = stops.map((stop) => stop.id);
    const transfersFromArtifact = timed(() =>
      mergeTransferTiles(corridorStopIds, tilesForMerge, 600),
    );

    const transferEdges = graph.transfers.edgeCount;
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
      /* What each shard form was published as, so a stage figure says which work it measured. */
      shards: slice.shards.length,
      shardsAsBytes: shardBytes.length,
      shardBytes: shardBytes.reduce((total, bytes) => total + bytes.byteLength, 0),
      /* Trip preparation: the old parse against the new decode, over the same rows. */
      tripParseTextMs: Number(tripParseText.ms.toFixed(2)),
      tripDecodeBytesMs: tripDecodeBytes === null ? null : Number(tripDecodeBytes.ms.toFixed(2)),
      /*
       * And that the decode produced the same rows the parse did. A faster stage that answers
       * with different trips is not a faster stage.
       */
      tripRowsAgree:
        tripDecodeBytes === null
          ? null
          : tripDecodeBytes.value.length === tripParseText.value.length &&
            tripDecodeBytes.value.every(
              (row, at) => JSON.stringify(row) === JSON.stringify(tripParseText.value[at]),
            ),
      buildGraphMs: Number(built.ms.toFixed(2)),
      buildTransfersMs: Number(transfersOnly.ms.toFixed(2)),
      groupRoutesMs: Number(groupingOnly.ms.toFixed(2)),
      groupRoutesUnflaggedMs: Number(groupingUnflagged.ms.toFixed(2)),
      /* What publishing each of them costs the request instead. */
      groupRoutesFromArtifactMs: Number(groupingFromArtifact.ms.toFixed(2)),
      transfersFromArtifactMs: Number(transfersFromArtifact.ms.toFixed(2)),
      transferTiles: tilePlans.length,
      /* And that each artifact path answers with the same thing the computed one did. */
      artifactTransfersAgree:
        transfersFromArtifact.value !== null &&
        transfersFromArtifact.value.edgeCount === transfersOnly.value.edgeCount,
      artifactGroupingAgrees:
        groupingFromArtifact.value.routes.length === groupingOnly.value.routes.length &&
        [...groupingFromArtifact.value.routes]
          .map((route) => `${route.stopIds.join(">")}|${route.trips.map((t) => t.id).join(",")}`)
          .sort()
          .join("\n") ===
          [...groupingOnly.value.routes]
            .map((route) => `${route.stopIds.join(">")}|${route.trips.map((t) => t.id).join(",")}`)
            .sort()
            .join("\n"),
      /* And that the two forms agree about the routes, which is the flag's only promise. */
      groupingAgrees:
        groupingOnly.value.routes.length === groupingUnflagged.value.routes.length &&
        groupingOnly.value.routes.every(
          (route, at) =>
            route.trips.length === groupingUnflagged.value.routes[at]?.trips.length &&
            route.stopIds.join(">") === groupingUnflagged.value.routes[at]?.stopIds.join(">"),
        ),
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
      `${"".padEnd(44)} tripPrep parse ${tripParseText.ms.toFixed(1).padStart(7)}ms ` +
        `decode ${(tripDecodeBytes === null ? NaN : tripDecodeBytes.ms).toFixed(1).padStart(7)}ms ` +
        `transfers build ${transfersOnly.ms.toFixed(1).padStart(6)}ms merge ` +
        `${(transfersFromArtifact.ms as number).toFixed(1).padStart(6)}ms ` +
        `grouping compute ${groupingOnly.ms.toFixed(1).padStart(6)}ms keyed ` +
        `${groupingFromArtifact.ms.toFixed(1).padStart(6)}ms`,
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
