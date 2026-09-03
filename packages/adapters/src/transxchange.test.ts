import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveScheduledInstant } from "@busstops/pipeline-core";
import {
  addSecondsToTimeOfDay,
  formatIso8601Duration,
  parseIso8601DurationSeconds,
} from "./duration.js";
import {
  buildPatternShape,
  buildPatternStops,
  expandJourneysForDate,
  operatesOnDate,
  parseTransXChange,
} from "./transxchange.js";

const fixture = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../tests/fixtures/documented/transxchange-service.xml",
  ),
  "utf8",
);

describe("ISO 8601 durations", () => {
  it("parses the forms TransXChange uses", () => {
    expect(parseIso8601DurationSeconds("PT3M")).toBe(180);
    expect(parseIso8601DurationSeconds("PT6M30S")).toBe(390);
    expect(parseIso8601DurationSeconds("PT30S")).toBe(30);
    expect(parseIso8601DurationSeconds("PT1H15M")).toBe(4500);
    expect(parseIso8601DurationSeconds("PT0S")).toBe(0);
  });

  it("returns null for values it cannot parse, rather than zero", () => {
    // Silently returning 0 would collapse every later stop time on the journey.
    expect(parseIso8601DurationSeconds("3 minutes")).toBeNull();
    expect(parseIso8601DurationSeconds("")).toBeNull();
    expect(parseIso8601DurationSeconds("PT")).toBeNull();
  });

  it("round-trips through the formatter", () => {
    for (const seconds of [0, 30, 180, 390, 4500]) {
      expect(parseIso8601DurationSeconds(formatIso8601Duration(seconds))).toBe(seconds);
    }
  });
});

describe("time-of-day arithmetic", () => {
  it("adds seconds within the day", () => {
    expect(addSecondsToTimeOfDay("09:15:00", 180)).toBe("09:18:00");
    expect(addSecondsToTimeOfDay("09:15:00", 390)).toBe("09:21:30");
  });

  it("passes midnight without wrapping, as timetables require", () => {
    expect(addSecondsToTimeOfDay("23:50:00", 1800)).toBe("24:20:00");
    expect(addSecondsToTimeOfDay("23:50:00", 5400)).toBe("25:20:00");
  });

  it("rejects malformed input", () => {
    expect(() => addSecondsToTimeOfDay("quarter past", 60)).toThrow(/Invalid time of day/);
  });
});

