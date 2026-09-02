import { describe, expect, it } from "vitest";
import { FloodNoticeSchema, RoadEventSchema, RoadSegmentSchema } from "@busstops/contracts";
import { haversineMetres, pathLengthMetres } from "@busstops/pipeline-core";
import {
  describeWeatherCode,
  normalizeOpenMeteo,
  openMeteoUrl,
  rainfallBand,
  weatherGridCell,
} from "./open-meteo.js";
import {
  floodWording,
  isOfficialWarning,
  mapSeverityLevel,
  normalizeEaFloods,
} from "./environment-agency.js";
import {
  NATIONAL_HIGHWAYS_COVERAGE_CAVEAT,
  corroborateWithRoadEvents,
  normalizeNationalHighwaysEvent,
  normalizeStreetManagerPermit,
  parseWktPoint,
} from "./road-events.js";
import {
  isBusRoutableHighway,
  isWalkableHighway,
  mapRoadClass,
  normalizeOverpass,
  overpassQuery,
  parseMaxSpeedMph,
} from "./osm.js";
import { osgb36ToWgs84 } from "./osgb36.js";

const retrievedAt = "2026-09-02T09:00:00.000Z";

describe("Open-Meteo", () => {
  const payload = {
    latitude: 53.8,
    longitude: -1.55,
    generationtime_ms: 0.2,
    utc_offset_seconds: 0,
    timezone: "GMT",
    elevation: 50,
    hourly_units: { temperature_2m: "°C", precipitation: "mm", wind_speed_10m: "km/h" },
    hourly: {
      time: ["2026-09-02T07:00", "2026-09-02T08:00", "2026-09-02T09:00", "2026-09-02T10:00"],
      temperature_2m: [12.1, 12.8, 13.4, 14.0],
      precipitation: [0, 0.4, 3.2, 8.1],
      wind_speed_10m: [10.8, 14.4, 18.0, 21.6],
      weather_code: [3, 61, 63, 95],
    },
  };
  const options = { retrievedAt, now: new Date("2026-09-02T09:00:00Z") };

  it("splits the series into observations and forecasts at now", () => {
    const result = normalizeOpenMeteo(payload, options);
    expect(result.observations).toHaveLength(3); // 07:00, 08:00 and 09:00 are at or before now
    expect(result.forecasts).toHaveLength(1);
  });

  it("records the forecast horizon so an old forecast cannot pose as an observation", () => {
    const result = normalizeOpenMeteo(payload, options);
    expect(result.forecasts[0]?.forecastHorizonHours).toBe(1);
    expect(result.forecasts[0]?.modelRunAt).toBe(retrievedAt);
  });

  it("converts wind speed from km/h to m/s", () => {
    const result = normalizeOpenMeteo(payload, options);
    // 18.0 km/h = 5.0 m/s
    const nineAm = result.observations.find((o) => o.observedAt === "2026-09-02T09:00:00.000Z")!;
    expect(nineAm.condition.windSpeedMetresPerSecond).toBeCloseTo(5, 3);
  });

  it("skips hours with missing values rather than defaulting them to zero", () => {
    const withGap = {
      ...payload,
      hourly: { ...payload.hourly, temperature_2m: [12.1, null, 13.4, 14.0] },
    };
    const result = normalizeOpenMeteo(withGap, options);
    expect(result.rejected).toBe(1);
    expect(result.observations).toHaveLength(2);
  });

  it("rejects a payload that does not match the documented shape", () => {
    expect(normalizeOpenMeteo({ nope: true }, options).rejected).toBe(1);
  });

  it("buckets nearby coordinates into one cacheable grid cell", () => {
    expect(weatherGridCell({ lat: 53.79, lon: -1.54 })).toBe(
      weatherGridCell({ lat: 53.82, lon: -1.56 }),
    );
    expect(weatherGridCell({ lat: 53.79, lon: -1.54 })).not.toBe(
      weatherGridCell({ lat: 51.5, lon: -0.12 }),
    );
  });

  it("requests the grid cell, not the exact coordinate, so caching works", () => {
    const url = openMeteoUrl({ lat: 53.7965, lon: -1.5379 });
    expect(url).toContain("latitude=53.75");
    expect(url).toContain("timezone=UTC");
  });

  it("describes weather codes and rainfall bands", () => {
    expect(describeWeatherCode(0)).toBe("Clear");
    expect(describeWeatherCode(63)).toBe("Rain");
    expect(describeWeatherCode(95)).toBe("Thunderstorm");
    expect(rainfallBand(0)).toBe("dry");
    expect(rainfallBand(1)).toBe("light");
    expect(rainfallBand(5)).toBe("moderate");
    expect(rainfallBand(10)).toBe("heavy");
  });
});

