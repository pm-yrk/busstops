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

export interface JourneyGraph {
  stops: Map<string, JourneyStop>;
  trips: Trip[];
  /** Trips serving each stop, precomputed so the search does not rescan every trip. */
  tripsByStop: Map<string, Trip[]>;
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

  // Walking transfers between every pair within range. Fine at the candidate-set sizes the
  // planner works with, which are capped before the search begins.
  const transfers = new Map<string, Transfer[]>();
  for (const from of input.stops) {
    const list: Transfer[] = [];
    for (const to of input.stops) {
      if (from.id === to.id) continue;
      const seconds = walkSeconds(from.coordinate, to.coordinate);
      if (seconds <= maxTransferSeconds) {
        list.push({ fromStopId: from.id, toStopId: to.id, walkSeconds: seconds });
      }
    }
    transfers.set(from.id, list);
  }

  return { stops, trips: [...input.trips], tripsByStop, transfers };
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
  const stopTimes = effectiveStopTimes(trip);
  for (let i = 0; i < stopTimes.length - 1; i++) {
    const stopTime = stopTimes[i]!;
    if (stopTime.stopId === stopId && stopTime.departureSeconds >= afterSeconds) return i;
  }
  return null;
}
