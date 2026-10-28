import type { Coordinate, RoutePattern, ServiceRoute } from "@busstops/contracts";
import {
  canHoldBytes,
  canStream,
  corridorBoundingBox,
  objectKeyFor,
  objectKeyForBytes,
  withinBoundingBox,
  type ObjectStore,
} from "@busstops/pipeline-core";
import { readFilteredLinesStreaming } from "./stream-lines.js";
import {
  buildGraph,
  plan,
  type JourneyGraph,
  type PlanResult,
  type Trip,
  type TripStopTime,
} from "@busstops/journey";
import {
  PatternTripShard,
  checkArtifactLayout,
  describeLayoutCheck,
  passengerName,
  patternTripsDataset,
  routeBadgeName,
  tripTilesForBoundingBox,
  tripWindowsFor,
  type ArtifactLayout,
  type PatternTripRow,
} from "@busstops/pipeline-static-network";
import type { NetworkSlice } from "./network-reader.js";

/**
 * Journey planning at the edge.
 *
 * The national timetable cannot live in a Worker isolate, so the graph is built from the
 * spatial tiles a request actually spans. That keeps the work proportional to the journey rather
 * than to the country, which is what makes planning affordable on a free tier at all.
 *
 * Two guards keep it bounded: tiles per request are capped, and so are trips per graph. A request
 * that would exceed either is refused with a reason rather than served slowly or half-answered.
 */

export const JOURNEY_LIMITS = {
  /** Furthest a plan will ask someone to walk to reach a stop. Also the corridor margin. */
  maxAccessWalkMetres: 1200,
  /**
   * More tiles than this means a journey longer than this planner is built for.
   *
   * Counted on the trip grid, which is a quarter degree — the grid the trips are published on,
   * halved from a half degree after London's trip shards went over the byte budget at that size.
   * A corridor across a city is one or two of these and a long local journey four; sixteen leaves
   * room for a diagonal one without admitting a cross-country query this planner is not built to
   * answer.
   *
   * This constant has to move whenever the grid does. It was six for half-degree journey tiles,
   * and left at six it silently refused every journey longer than a mile as "too far" — a grid
   * change arriving as a product limitation rather than as a failure.
   */
  maxTiles: 16,
  /** Upper bound on graph size, so one request cannot exhaust the isolate. */
  maxTrips: 6000,
  maxStops: 4000,
} as const;

export interface JourneyPlanRequest {
  origin: Coordinate;
  destination: Coordinate;
  departAtSeconds: number;
  serviceDate: string;
  /** The layout the artifact declares, from the network index. Absent on older publishes. */
  layout?: ArtifactLayout | null;
  /**
   * Patterns by id, for the trips this corridor actually holds.
   *
   * The planner needs a pattern's stop sequence and never its geometry, and it was getting that
   * from the corridor's pattern tiles — which carry geometry, reach 3,935,975 bytes each, and put
   * a Leeds corridor past its budget, so the planner refused to plan rather than plan on half of
   * one. The trips name their patterns, so the order reverses: read the trips, then ask for
   * exactly the patterns they named.
   *
   * Absent on an artifact published before the pattern index existed, and then the slice's own
   * patterns are used as before.
   */
  resolvePatterns?: (
    patternIds: readonly string[],
  ) => Promise<{ patterns: Map<string, RoutePattern>; complete: boolean; available: boolean }>;
  /**
   * The services of the patterns this plan ended up with, asked for once they are known.
   *
   * The slice used to carry every service in England because it had no way of knowing which ones
   * the corridor's trips would name — and that read is an FNV-1a hash over 4.7 MiB plus a parse of
   * 13,626 records, which is tens of milliseconds against the ten a free invocation gets. It is
   * looked up in exactly one place, inside the trip loop, by `pattern.serviceRouteId`; by then the
   * patterns are resolved and the ids are a few hundred.
   *
   * Absent means use whatever the slice brought, which is what every caller did before this.
   */
  resolveServices?: (serviceIds: readonly string[]) => Promise<ReadonlyMap<string, ServiceRoute>>;
  /** The publish these shards belong to, from the network index, as every other reader takes it. */
  version: string;
}

/**
 * Why a plan came out the way it did, in numbers rather than in prose.
 *
 * A journey answered "0 options" and the response said only "We could not find a bus journey
 * between these points at this time." That sentence covers at least six unrelated situations —
 * no shard was written, a shard could not be read, the corridor spans too many tiles, the trips
 * loaded but none of their patterns were in the slice, the graph hit a size limit, or the search
 * genuinely found no path — and a deployed check could not tell them apart, so neither could
 * anyone reading it. The response carried `unavailableReason` and the deployed check read
 * `reason`, which meant even the prose was invisible.
 *
 * Every count here exists to separate two of those cases. `tripsWithoutPattern` is the sharpest:
 * trips are published on one grid and the patterns that give them their stops on another, so a
 * high number means the join failed rather than that England has no buses.
 */
