import { arrivalAt, departureAt, type JourneyGraph, type RouteGroup, type Trip } from "./graph.js";

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
  /**
   * Times read out of a trip in the boardability loop.
   *
   * It counted calls to `effectiveStopTimes`, each of which could allocate a whole array of
   * stop-time objects. The search reads the times in place now — a trip from a published shard has
   * no objects to allocate — so this counts the reads rather than the allocations, which is the
   * same loop and no longer the same cost.
   */
  tripTimeReads: number;
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
    tripTimeReads: 0,
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
): number {
  const trips = route.trips;
  /* Nothing past the trip already being ridden can help. */
  const ceiling = riding === -1 ? trips.length : riding;
  if (ceiling === 0) return -1;

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
    if (departureAt(trips[mid]!, at) >= readyAt) high = mid;
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
      counters.tripTimeReads += 1;
    }
    if (departureAt(trip, at) >= readyAt) return index;
  }
  return -1;
}

export function runRaptor(
  graph: JourneyGraph,
  origins: readonly SearchOrigin[],
  options: RaptorOptions,
  counters?: SearchCounters,
): RaptorResult {
  const maxRounds = options.maxRounds ?? 4;
  const minTransferSeconds = options.minTransferSeconds ?? DEFAULT_MIN_TRANSFER_SECONDS;

  /*
   * The whole search runs over integer stop indices, and becomes maps once at the end.
   *
   * A round is tens of thousands of label lookups — 42,924 offers and 49,179 transfer edges for
   * one Leeds plan — and every one of them was a `Map` keyed by a stop UUID, so every one hashed
   * a thirty-six character string. The labels live in typed arrays over the graph's stop space
   * instead, and the result is materialised into the maps the itinerary builder and the oracle
   * read, which is why nothing outside this function changed.
   *
   * `legs` and `previousStop` are the only non-numeric state, and a leg is still built only for a
   * label that was accepted.
   */
  const stopCount = graph.stopIdByIndex.length;
  const indexOf = graph.stopIndexOf;
  const names = graph.stopIdByIndex;
  const walks = graph.transfers;
  const walkIndex = graph.transferIndexByStop;

  const UNREACHED = 0x7fffffff;

  const bestArrival = new Int32Array(stopCount).fill(UNREACHED);
  const bestRound = new Int32Array(stopCount).fill(-1);
  const bestLeg: Array<SearchLeg | null> = new Array(stopCount).fill(null);
  const bestPrevious = new Int32Array(stopCount).fill(-1);

  const arrival = new Int32Array(stopCount).fill(UNREACHED);
  const labelRound = new Int32Array(stopCount).fill(-1);
  const legs: Array<SearchLeg | null> = new Array(stopCount).fill(null);
  const previousStop = new Int32Array(stopCount).fill(-1);

  /** Per round, the labels as they stood at its end, so each change count survives the search. */
  const snapshots: Array<{
    arrival: Int32Array;
    round: Int32Array;
    legs: Array<SearchLeg | null>;
    previous: Int32Array;
    /** How many stops had a label, which is what the copy used to cost. */
    labelled: number;
  }> = [];

  const snapshot = (): void => {
    let labelled = 0;
    for (let stop = 0; stop < stopCount; stop += 1) {
      if (arrival[stop]! !== UNREACHED) labelled += 1;
    }
    snapshots.push({
      arrival: arrival.slice(),
      round: labelRound.slice(),
      legs: [...legs],
      previous: previousStop.slice(),
      labelled,
    });
  };

  const improve = (stop: number, seconds: number, leg: SearchLeg | null, from: number): void => {
    arrival[stop] = seconds;
    labelRound[stop] = 0;
    legs[stop] = leg;
    previousStop[stop] = from;
    if (seconds < bestArrival[stop]!) {
      bestArrival[stop] = seconds;
      bestRound[stop] = 0;
      bestLeg[stop] = leg;
      bestPrevious[stop] = from;
    }
  };

  for (const origin of origins) {
    const stop = indexOf.get(origin.stopId);
    if (stop === undefined) continue;
    const seconds = options.departAtSeconds + origin.accessSeconds;
    if (seconds >= arrival[stop]!) continue;
    improve(stop, seconds, null, -1);
  }

  /*
   * Initial footpaths: a passenger can walk from the stop they started at to a nearby one and
   * board there. Without this the search silently misses itineraries a person would obviously
   * take, which is exactly what the brute-force comparison catches.
   */
  const allowInitialFootpaths = options.allowInitialFootpaths ?? true;
  if (allowInitialFootpaths) {
    /* The origins only, taken before any of them is extended, as the map version did. */
    const seeds: number[] = [];
    for (let stop = 0; stop < stopCount; stop += 1) {
      if (arrival[stop]! !== UNREACHED) seeds.push(stop);
    }
    for (const stop of seeds) {
      const from = arrival[stop]!;
      const fromIndex = walkIndex[stop]!;
      if (fromIndex < 0) continue;
      const lastEdge = walks.offsets[fromIndex + 1]!;
      for (let edge = walks.offsets[fromIndex]!; edge < lastEdge; edge += 1) {
        const neighbour = walks.stopIds[walks.neighbours[edge]!]!;
        const to = indexOf.get(neighbour);
        if (to === undefined) continue;
        const reached = from + walks.seconds[edge]!;
        if (reached >= arrival[to]!) continue;
        improve(
          to,
          reached,
          {
            kind: "transfer",
            fromStopId: names[stop]!,
            toStopId: neighbour,
            departureSeconds: from,
            arrivalSeconds: reached,
          },
          stop,
        );
      }
    }
  }

  snapshot();

  let marked: number[] = [];
  for (let stop = 0; stop < stopCount; stop += 1) {
    if (arrival[stop]! !== UNREACHED) marked.push(stop);
  }

  /** Whether a stop is already in `nextMarked`, so the list holds each stop once. */
  const queued = new Uint8Array(stopCount);

  for (let round = 1; round <= maxRounds && marked.length > 0; round++) {
    if (counters) {
      counters.rounds += 1;
      counters.markedPerRound.push(marked.length);
      counters.labelMapCopies += 1;
      counters.labelEntriesCopied += snapshots[round - 1]!.labelled;
    }

    const previousArrival = snapshots[round - 1]!.arrival;
    const previousRound = snapshots[round - 1]!.round;
    const nextMarked: number[] = [];
    queued.fill(0);

    /**
     * Whether a stop reached at `seconds` in this round is worth a label.
     *
     * Separated from building the label, which is the whole point. Profiled over real corridors,
     * this was called 6,510,009 times for a Manchester plan and accepted 24,105 of them — an
     * accept rate of 0.004 — and the caller built a `StopLabel` *and* a nested `leg` object before
     * every one of those calls. Thirteen million objects allocated to keep twenty-four thousand,
     * per journey, on a path allowed ten milliseconds of CPU in total.
     *
     * The test is the same test it always was, in the same order, on the same numbers.
     */
    const worthLabelling = (stop: number, seconds: number): boolean => {
      if (counters) counters.improveCalls += 1;
      if (seconds >= arrival[stop]!) return false;
      // Pruning against the global best is what keeps the search bounded.
      if (seconds >= bestArrival[stop]! && bestRound[stop]! <= round) return false;
      return true;
    };

    /** Records a label the test above has already accepted. */
    const accept = (stop: number, seconds: number, leg: SearchLeg, from: number): void => {
      if (counters) counters.improveAccepted += 1;
      arrival[stop] = seconds;
      labelRound[stop] = round;
      legs[stop] = leg;
      previousStop[stop] = from;
      if (seconds < bestArrival[stop]!) {
        bestArrival[stop] = seconds;
        bestRound[stop] = round;
        bestLeg[stop] = leg;
        bestPrevious[stop] = from;
      }
      if (queued[stop] === 0) {
        queued[stop] = 1;
        nextMarked.push(stop);
      }
    };

    /*
     * Which routes to scan, and from where.
     *
     * A route enters the queue because an improved stop is on it, and it is scanned from the
     * earliest such position: everything before that was already reachable in an earlier round,
     * so riding through it adds a change for nothing.
     */
    const queue = new Map<RouteGroup, number>();
    for (const stop of marked) {
      const entries = graph.routesByStopIndex[stop];
      if (entries === undefined) continue;
      for (const entry of entries) {
        const existing = queue.get(entry.route);
        if (existing === undefined || entry.at < existing) queue.set(entry.route, entry.at);
      }
    }

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
      const stopIndices = route.stopIndices;
      /** The trip being ridden: an index into `route.trips`, or -1 for none yet. */
      let riding = -1;
      let boardedStop = -1;
      let boardedDeparture = 0;

      for (let at = startAt; at < stopIndices.length; at++) {
        const stop = stopIndices[at]!;

        /* Alight here, if a trip is being ridden and this is worth a label. */
        if (riding !== -1) {
          const reached = arrivalAt(route.trips[riding]!, at);
          if (worthLabelling(stop, reached)) {
            accept(
              stop,
              reached,
              {
                kind: "board",
                fromStopId: names[boardedStop]!,
                toStopId: names[stop]!,
                departureSeconds: boardedDeparture,
                arrivalSeconds: reached,
                trip: route.trips[riding]!,
              },
              boardedStop,
            );
          }
        }

        /* Board here, if the previous round reached this stop in time for something earlier. */
        const from = previousArrival[stop]!;
        if (from === UNREACHED) continue;
        // Boarding after a previous ride needs the interchange buffer; the first boarding does not.
        const readyAt = previousRound[stop]! === 0 ? from : from + minTransferSeconds;
        if (riding !== -1 && departureAt(route.trips[riding]!, at) <= readyAt) continue;

        const earlier = earliestBoardable(route, at, readyAt, riding, counters);
        if (earlier === -1) continue;
        riding = earlier;
        boardedStop = stop;
        boardedDeparture = departureAt(route.trips[riding]!, at);
      }
    }

    /*
     * Walking transfers from anything improved this round. They do not consume a round, since
     * walking is not a boarding, but they only extend stops this round actually reached.
     *
     * One hop, from the stops the rides reached — the length is taken before the loop, so a stop
     * reached *by walking* is marked for the next round but is not itself walked from here. That
     * is what the map version did, by iterating a copy of the marked set, and walking the chain
     * instead would find itineraries with two consecutive walks in them: a different planner, not
     * a faster one.
     */
    const reachedByRiding = nextMarked.length;
    for (let queuedAt = 0; queuedAt < reachedByRiding; queuedAt += 1) {
      const stop = nextMarked[queuedAt]!;
      const from = arrival[stop]!;
      if (from === UNREACHED) continue;

      /*
       * Over the adjacency's arrays, not over a list of objects.
       *
       * This is where the published transfers are spent: integer arithmetic per edge and one array
       * read for the neighbour. The structure it walks is the same one the artifact decodes into,
       * which is the whole point of publishing it, and the stop's place in that structure was
       * resolved once when the graph was built rather than hashed per edge here.
       */
      const fromIndex = walkIndex[stop]!;
      if (fromIndex < 0) continue;
      const lastEdge = walks.offsets[fromIndex + 1]!;
      for (let edge = walks.offsets[fromIndex]!; edge < lastEdge; edge += 1) {
        if (counters) counters.transferScans += 1;
        const neighbour = walks.stopIds[walks.neighbours[edge]!]!;
        const to = indexOf.get(neighbour);
        if (to === undefined) continue;
        const reached = from + walks.seconds[edge]!;
        if (reached >= arrival[to]!) continue;

        const leg: SearchLeg = {
          kind: "transfer",
          fromStopId: names[stop]!,
          toStopId: neighbour,
          departureSeconds: from,
          arrivalSeconds: reached,
        };
        arrival[to] = reached;
        labelRound[to] = round;
        legs[to] = leg;
        previousStop[to] = stop;
        if (reached < bestArrival[to]!) {
          bestArrival[to] = reached;
          bestRound[to] = round;
          bestLeg[to] = leg;
          bestPrevious[to] = stop;
        }
        /* Marked for the next round, not for this one: see `reachedByRiding` above. */
        if (queued[to] === 0) {
          queued[to] = 1;
          nextMarked.push(to);
        }
      }
    }

    snapshot();
    marked = nextMarked;
  }

  /*
   * And back into the maps everything else reads.
   *
   * One pass per round over the stops that have a label, which is what building these maps cost
   * before — the saving is in the rounds, not here.
   */
  const labelsByRound: Array<Map<string, StopLabel>> = snapshots.map((snapshot) => {
    const labels = new Map<string, StopLabel>();
    for (let stop = 0; stop < stopCount; stop += 1) {
      if (snapshot.arrival[stop]! === UNREACHED) continue;
      const from = snapshot.previous[stop]!;
      labels.set(names[stop]!, {
        arrivalSeconds: snapshot.arrival[stop]!,
        round: snapshot.round[stop]!,
        leg: snapshot.legs[stop] ?? null,
        previousStopId: from < 0 ? null : names[from]!,
      });
    }
    return labels;
  });

  const best = new Map<string, StopLabel>();
  for (let stop = 0; stop < stopCount; stop += 1) {
    if (bestArrival[stop]! === UNREACHED) continue;
    const from = bestPrevious[stop]!;
    best.set(names[stop]!, {
      arrivalSeconds: bestArrival[stop]!,
      round: bestRound[stop]!,
      leg: bestLeg[stop] ?? null,
      previousStopId: from < 0 ? null : names[from]!,
    });
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