describe("parseTransXChange", () => {
  const document = parseTransXChange(fixture);

  it("extracts stop points, operators, routes and services", () => {
    expect(document.stopPoints).toHaveLength(3);
    expect(document.operators[0]?.name).toBe("First Leeds");
    expect(document.operators[0]?.nationalOperatorCode).toBe("FLEE");
    expect(document.services).toHaveLength(1);
    expect(document.services[0]?.lines[0]?.name).toBe("72");
  });

  it("extracts route links with geometry and distance", () => {
    const link = document.routeLinks.get("RL1")!;
    expect(link.fromStop).toBe("450010001");
    expect(link.distanceMetres).toBe(620);
    expect(link.track).toHaveLength(3);
  });

  it("extracts journey pattern timing links with run and wait times", () => {
    const section = document.journeyPatternSections.get("JPS1")!;
    expect(section.links).toHaveLength(2);
    expect(section.links[0]?.runTimeSeconds).toBe(180);
    expect(section.links[0]?.toWaitTimeSeconds).toBe(30);
    expect(section.links[1]?.runTimeSeconds).toBe(390);
  });

  it("records timing-point status, which determines schedule confidence", () => {
    const section = document.journeyPatternSections.get("JPS1")!;
    expect(section.links[0]?.fromTimingPoint).toBe(true);
    expect(section.links[0]?.toTimingPoint).toBe(false);
  });

  it("reads all four vehicle journeys with their operating profiles", () => {
    expect(document.vehicleJourneys).toHaveLength(4);
    const weekday = document.vehicleJourneys.find((j) => j.code === "VJ_WEEKDAY_0915")!;
    expect([...weekday.operatingProfile.daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(weekday.operatingProfile.excludedDates).toContain("2026-12-25");
  });

  it("expands grouped day elements such as MondayToFriday", () => {
    const night = document.vehicleJourneys.find((j) => j.code === "VJ_NIGHT_2350")!;
    expect([...night.operatingProfile.daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns an empty document for unparseable XML rather than throwing", () => {
    const broken = parseTransXChange("<TransXChange><oops>");
    expect(broken.services).toEqual([]);
    expect(broken.parseErrors.length).toBeGreaterThan(0);
  });

  it("reports a missing root element", () => {
    const wrong = parseTransXChange('<?xml version="1.0"?><SomethingElse/>');
    expect(wrong.parseErrors).toContain("missing TransXChange root element");
  });
});

describe("buildPatternStops", () => {
  const document = parseTransXChange(fixture);
  const pattern = document.services[0]!.journeyPatterns[0]!;
  const stops = buildPatternStops(pattern, document.journeyPatternSections);

  it("produces the full ordered stop sequence, not just the link endpoints", () => {
    expect(stops.map((s) => s.atcoCode)).toEqual(["450010001", "450010002", "450010003"]);
    expect(stops.map((s) => s.sequence)).toEqual([1, 2, 3]);
  });

  it("accumulates run times into arrival offsets", () => {
    expect(stops[0]?.arrivalOffsetSeconds).toBe(0);
    expect(stops[1]?.arrivalOffsetSeconds).toBe(180);
    // 180s run + 30s wait + 390s run = 600s to the final stop.
    expect(stops[2]?.arrivalOffsetSeconds).toBe(600);
  });

  it("carries wait time into the departure offset so later stops shift correctly", () => {
    expect(stops[1]?.departureOffsetSeconds).toBe(210);
  });

  it("respects pickup and set-down activity codes", () => {
    expect(stops[0]?.pickupAllowed).toBe(true);
    expect(stops[0]?.dropOffAllowed).toBe(false);
    expect(stops[2]?.pickupAllowed).toBe(false);
    expect(stops[2]?.dropOffAllowed).toBe(true);
  });

  it("returns an empty sequence when the referenced sections are missing", () => {
    expect(
      buildPatternStops({ ...pattern, sectionRefs: ["NOPE"] }, document.journeyPatternSections),
    ).toEqual([]);
  });
});

describe("buildPatternShape", () => {
  const document = parseTransXChange(fixture);
  const pattern = document.services[0]!.journeyPatterns[0]!;

  it("assembles the route geometry from its links", () => {
    const shape = buildPatternShape(pattern, document);
    expect(shape.length).toBeGreaterThanOrEqual(4);
    expect(shape[0]).toEqual({ lat: 53.7965, lon: -1.5379 });
  });

  it("de-duplicates the shared point between consecutive links", () => {
    const shape = buildPatternShape(pattern, document);
    const duplicates = shape.filter((p) => p.lat === 53.7946 && p.lon === -1.5419);
    expect(duplicates).toHaveLength(1);
  });

  it("returns an empty shape when the route reference is missing", () => {
    expect(buildPatternShape({ ...pattern, routeRef: undefined }, document)).toEqual([]);
  });
});

describe("operatesOnDate", () => {
  const weekdayProfile = {
    daysOfWeek: new Set([1, 2, 3, 4, 5]),
    additionalDates: [] as string[],
    excludedDates: ["2026-12-25"],
    operatesOnBankHolidays: false,
  };

  it("runs on a normal weekday", () => {
    expect(operatesOnDate(weekdayProfile, "2026-09-02", false)).toBe(true); // Wednesday
  });

  it("does not run at the weekend", () => {
    expect(operatesOnDate(weekdayProfile, "2026-09-05", false)).toBe(false); // Saturday
  });

  it("does not run on an excluded date", () => {
    expect(operatesOnDate(weekdayProfile, "2026-12-25", false)).toBe(false);
  });

  it("does not run on a bank holiday unless the profile says so", () => {
    expect(operatesOnDate(weekdayProfile, "2026-05-04", true)).toBe(false);
    expect(
      operatesOnDate({ ...weekdayProfile, operatesOnBankHolidays: true }, "2026-05-04", true),
    ).toBe(true);
  });

  it("runs on an explicitly added special date even outside its usual days", () => {
    expect(
      operatesOnDate({ ...weekdayProfile, additionalDates: ["2026-09-05"] }, "2026-09-05", false),
    ).toBe(true);
  });
});

describe("expandJourneysForDate", () => {
  const document = parseTransXChange(fixture);

  it("expands only the journeys that run on a Wednesday", () => {
    const { journeys } = expandJourneysForDate(document, "2026-09-02");
    const codes = journeys.map((j) => j.vehicleJourneyCode);
    expect(codes).toContain("VJ_WEEKDAY_0915");
    expect(codes).toContain("VJ_NIGHT_2350");
    expect(codes).not.toContain("VJ_SATURDAY_1015");
  });

  it("expands the Saturday journey on a Saturday", () => {
    const { journeys } = expandJourneysForDate(document, "2026-09-05");
    expect(journeys.map((j) => j.vehicleJourneyCode)).toContain("VJ_SATURDAY_1015");
  });

  it("computes stop times from the departure time and cumulative offsets", () => {
    const { journeys } = expandJourneysForDate(document, "2026-09-02");
    const morning = journeys.find((j) => j.vehicleJourneyCode === "VJ_WEEKDAY_0915")!;
    expect(morning.stopTimes.map((s) => s.departureTimeOfDay)).toEqual([
      "09:15:00",
      "09:18:30",
      "09:25:00",
    ]);
    expect(morning.stopTimes[1]?.arrivalTimeOfDay).toBe("09:18:00");
  });

  it("carries a late journey past midnight without wrapping to the previous morning", () => {
    const { journeys } = expandJourneysForDate(document, "2026-09-02");
    const night = journeys.find((j) => j.vehicleJourneyCode === "VJ_NIGHT_2350")!;
    expect(night.stopTimes[2]?.arrivalTimeOfDay).toBe("24:00:00");

    // Resolving through the DST-correct helper yields the next calendar day.
    const instant = resolveScheduledInstant(
      night.serviceDate,
      night.stopTimes[2]!.arrivalTimeOfDay,
    );
    expect(instant.toISOString()).toBe("2026-09-02T23:00:00.000Z"); // 00:00 BST on 3 September
  });

  it("skips a journey whose pattern is missing, and says why", () => {
    const { journeys, skipped } = expandJourneysForDate(document, "2026-09-02");
    expect(journeys.map((j) => j.vehicleJourneyCode)).not.toContain("VJ_ORPHAN");
    expect(skipped.find((s) => s.code === "VJ_ORPHAN")?.reason).toMatch(/unknown journey pattern/);
  });

  it("excludes journeys outside the service operating period", () => {
    const { journeys } = expandJourneysForDate(document, "2027-01-05");
    expect(journeys).toHaveLength(0);
  });

  it("excludes a journey on its non-operation date", () => {
    // 25 December 2026 is a Friday, so only the exclusion keeps the weekday journey off.
    const { journeys } = expandJourneysForDate(document, "2026-12-25", true);
    expect(journeys.map((j) => j.vehicleJourneyCode)).not.toContain("VJ_WEEKDAY_0915");
  });

  it("carries line name and direction through to the expanded journey", () => {
    const { journeys } = expandJourneysForDate(document, "2026-09-02");
    expect(journeys[0]?.lineName).toBe("72");
    expect(journeys[0]?.direction).toBe("outbound");
    expect(journeys[0]?.serviceCode).toBe("PB0002032:72");
  });
});
