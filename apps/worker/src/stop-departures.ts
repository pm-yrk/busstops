import type {
  Confidence,
  DeparturePrediction,
  ScheduledJourney,
  ServiceRoute,
  Stop,
} from "@busstops/contracts";
import type { PatternGeometry } from "@busstops/matching";
import { deterministicUuid } from "@busstops/adapters";
import { passengerName, routeBadgeName } from "@busstops/pipeline-static-network";
import type { DepartureRow } from "@busstops/pipeline-static-network";

/**
 * Departures at one stop, composed from the published timetable.
 *
 * This exists because it did not. `LiveService.departuresForStop` returned an empty array outside
 * London with a comment saying the caller would compose scheduled departures from the timetable —
 * and the caller never did. Every stop in England outside London therefore had an arrival board
 * with nothing on it, on a deployment whose checks were all green, because the checks asked
 * whether the board rendered rather than whether it said anything.
 *
 * The read is bounded the same way everything else at the edge is: one journey tile, the one that
 * contains this stop, filtered to the service dates that can still produce a departure now.
 */

/** How far ahead a board looks. Someone at a stop is not planning their evening. */
export const DEPARTURE_WINDOW_MINUTES = 90;

/** How many rows a board composes at most, before live matching trims it further. */
export const MAX_DEPARTURE_ROWS = 20;

/**
 * A journey that departed shortly before now still belongs on the board: it may not have gone.
 * Beyond this it is history and is dropped.
 */
export const DEPARTURE_GRACE_MINUTES = 2;

export interface ScheduledDepartureInput {
  stop: Stop;
  journeys: readonly ScheduledJourney[];
  patterns: readonly PatternGeometry[];
  services: ReadonlyMap<string, ServiceRoute>;
  stopNamesById?: ReadonlyMap<string, string>;
  now: Date;
  windowMinutes?: number;
  maxRows?: number;
}

/**
 * The service dates a board at `now` must consider.
 *
 * Yesterday matters: a journey that began at 23:40 and calls here at 00:20 is published under
 * yesterday's service date, and a board that only asked for today's would show the small hours as
 * having no buses at all.
 */
export function serviceDatesForBoard(now: Date): string[] {
  const day = 24 * 60 * 60 * 1000;
  return [new Date(now.getTime() - day), now, new Date(now.getTime() + day)].map((d) =>
    d.toISOString().slice(0, 10),
  );
}

function destinationFor(
  journey: ScheduledJourney,
  pattern: PatternGeometry | undefined,
  service: ServiceRoute | undefined,
  stopNamesById: ReadonlyMap<string, string> | undefined,
): string {
  // The destination is the last stop the journey calls at. A route pattern has no destination
  // name of its own, so the stop's name is the honest answer and the service name is the fallback.
  const lastStopId = journey.stopTimes[journey.stopTimes.length - 1]?.stopId;
  const named = lastStopId ? stopNamesById?.get(lastStopId) : undefined;
  void pattern;
  return named ?? service?.publicName ?? "Unknown destination";
}

/**
 * Composes the timetable rows for a stop.
 *
 * Every row is labelled `scheduled_only` here. Live matching upgrades rows it can explain; a row
 * nothing explains stays a timetable row, which is honest and is what a paper timetable at the
 * stop would tell you anyway.
 */
export function scheduledDeparturesForStop(input: ScheduledDepartureInput): DeparturePrediction[] {
  const {
    stop,
    journeys,
    patterns,
    services,
    stopNamesById,
    now,
    windowMinutes = DEPARTURE_WINDOW_MINUTES,
    maxRows = MAX_DEPARTURE_ROWS,
  } = input;

  const from = now.getTime() - DEPARTURE_GRACE_MINUTES * 60_000;
  const until = now.getTime() + windowMinutes * 60_000;
  const patternsById = new Map(patterns.map((geometry) => [geometry.pattern.id, geometry]));

  const rows: DeparturePrediction[] = [];
  for (const journey of journeys) {
    const stopTime = journey.stopTimes.find((entry) => entry.stopId === stop.id);
    if (!stopTime) continue;
    // A stop you cannot board at is not a departure. Alighting-only calls belong on the route
    // page, not on a board someone is standing in front of.
    if (!stopTime.pickupAllowed) continue;

    const departure = Date.parse(stopTime.scheduledDeparture);
    if (!Number.isFinite(departure) || departure < from || departure > until) continue;

    const pattern = patternsById.get(journey.routePatternId);
    const service = pattern ? services.get(pattern.pattern.serviceRouteId) : undefined;
    const cancelled = journey.state === "cancelled";

    /*
     * A timing point is a time the operator committed to; an interpolated stop is a straight-line
     * guess between two of them. Publishing both at "high" would claim a precision the timetable
     * does not have.
     */
    const confidence: Confidence = {
      level: cancelled ? "high" : stopTime.isTimingPoint ? "medium" : "low",
      score: cancelled ? 0.95 : stopTime.isTimingPoint ? 0.6 : 0.35,
      reasons: cancelled
        ? ["the operator has cancelled this journey"]
        : stopTime.isTimingPoint
          ? ["timetabled departure at a timing point"]
          : ["timetabled departure interpolated between timing points"],
    };

    rows.push({
      id: journey.id,
      provenance: journey.provenance,
      ingestedAt: journey.ingestedAt,
      qualityFlags: stopTime.isTimingPoint ? [] : ["interpolated"],
      stopId: stop.id,
      scheduledJourneyId: journey.id,
      routePatternId: journey.routePatternId,
      serviceRoutePublicName: service ? routeBadgeName(service.publicName) : "Bus",
      destinationName: passengerName(destinationFor(journey, pattern, service, stopNamesById)),
      scheduledTime: new Date(departure).toISOString(),
      expectedTime: cancelled ? null : new Date(departure).toISOString(),
      liveState: cancelled ? "cancelled" : "scheduled_only",
      uncertaintySeconds: cancelled ? null : stopTime.isTimingPoint ? 120 : 300,
      confidence,
    });
  }

  rows.sort((a, b) => Date.parse(a.scheduledTime ?? "") - Date.parse(b.scheduledTime ?? ""));
  return rows.slice(0, maxRows);
}

