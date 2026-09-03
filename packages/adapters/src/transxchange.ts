import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Coordinate } from "@busstops/contracts";
import { isPlausibleEnglandCoordinate } from "@busstops/pipeline-core";
import { addSecondsToTimeOfDay, parseIso8601DurationSeconds } from "./duration.js";
import { attribute, child, dig, hasElement, many, numberText, text, type XmlValue } from "./xml.js";

/**
 * TransXChange adapter — scheduled network for England outside London (BODS timetables).
 *
 * TransXChange separates the physical route (RouteSections/RouteLinks with geometry) from the
 * stopping pattern (JourneyPatternSections with run and wait times) from the individual trips
 * (VehicleJourneys with a departure time and an operating profile). This module reconstructs
 * all three and expands trips into concrete stop times for a service date.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
  isArray: (name) =>
    [
      "AnnotatedStopPointRef",
      "RouteSection",
      "RouteLink",
      "Route",
      "JourneyPatternSection",
      "JourneyPatternTimingLink",
      "Operator",
      "Service",
      "Line",
      "JourneyPattern",
      "VehicleJourney",
      "Location",
      "JourneyPatternSectionRefs",
      "DateRange",
    ].includes(name),
});

export interface TxcOperator {
  id: string;
  nationalOperatorCode: string | undefined;
  code: string | undefined;
  name: string;
}

export interface TxcStopPoint {
  atcoCode: string;
  commonName: string | undefined;
}

export interface TxcRouteLink {
  id: string;
  fromStop: string;
  toStop: string;
  distanceMetres: number | null;
  track: Coordinate[];
}

export interface TxcRoute {
  id: string;
  description: string | undefined;
  routeSectionRefs: string[];
}

export interface TxcTimingLink {
  fromStop: string;
  toStop: string;
  fromSequence: number | null;
  toSequence: number | null;
  fromTimingPoint: boolean;
  toTimingPoint: boolean;
  runTimeSeconds: number;
  fromWaitTimeSeconds: number;
  toWaitTimeSeconds: number;
  routeLinkRef: string | undefined;
  fromPickUp: boolean;
  toDropOff: boolean;
}

export interface TxcJourneyPatternSection {
  id: string;
  links: TxcTimingLink[];
}

export interface TxcJourneyPattern {
  id: string;
  direction: "outbound" | "inbound" | "circular";
  routeRef: string | undefined;
  sectionRefs: string[];
}

export interface TxcOperatingProfile {
  daysOfWeek: Set<number>;
  /** Dates the journey additionally runs, e.g. special services. */
  additionalDates: string[];
  /** Dates the journey does not run, e.g. Christmas Day. */
  excludedDates: string[];
  operatesOnBankHolidays: boolean;
}

export interface TxcVehicleJourney {
  code: string;
  serviceRef: string | undefined;
  lineRef: string | undefined;
  journeyPatternRef: string | undefined;
  departureTime: string;
  operatingProfile: TxcOperatingProfile;
}

export interface TxcService {
  serviceCode: string;
  lines: Array<{ id: string; name: string }>;
  operatorRef: string | undefined;
  mode: string;
  origin: string | undefined;
  destination: string | undefined;
  startDate: string | undefined;
  endDate: string | undefined;
  journeyPatterns: TxcJourneyPattern[];
}

export interface TransXChangeDocument {
  stopPoints: TxcStopPoint[];
  operators: TxcOperator[];
  routeLinks: Map<string, TxcRouteLink>;
  routeSections: Map<string, string[]>;
  routes: Map<string, TxcRoute>;
  journeyPatternSections: Map<string, TxcJourneyPatternSection>;
  services: TxcService[];
  vehicleJourneys: TxcVehicleJourney[];
  parseErrors: string[];
}

const WEEKDAY_NAMES: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

