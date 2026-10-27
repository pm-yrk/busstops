import type { Coordinate } from "@busstops/contracts";
import { haversineMetres } from "@busstops/pipeline-core";

/**
 * The time-dependent transport graph the planner searches (docs/11_JOURNEY_ENGINE.md).
 *
 * Kept deliberately independent of the storage format: the planner takes plain arrays of trips
 * and stops so it can be tested exhaustively against brute force on small graphs, which is the
 * only practical way to be confident a routing algorithm is correct.
 */

export interface JourneyStop {
  id: string;
  name: string;
  coordinate: Coordinate;
}

export interface TripStopTime {
  stopId: string;
  /** Seconds since the start of the service day. */
  arrivalSeconds: number;
  departureSeconds: number;
}

export interface Trip {
  id: string;
  /**
   * The service this trip belongs to, as the published network identifies it.
   *
   * Not the public name. "36" is what a passenger reads and several operators have one; the
   * itinerary has to carry the identity a link can be built from, so a leg can open the route it
   * is actually on rather than the first route in the country with the same number on the front.
   */
  routeId: string;
  /** The pattern the times belong to, so a leg can be drawn on the map it was planned from. */
  patternId: string;
  routeName: string;
  headsign: string;
  stopTimes: TripStopTime[];
  /** Live adjustment in seconds applied to every stop time; positive is late. */
  delaySeconds?: number;
  cancelled?: boolean;
}

export interface Transfer {
  fromStopId: string;
  toStopId: string;
  walkSeconds: number;
}

/**
 * Trips that follow exactly the same stop sequence, which is what RAPTOR calls a route.
 *
 * Not the published service and not the pattern: a *stop sequence*. Two trips on one pattern can
 * end up with different sequences here, because the planner drops stop times outside the corridor
 * before the graph is built, and a route whose trips disagree about where they stop cannot be
 * scanned as one. So the grouping key is the sequence itself and the pattern is incidental.
 *
 * This exists because the search was trip-centric and that is the wrong shape. Boarding every trip
 * at every improved stop and walking each one to its end counted 442,670 trip scans and 6,510,009
 * alighting offers for a single Manchester plan. A route scan visits each stop of each route once
 * per round — 606 routes of about thirty stops is 18,180 — and finds the earliest catchable trip
 * at the boarding stop instead of trying all of them.
 */
export interface RouteGroup {
  /** The stop sequence every trip in this group follows, in order. */
  stopIds: string[];
  /** The trips, in departure order at the first stop. */
  trips: Trip[];
  /**
   * Trips on a route never overtake each other: departure order is the same at every stop.
   *
   * Guaranteed by construction, not hoped for, and it is what makes the scan both correct and
   * fast. The scan boards the **earliest** trip it can catch and rides it, which is only the best
   * choice when an earlier departure also means an earlier arrival everywhere downstream. The
   * brute-force comparison caught the counter-example on the first run: a route where one bus
   * leaves Wellington Street at 08:17 and reaches Armley Road at 08:36, and the next leaves at
   * 08:25 and reaches it at 08:35. Boarding the earlier one arrives a minute later.
   *
   * So a stop sequence whose trips overtake is split into as many routes as it takes, each of them
   * free of overtaking, and the scan visits each. The split is on the **effective** times, so a
   * live delay that moves one trip past its neighbour splits them too — which assumes delays are
   * applied before the graph is built, as `buildGraphFor` does.
   */
  readonly nonOvertaking: true;
}

export interface JourneyGraph {
  stops: Map<string, JourneyStop>;
  trips: Trip[];
  /** Trips serving each stop, precomputed so the search does not rescan every trip. */
  tripsByStop: Map<string, Trip[]>;
  /** Routes in the graph, grouped by stop sequence. See `RouteGroup`. */
  routes: RouteGroup[];
  /**
   * Which routes call at each stop, and where in the sequence.
   *
   * One entry per occurrence, so a route that calls at a stop twice — a loop, or an out-and-back
   * — is boardable at both. The search queues a route from the earliest position any improved
   * stop holds, which is why the position travels with it.
   */
  routesByStop: Map<string, Array<{ route: RouteGroup; at: number }>>;
  transfers: Map<string, Transfer[]>;
}

export const WALK_SPEED_METRES_PER_SECOND = 1.3;

/** Walking time between two points, at a deliberately unhurried pace. */
export function walkSeconds(
  from: Coordinate,
  to: Coordinate,
  speed = WALK_SPEED_METRES_PER_SECOND,
): number {
  return Math.round(haversineMetres(from, to) / speed);
}

export interface BuildGraphInput {
  stops: readonly JourneyStop[];
  trips: readonly Trip[];
  /** Maximum walking transfer between stops, in seconds. */
  maxTransferSeconds?: number;
}