describe("Environment Agency floods", () => {
  const payload = {
    items: [
      {
        "@id": "http://environment.data.gov.uk/flood-monitoring/id/floods/122WAF943",
        description: "River Aire at Leeds",
        eaAreaName: "Yorkshire",
        floodArea: { county: "West Yorkshire", riverOrSea: "River Aire" },
        floodAreaID: "122WAF943",
        isTidal: false,
        message: "Flooding is possible. Be prepared.",
        severity: "Flood alert",
        severityLevel: 3,
        timeMessageChanged: "2026-09-02T06:00:00",
        timeRaised: "2026-09-02T05:30:00",
      },
      {
        "@id": "http://environment.data.gov.uk/flood-monitoring/id/floods/033WAF201",
        description: "River Ouse at York",
        floodAreaID: "033WAF201",
        severity: "Flood warning",
        severityLevel: 2,
        timeRaised: "2026-09-02T04:00:00",
      },
      {
        "@id": "http://environment.data.gov.uk/flood-monitoring/id/floods/999OLD",
        description: "Withdrawn notice",
        floodAreaID: "999OLD",
        severity: "Warning no longer in force",
        severityLevel: 4,
        timeRaised: "2026-09-01T04:00:00",
      },
    ],
  };

  it("maps EA severity levels to the normalized vocabulary", () => {
    expect(mapSeverityLevel(1)).toBe("severe_warning");
    expect(mapSeverityLevel(2)).toBe("warning");
    expect(mapSeverityLevel(3)).toBe("alert");
    expect(mapSeverityLevel(4)).toBeNull();
  });

  it("normalizes active notices and withdraws expired ones", () => {
    const result = normalizeEaFloods(payload, { retrievedAt });
    expect(result.notices).toHaveLength(2);
    expect(result.withdrawnFloodAreaIds).toEqual(["999OLD"]);
    for (const notice of result.notices) {
      expect(FloodNoticeSchema.safeParse(notice).success).toBe(true);
    }
  });

  it("links each notice to the official EA page", () => {
    const result = normalizeEaFloods(payload, { retrievedAt });
    expect(result.notices[0]?.officialUrl).toContain("check-for-flooding.service.gov.uk");
  });

  it("treats only levels 1 and 2 as official warnings", () => {
    const items = payload.items;
    expect(isOfficialWarning({ ...items[1] } as never)).toBe(true);
    expect(isOfficialWarning({ ...items[0] } as never)).toBe(false);
  });

  it("only says 'flood warning active' when an official warning exists", () => {
    const { notices } = normalizeEaFloods(payload, { retrievedAt });
    expect(floodWording(notices, false)).toBe("Flood warning active");

    const alertsOnly = notices.filter((n) => n.severity === "alert");
    expect(floodWording(alertsOnly, false)).toBe("Flood alert active");

    // Nothing official: derived risk must be worded cautiously.
    expect(floodWording([], true)).toBe("Elevated flooding risk");
    expect(floodWording([], false)).toBeNull();
  });

  it("handles a single-item response that is not wrapped in an array", () => {
    const single = { items: payload.items[1] };
    expect(normalizeEaFloods(single, { retrievedAt }).notices).toHaveLength(1);
  });

  it("rejects an unrecognised payload", () => {
    expect(normalizeEaFloods({ oops: true }, { retrievedAt }).rejected).toBe(1);
  });
});

describe("National Highways", () => {
  const event = {
    id: "NH-12345",
    category: "Roadworks",
    subCategory: "Carriageway resurfacing",
    description: "Lane closure for resurfacing",
    roadName: "M62",
    latitude: 53.7,
    longitude: -1.7,
    startDate: "2026-09-02T20:00:00Z",
    endDate: "2026-09-03T06:00:00Z",
    severity: "Moderate",
    url: "https://nationalhighways.co.uk/travel-updates/NH-12345",
  };

  it("normalizes an event and always attaches the coverage caveat", () => {
    const normalized = normalizeNationalHighwaysEvent(event, { retrievedAt })!;
    expect(RoadEventSchema.safeParse(normalized).success).toBe(true);
    expect(normalized.type).toBe("roadworks");
    expect(normalized.coverageCaveat).toBe(NATIONAL_HIGHWAYS_COVERAGE_CAVEAT);
    expect(normalized.coverageCaveat).toMatch(/not local streets/);
  });

  it("classifies closures separately from incidents", () => {
    expect(
      normalizeNationalHighwaysEvent({ ...event, category: "Road Closure" }, { retrievedAt })!.type,
    ).toBe("closure");
    expect(
      normalizeNationalHighwaysEvent({ ...event, category: "Incident" }, { retrievedAt })!.type,
    ).toBe("incident");
  });

  it("keeps an open-ended event with a null end", () => {
    const normalized = normalizeNationalHighwaysEvent(
      { ...event, endDate: null },
      { retrievedAt },
    )!;
    expect(normalized.endedAt).toBeNull();
  });

  it("rejects an event outside England or with an unusable start", () => {
    expect(
      normalizeNationalHighwaysEvent({ ...event, latitude: 0, longitude: 0 }, { retrievedAt }),
    ).toBeNull();
    expect(
      normalizeNationalHighwaysEvent({ ...event, startDate: "soon" }, { retrievedAt }),
    ).toBeNull();
  });
});