function parseOperatingProfile(raw: XmlValue): TxcOperatingProfile {
  const profile: TxcOperatingProfile = {
    daysOfWeek: new Set<number>(),
    additionalDates: [],
    excludedDates: [],
    operatesOnBankHolidays: false,
  };

  const regularDayType = dig(raw, "RegularDayType");
  if (regularDayType === undefined) {
    // No profile means the journey runs Monday to Friday under the TransXChange default.
    profile.daysOfWeek = new Set([1, 2, 3, 4, 5]);
    return profile;
  }

  const daysOfWeek = child(regularDayType, "DaysOfWeek");
  if (daysOfWeek !== undefined) {
    for (const [key, dayIndex] of Object.entries(WEEKDAY_NAMES)) {
      if (hasElement(daysOfWeek, key)) profile.daysOfWeek.add(dayIndex);
    }
    // TransXChange permits grouped elements such as <MondayToFriday/>.
    if (hasElement(daysOfWeek, "MondayToFriday"))
      [1, 2, 3, 4, 5].forEach((d) => profile.daysOfWeek.add(d));
    if (hasElement(daysOfWeek, "MondayToSaturday"))
      [1, 2, 3, 4, 5, 6].forEach((d) => profile.daysOfWeek.add(d));
    if (hasElement(daysOfWeek, "MondayToSunday"))
      [0, 1, 2, 3, 4, 5, 6].forEach((d) => profile.daysOfWeek.add(d));
    if (hasElement(daysOfWeek, "Weekend")) [0, 6].forEach((d) => profile.daysOfWeek.add(d));
  }

  const holidaysOnly = hasElement(regularDayType, "HolidaysOnly");
  if (holidaysOnly) {
    profile.daysOfWeek.clear();
  } else if (profile.daysOfWeek.size === 0) {
    profile.daysOfWeek = new Set([1, 2, 3, 4, 5]);
  }

  for (const range of many(dig(raw, "SpecialDaysOperation", "DaysOfOperation", "DateRange"))) {
    const start = text(child(range, "StartDate"));
    if (start) profile.additionalDates.push(start);
  }
  for (const range of many(dig(raw, "SpecialDaysOperation", "DaysOfNonOperation", "DateRange"))) {
    const start = text(child(range, "StartDate"));
    if (start) profile.excludedDates.push(start);
  }

  const bankHolidayOperation = dig(raw, "BankHolidayOperation", "DaysOfOperation");
  profile.operatesOnBankHolidays =
    bankHolidayOperation !== undefined &&
    typeof bankHolidayOperation === "object" &&
    bankHolidayOperation !== null &&
    Object.keys(bankHolidayOperation).length > 0;

  return profile;
}

function parseTrack(routeLink: XmlValue): Coordinate[] {
  const coordinates: Coordinate[] = [];
  for (const location of many(dig(routeLink, "Track", "Mapping", "Location"))) {
    const lat = numberText(child(location, "Latitude"));
    const lon = numberText(child(location, "Longitude"));
    if (lat === null || lon === null) continue;
    const candidate = { lat, lon };
    if (isPlausibleEnglandCoordinate(candidate)) coordinates.push(candidate);
  }
  return coordinates;
}

function parseTimingLink(raw: XmlValue): TxcTimingLink | null {
  const from = child(raw, "From");
  const to = child(raw, "To");
  const fromStop = text(child(from, "StopPointRef"));
  const toStop = text(child(to, "StopPointRef"));
  if (!fromStop || !toStop) return null;

  const runTimeSeconds = parseIso8601DurationSeconds(text(child(raw, "RunTime")) ?? "") ?? 0;
  const fromSequence = Number(attribute(from, "SequenceNumber"));
  const toSequence = Number(attribute(to, "SequenceNumber"));

  const fromActivity = (text(child(from, "Activity")) ?? "pickUpAndSetDown").toLowerCase();
  const toActivity = (text(child(to, "Activity")) ?? "pickUpAndSetDown").toLowerCase();

  return {
    fromStop,
    toStop,
    fromSequence: Number.isFinite(fromSequence) ? fromSequence : null,
    toSequence: Number.isFinite(toSequence) ? toSequence : null,
    fromTimingPoint: (text(child(from, "TimingStatus")) ?? "").toLowerCase().includes("principal"),
    toTimingPoint: (text(child(to, "TimingStatus")) ?? "").toLowerCase().includes("principal"),
    runTimeSeconds,
    fromWaitTimeSeconds: parseIso8601DurationSeconds(text(child(from, "WaitTime")) ?? "") ?? 0,
    toWaitTimeSeconds: parseIso8601DurationSeconds(text(child(to, "WaitTime")) ?? "") ?? 0,
    routeLinkRef: text(child(raw, "RouteLinkRef")),
    fromPickUp: fromActivity !== "setdown" && fromActivity !== "pass",
    toDropOff: toActivity !== "pickup" && toActivity !== "pass",
  };
}