export function buildGraph(input: BuildGraphInput): JourneyGraph {
  const maxTransferSeconds = input.maxTransferSeconds ?? 600;

  const stops = new Map(input.stops.map((stop) => [stop.id, stop]));
  const tripsByStop = new Map<string, Trip[]>();

  for (const trip of input.trips) {
    for (const stopTime of trip.stopTimes) {
      const existing = tripsByStop.get(stopTime.stopId);
      if (existing) existing.push(trip);
      else tripsByStop.set(stopTime.stopId, [trip]);
    }
  }

  const transfers = buildTransfers(input.stops, maxTransferSeconds);

  return {
    stops,
    trips: [...input.trips],
    tripsByStop,
    ...groupRoutes(input.trips),
    transfers,
  };
}

/**
 * Trips grouped by the stop sequence they follow, with the index that makes them searchable.
 *
 * The sequence is joined with a separator that cannot occur in a stop id — these are UUIDs — so
 * two different sequences cannot collide into one route and be scanned as though a bus called
 * somewhere it does not.
 */
export function groupRoutes(trips: readonly Trip[]): {
  routes: RouteGroup[];
  routesByStop: Map<string, Array<{ route: RouteGroup; at: number }>>;
} {
  const bySequence = new Map<string, Trip[]>();
  for (const trip of trips) {
    if (trip.stopTimes.length < 2) continue;
    const key = trip.stopTimes.map((stopTime) => stopTime.stopId).join("\u0000");
    const existing = bySequence.get(key);
    if (existing) existing.push(trip);
    else bySequence.set(key, [trip]);
  }

  const routes: RouteGroup[] = [];
  const routesByStop = new Map<string, Array<{ route: RouteGroup; at: number }>>();

  for (const group of bySequence.values()) {
    /*
     * Ordered by departure at the first stop, and ties broken on the trip id.
     *
     * The tie-break is not cosmetic: the split below compares each trip against the last one
     * admitted to a route, so an order that is not total would make which journey is found depend
     * on the order the trips happened to be read in.
     */
    const times = new Map(group.map((trip) => [trip, effectiveStopTimes(trip)]));
    const ordered = [...group].sort((a, b) => {
      const byTime = times.get(a)![0]!.departureSeconds - times.get(b)![0]!.departureSeconds;
      return byTime !== 0 ? byTime : a.id < b.id ? -1 : 1;
    });
    const stopIds = times.get(ordered[0]!)!.map((stopTime) => stopTime.stopId);

    /*
     * Split into routes no bus overtakes another on. See `RouteGroup.nonOvertaking`.
     *
     * Each trip joins the first route whose last admitted trip it is at or behind at every stop,
     * and starts a new one when there is none. Comparing against the last member is enough
     * because that route is already free of overtaking, so being behind its last trip puts this
     * one behind all of them — which keeps this O(trips × routes × stops) rather than quadratic
     * in the trips, and in practice there is one route and the inner loop runs once.
     */
    const buckets: Trip[][] = [];
    for (const trip of ordered) {
      const mine = times.get(trip)!;
      let placed = false;
      for (const bucket of buckets) {
        const last = times.get(bucket[bucket.length - 1]!)!;
        let behind = true;
        for (let at = 0; at < mine.length; at++) {
          if (mine[at]!.departureSeconds < last[at]!.departureSeconds) {
            behind = false;
            break;
          }
        }
        if (behind) {
          bucket.push(trip);
          placed = true;
          break;
        }
      }
      if (!placed) buckets.push([trip]);
    }

    for (const bucket of buckets) {
      const route: RouteGroup = { stopIds, trips: bucket, nonOvertaking: true };
      routes.push(route);
      for (let at = 0; at < stopIds.length; at++) {
        const stopId = stopIds[at]!;
        const list = routesByStop.get(stopId);
        if (list) list.push({ route, at });
        else routesByStop.set(stopId, [{ route, at }]);
      }
    }
  }

  return { routes, routesByStop };
}

/**
 * Walking transfers between stops within range, without comparing every pair.
 *
 * This was two nested loops over the corridor's stops and it is the single most expensive thing a
 * journey request does. Profiled against the published artifact: a Birmingham corridor holds 2,737
 * stops and 126,952 transfer edges, and building them took 911 milliseconds against a budget of
 * ten for the whole request — 7.5 million haversines, of which 126,952 produced an edge. The
 * quadratic was the whole of it. Nothing about the corridor was unreasonable; the loop was.
 *
 * Stops go into a grid of cells about as wide as the furthest walk allowed, so every stop within
 * range of one is in its own cell or one of the eight around it, and no pair outside those is ever
 * considered. That is exact rather than approximate: a pair further apart than the cell
 * neighbourhood cannot be within the walking cap, by construction of the cell size.
 *
 * Inside the neighbourhood a flat distance decides who gets a haversine. The flat metric is
 * within a fraction of a per cent of the real thing at these ranges and it costs no trigonometry,
 * so it is used as a sieve with a five per cent margin and the survivors are measured properly.
 * It is deliberately *only* a sieve: a property test caught a flat metric reordering exact ties
 * when it was used to rank, and the edge's own `walkSeconds` is what the search reads.
 */
