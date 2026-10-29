import type { Coordinate } from "@busstops/contracts";
import { haversineMetres } from "@busstops/pipeline-core";
import {
  WALK_SPEED_METRES_PER_SECOND as WALK_SPEED,
  buildTransferAdjacency,
  type TransferAdjacency,
} from "./transfers.js";

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

/**
 * Where a trip's times live when they were never turned into objects.
 *
 * The published shard holds a tile's departures and arrivals as typed arrays, indexed by trip and
 * by call, and this is the smallest thing that lets the search read them in place. It is an
 * interface rather than the shard's own class so the journey package does not depend on the
 * pipeline's.
 */
export interface TripCallSource {
  /**
   * Absolute seconds, as published, for one call of one trip.
   *
   * `call` is the call's **position in the pattern's stop sequence**, not its ordinal among the
   * calls this trip happens to have. That is how the published row is laid out — `t[at]` pairs
   * with `sequence[at]`, which is the whole economy of the format — and it is what lets a trip
   * that skips a stop in the middle of its pattern be read correctly rather than shifted one stop
   * along. A source whose own indexing is dense therefore only satisfies this where the trip's
   * calls are a prefix of its pattern, which is the condition the reader checks before taking the
   * shared path.
   */
  departure(trip: number, call: number): number;
  arrival(trip: number, call: number): number;
}

/**
 * A trip's calls, as a window into a published shard rather than an array of objects.
 *
 * This is the last place the trip artifact was being spent on the way in. A Manchester corridor
 * holds about nine and a half thousand trips of some thirty calls each, and turning each call into
 * `{ stopId, arrivalSeconds, departureSeconds }` is a few hundred thousand allocations per
 * passenger request — to express times that are already integers in a typed array, on a path
 * allowed ten milliseconds in total.
 *
 * Nothing here is per-call or per-trip storage. `sequence` is the pattern's stop ids, shared by
 * every trip on it. `kept` is which of those positions survived the corridor cut, shared per
 * pattern too, because a corridor cuts every trip of a pattern identically — the same fact that
 * lets a published route key survive the cut. A trip is then a source, an index and a count.
 */
