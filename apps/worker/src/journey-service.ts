import type { Coordinate } from "@busstops/contracts";
import {
  corridorBoundingBox,
  objectKeyFor,
  withinBoundingBox,
  type ObjectStore,
} from "@busstops/pipeline-core";
import { buildGraph, plan, type JourneyGraph, type PlanResult, type Trip } from "@busstops/journey";
import {
  patternTripsDataset,
  tripTilesForBoundingBox,
  tripWindowsFor,
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
  code: "planned" | "no_options" | "too_far" | "no_data" | "unreadable" | "too_large";
  corridorTiles: number;
  windows: number[];
  shardsRead: number;
  shardsMissing: number;
  /** Trip rows read out of the shards. */
  tripsLoaded: number;
  /** Rows whose pattern was present in the slice, and rows whose pattern was not. */
  tripsWithPattern: number;
  tripsWithoutPattern: number;
  /** Trips that survived into the graph, and the stops the corridor kept. */
  tripsInGraph: number;
  stopsInGraph: number;
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
      code: "too_far" | "no_data" | "too_large" | "unreadable";
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

export class JourneyService {
  private readonly cache = new Map<string, { rows: PatternTripRow[]; chars: number }>();

  constructor(private readonly store: ObjectStore) {}

  async planJourney(slice: NetworkSlice, request: JourneyPlanRequest): Promise<JourneyPlanOutcome> {
    const corridor = corridorBoundingBox(
      request.origin,
      request.destination,
      JOURNEY_LIMITS.maxAccessWalkMetres,
    );
    const tiles = tripTilesForBoundingBox(corridor);

    // Filled in as the plan proceeds, so whatever it returns says how far it got.
    const diagnostics: JourneyDiagnostics = {
      code: "no_data",
      corridorTiles: tiles.length,
      windows: [],
      shardsRead: 0,
      shardsMissing: 0,
      tripsLoaded: 0,
      tripsWithPattern: 0,
      tripsWithoutPattern: 0,
      tripsInGraph: 0,
      stopsInGraph: 0,
      patternsInSlice: slice.patternsById.size,
      stopsInSlice: slice.stopsById.size,
      failures: [],
    };

    if (tiles.length > JOURNEY_LIMITS.maxTiles) {
      return {
        ok: false,
        code: "too_far",
        reason:
          "These points are too far apart for this planner. It is built for local journeys, not cross-country ones.",
        diagnostics: { ...diagnostics, code: "too_far" },
      };
    }

    const loaded = await this.loadTrips(tiles, request);
    diagnostics.windows = loaded.windows;
    diagnostics.shardsRead = loaded.shardsRead;
    diagnostics.shardsMissing = loaded.shardsMissing;
    diagnostics.tripsLoaded = loaded.rows.length;
    diagnostics.failures = loaded.failures;

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

    const built = buildGraphFor(slice, loaded.rows, corridor, request.serviceDate);
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

    const result = plan(graph, {
      origin: request.origin,
      destination: request.destination,
      departAtSeconds: request.departAtSeconds,
      maxAccessWalkSeconds: Math.round(JOURNEY_LIMITS.maxAccessWalkMetres / 1.3),
    });

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
  ): Promise<{
    rows: PatternTripRow[];
    failures: Array<{ dataset: string; reason: string }>;
    windows: number[];
    shardsRead: number;
    shardsMissing: number;
  }> {
    const rows: PatternTripRow[] = [];
    const failures: Array<{ dataset: string; reason: string }> = [];
    let shardsRead = 0;
    let shardsMissing = 0;

    const midnight = Date.parse(`${request.serviceDate}T00:00:00Z`) / 1000;
    const from = midnight + request.departAtSeconds;
    // A plan looks a few hours ahead; beyond that the answer is a different day's timetable.
    const to = from + 4 * 60 * 60;
    const windows = tripWindowsFor(from, to, request.serviceDate);

    for (const tile of tiles) {
      for (const window of windows) {
        const dataset = patternTripsDataset(request.serviceDate, tile, window);
        const cacheKey = `${request.version}:${dataset}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
          // A cached empty shard is one that was absent when first asked for, not one that was
          // read and found empty; counting it as read would overstate the coverage of the plan.
          if (cached.chars === 0) shardsMissing += 1;
          else shardsRead += 1;
          rows.push(...cached.rows);
          continue;
        }

        try {
          const raw = await this.store.get(objectKeyFor(dataset, request.version));
          if (raw === null) {
            this.cache.set(cacheKey, { rows: [], chars: 0 });
            shardsMissing += 1;
            continue;
          }
          shardsRead += 1;
          const parsed: PatternTripRow[] = [];
          for (const line of raw.split("\n")) {
            if (line.length === 0) continue;
            parsed.push(JSON.parse(line) as PatternTripRow);
          }
          this.cache.set(cacheKey, { rows: parsed, chars: raw.length });
          this.evict();
          rows.push(...parsed);
        } catch (error) {
          failures.push({
            dataset,
            reason: error instanceof Error ? `${error.name}: ${error.message}` : "unreadable",
          });
        }
      }
    }

    return { rows, failures, windows, shardsRead, shardsMissing };
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
      routeName: service?.publicName ?? "Unknown route",
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
  return slice.stopsById.get(lastStopId)?.name ?? "Destination not published";
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