export interface JourneyDiagnostics {
  /** Machine-readable outcome, including the two ways of having no options. */
  code:
    | "planned"
    | "no_options"
    | "too_far"
    | "no_data"
    | "unreadable"
    | "too_large"
    | "artifact_format_mismatch"
    /*
     * The corridor's trip shards could not all be opened inside the request's budget.
     *
     * Distinct from `too_large`, which is a graph the planner refuses to build, and from
     * `no_data`, which is a corridor with nothing published. The timetable is there and part of
     * it was not read, so an itinerary built on it would be a guess with departure times on it.
     */
    | "incomplete_read";
  /**
   * Whether the artifact said how it was stored, and whether this reader agrees.
   *
   * `undeclared` is not `compatible`: an artifact published before layouts were recorded cannot
   * be checked, and saying so is what separates a verified deployment from an assumed one.
   */
  layout: "compatible" | "undeclared" | "mismatch";
  corridorTiles: number;
  windows: number[];
  /** Shards the corridor needed, before any budget was applied. */
  shardsRequested?: number;
  shardsRead: number;
  shardsMissing: number;
  /** Shards the budget left unopened. Non-zero is what makes the outcome `incomplete_read`. */
  shardsSkipped?: number;
  /** Rows parsed and immediately discarded as outside the plan's window or corridor patterns. */
  tripsFiltered?: number;
  /**
   * Shards that were read in the published binary form rather than as JSON lines.
   *
   * Here because the binary form is the whole reason a journey can fit in a passenger request's
   * CPU, and because "the fast path was not taken" and "the fast path is not fast" are different
   * problems. A deployed walk that reports zero of these is measuring the text path.
   */
  shardsBinary?: number;
  /** Binary shards that could not be opened, and were read as text instead. */
  shardsBinaryFallback?: number;
  /** Patterns the corridor's trips named, and therefore the patterns that had to be read. */
  patternsRequested?: number;
  /** Trip rows read out of the shards. */
  tripsLoaded: number;
  /** Rows whose pattern was present in the slice, and rows whose pattern was not. */
  tripsWithPattern: number;
  tripsWithoutPattern: number;
  /** Trips that survived into the graph, and the stops the corridor kept. */
  tripsInGraph: number;
  stopsInGraph: number;
  /** Walking transfers between those stops: the edges the search moves along between rides. */
  transferEdges: number;
  /**
   * Milliseconds per stage, so a slow plan says which part of it was slow.
   *
   * Leeds to Leeds Bradford Airport answered Cloudflare error 1102 — the platform killing the
   * isolate — and the counts alone could not say whether the cost was in reading the shards,
   * parsing them, joining trips to patterns, building the graph, generating transfers or running
   * the search. Timing each one is what turns "it is too expensive" into a thing to fix.
   */
  stageMs: Record<string, number>;
  /** Characters of trip shard text this plan decoded. */
  tripChars: number;
  /** The budget it was decoded against, so a truncation can be read against its cause. */
  tripCharBudget?: number;
  /**
   * Stops within walking distance of each end, and how the search fared.
   *
   * Zero at either end is stop selection, not planning: nothing was close enough to walk to. A
   * search that ran rounds and produced no itinerary is the planner genuinely finding no path.
   */
  originCandidates: number;
  destinationCandidates: number;
  rounds: number;
  roundsWithOption: number;
  patternsInSlice: number;
  stopsInSlice: number;
  failures: Array<{ dataset: string; reason: string }>;
}

export type JourneyPlanOutcome =
  | {
      ok: true;
      result: PlanResult;
      tilesLoaded: string[];
      tripCount: number;
      /**
       * Shards the plan could not read.
       *
       * A plan built on part of the corridor is not a plan, it is a plausible-looking guess, so
       * the caller is told rather than left to present it as complete. This replaces a `catch`
       * that cached an empty tile and carried on.
       */
      failures: Array<{ dataset: string; reason: string }>;
      diagnostics: JourneyDiagnostics;
    }
  | {
      ok: false;
      reason: string;
      code:
        | "too_far"
        | "no_data"
        | "too_large"
        | "unreadable"
        | "artifact_format_mismatch"
        | "incomplete_read";
      diagnostics: JourneyDiagnostics;
    };

/**
 * How many shards an isolate keeps, and how much text they were parsed from.
 *
 * The previous cache was an unbounded Map keyed by tile and service date, which in a long-lived
 * isolate is the national timetable arriving one corridor at a time — the exact failure the
 * sharding exists to prevent, just slower.
 */
const MAX_CACHED_TRIP_SHARDS = 16;
/**
 * The pattern id out of a spilled trip line, without building the row.
 *
 * This is the whole fix for the journey planner's CPU. A corridor tile holds every pattern that
 * crosses a half-degree square, and run 75 measured the consequence: 3,130 trip rows parsed to keep
 * 479, with 2,651 thrown away immediately after being built. `JSON.parse` on one of these lines also
 * builds two numeric arrays of thirty-odd departure times each, so five sixths of the planner's parse
 * cost went to rows it discarded in the next statement.
 *
 * Scanning text is cheap and parsing it is not — the same asymmetry that makes the map's filtered
 * parse affordable at 2.08 MiB. A trip line is `{"p":"<id>","j":…}`, so the pattern can be read with
 * an indexOf and a slice. Pattern ids are UUIDs, so there is no escaping to get wrong.
 *
 * Returns null rather than guessing when the shape is not what it expects, and a null falls through
 * to the full parse: dropping a trip because a scan did not understand its line would silently
 * remove buses from a journey, which is far worse than parsing one row too many.
 */
export function patternIdInTripLine(line: string): string | null {
  const at = line.indexOf('"p":"');
  if (at === -1) return null;
  const from = at + 5;
  const end = line.indexOf('"', from);
  return end === -1 ? null : line.slice(from, end);
}

/**
 * When a trip line's calls begin and end, read off the raw text.
 *
 * The pattern test already ran before the parse; the time test did not, and it is the other half
 * of what a plan keeps. A published shard holds an eight-hour window and a plan spans four, so
 * about half the rows in it are outside the plan's horizon — and they were parsed into objects
 * with two arrays of twenty-five numbers each before the next statement discarded them. Parsing
 * the trips is 37 ms of a Manchester corridor locally, which since the graph build and the search
 * came down is the largest item left in the endpoint.
 *
 * Only the first and the last departure are needed, because the array is in stop order and so in
 * time order: the row can be kept if its last call is at or after the plan begins and its first
 * is at or before the plan ends. Returns null when the shape is not recognised, and a line that
 * is not recognised is parsed rather than dropped — losing a bus because a text scan was confused
 * is far worse than parsing one row too many.
 */
export function tripWindowInLine(line: string): { first: number; last: number } | null {
  const open = line.indexOf('"t":[');
  if (open === -1) return null;
  const close = line.indexOf("]", open + 5);
  if (close === -1) return null;

  const firstEnd = line.indexOf(",", open + 5);
  const first = Number(
    line.slice(open + 5, firstEnd === -1 || firstEnd > close ? close : firstEnd),
  );
  const lastStart = line.lastIndexOf(",", close);
  const last = Number(line.slice(lastStart > open + 4 ? lastStart + 1 : open + 5, close));
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return { first, last };
}

