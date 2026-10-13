import { describe, expect, it } from "vitest";
import { describeFaults, isCoherentItinerary, itineraryFaults } from "./itinerary-check.js";

/**
 * Run 41 returned a three-leg itinerary whose first leg could not say where it went, and every
 * field the schema required was present. These are the questions a passenger asks that a schema
 * does not, written as the failure was reported: "leg 1 of 3 does not say where it goes".
 */

const LEEDS = { lat: 53.7955, lon: -1.5478 };
const HORSFORTH = { lat: 53.8395, lon: -1.6294 };
const AIRPORT = { lat: 53.8659, lon: -1.6606 };

const walkToStop = {
  mode: "walk" as const,
  fromStopId: null,
  toStopId: "stop-a",
  fromName: "Your starting point",
  toName: "Leeds City Square",
  fromCoordinate: LEEDS,
  toCoordinate: LEEDS,
  departureSeconds: 30_600,
  arrivalSeconds: 30_900,
  departAtExpected: "2026-09-17T08:30:00.000Z",
  arriveAtExpected: "2026-09-17T08:35:00.000Z",
};

const ride = {
  mode: "bus" as const,
  fromStopId: "stop-a",
  toStopId: "stop-b",
  fromName: "Leeds City Square",
  toName: "Horsforth Town Street",
  fromCoordinate: LEEDS,
  toCoordinate: HORSFORTH,
  routeId: "5f2a6d4e-0000-4000-8000-000000000001",
  routePatternId: "pattern-1",
  routeName: "A2",
  headsign: "Leeds Bradford Airport",
  departureSeconds: 30_960,
  arrivalSeconds: 32_400,
  departAtExpected: "2026-09-17T08:36:00.000Z",
  arriveAtExpected: "2026-09-17T09:00:00.000Z",
};

const walkToEnd = {
  mode: "walk" as const,
  fromStopId: "stop-b",
  toStopId: null,
  fromName: "Horsforth Town Street",
  toName: "Your destination",
  fromCoordinate: HORSFORTH,
  toCoordinate: AIRPORT,
  departureSeconds: 32_400,
  arrivalSeconds: 32_700,
  departAtExpected: "2026-09-17T09:00:00.000Z",
  arriveAtExpected: "2026-09-17T09:05:00.000Z",
};

const whole = { legs: [walkToStop, ride, walkToEnd], changeCount: 0 };

describe("an itinerary is offered only if it is a journey", () => {
  it("accepts a plan whose legs name, place, time and identify themselves", () => {
    expect(itineraryFaults(whole)).toEqual([]);
    expect(isCoherentItinerary(whole)).toBe(true);
  });

  it("rejects the leg that could not say where it went", () => {
    const faults = itineraryFaults({
      ...whole,
      legs: [{ ...walkToStop, toCoordinate: { lat: 0, lon: 0 } }, ride, walkToEnd],
    });
    expect(describeFaults(faults)).toContain("leg 1 does not say where it goes");
  });

  it("rejects a bus leg that cannot say which bus", () => {
    const { routeId: _routeId, ...noService } = ride;
    const faults = itineraryFaults({ ...whole, legs: [walkToStop, noService, walkToEnd] });
    expect(describeFaults(faults)).toContain("leg 2 is a bus leg with no service identity");
  });

  it("rejects a bus leg with no route number a passenger could read", () => {
    const faults = itineraryFaults({
      ...whole,
      legs: [walkToStop, { ...ride, routeName: "  " }, walkToEnd],
    });
    expect(describeFaults(faults)).toContain("leg 2 is a bus leg with no route number");
  });

  it("rejects legs that do not join up in time", () => {
    const faults = itineraryFaults({
      ...whole,
      legs: [walkToStop, { ...ride, departAtExpected: "2026-09-17T08:20:00.000Z" }, walkToEnd],
    });
    expect(describeFaults(faults)).toContain("leg 2 departs before the previous leg arrives");
  });

  it("rejects legs that do not join up in place, which is the convincing wrong answer", () => {
    const faults = itineraryFaults({
      ...whole,
      legs: [walkToStop, { ...ride, fromStopId: "stop-somewhere-else" }, walkToEnd],
    });
    expect(describeFaults(faults)).toContain("leg 2 does not start where the previous leg ended");
  });

  it("rejects an option whose change count does not match the rides it contains", () => {
    const twoRides = {
      legs: [
        walkToStop,
        ride,
        {
          ...ride,
          fromStopId: "stop-b",
          toStopId: "stop-c",
          fromName: "Horsforth Town Street",
          toName: "Leeds Bradford Airport",
          fromCoordinate: HORSFORTH,
          toCoordinate: AIRPORT,
          departAtExpected: "2026-09-17T09:05:00.000Z",
          arriveAtExpected: "2026-09-17T09:20:00.000Z",
        },
      ],
      changeCount: 0,
    };
    expect(describeFaults(itineraryFaults(twoRides))).toContain(
      "option claims 0 change(s) across 2 ride(s)",
    );
    expect(isCoherentItinerary({ ...twoRides, changeCount: 1 })).toBe(true);
  });

  it("rejects an option with no legs at all", () => {
    expect(describeFaults(itineraryFaults({ legs: [], changeCount: 0 }))).toBe(
      "option has no legs",
    );
  });

  it("rejects a walk nobody would be offered", () => {
    const faults = itineraryFaults({
      ...whole,
      legs: [
        { ...walkToStop, arriveAtExpected: "2026-09-17T10:30:00.000Z" },
        { ...ride, departAtExpected: "2026-09-17T10:31:00.000Z" },
        {
          ...walkToEnd,
          departAtExpected: "2026-09-17T10:40:00.000Z",
          arriveAtExpected: "2026-09-17T10:45:00.000Z",
        },
      ],
    });
    expect(describeFaults(faults)).toContain("minute walk");
  });
});