export function parseTransXChange(xml: string): TransXChangeDocument {
  const empty: TransXChangeDocument = {
    stopPoints: [],
    operators: [],
    routeLinks: new Map(),
    routeSections: new Map(),
    routes: new Map(),
    journeyPatternSections: new Map(),
    services: [],
    vehicleJourneys: [],
    parseErrors: [],
  };

  // The parser is deliberately lenient, so a truncated file would otherwise yield an
  // empty-but-plausible document. Validate first: a malformed timetable must fail loudly.
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (validation !== true) {
    return { ...empty, parseErrors: [`unparseable XML: ${validation.err.msg}`] };
  }

  let document: XmlValue;
  try {
    document = parser.parse(xml) as XmlValue;
  } catch {
    return { ...empty, parseErrors: ["unparseable XML"] };
  }

  const root = child(document, "TransXChange");
  if (root === undefined) return { ...empty, parseErrors: ["missing TransXChange root element"] };

  const parseErrors: string[] = [];

  const stopPoints: TxcStopPoint[] = many(dig(root, "StopPoints", "AnnotatedStopPointRef"))
    .map((raw) => ({
      atcoCode: text(child(raw, "StopPointRef")) ?? "",
      commonName: text(child(raw, "CommonName")),
    }))
    .filter((s) => s.atcoCode.length > 0);

  const operators: TxcOperator[] = many(dig(root, "Operators", "Operator"))
    .map((raw) => ({
      id: attribute(raw, "id") ?? text(child(raw, "OperatorCode")) ?? "",
      nationalOperatorCode: text(child(raw, "NationalOperatorCode")),
      code: text(child(raw, "OperatorCode")),
      name:
        text(child(raw, "OperatorShortName")) ??
        text(child(raw, "TradingName")) ??
        text(child(raw, "OperatorNameOnLicence")) ??
        text(child(raw, "OperatorCode")) ??
        "Unknown operator",
    }))
    .filter((o) => o.id.length > 0);

  const routeLinks = new Map<string, TxcRouteLink>();
  const routeSections = new Map<string, string[]>();
  for (const section of many(dig(root, "RouteSections", "RouteSection"))) {
    const sectionId = attribute(section, "id") ?? "";
    const linkIds: string[] = [];
    for (const link of many(child(section, "RouteLink"))) {
      const linkId = attribute(link, "id") ?? "";
      const fromStop = text(dig(link, "From", "StopPointRef"));
      const toStop = text(dig(link, "To", "StopPointRef"));
      if (!linkId || !fromStop || !toStop) continue;
      routeLinks.set(linkId, {
        id: linkId,
        fromStop,
        toStop,
        distanceMetres: numberText(child(link, "Distance")),
        track: parseTrack(link),
      });
      linkIds.push(linkId);
    }
    if (sectionId) routeSections.set(sectionId, linkIds);
  }

  const routes = new Map<string, TxcRoute>();
  for (const route of many(dig(root, "Routes", "Route"))) {
    const id = attribute(route, "id");
    if (!id) continue;
    routes.set(id, {
      id,
      description: text(child(route, "Description")),
      routeSectionRefs: many(child(route, "RouteSectionRef"))
        .map((r) => text(r))
        .filter((r): r is string => r !== undefined),
    });
  }

  const journeyPatternSections = new Map<string, TxcJourneyPatternSection>();
  for (const section of many(dig(root, "JourneyPatternSections", "JourneyPatternSection"))) {
    const id = attribute(section, "id");
    if (!id) continue;
    const links: TxcTimingLink[] = [];
    for (const link of many(child(section, "JourneyPatternTimingLink"))) {
      const parsed = parseTimingLink(link);
      if (parsed) links.push(parsed);
      else parseErrors.push(`journey pattern section ${id}: timing link missing stop refs`);
    }
    journeyPatternSections.set(id, { id, links });
  }

  const services: TxcService[] = [];
  for (const service of many(dig(root, "Services", "Service"))) {
    const serviceCode = text(child(service, "ServiceCode"));
    if (!serviceCode) {
      parseErrors.push("service without a ServiceCode");
      continue;
    }

    const lines = many(dig(service, "Lines", "Line")).map((line) => ({
      id: attribute(line, "id") ?? "",
      name: text(child(line, "LineName")) ?? "",
    }));

    const journeyPatterns: TxcJourneyPattern[] = many(
      dig(service, "StandardService", "JourneyPattern"),
    ).map((pattern) => {
      const direction = (
        text(child(pattern, "Direction")) ??
        text(child(pattern, "DirectionRef")) ??
        "outbound"
      ).toLowerCase();
      return {
        id: attribute(pattern, "id") ?? "",
        direction:
          direction === "inbound" ? "inbound" : direction === "circular" ? "circular" : "outbound",
        routeRef: text(child(pattern, "RouteRef")),
        sectionRefs: many(child(pattern, "JourneyPatternSectionRefs"))
          .map((r) => text(r))
          .filter((r): r is string => r !== undefined),
      };
    });

    services.push({
      serviceCode,
      lines,
      operatorRef: text(child(service, "RegisteredOperatorRef")),
      mode: text(child(service, "Mode")) ?? "bus",
      origin: text(dig(service, "StandardService", "Origin")),
      destination: text(dig(service, "StandardService", "Destination")),
      startDate: text(dig(service, "OperatingPeriod", "StartDate")),
      endDate: text(dig(service, "OperatingPeriod", "EndDate")),
      journeyPatterns,
    });
  }

  const vehicleJourneys: TxcVehicleJourney[] = [];
  for (const journey of many(dig(root, "VehicleJourneys", "VehicleJourney"))) {
    const code = text(child(journey, "VehicleJourneyCode"));
    const departureTime = text(child(journey, "DepartureTime"));
    if (!code || !departureTime) {
      parseErrors.push(`vehicle journey ${code ?? "(unnamed)"} missing code or departure time`);
      continue;
    }
    vehicleJourneys.push({
      code,
      serviceRef: text(child(journey, "ServiceRef")),
      lineRef: text(child(journey, "LineRef")),
      journeyPatternRef: text(child(journey, "JourneyPatternRef")),
      departureTime,
      operatingProfile: parseOperatingProfile(child(journey, "OperatingProfile")),
    });
  }

  return {
    stopPoints,
    operators,
    routeLinks,
    routeSections,
    routes,
    journeyPatternSections,
    services,
    vehicleJourneys,
    parseErrors,
  };
}