/*
 * Two mebibytes, down from eight, for the reason in network-reader.ts: a warm cache is paid for in
 * the CPU of whichever request triggers collection, and CPU is the resource this platform rations.
 * A corridor's trips are re-read from R2 instead, which costs a free operation and no compute.
 */
const MAX_CACHED_TRIP_CHARS = 2 * 1024 * 1024;

/**
 * How much trip shard text one plan will open.
 *
 * This is the stage that answered Cloudflare error 1102 on Leeds to Leeds Bradford Airport. The
 * read was a plain nested loop over sixteen corridor tiles and up to six windows, with nothing
 * counting what it opened; the largest published pattern-trips shard is 8,109,406 bytes, so a
 * corridor could ask for ninety-six of those and the isolate was gone long before the search ran.
 *
 * Twelve mebibytes is what a city corridor's shards actually cost, measured against real ones. A
 * plan that wants more is refused with `incomplete_read` rather than served: a journey built on
 * part of the corridor's timetable is a plausible-looking guess, and offering one as an itinerary
 * is worse than saying it could not be planned.
 */
const JOURNEY_TRIP_READ_CHARS = 12 * 1024 * 1024;

/**
 * And how long it may spend doing it.
 *
 * Bytes are not the only way to run out. A reader that only counts bytes will happily spend four
 * seconds counting them, and the platform does not care which resource ended the request — so the
 * clock is a second budget, and the plan owns it rather than leaving Cloudflare to end the request
 * first.
 */
const JOURNEY_TRIP_READ_BUDGET_MS = 3_000;

/**
 * Shards read before anything is known about how big they are, and the most read at once after.
 *
 * One, not four. A trip shard is an order of magnitude larger than a stop tile, and the first
 * round trip is the one no budget can undo: four of the largest arriving together is thirty-two
 * megabytes of text decoded before a single check runs. After the first, the measured average
 * decides — wide where a rural corridor's shards are small, one at a time in London.
 */
const FIRST_TRIP_SHARD_BATCH = 1;
const TRIP_SHARD_BATCH = 3;

export class JourneyService {
  private readonly cache = new Map<string, { rows: PatternTripRow[]; chars: number }>();

  constructor(
    private readonly store: ObjectStore,
    /**
     * Overridable so a test can make the budget bite on a fixture far too small to reach it.
     *
     * Without this the only way to prove the refusal is a twelve-mebibyte fixture, which is not a
     * test anybody runs. The production value is the default and nothing but a test passes
     * anything else.
     */
    private readonly tripCharBudget = JOURNEY_TRIP_READ_CHARS,
  ) {}

