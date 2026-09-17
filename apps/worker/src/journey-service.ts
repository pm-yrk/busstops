import type { Coordinate, RoutePattern } from "@busstops/contracts";
import {
  corridorBoundingBox,
  objectKeyFor,
  withinBoundingBox,
  type ObjectStore,
} from "@busstops/pipeline-core";
import { buildGraph, plan, type JourneyGraph, type PlanResult, type Trip } from "@busstops/journey";
import {
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
const MAX_CACHED_TRIP_CHARS = 8 * 1024 * 1024;

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
      const wanted = [...new Set(loaded.rows.map((row) => row.p))];
      const patternBegan = Date.now();
      const resolved = await request.resolvePatterns(wanted);
      diagnostics.stageMs.resolvePatterns = Date.now() - patternBegan;
      diagnostics.patternsRequested = wanted.length;

      if (resolved.available) {
        diagnostics.patternsInSlice = resolved.patterns.size;
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
        planningSlice = { ...slice, patternsById: resolved.patterns };
        // Rows on a pattern nothing could resolve cannot become trips; dropping them here keeps
        // them out of the graph builder's memory rather than out of its output.
        loaded.rows = loaded.rows.filter((row) => resolved.patterns.has(row.p));
        diagnostics.tripsLoaded = loaded.rows.length;
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
      const results = await Promise.all(
        batch.map(async (dataset) => {
          const cacheKey = `${request.version}:${dataset}:${from}:${to}`;
          const cached = this.cache.get(cacheKey);
          if (cached) return { kind: "cached", dataset, cached } as const;
          try {
            const raw = await this.store.get(objectKeyFor(dataset, request.version));
            return { kind: "body", dataset, raw } as const;
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
      chars,
      readMs,
      parseMs,
      truncated,
      stoppedBy: truncated ? stoppedBy : null,
    };
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

  for (const row of rows) {
    const pattern = slice.patternsById.get(row.p);
    // Without the pattern there is no stop sequence, and times alone are not a trip.
    if (!pattern) {
      tripsWithoutPattern += 1;
      continue;
    }
    tripsWithPattern += 1;
    const service = slice.services.get(pattern.serviceRouteId);

    const stopTimes = pattern.stopSequence
      .map((stopId, at) => {
        const departureEpoch = row.t[at];
        if (departureEpoch === undefined) return null;
        const arrivalEpoch = row.a?.[at] ?? departureEpoch;
        const departure = secondsIntoServiceDay(
          new Date(departureEpoch * 1000).toISOString(),
          serviceDate,
        );
        const arrival = secondsIntoServiceDay(
          new Date(arrivalEpoch * 1000).toISOString(),
          serviceDate,
        );
        if (departure === null || arrival === null) return null;
        return { stopId, arrivalSeconds: arrival, departureSeconds: departure };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

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

  const stops = [...stopIds]
    .map((stopId) => slice.stopsById.get(stopId))
    .filter((stop): stop is NonNullable<typeof stop> => stop !== undefined)
    // Stops outside the corridor cannot help this plan and only enlarge the transfer graph,
    // which is quadratic in stop count.
    .filter((stop) => withinBoundingBox(stop.locationCoordinate, corridor))
    .map((stop) => ({ id: stop.id, name: stop.name, coordinate: stop.locationCoordinate }));

  if (stops.length > JOURNEY_LIMITS.maxStops) {
    return { graph: null, tripsWithPattern, tripsWithoutPattern };
  }

  const usableStopIds = new Set(stops.map((stop) => stop.id));
  const usableTrips = trips
    .map((trip) => ({
      ...trip,
      stopTimes: trip.stopTimes.filter((stopTime) => usableStopIds.has(stopTime.stopId)),
    }))
    .filter((trip) => trip.stopTimes.length >= 2);

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
