#!/usr/bin/env node
/**
 * What the current planner answers, recorded so a faster one can be held against it.
 *
 * The profile settled that this search cannot fit ten milliseconds: with both of the
 * semantics-preserving fixes in, a Manchester corridor still takes 295 ms to search and 520 ms to
 * build the graph it searches, against a budget of ten for the whole request. So the planner is
 * going to be replaced by something that reads a query-ready representation — and the one thing
 * that must not happen quietly is that it answers *worse journeys* faster.
 *
 * "Worse" needs a baseline, and the baseline has to be the planner that is deployed today, because
 * that is what a passenger is getting now. This writes that baseline down: for twenty queries
 * across the five probe cities, every option the current planner returns, with its arrival, its
 * changes, and the services it rides, keyed so a replacement's answer can be compared option by
 * option.
 *
 * It is a record, not a judgement. A query the current planner cannot answer is recorded as
 * unanswered rather than dropped — a replacement that finds a journey here is an improvement, and
 * one that loses an answer is a regression, and neither is visible if the corpus only holds the
 * queries that happened to work.
 *
 * It writes nothing to the artifact and deploys nothing.
 *
 *   npx tsx scripts/journey-corpus.ts [--json journey-corpus.json] [--date 2026-10-27]
 */

import { writeFileSync } from "node:fs";
import { ArtifactStore, annotateReport, r2StoreFromEnv } from "@busstops/pipeline-core";
import { SHARDED, type NetworkIndexRecord } from "@busstops/pipeline-static-network";
import { buildGraph, plan } from "@busstops/journey";
import { loadCorridor, type CorridorQuery } from "./lib/journey-corridor.js";

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const JSON_OUT = arg("json");

/**
 * Twenty queries: four shapes in each of the five probe cities.
 *
 * The shapes are the ones B2 names, because a planner's cost and its correctness both vary with
 * them. A neighbourhood hop should be a single ride and is where an over-aggressive pruning shows
 * up as a walk. A cross-town trip is the ordinary case. A cross-city trip is where a change
 * becomes necessary and where a search that stops too early loses the journey rather than
 * lengthening it. An awkward pair — across a river, out to a park and ride, between two suburbs
 * that no single route joins — is where the planner has to find two changes or admit it cannot,
 * and is the shape a precomputed representation is most likely to get wrong.
 */
const QUERIES: readonly CorridorQuery[] = [
  {
    name: "Leeds: short hop in Armley",
    from: { lat: 53.7996, lon: -1.5491 },
    to: { lat: 53.8035, lon: -1.5555 },
  },
  {
    name: "Leeds: city centre to Headingley",
    from: { lat: 53.7965, lon: -1.5478 },
    to: { lat: 53.8198, lon: -1.5811 },
  },
  {
    name: "Leeds: station to the airport road",
    from: { lat: 53.7955, lon: -1.5491 },
    to: { lat: 53.8441, lon: -1.6151 },
  },
  {
    name: "Leeds: Beeston to Seacroft, no single route",
    from: { lat: 53.7742, lon: -1.5678 },
    to: { lat: 53.8231, lon: -1.4593 },
  },
  {
    name: "Manchester: short hop in the centre",
    from: { lat: 53.4794, lon: -2.2453 },
    to: { lat: 53.4839, lon: -2.2446 },
  },
  {
    name: "Manchester: Piccadilly to Cheetham Hill",
    from: { lat: 53.4794, lon: -2.2309 },
    to: { lat: 53.5044, lon: -2.2453 },
  },
  {
    name: "Manchester: centre to Salford Quays",
    from: { lat: 53.4794, lon: -2.2453 },
    to: { lat: 53.4702, lon: -2.2914 },
  },
  {
    name: "Manchester: Didsbury to Prestwich, across the city",
    from: { lat: 53.4186, lon: -2.2311 },
    to: { lat: 53.5316, lon: -2.2819 },
  },
  {
    name: "Birmingham: short hop in the centre",
    from: { lat: 52.4797, lon: -1.8996 },
    to: { lat: 52.4836, lon: -1.8936 },
  },
  {
    name: "Birmingham: New Street to Aston",
    from: { lat: 52.4751, lon: -1.8986 },
    to: { lat: 52.5106, lon: -1.8601 },
  },
  {
    name: "Birmingham: centre to Selly Oak",
    from: { lat: 52.4797, lon: -1.8996 },
    to: { lat: 52.4408, lon: -1.9342 },
  },
  {
    name: "Birmingham: Erdington to Harborne, across the city",
    from: { lat: 52.5245, lon: -1.8396 },
    to: { lat: 52.4601, lon: -1.9537 },
  },
  {
    name: "Bristol: short hop in the centre",
    from: { lat: 51.455, lon: -2.5879 },
    to: { lat: 51.4583, lon: -2.5918 },
  },
  {
    name: "Bristol: centre to Clifton",
    from: { lat: 51.455, lon: -2.5879 },
    to: { lat: 51.4805, lon: -2.6 },
  },
  {
    name: "Bristol: centre to Bedminster",
    from: { lat: 51.4518, lon: -2.5906 },
    to: { lat: 51.4341, lon: -2.5942 },
  },
  {
    name: "Bristol: Henleaze to Brislington, across the river",
    from: { lat: 51.4878, lon: -2.6022 },
    to: { lat: 51.4383, lon: -2.5465 },
  },
  {
    name: "York: short hop in the centre",
    from: { lat: 53.958, lon: -1.0803 },
    to: { lat: 53.9609, lon: -1.0859 },
  },
  {
    name: "York: centre to the park and ride",
    from: { lat: 53.958, lon: -1.0803 },
    to: { lat: 53.9512, lon: -1.0231 },
  },
  {
    name: "York: station to Acomb",
    from: { lat: 53.9579, lon: -1.0934 },
    to: { lat: 53.9497, lon: -1.1236 },
  },
  {
    name: "York: Clifton to Fulford, end to end",
    from: { lat: 53.9733, lon: -1.0931 },
    to: { lat: 53.9303, lon: -1.0493 },
  },
];