  async planJourney(slice: NetworkSlice, request: JourneyPlanRequest): Promise<JourneyPlanOutcome> {
    const corridor = corridorBoundingBox(
      request.origin,
      request.destination,
      JOURNEY_LIMITS.maxAccessWalkMetres,
    );
    const tiles = tripTilesForBoundingBox(corridor);

    const layoutCheck = checkArtifactLayout(request.layout ?? null);

    // Filled in as the plan proceeds, so whatever it returns says how far it got.
    const diagnostics: JourneyDiagnostics = {
      code: "no_data",
      layout: layoutCheck.state === "mismatch" ? "mismatch" : layoutCheck.state,
      corridorTiles: tiles.length,
      windows: [],
      shardsRead: 0,
      shardsMissing: 0,
      tripsLoaded: 0,
      tripsWithPattern: 0,
      tripsWithoutPattern: 0,
      tripsInGraph: 0,
      stopsInGraph: 0,
      transferEdges: 0,
      stageMs: {},
      tripChars: 0,
      originCandidates: 0,
      destinationCandidates: 0,
      rounds: 0,
      roundsWithOption: 0,
      patternsInSlice: slice.patternsById.size,
      stopsInSlice: slice.stopsById.size,
      failures: [],
    };

    /*
     * Refused before a single shard is requested. A reader that does not know how the artifact was
     * filed will ask for keys that cannot exist and then describe the country as having no buses —
     * which is exactly what happened, and is worse than an error because it reads as an answer.
     */
    if (layoutCheck.state === "mismatch") {
      return {
        ok: false,
        code: "artifact_format_mismatch",
        reason:
          "The published timetable was stored in a layout this server cannot read, so no journey " +
          "can be planned until the two are brought back into step. This is a fault on our side, " +
          `not an absence of buses. (${describeLayoutCheck(layoutCheck)})`,
        diagnostics: { ...diagnostics, code: "artifact_format_mismatch" },
      };
    }

    if (tiles.length > JOURNEY_LIMITS.maxTiles) {
      return {
        ok: false,
        code: "too_far",
        reason:
          "These points are too far apart for this planner. It is built for local journeys, not cross-country ones.",
        diagnostics: { ...diagnostics, code: "too_far" },
      };
    }

    const readBegan = Date.now();
    const loaded = await this.loadTrips(
      tiles,
      request,
      request.resolvePatterns ? null : new Set(slice.patternsById.keys()),
    );
    diagnostics.stageMs.loadTrips = Date.now() - readBegan;
    diagnostics.stageMs.readTrips = loaded.readMs;
    diagnostics.stageMs.parseTrips = loaded.parseMs;
    diagnostics.tripChars = loaded.chars;
    diagnostics.tripCharBudget = this.tripCharBudget;
    diagnostics.windows = loaded.windows;
    diagnostics.shardsRequested = loaded.shardsRequested;
    diagnostics.shardsRead = loaded.shardsRead;
    diagnostics.shardsMissing = loaded.shardsMissing;
    diagnostics.shardsSkipped = loaded.shardsSkipped;
    diagnostics.tripsFiltered = loaded.tripsFiltered;
    diagnostics.shardsBinary = loaded.shardsBinary;
    diagnostics.shardsBinaryFallback = loaded.shardsBinaryFallback;
    diagnostics.tripsLoaded = loaded.rows.length;
    diagnostics.failures = loaded.failures;

    /*
     * A corridor that was not read in full does not get an itinerary.
     *
     * This is the one place the map's rule and the planner's rule differ. A map that ran out of
     * budget can draw the stops it has and say so, because a partly-drawn map is still a map. A
     * journey cannot: the shard that was not opened is where the fast direct bus was, and a plan
     * built without it is not a worse plan, it is a wrong one — offered with departure times, a
     * platform and a walk, all of it confident. So the budget produces a refusal with a reason,
     * never a shorter list of options.
     */
    if (loaded.truncated) {
      return {
        ok: false,
        code: "incomplete_read",
        reason:
          "We could not read the whole timetable for this corridor inside one request, so any " +
          "journey we showed you might be missing the bus you actually want. Try a shorter " +
          "journey, or try again shortly.",
        diagnostics: { ...diagnostics, code: "incomplete_read" },
      };
    }

    if (loaded.rows.length === 0) {
      /*
       * Nothing read and something failed is a different answer from nothing read and nothing
       * there. Saying "no timetable is published here" when the timetable could not be fetched is
       * the mistake this whole change is about.
       */
      if (loaded.failures.length > 0) {
        return {
          ok: false,
          code: "unreadable",
          reason:
            "The timetable for this area could not be read just now, so we cannot plan a journey. This is a fault on our side, not an absence of buses.",
          diagnostics: { ...diagnostics, code: "unreadable" },
        };
      }
      return {
        ok: false,
        code: "no_data",
        reason:
          "No timetable data is published for this area yet, so we cannot plan a journey here.",
        diagnostics: { ...diagnostics, code: "no_data" },
      };
    }

    /*
     * Now the patterns, and only the ones these trips actually named.
     *
     * This is the journey planner's version of what the route-pattern index did for route detail:
     * a targeted read of a handful of small rows in place of a geographic scan of megabytes of
     * geometry the planner never looks at. An incomplete resolution is still a refusal — a pattern
     * that could not be read is a bus the plan cannot see.
     */
    let planningSlice = slice;
    if (request.resolvePatterns) {
      /*
       * Only the patterns the corridor slice does not already have.
       *
       * This asked the index for every pattern the trips named, including the ones already read
       * as geometry a moment earlier — and then *replaced* the slice's patterns with the index's
       * answer, throwing away the ones the index could not supply. Run 46 measured what that
       * cost: 190 patterns wanted, 92 index objects read, 12 mebibytes of request budget spent,
       * and the read cut short with 114 of 190 resolved, so the planner refused a journey it had
       * most of the material for.
       *
       * The slice's patterns are the same records, already in the isolate and already paid for.
       * Asking only for the remainder is strictly less reading, and merging rather than replacing
       * is strictly more patterns.
       */
      const wanted = [
        ...new Set(loaded.rows.map((row) => row.p).filter((id) => !slice.patternsById.has(id))),
      ];
      const patternBegan = Date.now();
      const resolved = await request.resolvePatterns(wanted);
      diagnostics.stageMs.resolvePatterns = Date.now() - patternBegan;
      diagnostics.patternsRequested = wanted.length;

      if (resolved.available) {
        const merged = new Map(slice.patternsById);
        for (const [id, pattern] of resolved.patterns) merged.set(id, pattern);
        diagnostics.patternsInSlice = merged.size;
        if (!resolved.complete) {
          return {
            ok: false,
            code: "incomplete_read",
            reason:
              "We could not read every route along this corridor inside one request, so any " +
              "journey we showed you might be missing the bus you actually want. Try a shorter " +
              "journey, or try again shortly.",
            diagnostics: { ...diagnostics, code: "incomplete_read" },
          };
        }
        planningSlice = { ...slice, patternsById: merged };
        // Rows on a pattern nothing could resolve cannot become trips; dropping them here keeps
        // them out of the graph builder's memory rather than out of its output.
        loaded.rows = loaded.rows.filter((row) => merged.has(row.p));
        diagnostics.tripsLoaded = loaded.rows.length;
      }
    }

    /*
     * The services of the patterns this plan actually has, asked for now that they are known.
     *
     * The slice used to arrive carrying every service in England, because at slice time nothing
     * knew which ones the corridor's trips would name. A service is looked up in exactly one
     * place — inside the trip loop, by `pattern.serviceRouteId` — and by here the patterns are
     * resolved, so the ids are a few hundred rather than 13,626.
     */
    if (request.resolveServices) {
      const serviceIds = [
        ...new Set(
          [...planningSlice.patternsById.values()]
            .map((pattern) => pattern.serviceRouteId)
            .filter((id) => !planningSlice.services.has(id)),
        ),
      ];
      if (serviceIds.length > 0) {
        const servicesBegan = Date.now();
        const resolved = await request.resolveServices(serviceIds);
        diagnostics.stageMs.resolveServices = Date.now() - servicesBegan;
        const merged = new Map(planningSlice.services);
        for (const [id, service] of resolved) merged.set(id, service);
        planningSlice = { ...planningSlice, services: merged };
      }
    }

    const graphBegan = Date.now();
    const built = buildGraphFor(planningSlice, loaded.rows, corridor, request.serviceDate);
    diagnostics.stageMs.buildGraph = Date.now() - graphBegan;
    diagnostics.tripsWithPattern = built.tripsWithPattern;
    diagnostics.tripsWithoutPattern = built.tripsWithoutPattern;

    if (built.graph === null) {
      return {
        ok: false,
        code: "too_large",
        reason:
          "This journey covers more of the network than we can plan in one request. Try a shorter journey.",
        diagnostics: { ...diagnostics, code: "too_large" },
      };
    }

    const graph = built.graph;
    diagnostics.tripsInGraph = graph.trips.length;
    diagnostics.stopsInGraph = graph.stops.size;
    let transferEdges = 0;
    for (const transfers of graph.transfers.values()) transferEdges += transfers.length;
    diagnostics.transferEdges = transferEdges;

    const searchBegan = Date.now();
    const result = plan(graph, {
      origin: request.origin,
      destination: request.destination,
      departAtSeconds: request.departAtSeconds,
      maxAccessWalkSeconds: Math.round(JOURNEY_LIMITS.maxAccessWalkMetres / 1.3),
    });

    diagnostics.stageMs.search = Date.now() - searchBegan;
    diagnostics.originCandidates = result.reach.originCandidates;
    diagnostics.destinationCandidates = result.reach.destinationCandidates;
    diagnostics.rounds = result.reach.rounds;
    diagnostics.roundsWithOption = result.reach.roundsWithOption;

    return {
      ok: true,
      result,
      tilesLoaded: tiles,
      tripCount: graph.trips.length,
      failures: loaded.failures,
      /*
       * `no_options` rather than `planned` when the search found nothing. A graph that was built
       * from real trips and yields no path is a different fact from an empty area, and it is the
       * one the numbers above are needed to interpret.
       */
      diagnostics: { ...diagnostics, code: result.options.length > 0 ? "planned" : "no_options" },
    };
  }