describe("Street Manager", () => {
  const permit = {
    work_reference_number: "TSR-1234-5678",
    permit_reference_number: "TSR-1234-5678-01",
    street_name: "Boar Lane",
    area_name: "Leeds",
    work_category: "Standard",
    activity_type: "Remedial works",
    proposed_start_date: "2026-09-01T07:00:00.000Z",
    proposed_end_date: "2026-09-10T17:00:00.000Z",
    work_status: "in_progress",
    activity_location_coordinates: "POINT (429695 433350)",
    description_of_work: "Gas main replacement",
  };

  it("parses WKT points", () => {
    expect(parseWktPoint("POINT (429695 433350)")).toEqual({ easting: 429695, northing: 433350 });
    expect(parseWktPoint("POINT(-1.5419 53.7946)")).toEqual({
      easting: -1.5419,
      northing: 53.7946,
    });
    expect(parseWktPoint("LINESTRING (1 2, 3 4)")).toBeNull();
  });

  it("converts a National Grid location to WGS84", () => {
    const normalized = normalizeStreetManagerPermit(permit, {
      retrievedAt,
      gridToWgs84: osgb36ToWgs84,
    })!;
    expect(normalized.coordinate?.lat).toBeCloseTo(53.79, 1);
    expect(normalized.coordinate?.lon).toBeCloseTo(-1.54, 1);
  });

  it("accepts a WGS84 location without conversion", () => {
    const normalized = normalizeStreetManagerPermit(
      { ...permit, activity_location_coordinates: "POINT (-1.5419 53.7946)" },
      { retrievedAt },
    )!;
    expect(normalized.coordinate?.lat).toBeCloseTo(53.7946, 4);
  });

  it("prefers actual dates over proposed ones when works have started", () => {
    const normalized = normalizeStreetManagerPermit(
      { ...permit, actual_start_date_time: "2026-09-02T08:00:00.000Z" },
      { retrievedAt },
    )!;
    expect(normalized.startedAt).toBe("2026-09-02T08:00:00.000Z");
  });

  it("never records a permit as a cause", () => {
    const normalized = normalizeStreetManagerPermit(permit, { retrievedAt })!;
    expect(RoadEventSchema.safeParse(normalized).success).toBe(true);
    expect(Object.keys(normalized)).not.toContain("cause");
    expect(normalized.type).toBe("roadworks");
  });
});

