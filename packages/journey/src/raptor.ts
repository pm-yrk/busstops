import {
  effectiveStopTimes,
  type JourneyGraph,
  type RouteGroup,
  type Trip,
  type TripStopTime,
} from "./graph.js";

/**
 * Round-based earliest-arrival search (RAPTOR-style).
 *
 * Each round adds one more boarding, so the round a stop is first reached in *is* the number of
 * changes needed to reach it. That structure is what makes "fewest changes" a real answer rather
 * than a re-sort of the fastest one, and it is why this is preferred over a plain Dijkstra here.
 */

export interface SearchOrigin {
  stopId: string;
  /** Walking time from the user's actual origin to this stop. */
  accessSeconds: number;
}

export interface SearchDestination {
  stopId: string;
  /** Walking time from this stop to the user's actual destination. */
  egressSeconds: number;
}

export interface RaptorOptions {
  departAtSeconds: number;
  maxRounds?: number;
  /** Time needed to change vehicles at the same stop, on top of any walking. */
  minTransferSeconds?: number;
  /**
   * Whether the traveller may walk from their starting stop to a different one before boarding.
   * True for real planning. Set false to ask the narrower question "what can I reach boarding
   * *at this stop*", which is what the nearest-versus-fastest explanation actually compares.
   */
  allowInitialFootpaths?: boolean;
}

export type LegKind = "board" | "transfer";

export interface SearchLeg {
  kind: LegKind;
  fromStopId: string;
  toStopId: string;
  departureSeconds: number;
  arrivalSeconds: number;
  trip?: Trip;
}

export interface StopLabel {
  arrivalSeconds: number;
  round: number;
  leg: SearchLeg | null;
  previousStopId: string | null;
}

export interface RaptorResult {
  /** Best label per stop per round, so every change-count option survives the search. */
  labelsByRound: Array<Map<string, StopLabel>>;
  best: Map<string, StopLabel>;
}

export const DEFAULT_MIN_TRANSFER_SECONDS = 60;

/**
 * Counters a profiler can pass in, so the search can be measured without being rewritten.
 *
 * Cloudflare recorded `/v1/journeys` at 243 ms of CPU against a ten-millisecond free limit, 183 of
 * them in this function — over a corridor of 250 stops and 1,390 trips, which is small. A number
 * that large over a set that small is a question about data structures rather than about
 * algorithms, and answering it needs to know how many times the inner work actually runs.
 *
 * Optional and unused in production: nothing allocates these unless a caller asks.
 */
export interface SearchCounters {
  rounds: number;
  /** Stops marked as improved at the start of each round. */
  markedPerRound: number[];
  /** `(stop, trip)` pairs considered: the inner loop's real size. */
  tripScans: number;
  /** Calls to `boardingIndex`, each of which scans a trip's stop times. */
  boardingIndexCalls: number;
  /** Calls to `effectiveStopTimes`, each of which may allocate a whole array. */
  effectiveStopTimesCalls: number;
  /** Alighting labels offered, and how many survived. Garbage is the difference. */
  improveCalls: number;
  improveAccepted: number;
  /** Transfer edges walked. */
  transferScans: number;
  /** Label maps copied, and the entries copied with them. */
  labelMapCopies: number;
  labelEntriesCopied: number;
}

export function newSearchCounters(): SearchCounters {
  return {
    rounds: 0,
    markedPerRound: [],
    tripScans: 0,
    boardingIndexCalls: 0,
    effectiveStopTimesCalls: 0,
    improveCalls: 0,
    improveAccepted: 0,
    transferScans: 0,
    labelMapCopies: 0,
    labelEntriesCopied: 0,
  };
}

/**
 * The earliest trip on this route that can be boarded at `at`, or null if none beats what is ridden.
 *
 * Only an *earlier* trip than the one already being ridden is of interest: a later one cannot
 * improve any arrival downstream, and RAPTOR's route scan relies on that to visit each stop once.
 *
 * A binary search, which is sound because a route's trips never overtake each other — see
 * `RouteGroup.nonOvertaking`, which is what the split in `groupRoutes` exists to guarantee.
 * Departure order is therefore the same at this stop as at the first, so "boardable here" is
 * monotone in the index and the first such trip can be found without scanning them all. On a stop
 * sequence where buses *do* overtake, the trips are in different routes and each is scanned on its
 * own; claiming the order where it did not hold would quietly return a later bus than the one a
 * passenger could catch.
 */