  /**
   * The trips a corridor needs, from the shards they are published in.
   *
   * Reads the pattern tiles the corridor crosses, for the windows the search spans plus one of
   * lookback — a trip is filed under the window its first call falls in, and a bus that left an
   * hour before the search still matters.
   *
   * A shard that was never written is an area with nothing scheduled in that window. A shard that
   * cannot be read is a failure, and is returned as one: the previous version cached an empty
   * tile and carried on, so a corridor whose timetable was unreachable produced a confident
   * "no journeys found".
   */
  private async loadTrips(
    tiles: readonly string[],
    request: JourneyPlanRequest,
    /**
     * Null when the patterns are not known yet.
     *
     * With the pattern index the order reverses — the trips say which patterns to fetch — so the
     * pattern test cannot be applied while parsing. The time test still can, and it is the one
     * that drops most of a shard: a window is eight hours and a plan spans four.
     */
    patternIds: ReadonlySet<string> | null,
  ): Promise<{
    rows: PatternTripRow[];
    failures: Array<{ dataset: string; reason: string }>;
    windows: number[];
    shardsRequested: number;
    shardsRead: number;
    shardsMissing: number;
    shardsSkipped: number;
    tripsFiltered: number;
    shardsBinary: number;
    shardsBinaryFallback: number;
    chars: number;
    readMs: number;
    parseMs: number;
    truncated: boolean;
    stoppedBy: "chars" | "clock" | null;
  }> {
    const rows: PatternTripRow[] = [];
    const failures: Array<{ dataset: string; reason: string }> = [];
    let shardsRead = 0;
    let shardsMissing = 0;
    let tripsFiltered = 0;
    let shardsBinary = 0;
    let shardsBinaryFallback = 0;
    let chars = 0;
    let readMs = 0;
    let parseMs = 0;
    let stoppedBy: "chars" | "clock" | null = null;

    const began = Date.now();
    const midnight = Date.parse(`${request.serviceDate}T00:00:00Z`) / 1000;
    const from = midnight + request.departAtSeconds;
    // A plan looks a few hours ahead; beyond that the answer is a different day's timetable.
    const to = from + 4 * 60 * 60;
    const windows = tripWindowsFor(from, to, request.serviceDate);

    /*
     * Tile-major, and the tiles arrive centre-out from the corridor, so what a budget cannot
     * reach is the far end of the corridor rather than an arbitrary set of shards. It does not
     * change what is served — a truncated read is refused, not returned — but it decides which
     * corridors fit at all.
     */
    const datasets: string[] = [];
    for (const tile of tiles) {
      for (const window of windows) {
        datasets.push(patternTripsDataset(request.serviceDate, tile, window));
      }
    }

    /*
     * A trip that cannot appear in this plan is dropped as it is parsed, not after.
     *
     * A window is eight hours and a plan spans four, and a corridor tile holds every pattern that
     * crosses it rather than only the ones the search can use. Keeping all of that and letting
     * the graph builder discard it means the isolate holds the whole shard as objects — which is
     * several times the text it came from — for the sake of a fraction of it. The two tests are
     * exactly the ones the graph would apply later: a trip still running inside the plan's window,
     * on a pattern the corridor slice actually has.
     */
    const keep = (row: PatternTripRow): boolean => {
      if (patternIds !== null && !patternIds.has(row.p)) return false;
      const times = row.t;
      if (times.length === 0) return false;
      return times[times.length - 1]! >= from && times[0]! <= to;
    };

    let start = 0;
    let batchSize = FIRST_TRIP_SHARD_BATCH;
    let opened = 0;

    while (start < datasets.length) {
      const batch = datasets.slice(start, start + batchSize);
      const readBegan = Date.now();
      /*
       * Read, filtered and parsed inside the batch, rather than collected as text and filtered
       * after.
       *
       * This held `raw` for every shard in the batch and then ran `raw.split("\n")` over each —
       * the largest published pattern-trips shard is 8,109,406 bytes, so a batch of four was
       * thirty-two megabytes of strings and then thirty-two megabytes of substrings on top. The
       * isolate's 128 MB ceiling is **per isolate, not per invocation**, so those allocations are
       * charged against every request that follows on the same isolate, which is why a journey
       * could die reporting a few cheap megabytes of its own.
       *
       * Nothing about which trips survive changes: the same pattern test off the raw text, the
       * same `keep` on the parsed row, in the same order.
       */
      const results = await Promise.all(
        batch.map(async (dataset) => {
          const cacheKey = `${request.version}:${dataset}:${from}:${to}`;
          const cached = this.cache.get(cacheKey);
          if (cached) return { kind: "cached", dataset, cached } as const;
          const objectKey = objectKeyFor(dataset, request.version);
          try {
            /*
             * The published binary shard first, when there is one.
             *
             * This is the stage that did not fit. A corridor opens about eight megabytes of trip
             * text and `JSON.parse` over it measured 24.26 ms against a ten-millisecond budget —
             * more than the graph build and the search put together, and the search is the only
             * part of a request that is actually transport computation. The same shard published
             * columnar is read through typed arrays: the horizon test is two integer comparisons
             * per trip and costs nothing, and only the trips that survive are built into rows.
             * Measured on a Manchester-shaped shard: 19.18 ms of text against 7.10 ms of bytes
             * for the same answer, and 0.65 ms if the rows are not materialised at all, which is
             * where the graph builder has to go next.
             *
             * A shard that cannot be opened falls through to the text sibling and is counted,
             * rather than failing the plan: corrupt bytes are a publishing fault, and a passenger
             * should not lose a journey to one while it is being fixed. A count rather than a
             * silent fallback, because "the fast path was not taken" has to be visible.
             */
            let binaryFallback = false;
            if (canHoldBytes(this.store)) {
              const binary = await this.readBinaryShard(
                dataset,
                request.version,
                from,
                to,
                patternIds,
              );
              if (binary?.kind === "binary") return binary;
              binaryFallback = binary !== null;
            }
            if (!canStream(this.store)) {
              const raw = await this.store.get(objectKey);
              return { kind: "buffered", dataset, raw, binaryFallback } as const;
            }
            const body = await this.store.getStream(objectKey);
            if (body === null) {
              return { kind: "buffered", dataset, raw: null, binaryFallback } as const;
            }

            let filtered = 0;
            const read = await readFilteredLinesStreaming<PatternTripRow>(body, {
              key: objectKey,
              keep: (buffer, lineStart, lineEnd) => {
                /*
                 * Both tests off the text, before anything is built.
                 *
                 * The pattern test was here and the window test was not — it ran on the parsed
                 * row, one statement after the parse it should have prevented. A shard holds an
                 * eight-hour window and a plan spans four, so about half of what survives the
                 * pattern test is outside the horizon and was built into an object with two
                 * arrays of twenty-five numbers first.
                 *
                 * A line whose shape either scan does not recognise falls through to the parse
                 * rather than being dropped: removing a bus from a journey because a scan was
                 * confused is far worse than parsing one row too many.
                 */
                const line = buffer.slice(lineStart, lineEnd);
                if (patternIds !== null) {
                  const pattern = patternIdInTripLine(line);
                  if (pattern !== null && !patternIds.has(pattern)) {
                    filtered += 1;
                    return false;
                  }
                }
                const window = tripWindowInLine(line);
                if (window !== null && (window.last < from || window.first > to)) {
                  filtered += 1;
                  return false;
                }
                return true;
              },
              take: (row) => {
                if (keep(row)) return "keep";
                filtered += 1;
                return "drop";
              },
            });
            return {
              kind: "streamed",
              dataset,
              rows: read.records,
              chars: read.stats.chars,
              filtered,
              binaryFallback,
            } as const;
          } catch (error) {
            return { kind: "error", dataset, error } as const;
          }
        }),
      );
      readMs += Date.now() - readBegan;
      start += batch.length;

      for (const result of results) {
        if (result.kind === "cached") {
          // A cached empty shard is one that was absent when first asked for, not one that was
          // read and found empty; counting it as read would overstate the coverage of the plan.
          if (result.cached.chars === 0) shardsMissing += 1;
          else {
            shardsRead += 1;
            opened += 1;
          }
          chars += result.cached.chars;
          for (const row of result.cached.rows) rows.push(row);
          continue;
        }
        if (result.kind === "binary") {
          /*
           * A shard read without a parse. Counted as read like any other, with its bytes against
           * the same budget — which is a byte budget in all but name, and the published binary
           * form is about 46% of the text it replaces, so the same ceiling reaches further up the
           * corridor than it used to.
           */
          shardsRead += 1;
          shardsBinary += 1;
          opened += 1;
          chars += result.bytes;
          tripsFiltered += result.filtered;
          this.cache.set(`${request.version}:${result.dataset}:${from}:${to}`, {
            rows: result.rows,
            chars: result.bytes,
          });
          this.evict();
          for (const row of result.rows) rows.push(row);
          continue;
        }
        if (result.kind === "error") {
          failures.push({
            dataset: result.dataset,
            reason:
              result.error instanceof Error
                ? `${result.error.name}: ${result.error.message}`
                : "unreadable",
          });
          continue;
        }
        if (result.kind === "streamed") {
          if (result.binaryFallback) shardsBinaryFallback += 1;
          shardsRead += 1;
          opened += 1;
          chars += result.chars;
          tripsFiltered += result.filtered;
          /*
           * Timed as read rather than split between read and parse. A streamed read interleaves
           * the two by construction — the filter runs on a chunk while the next one is in flight
           * — so attributing part of it to a parse clock would be an invention. `parseMs` stays
           * for the buffered path, where the two really are separate.
           */
          this.cache.set(`${request.version}:${result.dataset}:${from}:${to}`, {
            rows: result.rows,
            chars: result.chars,
          });
          this.evict();
          for (const row of result.rows) rows.push(row);
          continue;
        }
        if (result.binaryFallback) shardsBinaryFallback += 1;
        if (result.raw === null) {
          this.cache.set(`${request.version}:${result.dataset}:${from}:${to}`, {
            rows: [],
            chars: 0,
          });
          shardsMissing += 1;
          continue;
        }

        shardsRead += 1;
        opened += 1;
        chars += result.raw.length;
        // Timed apart from the read, because "the network was slow" and "parsing eight
        // megabytes of JSON was slow" are different problems with different fixes.
        const parseBegan = Date.now();
        const parsed: PatternTripRow[] = [];
        for (const line of result.raw.split("\n")) {
          if (line.length === 0) continue;
          /*
           * Both tests off the text, before anything is built, exactly as the streaming path does
           * them. Five sixths of what this loop used to construct was discarded by `keep` one
           * statement later, and half of the rest is outside the plan's horizon. The two read
           * paths have to filter identically or a store without streaming would answer a
           * different plan from one with it.
           */
          if (patternIds !== null) {
            const pattern = patternIdInTripLine(line);
            if (pattern !== null && !patternIds.has(pattern)) {
              tripsFiltered += 1;
              continue;
            }
          }
          const window = tripWindowInLine(line);
          if (window !== null && (window.last < from || window.first > to)) {
            tripsFiltered += 1;
            continue;
          }
          const row = JSON.parse(line) as PatternTripRow;
          if (keep(row)) parsed.push(row);
          else tripsFiltered += 1;
        }
        parseMs += Date.now() - parseBegan;
        this.cache.set(`${request.version}:${result.dataset}:${from}:${to}`, {
          rows: parsed,
          chars: result.raw.length,
        });
        this.evict();
        for (const row of parsed) rows.push(row);
      }

      /*
       * Two ways to run out, and a corridor can hit either first. Checked after every batch, and
       * the batch is sized so that what has already arrived cannot have overshot by more than one
       * shard's worth.
       */
      if (chars >= this.tripCharBudget) stoppedBy = "chars";
      else if (Date.now() - began >= JOURNEY_TRIP_READ_BUDGET_MS) stoppedBy = "clock";
      if (stoppedBy) break;

      const averageChars = Math.max(1, Math.ceil(chars / Math.max(1, opened)));
      const affordable = Math.floor((this.tripCharBudget - chars) / averageChars);
      batchSize = Math.max(1, Math.min(TRIP_SHARD_BATCH, affordable));
    }

    const truncated = start < datasets.length;

    return {
      rows,
      failures,
      windows,
      shardsRequested: datasets.length,
      shardsRead,
      shardsMissing,
      shardsSkipped: datasets.length - start,
      tripsFiltered,
      shardsBinary,
      shardsBinaryFallback,
      chars,
      readMs,
      parseMs,
      truncated,
      stoppedBy: truncated ? stoppedBy : null,
    };
  }

