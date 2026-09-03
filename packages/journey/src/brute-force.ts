import { effectiveStopTimes, type JourneyGraph } from "./graph.js";
import type { SearchDestination, SearchOrigin } from "./raptor.js";

/**
 * Exhaustive reference implementation, used only in tests.
 *
 * The planner's correctness claim is checked against this by enumerating every legal itinerary
 * up to a bounded number of boardings on small graphs. A routing algorithm that has only ever
 * been checked against its own output has not been checked at all.
 */

export interface BruteForceResult {
  arrivalSeconds: number;
  changeCount: number;
  boardedTripIds: string[];
}

export function bruteForceEarliestArrival(
  graph: JourneyGraph,
  origins: readonly SearchOrigin[],
  destinations: readonly SearchDestination[],
  departAtSeconds: number,
  maxBoardings: number,
  minTransferSeconds = 60,
): BruteForceResult | null {
  let best: BruteForceResult | null = null;

  const destinationBy = new Map(destinations.map((d) => [d.stopId, d.egressSeconds]));

  const visit = (
    stopId: string,
    readySeconds: number,
    boardings: number,
    boardedTripIds: string[],
    visitedStops: ReadonlySet<string>,
  ): void => {
    const egress = destinationBy.get(stopId);
    if (egress !== undefined) {
      const arrival = readySeconds + egress;
      if (!best || arrival < best.arrivalSeconds) {
        best = { arrivalSeconds: arrival, changeCount: Math.max(0, boardings - 1), boardedTripIds };
      }
    }

    if (boardings >= maxBoardings) return;

    for (const trip of graph.tripsByStop.get(stopId) ?? []) {
      if (trip.cancelled) continue;
      const stopTimes = effectiveStopTimes(trip);
      const readyAt = boardings === 0 ? readySeconds : readySeconds + minTransferSeconds;

      for (let i = 0; i < stopTimes.length - 1; i++) {
        const boardStop = stopTimes[i]!;
        if (boardStop.stopId !== stopId) continue;
        if (boardStop.departureSeconds < readyAt) continue;

        for (let j = i + 1; j < stopTimes.length; j++) {
          const alight = stopTimes[j]!;
          if (visitedStops.has(alight.stopId)) continue;

          const nextVisited = new Set(visitedStops);
          nextVisited.add(alight.stopId);

          visit(
            alight.stopId,
            alight.arrivalSeconds,
            boardings + 1,
            [...boardedTripIds, trip.id],
            nextVisited,
          );

          // Walking on from where we alighted.
          for (const transfer of graph.transfers.get(alight.stopId) ?? []) {
            if (nextVisited.has(transfer.toStopId)) continue;
            const walked = new Set(nextVisited);
            walked.add(transfer.toStopId);
            visit(
              transfer.toStopId,
              alight.arrivalSeconds + transfer.walkSeconds,
              boardings + 1,
              [...boardedTripIds, trip.id],
              walked,
            );
          }
        }
        break; // one boarding per trip per stop is enough for the earliest departure
      }
    }
  };

  for (const origin of origins) {
    visit(origin.stopId, departAtSeconds + origin.accessSeconds, 0, [], new Set([origin.stopId]));
  }

  return best;
}