/** Nine in the morning, which is the hour the profile and the deployed probes both use. */
const DEPART_AT_SECONDS = 9 * 3600;

/**
 * How far a passenger may walk to change buses, in seconds, for this run.
 *
 * A parameter rather than a constant because it is the lever with the most CPU behind it and the
 * most coverage at stake. The graph's walking transfers are what a journey request spends most of
 * its time on — a Birmingham corridor has 126,952 of them over 2,737 stops — and the count goes
 * roughly with the square of this number. Ten minutes of walking between two buses is generous;
 * five is nearer what somebody would actually do.
 *
 * It is not cut on that reasoning. The corpus is recorded at each value and
 * `scripts/compare-journey-plans.ts` says what the tighter one costs: how often it recommends a
 * different ride, how often it arrives materially later, and how often it loses the journey
 * altogether. A number nobody has measured the cost of is not a saving.
 */
const MAX_TRANSFER_SECONDS = Number(arg("max-transfer-seconds") ?? "600");

/**
 * How far either side of the straight line a plan may look, in degrees.
 *
 * The other lever with real CPU behind it, and the other one whose cost has to be measured rather
 * than assumed. A Birmingham corridor at the default width holds 2,737 stops and 13,793 trips; a
 * narrower one opens less timetable and can lose a journey that goes round rather than through.
 */
const CORRIDOR_MARGIN_DEGREES = Number(arg("corridor-margin-degrees") ?? "0.05");

/**
 * How many hours of timetable a plan opens, which is the third lever and now the largest.
 *
 * The deployed planner loads four hours of trips from the departure time. Parsing them is 37 ms of
 * a Manchester request locally — about a hundred on Cloudflare — which since the graph build and
 * the search came down is the single biggest item left in the endpoint. Two hours covers an urban
 * journey comfortably and loses one that takes longer than the horizon, so, like the other two,
 * it is recorded and compared rather than chosen.
 */
const WINDOW_HOURS = Number(arg("window-hours") ?? "4");

/** One option of one answer, in the form a comparison reads. */
interface CorpusOption {
  ranking: string;
  arrivalSeconds: number;
  departureSeconds: number;
  changeCount: number;
  totalWalkSeconds: number;
  /**
   * The planner's own confidence object, carried whole.
   *
   * Declared as `string` and assigned an object, which compiled because nothing typechecked
   * `scripts/`. The recorded corpora have the object in them, so the JSON was always right and the
   * type was always wrong; `scripts/lib/compare-plans.ts` does not read this field, which is why
   * nothing downstream noticed.
   */
  confidence: { level: string; score: number; reasons: readonly string[] };
  boardingStopId: string | null;
  /** The ride, service by service: what a passenger would actually be told to get on. */
  rides: Array<{
    routeId: string | null;
    routeName: string | null;
    fromStopId: string | null;
    toStopId: string | null;
    departureSeconds: number;
    arrivalSeconds: number;
  }>;
}

function optionOf(option: ReturnType<typeof plan>["options"][number]): CorpusOption {
  return {
    ranking: option.ranking,
    arrivalSeconds: option.arrivalSeconds,
    departureSeconds: option.departureSeconds,
    changeCount: option.changeCount,
    totalWalkSeconds: option.totalWalkSeconds,
    confidence: option.confidence,
    boardingStopId: option.boardingStopId,
    rides: option.legs
      .filter((leg) => leg.mode === "bus")
      .map((leg) => ({
        routeId: leg.routeId ?? null,
        routeName: leg.routeName ?? null,
        fromStopId: leg.fromStopId,
        toStopId: leg.toStopId,
        departureSeconds: leg.departureSeconds,
        arrivalSeconds: leg.arrivalSeconds,
      })),
  };
}