function earliestBoardable(
  route: RouteGroup,
  at: number,
  readyAt: number,
  riding: number,
  counters?: SearchCounters,
): { index: number; times: readonly TripStopTime[] } | null {
  const trips = route.trips;
  /* Nothing past the trip already being ridden can help. */
  const ceiling = riding === -1 ? trips.length : riding;
  if (ceiling === 0) return null;

  /*
   * The first index in [0, ceiling) whose departure here is at or after `readyAt`.
   *
   * `monotone` is guaranteed by construction — see `RouteGroup.nonOvertaking` — so "boardable
   * here" is monotone in the index and the first such trip can be found without scanning them all.
   */
  let low = 0;
  let high = ceiling;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (counters) counters.boardingIndexCalls += 1;
    if (effectiveStopTimes(trips[mid]!)[at]!.departureSeconds >= readyAt) high = mid;
    else low = mid + 1;
  }
  /*
   * Then the first of those that is actually running.
   *
   * Written as a loop rather than around a `boardable` helper, because the helper was a closure
   * created on every call to this function. The V8 profile over forty searches put 383 ms in
   * esbuild's `__name` wrapper alone — about 9.6 ms a search, a quarter of its cost — from the
   * 328,600 closures that created, before counting the allocations themselves.
   */
  for (let index = low; index < ceiling; index++) {
    const trip = trips[index]!;
    if (trip.cancelled) continue;
    if (counters) {
      counters.tripScans += 1;
      counters.effectiveStopTimesCalls += 1;
    }
    const times = effectiveStopTimes(trip);
    if (times[at]!.departureSeconds >= readyAt) return { index, times };
  }
  return null;
}

