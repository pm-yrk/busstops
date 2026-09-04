import { describe, expect, it } from "vitest";
import type { ScheduledJourney, ServiceRoute, Stop } from "@busstops/contracts";
import type { PatternGeometry } from "@busstops/matching";
import {
  mergeLiveIntoScheduled,
  scheduledDeparturesForStop,
  serviceDatesForBoard,
} from "./stop-departures.js";

/**
 * The bug these cover: `departuresForStop` returned an empty array outside London and said the
 * caller would compose the timetable, and the caller did not. Every stop in England outside
 * London had a board with nothing on it while every deployed check passed.
 */

const STOP_ID = "00000000-0000-4000-8000-000000000001";
const TERMINUS_ID = "00000000-0000-4000-8000-000000000009";
const PATTERN_ID = "00000000-0000-4000-8000-0000000000a1";
const SERVICE_ID = "00000000-0000-4000-8000-0000000000b1";

const provenance = {
  source: "bods" as const,
  retrievedAt: "2026-09-04T08:00:00.000Z",
  externalIds: [],
};

const stop: Stop = {
  id: STOP_ID,
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: null,
  provenance: { ...provenance, source: "naptan" },
  ingestedAt: provenance.retrievedAt,
  qualityFlags: [],
  atcoCode: "450010001",
  name: "Boar Lane",
  locationCoordinate: { lat: 53.7965, lon: -1.5445 },
  stopType: "BCT",
};

function journey(id: string, departure: string, extra: Partial<ScheduledJourney> = {}) {
  return {
    id,
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    provenance,
    ingestedAt: provenance.retrievedAt,
    qualityFlags: [],
    routePatternId: PATTERN_ID,
    serviceDate: "2026-09-04",
    tripId: `trip-${id}`,
    state: "scheduled",
    stopTimes: [
      {
        stopId: STOP_ID,
        sequence: 0,
        scheduledDeparture: departure,
        isTimingPoint: true,
        pickupAllowed: true,
        dropOffAllowed: true,
      },
      {
        stopId: TERMINUS_ID,
        sequence: 1,
        scheduledDeparture: departure,
        isTimingPoint: true,
        pickupAllowed: false,
        dropOffAllowed: true,
      },
    ],
    ...extra,
  } as ScheduledJourney;
}

const patterns: PatternGeometry[] = [
  {
    pattern: {
      id: PATTERN_ID,
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: null,
      provenance,
      ingestedAt: provenance.retrievedAt,
      qualityFlags: [],
      serviceRouteId: SERVICE_ID,
      direction: "outbound",
      stopSequence: [STOP_ID, TERMINUS_ID],
      shapeRef: "shape-1",
      distanceMetres: 4200,
    },
    shape: [
      { lat: 53.7965, lon: -1.5445 },
      { lat: 53.81, lon: -1.53 },
    ],
    stopDistances: [0, 4200],
  },
];

const services = new Map<string, ServiceRoute>([
  [
    SERVICE_ID,
    {
      id: SERVICE_ID,
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: null,
      provenance,
      ingestedAt: provenance.retrievedAt,
      qualityFlags: [],
      operatorId: "00000000-0000-4000-8000-0000000000c1",
      publicName: "36",
      lineName: "36",
      mode: "bus",
    } as ServiceRoute,
  ],
]);

const stopNames = new Map([[TERMINUS_ID, "Ripon Market Place"]]);