describe("corroboration with road events", () => {
  const events = [
    {
      id: "00000000-0000-5000-8000-000000000001",
      provenance: { source: "street_manager" as const, retrievedAt, externalIds: [] },
      ingestedAt: retrievedAt,
      qualityFlags: [],
      type: "roadworks" as const,
      sourceSystem: "street_manager" as const,
      coordinate: { lat: 53.7946, lon: -1.5419 },
      startedAt: "2026-09-01T07:00:00.000Z",
      endedAt: "2026-09-10T17:00:00.000Z",
      description: "Boar Lane: Gas main replacement",
    },
  ];

  const disruption = {
    coordinate: { lat: 53.7948, lon: -1.542 },
    startedAt: "2026-09-02T08:00:00.000Z",
    endedAt: "2026-09-02T09:00:00.000Z",
  };

  it("matches a nearby, time-overlapping event", () => {
    const matches = corroborateWithRoadEvents(disruption, events, haversineMetres);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe("high");
  });

  it("words the match as corroboration, never causation", () => {
    const matches = corroborateWithRoadEvents(disruption, events, haversineMetres);
    expect(matches[0]?.wording).toMatch(/recorded .* away over the same period/);
    expect(matches[0]?.wording).not.toMatch(/caused|because|due to/i);
  });

  it("ignores an event that is too far away", () => {
    const far = [{ ...events[0]!, coordinate: { lat: 53.85, lon: -1.6 } }];
    expect(corroborateWithRoadEvents(disruption, far, haversineMetres)).toHaveLength(0);
  });

  it("ignores an event whose window does not overlap", () => {
    const past = [
      { ...events[0]!, startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-02T00:00:00.000Z" },
    ];
    expect(corroborateWithRoadEvents(disruption, past, haversineMetres)).toHaveLength(0);
  });
});

describe("OpenStreetMap", () => {
  const payload = {
    version: 0.6,
    generator: "Overpass API",
    elements: [
      { type: "node", id: 1, lat: 53.7965, lon: -1.5379 },
      { type: "node", id: 2, lat: 53.7955, lon: -1.54 },
      { type: "node", id: 3, lat: 53.7946, lon: -1.5419 },
      {
        type: "way",
        id: 100,
        nodes: [1, 2, 3],
        tags: { highway: "primary", name: "Boar Lane", maxspeed: "20 mph", ref: "A58" },
      },
      {
        type: "way",
        id: 101,
        nodes: [1, 3],
        tags: { highway: "footway" },
      },
      {
        type: "way",
        id: 102,
        nodes: [1, 2],
        tags: { highway: "motorway", maxspeed: "GB:motorway" },
      },
    ],
  };
  const options = { retrievedAt, pathLengthMetres };

  it("builds road segments for bus-routable ways only", () => {
    const result = normalizeOverpass(payload, options);
    const ids = result.segments.map((s) => s.osmWayIds[0]);
    expect(ids).toContain("100");
    expect(ids).toContain("102");
    expect(ids).not.toContain("101"); // footway is walking-only
  });

  it("produces segments that satisfy the RoadSegment contract", () => {
    const result = normalizeOverpass(payload, options);
    for (const segment of result.segments) {
      expect(RoadSegmentSchema.safeParse(segment).success).toBe(true);
      expect(segment.lengthMetres).toBeGreaterThan(0);
    }
  });

  it("builds a bidirectional walking graph including footways", () => {
    const result = normalizeOverpass(payload, options);
    expect(result.walkingGraph.get(1)?.some((e) => e.node === 3)).toBe(true);
    expect(result.walkingGraph.get(3)?.some((e) => e.node === 1)).toBe(true);
  });

  it("excludes motorways from the walking graph", () => {
    const motorwayOnly = {
      ...payload,
      elements: payload.elements.filter((e) => e.type === "node" || e.id === 102),
    };
    const result = normalizeOverpass(motorwayOnly, options);
    expect(result.walkingGraph.size).toBe(0);
  });

  it("parses UK speed limits, including national speed limit forms", () => {
    expect(parseMaxSpeedMph("20 mph")).toBe(20);
    expect(parseMaxSpeedMph("30mph")).toBe(30);
    expect(parseMaxSpeedMph("GB:nsl_single")).toBe(60);
    expect(parseMaxSpeedMph("GB:motorway")).toBe(70);
    expect(parseMaxSpeedMph("50")).toBeCloseTo(31.07, 1); // km/h per OSM default
  });

  it("returns null for an unknown speed limit rather than guessing", () => {
    // A guessed limit would manufacture speed anomalies that never happened.
    expect(parseMaxSpeedMph(undefined)).toBeNull();
    expect(parseMaxSpeedMph("national")).toBeNull();
    expect(parseMaxSpeedMph("fast")).toBeNull();
  });

  it("records speed-limit provenance only when a limit was actually sourced", () => {
    const result = normalizeOverpass(payload, options);
    const boarLane = result.segments.find((s) => s.osmWayIds[0] === "100")!;
    expect(boarLane.speedLimitMph).toBe(20);
    expect(boarLane.speedLimitProvenance).toBe("osm:maxspeed");

    const noLimit = normalizeOverpass(
      {
        ...payload,
        elements: [
          ...payload.elements.filter((e) => e.type === "node"),
          { type: "way", id: 200, nodes: [1, 2], tags: { highway: "residential" } },
        ],
      },
      options,
    );
    expect(noLimit.segments[0]?.speedLimitMph).toBeUndefined();
    expect(noLimit.segments[0]?.speedLimitProvenance).toBeUndefined();
  });

  it("maps highway tags to road classes", () => {
    expect(mapRoadClass("motorway")).toBe("motorway");
    expect(mapRoadClass("residential")).toBe("local");
    expect(mapRoadClass("proposed")).toBe("other");
    expect(isBusRoutableHighway("service")).toBe(false);
    expect(isWalkableHighway({ highway: "footway" })).toBe(true);
    expect(isWalkableHighway({ highway: "footway", foot: "no" })).toBe(false);
  });

  it("groups segments by corridor for congestion aggregation", () => {
    const result = normalizeOverpass(payload, options);
    expect(result.segments.find((s) => s.osmWayIds[0] === "100")?.corridorId).toBe("A58");
  });

  it("builds a bounded Overpass query rather than an unrestricted one", () => {
    const query = overpassQuery({ south: 53.7, west: -1.6, north: 53.85, east: -1.5 });
    expect(query).toContain("53.7,-1.6,53.85,-1.5");
    expect(query).toContain("timeout:180");
  });

  it("rejects a payload that does not match the documented shape", () => {
    expect(normalizeOverpass({ elements: "nope" }, options).rejected).toBe(1);
  });
});