export interface PatternStop {
  atcoCode: string;
  sequence: number;
  isTimingPoint: boolean;
  pickupAllowed: boolean;
  dropOffAllowed: boolean;
  /** Seconds from the journey's departure time to arrival at this stop. */
  arrivalOffsetSeconds: number;
  /** Seconds from the journey's departure time to departure from this stop. */
  departureOffsetSeconds: number;
}

/**
 * Flattens a journey pattern's sections into an ordered stop list with cumulative offsets.
 * Wait time at a stop shifts every later stop, so offsets are accumulated rather than derived
 * per link.
 */
export function buildPatternStops(
  pattern: TxcJourneyPattern,
  sections: ReadonlyMap<string, TxcJourneyPatternSection>,
): PatternStop[] {
  const links: TxcTimingLink[] = [];
  for (const ref of pattern.sectionRefs) {
    const section = sections.get(ref);
    if (section) links.push(...section.links);
  }
  if (links.length === 0) return [];

  const stops: PatternStop[] = [];
  let cumulative = 0;
  let sequence = 1;

  const first = links[0]!;
  stops.push({
    atcoCode: first.fromStop,
    sequence: sequence++,
    isTimingPoint: first.fromTimingPoint,
    pickupAllowed: first.fromPickUp,
    dropOffAllowed: false,
    arrivalOffsetSeconds: 0,
    departureOffsetSeconds: 0,
  });

  for (const link of links) {
    cumulative += link.runTimeSeconds;
    const arrivalOffset = cumulative;
    cumulative += link.toWaitTimeSeconds;

    stops.push({
      atcoCode: link.toStop,
      sequence: sequence++,
      isTimingPoint: link.toTimingPoint,
      pickupAllowed: true,
      dropOffAllowed: link.toDropOff,
      arrivalOffsetSeconds: arrivalOffset,
      departureOffsetSeconds: cumulative,
    });
  }

  // The final stop is set-down only.
  const last = stops[stops.length - 1];
  if (last) last.pickupAllowed = false;

  return stops;
}