describe("scheduled departures", () => {
  const now = new Date("2026-09-04T09:00:00.000Z");

  it("puts the timetable on the board, in time order", () => {
    const rows = scheduledDeparturesForStop({
      stop,
      journeys: [
        journey("00000000-0000-4000-8000-000000000021", "2026-09-04T09:25:00.000Z"),
        journey("00000000-0000-4000-8000-000000000022", "2026-09-04T09:05:00.000Z"),
      ],
      patterns,
      services,
      stopNamesById: stopNames,
      now,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]!.scheduledTime).toBe("2026-09-04T09:05:00.000Z");
    expect(rows[0]!.serviceRoutePublicName).toBe("36");
    // The destination is where the journey ends, not the name of the route.
    expect(rows[0]!.destinationName).toBe("Ripon Market Place");
    expect(rows[0]!.liveState).toBe("scheduled_only");
  });

  it("drops what has gone and what is too far ahead, and keeps the one just missed", () => {
    const rows = scheduledDeparturesForStop({
      stop,
      journeys: [
        journey("00000000-0000-4000-8000-000000000031", "2026-09-04T08:40:00.000Z"),
        journey("00000000-0000-4000-8000-000000000032", "2026-09-04T08:59:00.000Z"),
        journey("00000000-0000-4000-8000-000000000033", "2026-09-04T13:00:00.000Z"),
      ],
      patterns,
      services,
      now,
    });
    expect(rows.map((r) => r.scheduledTime)).toEqual(["2026-09-04T08:59:00.000Z"]);
  });

  it("never lists a call a passenger cannot board", () => {
    const alightOnly = journey("00000000-0000-4000-8000-000000000041", "2026-09-04T09:10:00.000Z");
    alightOnly.stopTimes[0]!.pickupAllowed = false;
    expect(
      scheduledDeparturesForStop({ stop, journeys: [alightOnly], patterns, services, now }),
    ).toHaveLength(0);
  });

  it("shows a cancelled journey as cancelled rather than hiding it", () => {
    const rows = scheduledDeparturesForStop({
      stop,
      journeys: [
        journey("00000000-0000-4000-8000-000000000051", "2026-09-04T09:10:00.000Z", {
          state: "cancelled",
        }),
      ],
      patterns,
      services,
      now,
    });
    expect(rows[0]!.liveState).toBe("cancelled");
    expect(rows[0]!.expectedTime).toBeNull();
  });

  /*
   * An interpolated stop time is a straight-line guess between two timing points. Publishing it
   * at the same confidence as a committed time would claim a precision the timetable lacks.
   */
  it("does not claim a timing point's confidence for an interpolated call", () => {
    const interpolated = journey(
      "00000000-0000-4000-8000-000000000061",
      "2026-09-04T09:10:00.000Z",
    );
    interpolated.stopTimes[0]!.isTimingPoint = false;
    const [row] = scheduledDeparturesForStop({
      stop,
      journeys: [interpolated],
      patterns,
      services,
      now,
    });
    expect(row!.confidence.level).toBe("low");
    expect(row!.qualityFlags).toContain("interpolated");
    expect(row!.uncertaintySeconds).toBeGreaterThan(120);
  });

  /*
   * A journey that began at 23:40 yesterday and calls here at 00:20 is published under
   * yesterday's service date. A board that only asked for today reported the small hours as
   * having no buses at all.
   */
  it("asks for yesterday as well, so after-midnight journeys are not lost", () => {
    expect(serviceDatesForBoard(new Date("2026-09-04T00:20:00.000Z"))).toEqual([
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
  });
});

describe("merging live into the timetable", () => {
  const now = new Date("2026-09-04T09:00:00.000Z");
  const rows = scheduledDeparturesForStop({
    stop,
    journeys: [journey("00000000-0000-4000-8000-000000000071", "2026-09-04T09:10:00.000Z")],
    patterns,
    services,
    now,
  });

  it("upgrades a matched row and moves its time", () => {
    const merged = mergeLiveIntoScheduled(rows, [
      {
        scheduledJourneyId: "00000000-0000-4000-8000-000000000071",
        expectedTime: "2026-09-04T09:13:00.000Z",
        observedAtAgeSeconds: 30,
        confidence: { level: "high", score: 0.9, reasons: ["matched to a reporting vehicle"] },
      },
    ]);
    expect(merged[0]!.liveState).toBe("live");
    expect(merged[0]!.expectedTime).toBe("2026-09-04T09:13:00.000Z");
  });

  it("calls an old position an estimate, not a live time", () => {
    const merged = mergeLiveIntoScheduled(rows, [
      {
        scheduledJourneyId: "00000000-0000-4000-8000-000000000071",
        expectedTime: "2026-09-04T09:13:00.000Z",
        observedAtAgeSeconds: 400,
        confidence: { level: "medium", score: 0.5, reasons: ["position is several minutes old"] },
      },
    ]);
    expect(merged[0]!.liveState).toBe("estimated");
  });

  /* "We cannot see this bus" and "this bus is not running" are different, and only one is true. */
  it("leaves an unmatched row on the board rather than hiding it", () => {
    expect(mergeLiveIntoScheduled(rows, [])[0]!.liveState).toBe("scheduled_only");
  });
});