export interface TripCalls {
  readonly source: TripCallSource;
  /** This trip's index in the source. */
  readonly trip: number;
  /** The pattern's stop sequence, whole, shared. */
  readonly sequence: readonly string[];
  /** Positions in `sequence` this trip still calls at, or null when it calls at all of them. */
  readonly kept: Uint16Array | null;
  readonly count: number;
  /** Subtracted from the published seconds to get seconds since the service day began. */
  readonly dayStartSeconds: number;
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
  /**
   * The calls, as objects.
   *
   * Optional because a trip read from a published shard carries `calls` instead and never
   * materialises these. Exactly one of the two is present; `effectiveStopTimes` is what every
   * caller that genuinely needs objects goes through, and the accessors below are what the search
   * uses so that it needs none.
   */
  stopTimes?: readonly TripStopTime[];
  /** The calls, in place, when they came from a published shard. See `TripCalls`. */
  calls?: TripCalls;
  /** Live adjustment in seconds applied to every stop time; positive is late. */
  delaySeconds?: number;
  cancelled?: boolean;
  /**
   * That `stopTimes` is the pattern's whole stop sequence, nothing skipped and nothing cut.
   *
   * Set by whoever built the trip, because only they know. Grouping trips into routes means
   * finding the ones whose sequences are identical, and for a Manchester corridor the
   * element-wise comparison that establishes it ran over 238,000 stop ids to rediscover what the
   * pattern id already implied — two trips on one pattern have the same sequence unless something
   * cut one of them. A trip carrying this flag needs no comparison at all: it is the pattern's
   * sequence by construction, so every other trip with the flag and the same pattern is too.
   *
   * Absent means "not known to be", never "is not", so a caller that does not set it loses the
   * saving and nothing else.
   */
  wholePatternSequence?: boolean;
  /**
   * The route this trip belongs to, as the published grouping decided.
   *
   * Grouping trips into routes is derived entirely from the published timetable — the pattern and
   * the number of calls are the stop sequence, and the non-overtaking split is a function of the
   * times — and deriving it per request measured more than the walking transfers did: 27.65 ms
   * against 23.56 in Manchester, 38.28 against 24.76 in Birmingham. So it is published, and a trip
   * that carries its route needs no comparison, no sort and no split.
   *
   * Two trips with the same key are on the same route, in the order they arrive. A corridor that
   * cuts their stop sequences cuts both identically — routes are per pattern and call count, so
   * their kept positions are the same — which is why the key survives the corridor filter.
   *
   * Absent means "not known", never "not grouped": the trips that lack it are grouped the long way.
   */
  routeKey?: string;
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
  /**
   * The same sequence as indices into the graph's stop space.
   *
   * Filled in by `buildGraph`, because only the graph knows the space. The scan walks this rather
   * than `stopIds`: a round of RAPTOR is tens of thousands of label lookups, and a lookup keyed by
   * a UUID string hashes it every time where an index is an array offset.
   */
  stopIndices: Int32Array;
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
  /**
   * The corridor's stops as an integer space, so the search needs no string hashing.
   *
   * Every stop the search can reach has an index: the corridor's own stops first, then any stop a
   * route calls at that the corridor did not list. The search keeps its labels in typed arrays
   * over this space and turns them back into maps once, at the end, for the itinerary builder and
   * the oracle — which is why the result shape is unchanged.
   */
  stopIndexOf: ReadonlyMap<string, number>;
  stopIdByIndex: readonly string[];
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
  /** The same, over the integer space: the lookup a round does once per marked stop. */
  routesByStopIndex: ReadonlyArray<ReadonlyArray<{ route: RouteGroup; at: number }> | undefined>;
  /**
   * Each stop's index in the transfer adjacency, by graph stop index, or -1 where it has none.
   *
   * The adjacency has its own space — it is built, or read, from the stop ids it was given — and
   * resolving a stop in it by id was a string hash per edge walked. Two thousand lookups once per
   * search replaces fifty thousand.
   */
  transferIndexByStop: Int32Array;
  /**
   * Walking transfers, as three parallel arrays over an integer index space.
   *
   * Not a `Map<string, Transfer[]>` any more. A Manchester corridor holds 108,284 edges and a
   * Birmingham one 126,952, and as objects that is a hundred thousand allocations per request for
   * a structure identical for every passenger on a published network — which is also why it is
   * published rather than built. The reader decodes straight into this shape; turning it back into
   * objects would spend the artifact's whole value on the way in.
   */
  transfers: TransferAdjacency;
}

/**
 * The placeholder a route carries until the graph gives it the real one.
 *
 * `groupRoutes` decides which trips are one route; it has no stop space to express the sequence
 * in, because the space belongs to the graph. Shared and empty rather than allocated per route,
 * and a search over a route still holding it would visit no stops — which is why `buildGraph`
 * fills every one of them before the graph exists.
 */
const NO_INDICES = new Int32Array(0);

export const WALK_SPEED_METRES_PER_SECOND = WALK_SPEED;

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
  /**
   * Walking transfers the caller already has, from the published artifact.
   *
   * Given one, the graph does not build them: stops do not move between requests, so computing
   * them per journey was work that belonged to the publish. Omitted, they are built here, which
   * is what a corridor whose transfers are not published yet falls back to.
   */
  transfers?: TransferAdjacency;
}