export function buildTransfers(
  stops: readonly JourneyStop[],
  maxTransferSeconds: number,
): Map<string, Transfer[]> {
  const transfers = new Map<string, Transfer[]>();
  if (stops.length === 0) return transfers;

  const maxMetres = maxTransferSeconds * WALK_SPEED_METRES_PER_SECOND;
  /* A degree of latitude is about 111,320 m everywhere; of longitude, that times cos(latitude). */
  const latitudeSpan = maxMetres / 111_320;
  /*
   * Taken at the highest latitude in the set, not its middle, and that is the difference between
   * exact and nearly.
   *
   * A degree of longitude shortens towards the poles, so sizing the cell on the mean latitude
   * makes it *narrower* than the walking cap wherever the set reaches higher than its mean — and a
   * pair within walking distance could then sit two cells apart and never be compared at all. The
   * smallest cosine in the set makes every cell at least as wide as the cap everywhere in it, so
   * the eight neighbours are always enough. The same figure sieves below, where under-stating the
   * metres in a degree of longitude under-states the distance, and therefore keeps pairs rather
   * than discarding them.
   */
  let cosLatitude = 1;
  for (const stop of stops) {
    cosLatitude = Math.min(cosLatitude, Math.cos((Math.abs(stop.coordinate.lat) * Math.PI) / 180));
  }
  cosLatitude = Math.max(0.01, cosLatitude);
  const longitudeSpan = latitudeSpan / cosLatitude;

  const cells = new Map<string, JourneyStop[]>();
  const cellOf = (stop: JourneyStop): { row: number; column: number } => ({
    row: Math.floor(stop.coordinate.lat / latitudeSpan),
    column: Math.floor(stop.coordinate.lon / longitudeSpan),
  });
  for (const stop of stops) {
    const cell = cellOf(stop);
    const key = `${String(cell.row)}:${String(cell.column)}`;
    const existing = cells.get(key);
    if (existing) existing.push(stop);
    else cells.set(key, [stop]);
  }

  /* The sieve's threshold, in squared metres, with the margin the flat metric needs. */
  const sieve = (maxMetres * 1.05) ** 2;
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude = 111_320 * cosLatitude;

  for (const from of stops) {
    const list: Transfer[] = [];
    const cell = cellOf(from);
    for (let row = cell.row - 1; row <= cell.row + 1; row++) {
      for (let column = cell.column - 1; column <= cell.column + 1; column++) {
        const neighbours = cells.get(`${String(row)}:${String(column)}`);
        if (!neighbours) continue;
        for (const to of neighbours) {
          if (from.id === to.id) continue;
          const dLat = (to.coordinate.lat - from.coordinate.lat) * metresPerDegreeLatitude;
          const dLon = (to.coordinate.lon - from.coordinate.lon) * metresPerDegreeLongitude;
          if (dLat * dLat + dLon * dLon > sieve) continue;
          const seconds = walkSeconds(from.coordinate, to.coordinate);
          if (seconds <= maxTransferSeconds) {
            list.push({ fromStopId: from.id, toStopId: to.id, walkSeconds: seconds });
          }
        }
      }
    }
    transfers.set(from.id, list);
  }

  return transfers;
}

/** Effective stop times for a trip, with any live delay applied. */
export function effectiveStopTimes(trip: Trip): TripStopTime[] {
  const delay = trip.delaySeconds ?? 0;
  if (delay === 0) return trip.stopTimes;
  return trip.stopTimes.map((stopTime) => ({
    stopId: stopTime.stopId,
    arrivalSeconds: stopTime.arrivalSeconds + delay,
    departureSeconds: stopTime.departureSeconds + delay,
  }));
}

/**
 * The earliest boarding on this trip at or after `afterSeconds`, or null.
 * A cancelled trip is never boardable — that is the difference between "no data" and
 * "confirmed not running", and it must not be blurred.
 */
export function boardingIndex(trip: Trip, stopId: string, afterSeconds: number): number | null {
  if (trip.cancelled) return null;
  return boardingIndexIn(effectiveStopTimes(trip), stopId, afterSeconds);
}

/**
 * The same search, over stop times the caller already has.
 *
 * The search loop needs the effective times anyway — to walk the trip's downstream stops — and was
 * calling `effectiveStopTimes` once here and once there. Profiled over a Manchester corridor that
 * was 885,340 calls against 442,670 trips scanned, and for a trip carrying a live delay each call
 * allocates a fresh array of stop-time objects. `boardingIndex` above keeps its signature for
 * every other caller and for the tests that pin its behaviour.
 */
export function boardingIndexIn(
  stopTimes: readonly TripStopTime[],
  stopId: string,
  afterSeconds: number,
): number | null {
  for (let i = 0; i < stopTimes.length - 1; i++) {
    const stopTime = stopTimes[i]!;
    if (stopTime.stopId === stopId && stopTime.departureSeconds >= afterSeconds) return i;
  }
  return null;
}