export function runRaptor(
  graph: JourneyGraph,
  origins: readonly SearchOrigin[],
  options: RaptorOptions,
  counters?: SearchCounters,
): RaptorResult {
  const maxRounds = options.maxRounds ?? 4;
  const minTransferSeconds = options.minTransferSeconds ?? DEFAULT_MIN_TRANSFER_SECONDS;

  const best = new Map<string, StopLabel>();
  const labelsByRound: Array<Map<string, StopLabel>> = [];

  const round0 = new Map<string, StopLabel>();
  for (const origin of origins) {
    const arrival = options.departAtSeconds + origin.accessSeconds;
    const existing = round0.get(origin.stopId);
    if (!existing || arrival < existing.arrivalSeconds) {
      const label: StopLabel = {
        arrivalSeconds: arrival,
        round: 0,
        leg: null,
        previousStopId: null,
      };
      round0.set(origin.stopId, label);
      const bestExisting = best.get(origin.stopId);
      if (!bestExisting || arrival < bestExisting.arrivalSeconds) best.set(origin.stopId, label);
    }
  }
  // Initial footpaths: a passenger can walk from the stop they started at to a nearby one and
  // board there. Without this the search silently misses itineraries a person would obviously
  // take, which is exactly what the brute-force comparison catches.
  const walks = graph.transfers;
  const allowInitialFootpaths = options.allowInitialFootpaths ?? true;
  for (const originStopId of allowInitialFootpaths ? [...round0.keys()] : []) {
    const from = round0.get(originStopId)!;
    const fromIndex = walks.indexOf(originStopId);
    const lastEdge = fromIndex < 0 ? 0 : walks.offsets[fromIndex + 1]!;
    for (let edge = fromIndex < 0 ? 0 : walks.offsets[fromIndex]!; edge < lastEdge; edge += 1) {
      const toStopId = walks.stopIds[walks.neighbours[edge]!]!;
      const arrival = from.arrivalSeconds + walks.seconds[edge]!;
      const existing = round0.get(toStopId);
      if (existing && existing.arrivalSeconds <= arrival) continue;

      const label: StopLabel = {
        arrivalSeconds: arrival,
        round: 0,
        leg: {
          kind: "transfer",
          fromStopId: originStopId,
          toStopId,
          departureSeconds: from.arrivalSeconds,
          arrivalSeconds: arrival,
        },
        previousStopId: originStopId,
      };
      round0.set(toStopId, label);

      const bestExisting = best.get(toStopId);
      if (!bestExisting || arrival < bestExisting.arrivalSeconds) best.set(toStopId, label);
    }
  }

  labelsByRound.push(round0);

  let marked = new Set(round0.keys());

  for (let round = 1; round <= maxRounds && marked.size > 0; round++) {
    if (counters) {
      counters.rounds += 1;
      counters.markedPerRound.push(marked.size);
      counters.labelMapCopies += 1;
      counters.labelEntriesCopied += labelsByRound[round - 1]!.size;
    }
    const current = new Map<string, StopLabel>(labelsByRound[round - 1]!);
    const nextMarked = new Set<string>();

    /**
     * Whether a stop reached at `arrivalSeconds` in this round is worth a label.
     *
     * Separated from building the label, which is the whole point. Profiled over real corridors,
     * this was called 6,510,009 times for a Manchester plan and accepted 24,105 of them — an
     * accept rate of 0.004 — and the caller built a `StopLabel` *and* a nested `leg` object before
     * every one of those calls. Thirteen million objects allocated to keep twenty-four thousand,
     * per journey, on a path allowed ten milliseconds of CPU in total.
     *
     * The test is the same test it always was, in the same order, on the same numbers. What
     * changed is that the answer is now known before anything is built.
     */
    const worthLabelling = (stopId: string, arrivalSeconds: number): boolean => {
      if (counters) counters.improveCalls += 1;
      const existing = current.get(stopId);
      if (existing && existing.arrivalSeconds <= arrivalSeconds) return false;
      // Pruning against the global best is what keeps the search bounded.
      const globalBest = best.get(stopId);
      if (globalBest && globalBest.arrivalSeconds <= arrivalSeconds && globalBest.round <= round) {
        return false;
      }
      return true;
    };

    /** Records a label the test above has already accepted. */
    const accept = (stopId: string, label: StopLabel) => {
      if (counters) counters.improveAccepted += 1;
      current.set(stopId, label);
      const globalBest = best.get(stopId);
      if (!globalBest || label.arrivalSeconds < globalBest.arrivalSeconds) best.set(stopId, label);
      nextMarked.add(stopId);
    };

    /*
     * Which routes to scan, and from where.
     *
     * A route enters the queue because an improved stop is on it, and it is scanned from the
     * earliest such position: everything before that was already reachable in an earlier round,
     * so riding through it adds a change for nothing.
     */
    const queue = new Map<RouteGroup, number>();
    for (const stopId of marked) {
      for (const entry of graph.routesByStop.get(stopId) ?? []) {
        const existing = queue.get(entry.route);
        if (existing === undefined || entry.at < existing) queue.set(entry.route, entry.at);
      }
    }

    const previous = labelsByRound[round - 1]!;

    /*
     * One pass along each route, carrying the trip currently being ridden.
     *
     * This is the scan the search was missing. It used to board *every trip* serving every
     * improved stop and walk each of them to its end — 442,670 trip scans and 6,510,009 alighting
     * offers for one Manchester plan, of which 24,105 were kept. Here each stop of each queued
     * route is visited once: the ride is offered to it, and then the earliest trip catchable from
     * it is boarded if that is better than the one being ridden.
     *
     * The answer is the same answer. RAPTOR's round structure is unchanged — a round is still one
     * boarding, so the round a stop is first reached in is still its change count — and the
     * brute-force comparison in `journey.test.ts` is what holds that claim up, over randomised
     * timetables with delays, cancellations, loops and overtaking.
     */
    for (const [route, startAt] of queue) {
      const stopIds = route.stopIds;
      /** The trip being ridden: an index into `route.trips`, or -1 for none yet. */
      let riding = -1;
      let ridingTimes: readonly TripStopTime[] | null = null;
      let boardedStopId: string | null = null;
      let boardedDeparture = 0;

      for (let at = startAt; at < stopIds.length; at++) {
        const stopId = stopIds[at]!;

        /* Alight here, if a trip is being ridden and this is worth a label. */
        if (ridingTimes !== null) {
          const alight = ridingTimes[at]!;
          if (worthLabelling(stopId, alight.arrivalSeconds)) {
            accept(stopId, {
              arrivalSeconds: alight.arrivalSeconds,
              round,
              leg: {
                kind: "board",
                fromStopId: boardedStopId!,
                toStopId: stopId,
                departureSeconds: boardedDeparture,
                arrivalSeconds: alight.arrivalSeconds,
                trip: route.trips[riding]!,
              },
              previousStopId: boardedStopId,
            });
          }
        }

        /* Board here, if the previous round reached this stop in time for something earlier. */
        const from = previous.get(stopId);
        if (!from) continue;
        // Boarding after a previous ride needs the interchange buffer; the first boarding does not.
        const readyAt =
          from.round === 0 ? from.arrivalSeconds : from.arrivalSeconds + minTransferSeconds;
        if (ridingTimes !== null && ridingTimes[at]!.departureSeconds <= readyAt) continue;

        const earlier = earliestBoardable(route, at, readyAt, riding, counters);
        if (earlier === null) continue;
        riding = earlier.index;
        ridingTimes = earlier.times;
        boardedStopId = stopId;
        boardedDeparture = earlier.times[at]!.departureSeconds;
      }
    }

    // Walking transfers from anything improved this round. They do not consume a round, since
    // walking is not a boarding, but they only extend stops this round actually reached.
    for (const stopId of [...nextMarked]) {
      const from = current.get(stopId);
      if (!from) continue;

      /*
       * Over the adjacency's arrays, not over a list of objects.
       *
       * This is where the published transfers are spent: an index for the stop, then integer
       * arithmetic per edge and one array read for the neighbour's id. The structure it walks is
       * the same one the artifact decodes into, which is the whole point of publishing it.
       */
      const fromIndex = walks.indexOf(stopId);
      if (fromIndex < 0) continue;
      const lastEdge = walks.offsets[fromIndex + 1]!;
      for (let edge = walks.offsets[fromIndex]!; edge < lastEdge; edge += 1) {
        if (counters) counters.transferScans += 1;
        const toStopId = walks.stopIds[walks.neighbours[edge]!]!;
        const arrival = from.arrivalSeconds + walks.seconds[edge]!;
        const existing = current.get(toStopId);
        if (existing && existing.arrivalSeconds <= arrival) continue;

        const label: StopLabel = {
          arrivalSeconds: arrival,
          round,
          leg: {
            kind: "transfer",
            fromStopId: stopId,
            toStopId,
            departureSeconds: from.arrivalSeconds,
            arrivalSeconds: arrival,
          },
          previousStopId: stopId,
        };
        current.set(toStopId, label);

        const globalBest = best.get(toStopId);
        if (!globalBest || arrival < globalBest.arrivalSeconds) best.set(toStopId, label);
        nextMarked.add(toStopId);
      }
    }

    labelsByRound.push(current);
    marked = nextMarked;
  }

  return { labelsByRound, best };
}