export function buildGraph(input: BuildGraphInput): JourneyGraph {
  const maxTransferSeconds = input.maxTransferSeconds ?? 600;

  const stops = new Map(input.stops.map((stop) => [stop.id, stop]));

  const transfers = input.transfers ?? buildTransferAdjacency(input.stops, maxTransferSeconds);

  const trips = [...input.trips];
  /*
   * Built on first use, because the search stopped needing it.
   *
   * Every trip serving every stop is 238,150 map operations for a Manchester corridor — fifteen
   * milliseconds of a graph build that has to fit inside a ten-millisecond request — and since the
   * scan became route-centric nothing on the request path reads it. What does read it is the
   * exhaustive oracle in the tests and the profiler, and neither is in a hurry. The field stays so
   * both keep working unchanged.
   */
  let tripsByStop: Map<string, Trip[]> | null = null;

  const grouped = groupRoutes(input.trips);

  /*
   * The integer space, and the route sequences in it.
   *
   * The corridor's own stops first, so the common indices are the ones the transfers are keyed on,
   * then any stop a route calls at that the corridor did not list — those are reachable and have
   * no walking edges, and leaving them out of the space would mean a label the search could not
   * record.
   */
  const stopIndexOf = new Map<string, number>();
  const stopIdByIndex: string[] = [];
  for (const stop of input.stops) {
    if (stopIndexOf.has(stop.id)) continue;
    stopIndexOf.set(stop.id, stopIdByIndex.length);
    stopIdByIndex.push(stop.id);
  }
  for (const route of grouped.routes) {
    const indices = new Int32Array(route.stopIds.length);
    for (let at = 0; at < route.stopIds.length; at += 1) {
      const stopId = route.stopIds[at]!;
      let index = stopIndexOf.get(stopId);
      if (index === undefined) {
        index = stopIdByIndex.length;
        stopIndexOf.set(stopId, index);
        stopIdByIndex.push(stopId);
      }
      indices[at] = index;
    }
    route.stopIndices = indices;
  }

  const routesByStopIndex: Array<Array<{ route: RouteGroup; at: number }> | undefined> = new Array(
    stopIdByIndex.length,
  );
  for (const [stopId, entries] of grouped.routesByStop) {
    const index = stopIndexOf.get(stopId);
    if (index !== undefined) routesByStopIndex[index] = entries;
  }

  /* And each stop's place in the adjacency, resolved once rather than once per edge walked. */
  const transferIndexByStop = new Int32Array(stopIdByIndex.length);
  for (let index = 0; index < stopIdByIndex.length; index += 1) {
    transferIndexByStop[index] = transfers.indexOf(stopIdByIndex[index]!);
  }

  return {
    stops,
    trips,
    stopIndexOf,
    stopIdByIndex,
    routesByStopIndex,
    transferIndexByStop,
    get tripsByStop(): Map<string, Trip[]> {
      if (tripsByStop !== null) return tripsByStop;
      const byStop = new Map<string, Trip[]>();
      for (const trip of trips) {
        const count = callCount(trip);
        for (let at = 0; at < count; at += 1) {
          const stopId = stopIdAt(trip, at);
          const existing = byStop.get(stopId);
          if (existing) existing.push(trip);
          else byStop.set(stopId, [trip]);
        }
      }
      tripsByStop = byStop;
      return byStop;
    },
    routes: grouped.routes,
    routesByStop: grouped.routesByStop,
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
/**
 * Routes from groups that are already decided: one route per group, in the order given.
 *
 * Used by the published-grouping path, where the publisher has already split the trips so that no
 * bus overtakes another and ordered them by departure. The sequence comes from the first trip's
 * effective times, as it does in the long path, so a corridor that cut the sequence is reflected
 * here too.
 */
function routesFromGroups(
  groups: readonly Trip[][],
  /**
   * Check the order rather than trust it.
   *
   * A route's trips must be in departure order: `earliestBoardable` binary-searches them, which is
   * only sound if they are sorted. The published grouping lists them in that order — and the first
   * reader of it walked the shard in *index* order and merely tagged each trip with its route, so
   * the order was lost and a binary search over unsorted departures returned a later bus. The
   * corpus caught it as four of ten recommendations changed, one arriving 4,050 seconds later.
   *
   * So this does not take the caller's word for it. One comparison per trip says whether the group
   * is ordered, and a group that is not gets sorted — which costs something only when the input is
   * wrong, and turns a silently worse journey into a slightly slower request.
   */
  verifyOrder = false,
): {
  routes: RouteGroup[];
  routesByStop: Map<string, Array<{ route: RouteGroup; at: number }>>;
} {
  const routes: RouteGroup[] = [];
  const routesByStop = new Map<string, Array<{ route: RouteGroup; at: number }>>();
  for (const group of groups) {
    if (group.length === 0) continue;
    let trips = group;
    if (verifyOrder && group.length > 1) {
      let ordered = true;
      for (let at = 1; at < group.length; at += 1) {
        if (departureAt(group[at]!, 0) < departureAt(group[at - 1]!, 0)) {
          ordered = false;
          break;
        }
      }
      if (!ordered) {
        trips = [...group].sort((a, b) => {
          const left = departureAt(a, 0);
          const right = departureAt(b, 0);
          return left !== right ? left - right : a.id < b.id ? -1 : 1;
        });
      }
    }
    const first = trips[0]!;
    const stopIds: string[] = [];
    for (let at = 0, count = callCount(first); at < count; at += 1) {
      stopIds.push(stopIdAt(first, at));
    }
    const route: RouteGroup = {
      stopIds,
      /* Filled in by `buildGraph`, which is the only thing that knows the space. */
      stopIndices: NO_INDICES,
      trips: [...trips],
      nonOvertaking: true,
    };
    routes.push(route);
    for (let at = 0; at < stopIds.length; at += 1) {
      const stopId = stopIds[at]!;
      const list = routesByStop.get(stopId);
      if (list) list.push({ route, at });
      else routesByStop.set(stopId, [{ route, at }]);
    }
  }
  return { routes, routesByStop };
}

export function groupRoutes(trips: readonly Trip[]): {
  routes: RouteGroup[];
  routesByStop: Map<string, Array<{ route: RouteGroup; at: number }>>;
} {
  /*
   * Grouped by pattern first, then by sequence inside it, and the order matters for cost.
   *
   * The first version keyed on the sequence itself — the stop ids joined — which for a Manchester
   * corridor is nine and a half thousand strings of about nine hundred characters each, built and
   * hashed to discover what the pattern id already says. It measured forty milliseconds of a
   * seventy-five millisecond graph build. Trips sharing a pattern share a sequence unless the
   * corridor filter cut one of them short, so the pattern groups them and an element-wise
   * comparison inside the group separates the few that disagree. No string is built.
   *
   * Two different patterns that happen to have the same sequence stay separate routes. That costs
   * one extra route scan and is correct, which is the right way round.
   */
  /*
   * The published grouping first, when every trip carries one.
   *
   * This is the whole of the artifact's value on the request path: a `Map` insert per trip and
   * nothing else — no sequence comparison, no sort, no overtaking split. The publisher has already
   * made all three decisions, and it made them with the same code this falls back to, which a test
   * holds it to over two hundred generated timetables.
   *
   * All or nothing: a mixture of keyed and unkeyed trips goes the long way, because a keyed trip
   * and an unkeyed one with the same sequence belong in one route and only the comparison can say
   * so.
   */
  const keyed = new Map<string, Trip[]>();
  let everyTripKeyed = true;
  for (const trip of trips) {
    if (callCount(trip) < 2) continue;
    if (trip.routeKey === undefined) {
      everyTripKeyed = false;
      break;
    }
    const existing = keyed.get(trip.routeKey);
    if (existing) existing.push(trip);
    else keyed.set(trip.routeKey, [trip]);
  }
  if (everyTripKeyed && keyed.size > 0) return routesFromGroups([...keyed.values()], true);

  const byPattern = new Map<string, { whole: Trip[] | null; cut: Trip[][] }>();
  for (const trip of trips) {
    if (callCount(trip) < 2) continue;
    let entry = byPattern.get(trip.patternId);
    if (entry === undefined) {
      entry = { whole: null, cut: [] };
      byPattern.set(trip.patternId, entry);
    }

    /*
     * The trips that kept the pattern's whole sequence need no comparison: they are identical to
     * each other by construction. That is the common case — a corridor cuts the few trips that
     * leave it — and it is where the 238,000 stop-id comparisons went.
     */
    /*
     * The length is still checked, because the flag is a caller's claim and this is where a wrong
     * one would do its damage: two sequences of different lengths in one route, and the
     * non-overtaking scan comparing a stop that is not there. A trip whose length disagrees with
     * the rest of its pattern's whole-sequence group goes down the comparison path instead, which
     * is correct whatever the flag says. One integer comparison per trip keeps the saving.
     */
    if (trip.wholePatternSequence === true) {
      if (entry.whole === null) entry.whole = [trip];
      else if (callCount(entry.whole[0]!) === callCount(trip)) entry.whole.push(trip);
      else entry.cut.push([trip]);
      continue;
    }

    let placed = false;
    const mineCount = callCount(trip);
    for (const bucket of entry.cut) {
      const against = bucket[0]!;
      if (callCount(against) !== mineCount) continue;
      let same = true;
      for (let at = 0; at < mineCount; at++) {
        if (stopIdAt(against, at) !== stopIdAt(trip, at)) {
          same = false;
          break;
        }
      }
      if (same) {
        bucket.push(trip);
        placed = true;
        break;
      }
    }
    if (!placed) entry.cut.push([trip]);
  }
  /*
   * A cut trip whose sequence happens to be the pattern's whole one joins the whole group, which
   * it has to: two trips with the same sequence are one route however each of them got there.
   */
  const bySequence: Trip[][] = [];
  for (const entry of byPattern.values()) {
    const whole = entry.whole;
    if (whole !== null) {
      const reference = whole[0]!;
      const referenceCount = callCount(reference);
      const remaining: Trip[][] = [];
      for (const bucket of entry.cut) {
        const against = bucket[0]!;
        const againstCount = callCount(against);
        let same = againstCount === referenceCount;
        for (let at = 0; same && at < againstCount; at++) {
          if (stopIdAt(against, at) !== stopIdAt(reference, at)) same = false;
        }
        if (same) for (const trip of bucket) whole.push(trip);
        else remaining.push(bucket);
      }
      bySequence.push(whole, ...remaining);
      continue;
    }
    bySequence.push(...entry.cut);
  }

  const routes: RouteGroup[] = [];
  const routesByStop = new Map<string, Array<{ route: RouteGroup; at: number }>>();

  for (const group of bySequence) {
    /*
     * Ordered by departure at the first stop, and ties broken on the trip id.
     *
     * The tie-break is not cosmetic: the split below compares each trip against the last one
     * admitted to a route, so an order that is not total would make which journey is found depend
     * on the order the trips happened to be read in.
     */
    /*
     * One object per trip, carrying its effective times and the key it sorts on, instead of a
     * `Map` keyed by the trip object and two lookups per comparison. A sort of nine and a half
     * thousand trips is upwards of a hundred thousand comparisons, and each one was two map
     * probes to fetch an array in order to read one number out of its first element.
     */
    const entries = group.map((trip) => ({ trip, at: departureAt(trip, 0) }));
    entries.sort((a, b) => (a.at !== b.at ? a.at - b.at : a.trip.id < b.trip.id ? -1 : 1));
    const ordered = entries;
    const firstTrip = ordered[0]!.trip;
    const callsHere = callCount(firstTrip);
    const stopIds: string[] = [];
    for (let at = 0; at < callsHere; at += 1) stopIds.push(stopIdAt(firstTrip, at));

    /*
     * Split into routes no bus overtakes another on. See `RouteGroup.nonOvertaking`.
     *
     * Each trip joins the first route whose last admitted trip it is at or behind at every stop,
     * and starts a new one when there is none. Comparing against the last member is enough
     * because that route is already free of overtaking, so being behind its last trip puts this
     * one behind all of them — which keeps this O(trips × routes × stops) rather than quadratic
     * in the trips, and in practice there is one route and the inner loop runs once.
     */
    const buckets: Array<Array<{ trip: Trip; at: number }>> = [];
    for (const entry of ordered) {
      const mine = entry.trip;
      const mineCount = callCount(mine);
      let placed = false;
      for (const bucket of buckets) {
        const last = bucket[bucket.length - 1]!.trip;
        let behind = true;
        for (let at = 0; at < mineCount; at++) {
          if (departureAt(mine, at) < departureAt(last, at)) {
            behind = false;
            break;
          }
        }
        if (behind) {
          bucket.push(entry);
          placed = true;
          break;
        }
      }
      if (!placed) buckets.push([entry]);
    }

    for (const bucket of buckets) {
      const route: RouteGroup = {
        stopIds,
        stopIndices: NO_INDICES,
        trips: bucket.map((entry) => entry.trip),
        nonOvertaking: true,
      };
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
 * How many calls this trip has.
 *
 * These four accessors are the search's whole view of a trip's times, and they exist so that a
 * trip read from a published shard never has to be turned into objects to be searched. Each one
 * is a module-level function rather than a method, because the deployed bundle keeps function
 * names and a closure per trip costs about a microsecond — thirty milliseconds over a corridor,
 * which is the entire budget.
 */
export function callCount(trip: Trip): number {
  const calls = trip.calls;
  return calls === undefined ? (trip.stopTimes?.length ?? 0) : calls.count;
}

/** The stop this trip's `at`th call is at. */
export function stopIdAt(trip: Trip, at: number): string {
  const calls = trip.calls;
  if (calls === undefined) return trip.stopTimes![at]!.stopId;
  return calls.sequence[calls.kept === null ? at : calls.kept[at]!]!;
}

/** Seconds since the service day began, with any live delay applied. */
export function departureAt(trip: Trip, at: number): number {
  const calls = trip.calls;
  const delay = trip.delaySeconds ?? 0;
  if (calls === undefined) return trip.stopTimes![at]!.departureSeconds + delay;
  const call = calls.kept === null ? at : calls.kept[at]!;
  return calls.source.departure(calls.trip, call) - calls.dayStartSeconds + delay;
}

export function arrivalAt(trip: Trip, at: number): number {
  const calls = trip.calls;
  const delay = trip.delaySeconds ?? 0;
  if (calls === undefined) return trip.stopTimes![at]!.arrivalSeconds + delay;
  const call = calls.kept === null ? at : calls.kept[at]!;
  return calls.source.arrival(calls.trip, call) - calls.dayStartSeconds + delay;
}

/**
 * Effective stop times for a trip, as objects, with any live delay applied.
 *
 * For the callers that genuinely need objects: the exhaustive oracle in the tests, the profiler,
 * and anything presenting an itinerary. The search does not — it reads the accessors above — which
 * is the point of this being the only place a columnar trip is ever materialised.
 */
export function effectiveStopTimes(trip: Trip): readonly TripStopTime[] {
  const delay = trip.delaySeconds ?? 0;
  const times = trip.stopTimes;
  if (times !== undefined) {
    if (delay === 0) return times;
    return times.map((stopTime) => ({
      stopId: stopTime.stopId,
      arrivalSeconds: stopTime.arrivalSeconds + delay,
      departureSeconds: stopTime.departureSeconds + delay,
    }));
  }
  const count = callCount(trip);
  const materialised: TripStopTime[] = [];
  for (let at = 0; at < count; at += 1) {
    materialised.push({
      stopId: stopIdAt(trip, at),
      arrivalSeconds: arrivalAt(trip, at),
      departureSeconds: departureAt(trip, at),
    });
  }
  return materialised;
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
