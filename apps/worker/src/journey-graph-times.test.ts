import { describe, expect, it } from "vitest";
import type { RoutePattern, ServiceRoute } from "@busstops/contracts";
import type { PatternTripRow } from "@busstops/pipeline-static-network";
import { buildGraphFor, secondsIntoServiceDay } from "./journey-service.js";
import type { RouteStop } from "./network-queries.js";

/**
 * The arithmetic that replaced a round trip through text, held against the function it replaced.
 *
 * `buildGraphFor` read `secondsIntoServiceDay(new Date(epoch * 1000).toISOString(), serviceDate)`
 * for the arrival and the departure of every call of every trip. For a Manchester corridor —
 * 9,526 trips of about twenty-five calls — that is 476,300 `Date` objects, 476,300 ISO strings and
 * 952,600 `Date.parse` calls, half of them re-parsing the same midnight, to compute `epoch -
 * dayStart`. It is the cost the journey profile could not see, because
 * `scripts/profile-journey-search.ts` builds its trips arithmetically and so measured a search of
 * 28 ms over a corridor the deployed endpoint was spending hundreds of milliseconds on.
 *
 * `Date.parse` of a string `toISOString` has just produced is the epoch it came from, so the two
 * forms are the same number. That is an argument; this is the test.
 */

const PATTERN_ID = "11111111-1111-5111-8111-111111111111";
const SERVICE_ID = "22222222-2222-5222-8222-222222222222";
const STOP_A = "33333333-3333-5333-8333-333333333333";
const STOP_B = "44444444-4444-5444-8444-444444444444";
const STOP_C = "55555555-5555-5555-8555-555555555555";

function slice(stops: readonly string[]) {
  const pattern = {
    id: PATTERN_ID,
    serviceRouteId: SERVICE_ID,
    direction: "outbound",
    stopSequence: [...stops],
    shapeRef: "shape",
    distanceMetres: 1000,
  } as unknown as RoutePattern;
  const service = { id: SERVICE_ID, publicName: "36" } as unknown as ServiceRoute;
  /* Close together, so every stop is inside any corridor the tests use. */
  const coordinates: Record<string, { lat: number; lon: number }> = {
    [STOP_A]: { lat: 53.796, lon: -1.548 },
    [STOP_B]: { lat: 53.801, lon: -1.556 },
    [STOP_C]: { lat: 53.806, lon: -1.564 },
  };
  const stopsById = new Map<string, RouteStop>(
    stops.map((id) => [
      id,
      {
        id,
        atcoCode: `ATCO${id.slice(0, 4)}`,
        name: `Stop ${id.slice(0, 4)}`,
        locationCoordinate: coordinates[id]!,
      },
    ]),
  );
  return {
    stopsById,
    patternsById: new Map([[PATTERN_ID, pattern]]),
    services: new Map([[SERVICE_ID, service]]),
  };
}

const corridor = { west: -1.7, east: -1.4, south: 53.7, north: 53.9 };

function row(times: readonly number[], arrivals?: readonly number[]): PatternTripRow {
  return {
    p: PATTERN_ID,
    j: "trip-1",
    t: [...times],
    ...(arrivals === undefined ? {} : { a: [...arrivals] }),
  };
}

/** The same conversion the old form did, kept here as the thing to agree with. */
function viaText(epochSeconds: number, serviceDate: string): number | null {
  return secondsIntoServiceDay(new Date(epochSeconds * 1000).toISOString(), serviceDate);
}

