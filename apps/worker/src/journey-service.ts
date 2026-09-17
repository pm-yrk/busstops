import type { Coordinate } from "@busstops/contracts";
import {
  corridorBoundingBox,
  objectKeyFor,
  withinBoundingBox,
  type ObjectStore,
} from "@busstops/pipeline-core";
import { buildGraph, plan, type JourneyGraph, type PlanResult, type Trip } from "@busstops/journey";
import {
  patternTilesForBoundingBox,
  patternTripWindowsFor,
  patternTripsDataset,
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
   * Counted on the pattern grid, which is an eighth of a degree — the grid the trips are
   * published on. The number was six when trips were read from half-degree journey tiles; a
   * corridor spans sixteen times as many of these, so keeping six would have refused every
   * journey longer than a mile as "too far".
   */
  maxTiles: 24,
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
    }
  | { ok: false; reason: string; code: "too_far" | "no_data" | "too_large" | "unreadable" };

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
    const tiles = patternTilesForBoundingBox(corridor);

    if (tiles.length > JOURNEY_LIMITS.maxTiles) {
      return {
        ok: false,
        code: "too_far",
        reason:
          "These points are too far apart for this planner. It is built for local journeys, not cross-country ones.",
      };
    }

    const loaded = await this.loadTrips(tiles, request);
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
        };
      }
      return {
        ok: false,
        code: "no_data",
        reason:
          "No timetable data is published for this area yet, so we cannot plan a journey here.",
      };
    }

    const graph = buildGraphFor(slice, loaded.rows, corridor, request.serviceDate);
    if (graph === null) {
      return {
        ok: false,
        code: "too_large",
        reason:
          "This journey covers more of the network than we can plan in one request. Try a shorter journey.",
      };
    }

    return {
      ok: true,
      result: plan(graph, {
        origin: request.origin,
        destination: request.destination,
        departAtSeconds: request.departAtSeconds,
        maxAccessWalkSeconds: Math.round(JOURNEY_LIMITS.maxAccessWalkMetres / 1.3),
      }),
      tilesLoaded: tiles,
      tripCount: graph.trips.length,
      failures: loaded.failures,
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
  ): Promise<{ rows: PatternTripRow[]; failures: Array<{ dataset: string; reason: string }> }> {
    const rows: PatternTripRow[] = [];
    const failures: Array<{ dataset: string; reason: string }> = [];

    const midnight = Date.parse(`${request.serviceDate}T00:00:00Z`) / 1000;
    const from = midnight + request.departAtSeconds;
    // A plan looks a few hours ahead; beyond that the answer is a different day's timetable.
    const to = from + 4 * 60 * 60;
    const windows = patternTripWindowsFor(from, to, request.serviceDate);

    for (const tile of tiles) {
      for (const window of windows) {
        const dataset = patternTripsDataset(request.serviceDate, tile, window);
        const cacheKey = `${request.version}:${dataset}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
          rows.push(...cached.rows);
          continue;
        }

        try {
          const raw = await this.store.get(objectKeyFor(dataset, request.version));
          if (raw === null) {
            this.cache.set(cacheKey, { rows: [], chars: 0 });
            continue;
          }
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

    return { rows, failures };
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
export function buildGraphFor(
  slice: NetworkSlice,
  rows: readonly PatternTripRow[],
  corridor: ReturnType<typeof corridorBoundingBox>,
  serviceDate: string,
): JourneyGraph | null {
  if (rows.length > JOURNEY_LIMITS.maxTrips) return null;

  const stopIds = new Set<string>();
  const trips: Trip[] = [];

  for (const row of rows) {
    const pattern = slice.patternsById.get(row.p);
    // Without the pattern there is no stop sequence, and times alone are not a trip.
    if (!pattern) continue;
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

  if (stops.length > JOURNEY_LIMITS.maxStops) return null;

  const usableStopIds = new Set(stops.map((stop) => stop.id));
  const usableTrips = trips
    .map((trip) => ({
      ...trip,
      stopTimes: trip.stopTimes.filter((stopTime) => usableStopIds.has(stopTime.stopId)),
    }))
    .filter((trip) => trip.stopTimes.length >= 2);

  return buildGraph({ stops, trips: usableTrips });
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