  /**
   * One shard in its published binary form, or null when there is not one to read.
   *
   * Null means "no binary shard here", which is not a failure: the migration converts the bucket
   * shard by shard, and a corridor can legitimately be half converted. The caller then reads the
   * text sibling. A shard that exists and cannot be opened also returns null — with the fallback
   * counted, so that a publishing fault shows up as a number rather than as a slow endpoint.
   *
   * The two filters are the same two the text path applies, in the cheaper order: the horizon
   * test is two integer comparisons against a typed array, and the pattern test needs a string,
   * so the pattern ids are decoded once per shard (there are a few hundred) into a flag per
   * pattern index rather than once per trip (there are tens of thousands).
   */
  private async readBinaryShard(
    dataset: string,
    version: string,
    from: number,
    to: number,
    patternIds: ReadonlySet<string> | null,
  ): Promise<
    | { kind: "binary"; dataset: string; rows: PatternTripRow[]; bytes: number; filtered: number }
    | { kind: "unreadable" }
    | null
  > {
    if (!canHoldBytes(this.store)) return null;
    let bytes: Uint8Array | null;
    try {
      bytes = await this.store.getBytes(objectKeyForBytes(dataset, version));
    } catch {
      /* Reading it failed outright. The text sibling is the answer, and it is counted there. */
      return { kind: "unreadable" };
    }
    if (bytes === null) return null;

    try {
      const shard = new PatternTripShard(bytes);
      const wanted: boolean[] | null =
        patternIds === null
          ? null
          : Array.from({ length: shard.patternCount }, (_, index) =>
              patternIds.has(shard.patternId(index)),
            );

      const rows: PatternTripRow[] = [];
      let filtered = 0;
      for (let trip = 0; trip < shard.tripCount; trip += 1) {
        if (shard.lastDeparture(trip) < from || shard.firstDeparture(trip) > to) {
          filtered += 1;
          continue;
        }
        if (wanted !== null && !wanted[shard.patternOf(trip)]) {
          filtered += 1;
          continue;
        }
        rows.push(shard.rowAt(trip));
      }
      return { kind: "binary", dataset, rows, bytes: bytes.byteLength, filtered };
    } catch {
      return { kind: "unreadable" };
    }
  }

