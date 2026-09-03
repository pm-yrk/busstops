import { boardingIndex, effectiveStopTimes, type JourneyGraph, type Trip } from "./graph.js";

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

export function runRaptor(
  graph: JourneyGraph,
  origins: readonly SearchOrigin[],
  options: RaptorOptions,
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
  const allowInitialFootpaths = options.allowInitialFootpaths ?? true;
  for (const originStopId of allowInitialFootpaths ? [...round0.keys()] : []) {
    const from = round0.get(originStopId)!;
    for (const transfer of graph.transfers.get(originStopId) ?? []) {
      const arrival = from.arrivalSeconds + transfer.walkSeconds;
      const existing = round0.get(transfer.toStopId);
      if (existing && existing.arrivalSeconds <= arrival) continue;

      const label: StopLabel = {
        arrivalSeconds: arrival,
        round: 0,
        leg: {
          kind: "transfer",
          fromStopId: originStopId,
          toStopId: transfer.toStopId,
          departureSeconds: from.arrivalSeconds,
          arrivalSeconds: arrival,
        },
        previousStopId: originStopId,
      };
      round0.set(transfer.toStopId, label);

      const bestExisting = best.get(transfer.toStopId);
      if (!bestExisting || arrival < bestExisting.arrivalSeconds)
        best.set(transfer.toStopId, label);
    }
  }

  labelsByRound.push(round0);

  let marked = new Set(round0.keys());

  for (let round = 1; round <= maxRounds && marked.size > 0; round++) {
    const current = new Map<string, StopLabel>(labelsByRound[round - 1]!);
    const nextMarked = new Set<string>();

    const improve = (stopId: string, label: StopLabel) => {
      const existing = current.get(stopId);
      if (existing && existing.arrivalSeconds <= label.arrivalSeconds) return;
      // Pruning against the global best is what keeps the search bounded.
      const globalBest = best.get(stopId);
      if (
        globalBest &&
        globalBest.arrivalSeconds <= label.arrivalSeconds &&
        globalBest.round <= label.round
      ) {
        return;
      }
      current.set(stopId, label);
      if (!globalBest || label.arrivalSeconds < globalBest.arrivalSeconds) best.set(stopId, label);
      nextMarked.add(stopId);
    };

    // Board every trip reachable from a stop improved in the previous round.
    for (const stopId of marked) {
      const from = labelsByRound[round - 1]!.get(stopId);
      if (!from) continue;

      // Boarding after a previous ride needs the interchange buffer; the first boarding does not.
      const readyAt =
        from.round === 0 ? from.arrivalSeconds : from.arrivalSeconds + minTransferSeconds;

      for (const trip of graph.tripsByStop.get(stopId) ?? []) {
        const index = boardingIndex(trip, stopId, readyAt);
        if (index === null) continue;

        const stopTimes = effectiveStopTimes(trip);
        const boarded = stopTimes[index]!;

        for (let i = index + 1; i < stopTimes.length; i++) {
          const alight = stopTimes[i]!;
          improve(alight.stopId, {
            arrivalSeconds: alight.arrivalSeconds,
            round,
            leg: {
              kind: "board",
              fromStopId: stopId,
              toStopId: alight.stopId,
              departureSeconds: boarded.departureSeconds,
              arrivalSeconds: alight.arrivalSeconds,
              trip,
            },
            previousStopId: stopId,
          });
        }
      }
    }

    // Walking transfers from anything improved this round. They do not consume a round, since
    // walking is not a boarding, but they only extend stops this round actually reached.
    for (const stopId of [...nextMarked]) {
      const from = current.get(stopId);
      if (!from) continue;

      for (const transfer of graph.transfers.get(stopId) ?? []) {
        const arrival = from.arrivalSeconds + transfer.walkSeconds;
        const existing = current.get(transfer.toStopId);
        if (existing && existing.arrivalSeconds <= arrival) continue;

        current.set(transfer.toStopId, {
          arrivalSeconds: arrival,
          round,
          leg: {
            kind: "transfer",
            fromStopId: stopId,
            toStopId: transfer.toStopId,
            departureSeconds: from.arrivalSeconds,
            arrivalSeconds: arrival,
          },
          previousStopId: stopId,
        });

        const globalBest = best.get(transfer.toStopId);
        if (!globalBest || arrival < globalBest.arrivalSeconds) {
          best.set(transfer.toStopId, current.get(transfer.toStopId)!);
        }
        nextMarked.add(transfer.toStopId);
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