async function main(): Promise<number> {
  const resolved = r2StoreFromEnv(process.env);
  if (!resolved.ok) {
    annotateReport("journey corpus", { outcome: "not_configured", missing: resolved.missing });
    return 2;
  }
  const store = resolved.store;
  const index = (await new ArtifactStore(store).readCurrent<NetworkIndexRecord>(SHARDED.index))
    .records[0];
  if (!index) {
    annotateReport("journey corpus", { outcome: "failed", reason: "no index record" });
    return 1;
  }

  const serviceDate = arg("date") ?? new Date().toISOString().slice(0, 10);
  const entries: Array<Record<string, unknown>> = [];
  let answered = 0;

  for (const query of QUERIES) {
    const slice = await loadCorridor(
      store,
      index,
      query,
      serviceDate,
      DEPART_AT_SECONDS,
      WINDOW_HOURS,
      CORRIDOR_MARGIN_DEGREES,
    );
    if (slice.stops.length === 0 || slice.trips.length === 0) {
      entries.push({
        query: query.name,
        from: query.from,
        to: query.to,
        outcome: "no corridor published",
        stops: slice.stops.length,
        trips: slice.trips.length,
      });
      console.log(`${query.name.padEnd(52)} no corridor`);
      continue;
    }

    const graphBegan = process.hrtime.bigint();
    const graph = buildGraph({
      stops: slice.stops,
      trips: slice.trips,
      maxTransferSeconds: MAX_TRANSFER_SECONDS,
    });
    const buildGraphMs = Number(process.hrtime.bigint() - graphBegan) / 1e6;
    const transferEdges = graph.transfers.edgeCount;
    const planBegan = process.hrtime.bigint();
    const result = plan(graph, {
      origin: query.from,
      destination: query.to,
      departAtSeconds: DEPART_AT_SECONDS,
    });
    const planMs = Number(process.hrtime.bigint() - planBegan) / 1e6;
    if (result.options.length > 0) answered += 1;

    entries.push({
      query: query.name,
      from: query.from,
      to: query.to,
      outcome: result.options.length > 0 ? "answered" : "unanswered",
      stops: slice.stops.length,
      trips: slice.trips.length,
      transferEdges,
      /* A runner's milliseconds, which transfer as ratios rather than as figures. */
      buildGraphMs: Number(buildGraphMs.toFixed(2)),
      planMs: Number(planMs.toFixed(2)),
      /*
       * Why an unanswered query was unanswered, carried with it. A replacement that also cannot
       * answer it for the same reason is not a regression; one that fails differently is a
       * different question, and without this they look the same.
       */
      reach: result.reach,
      explanation: result.explanation,
      options: result.options.map(optionOf),
    });
    console.log(
      `${query.name.padEnd(52)} stops ${String(slice.stops.length).padStart(5)} ` +
        `edges ${String(transferEdges).padStart(7)} build ${buildGraphMs.toFixed(1).padStart(7)}ms ` +
        `plan ${planMs.toFixed(1).padStart(6)}ms options ${String(result.options.length)}` +
        (result.options[0]
          ? ` best ${String(result.options[0].arrivalSeconds - DEPART_AT_SECONDS)}s ` +
            `${String(result.options[0].changeCount)} change(s)`
          : ""),
    );
  }

  const report = {
    outcome: "recorded",
    version: index.version,
    serviceDate,
    departAtSeconds: DEPART_AT_SECONDS,
    maxTransferSeconds: MAX_TRANSFER_SECONDS,
    corridorMarginDegrees: CORRIDOR_MARGIN_DEGREES,
    windowHours: WINDOW_HOURS,
    queries: QUERIES.length,
    answered,
    note:
      "The deployed planner's own answers, as the baseline a replacement is compared against. " +
      "Times are seconds after midnight on the service date. `routeName` is null throughout " +
      "because this harness builds its trips from the pattern index without resolving service " +
      "names, which the planner does not need and the comparison does not read — it is a gap in " +
      "this script, not a route the product cannot name.",
    entries,
  };
  if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 1)}\n`);
  /*
   * A summary in the annotation, the whole thing in the artifact.
   *
   * The full report is twenty queries with every option and every ride in each, which the
   * annotator splits into ten parts — and GitHub keeps ten annotations per level per step, so
   * three corpora in one job crowded out the comparison that followed them. The run that measured
   * what a five-minute change walk costs lost the figure for the narrower corridor to exactly
   * that. What a reader wants here is one line a query; what a diff wants is the JSON, and the
   * JSON is uploaded.
   */
  annotateReport("journey corpus", {
    ...report,
    entries: entries.map((entry) => {
      const options = (entry.options ?? []) as CorpusOption[];
      const best = options[0];
      return {
        query: entry.query,
        outcome: entry.outcome,
        stops: entry.stops,
        trips: entry.trips,
        transferEdges: entry.transferEdges,
        buildGraphMs: entry.buildGraphMs,
        planMs: entry.planMs,
        options: options.length,
        ...(best === undefined
          ? {}
          : {
              best: `${String(best.arrivalSeconds - DEPART_AT_SECONDS)}s, ${String(
                best.changeCount,
              )} change(s), ${String(best.rides.length)} ride(s)`,
            }),
      };
    }),
  });
  console.log(`\nAnswered ${String(answered)} of ${String(QUERIES.length)} queries.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    annotateReport("journey corpus", { outcome: "threw", error: String(error).slice(0, 400) });
    process.exit(1);
  });