  private evict(): void {
    let chars = 0;
    for (const shard of this.cache.values()) chars += shard.chars;
    if (this.cache.size <= MAX_CACHED_TRIP_SHARDS && chars <= MAX_CACHED_TRIP_CHARS) return;
    for (const [key, shard] of [...this.cache].slice(0, -1)) {
      if (this.cache.size <= MAX_CACHED_TRIP_SHARDS && chars <= MAX_CACHED_TRIP_CHARS) break;
      this.cache.delete(key);
      chars -= shard.chars;
    }
  }

  /** How much text the resident shards were parsed from. Exposed so a test can bound it. */
  get cachedChars(): number {
    let total = 0;
    for (const shard of this.cache.values()) total += shard.chars;
    return total;
  }
}

/**
 * Builds the search graph, or null when the request would exceed the size guards.
 *
 * A trip row carries times and nothing else; the stops come from the pattern it names. That
 * pairing is the whole economy of the format — 296 bytes for 45 calls against the 10,313 a
 * journey cost to say the same thing — and it means a row whose pattern is not in this slice
 * cannot be placed at all, so it is skipped rather than guessed at.
 */
/**
 * The graph a corridor's trips make, with the counts that explain an empty one.
 *
 * `graph: null` is a size refusal. The counts are returned either way, because the number that
 * matters most — how many trips named a pattern the slice did not have — is the one that
 * distinguishes a broken join from an area with no buses, and it is worth having even when the
 * graph was built successfully.
 */
export interface BuiltGraph {
  graph: JourneyGraph | null;
  tripsWithPattern: number;
  tripsWithoutPattern: number;
}