/**
 * Folds live vehicle knowledge into the timetable rows.
 *
 * A matched vehicle turns a timetable row into a live one and moves its expected time; an
 * unmatched row is left exactly as it was rather than being quietly hidden, because "we cannot
 * see this bus" and "this bus is not running" are different things and only one of them is true.
 */
export interface LiveDepartureHint {
  scheduledJourneyId: string;
  expectedTime: string;
  observedAtAgeSeconds: number;
  confidence: Confidence;
}

export function mergeLiveIntoScheduled(
  scheduled: readonly DeparturePrediction[],
  hints: readonly LiveDepartureHint[],
): DeparturePrediction[] {
  const byJourney = new Map(hints.map((hint) => [hint.scheduledJourneyId, hint]));
  return scheduled.map((row) => {
    const hint = row.scheduledJourneyId ? byJourney.get(row.scheduledJourneyId) : undefined;
    if (!hint || row.liveState === "cancelled") return row;
    return {
      ...row,
      expectedTime: hint.expectedTime,
      // A position minutes old supports an estimate, not a live claim.
      liveState: hint.observedAtAgeSeconds <= 120 ? "live" : "estimated",
      uncertaintySeconds: hint.observedAtAgeSeconds <= 120 ? 60 : 180,
      confidence: hint.confidence,
    };
  });
}

/**
 * Composes the board from published departure rows.
 *
 * The same output as `scheduledDeparturesForStop` from a hundredth of the input. That function
 * takes whole journeys because that is what the old layout stored, and a journey is 10,313 bytes
 * of which a board uses one call; a row is the call. The two are kept side by side rather than
 * one replacing the other outright because the planner still reads journeys, and a single shape
 * serving both is what produced a 281 MiB tile in the first place.
 */
export function departuresFromRows(input: {
  stop: Stop;
  rows: readonly DepartureRow[];
  now: Date;
  retrievedAt: string;
  windowMinutes?: number;
  maxRows?: number;
}): DeparturePrediction[] {
  const {
    stop,
    rows,
    now,
    retrievedAt,
    windowMinutes = DEPARTURE_WINDOW_MINUTES,
    maxRows = MAX_DEPARTURE_ROWS,
  } = input;

  const from = now.getTime() - DEPARTURE_GRACE_MINUTES * 60_000;
  const until = now.getTime() + windowMinutes * 60_000;
  const provenance = { source: "bods" as const, retrievedAt, externalIds: [] };

  const board: DeparturePrediction[] = [];
  for (const row of rows) {
    const departure = row.t * 1000;
    if (departure < from || departure > until) continue;

    /*
     * A timing point is a time the operator committed to; an interpolated stop is a straight-line
     * guess between two of them. Publishing both at "high" would claim a precision the timetable
     * does not have.
     */
    const timingPoint = row.k === 1;
    const confidence: Confidence = {
      level: timingPoint ? "medium" : "low",
      score: timingPoint ? 0.6 : 0.35,
      reasons: [
        timingPoint
          ? "timetabled departure at a timing point"
          : "timetabled departure interpolated between timing points",
      ],
    };

    board.push({
      /*
       * Deterministic in the trip, the stop and the instant, so the same row keeps the same id
       * between requests and a client can follow it across a refresh. Namespaced as a journey
       * because that is what it identifies a call of.
       */
      id: deterministicUuid("journey", `departure:${row.j}:${stop.atcoCode}:${row.t}`),
      provenance,
      ingestedAt: retrievedAt,
      qualityFlags: timingPoint ? [] : ["interpolated"],
      stopId: stop.id,
      scheduledJourneyId: null,
      routePatternId: row.p,
      serviceRoutePublicName: routeBadgeName(row.r),
      destinationName: row.d.length > 0 ? passengerName(row.d) : "Unknown destination",
      scheduledTime: new Date(departure).toISOString(),
      expectedTime: new Date(departure).toISOString(),
      liveState: "scheduled_only",
      uncertaintySeconds: timingPoint ? 120 : 300,
      confidence,
    });
  }

  // Sorted on the epoch seconds the rows carry rather than by re-parsing a nullable ISO string.
  board.sort((a, b) => Date.parse(a.scheduledTime ?? "") - Date.parse(b.scheduledTime ?? ""));
  return board.slice(0, maxRows);
}