/** Walks the label chain back to the origin, producing legs in travel order. */
export function reconstructLegs(
  labels: ReadonlyMap<string, StopLabel>,
  destinationStopId: string,
): SearchLeg[] {
  const legs: SearchLeg[] = [];
  let stopId: string | null = destinationStopId;
  const guard = new Set<string>();

  while (stopId !== null) {
    const label: StopLabel | undefined = labels.get(stopId);
    if (!label?.leg) break;
    if (guard.has(stopId)) break; // defensive: a cycle would otherwise loop forever
    guard.add(stopId);

    legs.push(label.leg);
    stopId = label.previousStopId;
  }

  return legs.reverse();
}

/**
 * Earliest arrival at the user's destination across all destination stops, accounting for the
 * walk from each stop. The nearest stop is often not the one that wins, which is the whole
 * point of evaluating candidates rather than assuming.
 */
export function bestArrival(
  labels: ReadonlyMap<string, StopLabel>,
  destinations: readonly SearchDestination[],
): { stopId: string; arrivalSeconds: number; egressSeconds: number } | null {
  let winner: { stopId: string; arrivalSeconds: number; egressSeconds: number } | null = null;

  for (const destination of destinations) {
    const label = labels.get(destination.stopId);
    if (!label) continue;
    const arrival = label.arrivalSeconds + destination.egressSeconds;
    if (!winner || arrival < winner.arrivalSeconds) {
      winner = {
        stopId: destination.stopId,
        arrivalSeconds: arrival,
        egressSeconds: destination.egressSeconds,
      };
    }
  }

  return winner;
}