export function buildGraphFor(
  slice: NetworkSlice,
  rows: readonly PatternTripRow[],
  corridor: ReturnType<typeof corridorBoundingBox>,
  serviceDate: string,
): BuiltGraph {
  let tripsWithPattern = 0;
  let tripsWithoutPattern = 0;
  if (rows.length > JOURNEY_LIMITS.maxTrips) {
    return { graph: null, tripsWithPattern, tripsWithoutPattern };
  }

  const stopIds = new Set<string>();
  const trips: Trip[] = [];

  /*
   * Midnight once, and arithmetic instead of a round trip through text.
   *
   * This read `secondsIntoServiceDay(new Date(epoch * 1000).toISOString(), serviceDate)` for the
   * arrival and the departure of every stop of every trip. For a Manchester corridor — 9,526 trips
   * of about twenty-five calls each — that is 476,300 `Date` objects, 476,300 ISO strings, and
   * 952,600 `Date.parse` calls, half of them re-parsing the same `serviceDate` midnight. All of it
   * to compute one subtraction: `Date.parse` of an ISO string that `toISOString` just produced is
   * the epoch it came from, exactly, so the whole expression is `epoch - dayStart`.
   *
   * It is the cost the profile could not see. `scripts/profile-journey-search.ts` builds its trips
   * arithmetically, so it measured a search of 28 ms over a corridor the deployed endpoint was
   * taking hundreds of milliseconds on, and the difference was never the search.
   *
   * `secondsIntoServiceDay` stays below for a caller that genuinely has an instant as text.
   */
  const dayStartSeconds = Date.parse(`${serviceDate}T00:00:00.000Z`) / 1000;
  if (!Number.isFinite(dayStartSeconds)) {
    return { graph: null, tripsWithPattern, tripsWithoutPattern };
  }

  for (const row of rows) {
    const pattern = slice.patternsById.get(row.p);
    // Without the pattern there is no stop sequence, and times alone are not a trip.
    if (!pattern) {
      tripsWithoutPattern += 1;
      continue;
    }
    tripsWithPattern += 1;
    const service = slice.services.get(pattern.serviceRouteId);

    /*
     * One loop, one array. The pair of `map` and `filter` this replaces built two arrays per trip
     * and created two closures per trip with them — and esbuild keeps function names in the
     * deployed bundle, so each closure costs an `Object.defineProperty`, measured at about a
     * microsecond. Three closures a trip over nine and a half thousand trips is its own thirty
     * milliseconds, before the arrays.
     */
    const sequence = pattern.stopSequence;
    const stopTimes: TripStopTime[] = [];
    for (let at = 0; at < sequence.length; at++) {
      const departureEpoch = row.t[at];
      if (departureEpoch === undefined) continue;
      const arrivalEpoch = row.a?.[at] ?? departureEpoch;
      stopTimes.push({
        stopId: sequence[at]!,
        arrivalSeconds: Math.round(arrivalEpoch - dayStartSeconds),
        departureSeconds: Math.round(departureEpoch - dayStartSeconds),
      });
    }

    if (stopTimes.length < 2) continue;

    for (const stopTime of stopTimes) stopIds.add(stopTime.stopId);

    trips.push({
      id: `${row.p}:${row.j}`,
      routeId: pattern.serviceRouteId,
      patternId: pattern.id,
      // Cleaned on the way out, like every other passenger-facing name: a feed that publishes
      // `X84_Leeds_Otley` should read as a route number on an itinerary, not as a database key.
      routeName: service ? routeBadgeName(service.publicName) : "Bus",
      headsign: headsignFor(slice, stopTimes[stopTimes.length - 1]!.stopId),
      stopTimes,
    });
  }

  /* Stops outside the corridor cannot help this plan, and they enlarge the transfer graph. */
  const stops: Array<{ id: string; name: string; coordinate: Coordinate }> = [];
  const usableStopIds = new Set<string>();
  for (const stopId of stopIds) {
    const stop = slice.stopsById.get(stopId);
    if (!stop) continue;
    if (!withinBoundingBox(stop.locationCoordinate, corridor)) continue;
    stops.push({ id: stop.id, name: stop.name, coordinate: stop.locationCoordinate });
    usableStopIds.add(stop.id);
  }

  if (stops.length > JOURNEY_LIMITS.maxStops) {
    return { graph: null, tripsWithPattern, tripsWithoutPattern };
  }

  /*
   * One loop again, and the filter inside it rather than a closure per trip.
   *
   * A trip whose every call survives is kept as it is, so the common case allocates nothing: the
   * old form spread every trip into a new object and built a new stop-time array for all of them,
   * whether the corridor had cut anything or not.
   */
  const usableTrips: Trip[] = [];
  for (const trip of trips) {
    let dropped = 0;
    for (const stopTime of trip.stopTimes) {
      if (!usableStopIds.has(stopTime.stopId)) dropped += 1;
    }
    if (dropped === 0) {
      usableTrips.push(trip);
      continue;
    }
    if (trip.stopTimes.length - dropped < 2) continue;
    const kept: TripStopTime[] = [];
    for (const stopTime of trip.stopTimes) {
      if (usableStopIds.has(stopTime.stopId)) kept.push(stopTime);
    }
    usableTrips.push({ ...trip, stopTimes: kept });
  }

  return {
    graph: buildGraph({ stops, trips: usableTrips }),
    tripsWithPattern,
    tripsWithoutPattern,
  };
}

function headsignFor(slice: NetworkSlice, lastStopId: string): string {
  const name = slice.stopsById.get(lastStopId)?.name;
  return name ? passengerName(name) : "Destination not published";
}

/**
 * Seconds since the start of the service day. Times after midnight belong to the previous
 * service day and must exceed 86400 rather than wrapping to a small number, or a 00:20 bus would
 * appear to depart before the 23:50 one it follows.
 */
export function secondsIntoServiceDay(instant: string, serviceDate: string): number | null {
  const time = Date.parse(instant);
  const dayStart = Date.parse(`${serviceDate}T00:00:00.000Z`);
  if (!Number.isFinite(time) || !Number.isFinite(dayStart)) return null;
  return Math.round((time - dayStart) / 1000);
}