/** Geometry for a journey pattern, assembled from the route links its route references. */
export function buildPatternShape(
  pattern: TxcJourneyPattern,
  document: TransXChangeDocument,
): Coordinate[] {
  if (!pattern.routeRef) return [];
  const route = document.routes.get(pattern.routeRef);
  if (!route) return [];

  const shape: Coordinate[] = [];
  for (const sectionRef of route.routeSectionRefs) {
    for (const linkId of document.routeSections.get(sectionRef) ?? []) {
      const link = document.routeLinks.get(linkId);
      if (!link) continue;
      for (const point of link.track) {
        const previous = shape[shape.length - 1];
        if (!previous || previous.lat !== point.lat || previous.lon !== point.lon) {
          shape.push(point);
        }
      }
    }
  }
  return shape;
}

/** Does this journey's operating profile mean it runs on the given service date? */
export function operatesOnDate(
  profile: TxcOperatingProfile,
  serviceDate: string,
  isBankHoliday: boolean,
): boolean {
  if (profile.excludedDates.includes(serviceDate)) return false;
  if (profile.additionalDates.includes(serviceDate)) return true;
  if (isBankHoliday && !profile.operatesOnBankHolidays) return false;

  const weekday = new Date(`${serviceDate}T12:00:00Z`).getUTCDay();
  return profile.daysOfWeek.has(weekday);
}

export interface ExpandedStopTime {
  atcoCode: string;
  sequence: number;
  arrivalTimeOfDay: string;
  departureTimeOfDay: string;
  isTimingPoint: boolean;
  pickupAllowed: boolean;
  dropOffAllowed: boolean;
}

export interface ExpandedJourney {
  vehicleJourneyCode: string;
  serviceCode: string;
  lineName: string;
  direction: "outbound" | "inbound" | "circular";
  journeyPatternId: string;
  serviceDate: string;
  stopTimes: ExpandedStopTime[];
}

/**
 * Expands vehicle journeys into concrete stop times for one service date. Times remain as
 * time-of-day strings (which may exceed 24:00) so the DST-correct resolver in pipeline-core
 * converts them to instants exactly once.
 */
export function expandJourneysForDate(
  document: TransXChangeDocument,
  serviceDate: string,
  isBankHoliday = false,
): { journeys: ExpandedJourney[]; skipped: Array<{ code: string; reason: string }> } {
  const journeys: ExpandedJourney[] = [];
  const skipped: Array<{ code: string; reason: string }> = [];

  const patternsById = new Map<string, { pattern: TxcJourneyPattern; service: TxcService }>();
  for (const service of document.services) {
    for (const pattern of service.journeyPatterns) {
      patternsById.set(pattern.id, { pattern, service });
    }
  }

  for (const journey of document.vehicleJourneys) {
    if (!operatesOnDate(journey.operatingProfile, serviceDate, isBankHoliday)) {
      continue;
    }
    if (!journey.journeyPatternRef) {
      skipped.push({ code: journey.code, reason: "no journey pattern reference" });
      continue;
    }
    const entry = patternsById.get(journey.journeyPatternRef);
    if (!entry) {
      skipped.push({
        code: journey.code,
        reason: `unknown journey pattern ${journey.journeyPatternRef}`,
      });
      continue;
    }

    const { pattern, service } = entry;
    if (service.startDate && serviceDate < service.startDate) continue;
    if (service.endDate && serviceDate > service.endDate) continue;

    const patternStops = buildPatternStops(pattern, document.journeyPatternSections);
    if (patternStops.length < 2) {
      skipped.push({ code: journey.code, reason: "journey pattern has fewer than two stops" });
      continue;
    }

    const line = service.lines.find((l) => l.id === journey.lineRef) ??
      service.lines[0] ?? { id: "", name: "" };

    journeys.push({
      vehicleJourneyCode: journey.code,
      serviceCode: service.serviceCode,
      lineName: line.name,
      direction: pattern.direction,
      journeyPatternId: pattern.id,
      serviceDate,
      stopTimes: patternStops.map((stop) => ({
        atcoCode: stop.atcoCode,
        sequence: stop.sequence,
        arrivalTimeOfDay: addSecondsToTimeOfDay(journey.departureTime, stop.arrivalOffsetSeconds),
        departureTimeOfDay: addSecondsToTimeOfDay(
          journey.departureTime,
          stop.departureOffsetSeconds,
        ),
        isTimingPoint: stop.isTimingPoint,
        pickupAllowed: stop.pickupAllowed,
        dropOffAllowed: stop.dropOffAllowed,
      })),
    });
  }

  return { journeys, skipped };
}
