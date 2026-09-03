import type { Coordinate, ScheduledJourney } from "@busstops/contracts";
import {
  ArtifactStore,
  corridorBoundingBox,
  tilesForBoundingBox,
  withinBoundingBox,
  type ObjectStore,
} from "@busstops/pipeline-core";
import { buildGraph, plan, type JourneyGraph, type PlanResult, type Trip } from "@busstops/journey";
import { journeyTileDataset } from "@busstops/pipeline-static-network";
import type { NetworkSnapshot } from "./network-repository.js";

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
  /** More tiles than this means a journey longer than this planner is built for. */
  maxTiles: 6,
  /** Upper bound on graph size, so one request cannot exhaust the isolate. */
  maxTrips: 6000,
  maxStops: 4000,
} as const;

export interface JourneyPlanRequest {
  origin: Coordinate;
  destination: Coordinate;
  departAtSeconds: number;
  serviceDate: string;
}

export type JourneyPlanOutcome =
  | { ok: true; result: PlanResult; tilesLoaded: string[]; tripCount: number }
  | { ok: false; reason: string; code: "too_far" | "no_data" | "too_large" };

export class JourneyService {
  private readonly cache = new Map<string, ScheduledJourney[]>();

  constructor(private readonly store: ObjectStore) {}

  async planJourney(
    snapshot: NetworkSnapshot,
    request: JourneyPlanRequest,
  ): Promise<JourneyPlanOutcome> {
    const corridor = corridorBoundingBox(
      request.origin,
      request.destination,
      JOURNEY_LIMITS.maxAccessWalkMetres,
    );
    const tiles = tilesForBoundingBox(corridor);

    if (tiles.length > JOURNEY_LIMITS.maxTiles) {
      return {
        ok: false,
        code: "too_far",
        reason:
          "These points are too far apart for this planner. It is built for local journeys, not cross-country ones.",
      };
    }

    const journeys = await this.loadTiles(tiles, request.serviceDate);
    if (journeys.length === 0) {
      return {
        ok: false,
        code: "no_data",
        reason:
          "No timetable data is published for this area yet, so we cannot plan a journey here.",
      };
    }

    const graph = buildGraphFor(snapshot, journeys, corridor);
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
    };
  }

  private async loadTiles(
    tiles: readonly string[],
    serviceDate: string,
  ): Promise<ScheduledJourney[]> {
    const artifacts = new ArtifactStore(this.store);
    const journeys: ScheduledJourney[] = [];

    for (const tile of tiles) {
      const cacheKey = `${tile}|${serviceDate}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        journeys.push(...cached);
        continue;
      }

      try {
        const loaded = await artifacts.readCurrent<ScheduledJourney>(journeyTileDataset(tile));
        const forDate = loaded.records.filter((journey) => journey.serviceDate === serviceDate);
        // Isolate-scoped cache: a tile is read once per isolate per service day, not per request.
        this.cache.set(cacheKey, forDate);
        journeys.push(...forDate);
      } catch {
        // A missing or corrupt tile means part of the corridor is unplannable. The plan still
        // runs on what did load, and the response's coverage reflects it.
        this.cache.set(cacheKey, []);
      }
    }

    return journeys;
  }
}

/** Builds the search graph, or null when the request would exceed the size guards. */
export function buildGraphFor(
  snapshot: NetworkSnapshot,
  journeys: readonly ScheduledJourney[],
  corridor: ReturnType<typeof corridorBoundingBox>,
): JourneyGraph | null {
  if (journeys.length > JOURNEY_LIMITS.maxTrips) return null;

  const stopIds = new Set<string>();
  const trips: Trip[] = [];

  for (const journey of journeys) {
    if (journey.state === "cancelled") continue;

    const pattern = snapshot.patternsById.get(journey.routePatternId);
    const service = pattern ? snapshot.services.get(pattern.serviceRouteId) : undefined;

    const stopTimes = journey.stopTimes
      .map((stopTime) => {
        const departure = secondsIntoServiceDay(stopTime.scheduledDeparture, journey.serviceDate);
        const arrival = stopTime.scheduledArrival
          ? secondsIntoServiceDay(stopTime.scheduledArrival, journey.serviceDate)
          : departure;
        if (departure === null || arrival === null) return null;
        return { stopId: stopTime.stopId, arrivalSeconds: arrival, departureSeconds: departure };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (stopTimes.length < 2) continue;

    for (const stopTime of stopTimes) stopIds.add(stopTime.stopId);

    trips.push({
      id: journey.id,
      routeId: pattern?.serviceRouteId ?? journey.routePatternId,
      routeName: service?.publicName ?? "Unknown route",
      headsign: headsignFor(snapshot, stopTimes[stopTimes.length - 1]!.stopId),
      stopTimes,
    });
  }

  const stops = [...stopIds]
    .map((stopId) => snapshot.stopsById.get(stopId))
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

function headsignFor(snapshot: NetworkSnapshot, lastStopId: string): string {
  return snapshot.stopsById.get(lastStopId)?.name ?? "Destination not published";
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