describe("stop times into seconds of the service day", () => {
  it("agrees with the text round trip it replaced, to the second", () => {
    /* A winter date and a summer one, so a British Summer Time offset cannot hide in it. */
    for (const serviceDate of ["2026-01-14", "2026-07-15", "2026-10-25"]) {
      const midnight = Date.parse(`${serviceDate}T00:00:00.000Z`) / 1000;
      const departures = [
        midnight, // exactly midnight
        midnight + 9 * 3600 + 37 * 60 + 13, // an awkward minute and second
        midnight + 23 * 3600 + 59 * 60 + 59,
        midnight + 25 * 3600, // the night bus, past midnight into the next day
      ];
      const built = buildGraphFor(
        slice([STOP_A, STOP_B, STOP_C, STOP_A]),
        [row(departures)],
        corridor,
        serviceDate,
      );
      const trip = built.graph?.trips[0];
      expect(trip, `${serviceDate} produced no trip`).toBeDefined();
      expect(trip!.stopTimes.map((stopTime) => stopTime.departureSeconds)).toEqual(
        departures.map((epoch) => viaText(epoch, serviceDate)),
      );
      expect(trip!.stopTimes.map((stopTime) => stopTime.arrivalSeconds)).toEqual(
        departures.map((epoch) => viaText(epoch, serviceDate)),
      );
    }
  });

  it("keeps a separate arrival where the feed publishes one", () => {
    const serviceDate = "2026-07-15";
    const midnight = Date.parse(`${serviceDate}T00:00:00.000Z`) / 1000;
    const departures = [midnight + 32_400, midnight + 33_000, midnight + 33_600];
    /* A layover: the bus arrives two minutes before it leaves the interchange. */
    const arrivals = [midnight + 32_400, midnight + 32_880, midnight + 33_600];
    const built = buildGraphFor(
      slice([STOP_A, STOP_B, STOP_C]),
      [row(departures, arrivals)],
      corridor,
      serviceDate,
    );
    const trip = built.graph!.trips[0]!;
    expect(trip.stopTimes[1]!.arrivalSeconds).toBe(32_880);
    expect(trip.stopTimes[1]!.departureSeconds).toBe(33_000);
  });

  it("drops a call the trip has no time for, and keeps the stops in order", () => {
    const serviceDate = "2026-07-15";
    const midnight = Date.parse(`${serviceDate}T00:00:00.000Z`) / 1000;
    /* The middle call is missing: a trip that does not serve that stop. */
    const times = [midnight + 32_400, undefined, midnight + 33_600] as unknown as number[];
    const built = buildGraphFor(
      slice([STOP_A, STOP_B, STOP_C]),
      [{ p: PATTERN_ID, j: "trip-1", t: times }],
      corridor,
      serviceDate,
    );
    const trip = built.graph!.trips[0]!;
    expect(trip.stopTimes.map((stopTime) => stopTime.stopId)).toEqual([STOP_A, STOP_C]);
  });

  it("refuses the graph rather than inventing times for an unreadable service date", () => {
    const built = buildGraphFor(
      slice([STOP_A, STOP_B]),
      [row([1_000, 2_000])],
      corridor,
      "not-a-date",
    );
    expect(built.graph).toBeNull();
  });

  it("keeps a trip untouched when the corridor cuts nothing from it", () => {
    const serviceDate = "2026-07-15";
    const midnight = Date.parse(`${serviceDate}T00:00:00.000Z`) / 1000;
    const built = buildGraphFor(
      slice([STOP_A, STOP_B, STOP_C]),
      [row([midnight + 1, midnight + 2, midnight + 3])],
      corridor,
      serviceDate,
    );
    expect(built.graph!.trips[0]!.stopTimes).toHaveLength(3);
  });

  it("cuts the calls outside the corridor and drops a trip left with fewer than two", () => {
    const serviceDate = "2026-07-15";
    const midnight = Date.parse(`${serviceDate}T00:00:00.000Z`) / 1000;
    /* A corridor around the first stop only: the other two are a long way east. */
    const narrow = { west: -1.56, east: -1.54, south: 53.79, north: 53.8 };
    const built = buildGraphFor(
      slice([STOP_A, STOP_B, STOP_C]),
      [row([midnight + 1, midnight + 2, midnight + 3])],
      narrow,
      serviceDate,
    );
    expect(built.graph!.trips).toEqual([]);
    expect(built.tripsWithPattern).toBe(1);
  });
});
