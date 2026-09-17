import type {
  Coordinate,
  Mode,
  Operator,
  RoutePattern,
  ScheduledJourney,
  ServiceRoute,
  Stop,
  StopTime,
} from "@busstops/contracts";
import { deterministicUuid } from "@busstops/adapters";
import { parseTimeOfDay, pathLengthMetres, resolveScheduledInstant } from "@busstops/pipeline-core";
import { streamGtfsTable } from "./gtfs-csv.js";
import { readZipDirectory, type ZipDirectoryEntry } from "./gtfs-zip.js";

/**
 * The national timetable, read out of a GTFS archive without ever holding it.
 *
 * This replaces taking the first 60 of 945 published TransXChange datasets — a cap that gave the
 * whole country a map and a fraction of it a departure board, which is how a stop in Manchester
 * came back with no routes at all. BODS publishes the same registrations as GTFS, nationally and
 * by region, so the ceiling comes off entirely.
 *
 * The shape of the problem is `stop_times.txt`: it is the only table whose size is a multiple of
 * every trip in England, and it is far too large to hold. Everything else — stops, routes,
 * agencies, the calendar, and the trips inside the horizon — is an index measured in hundreds of
 * thousands of small entries, which is affordable. So the build is:
 *
 *   1. read the small tables into indexes,
 *   2. decide which service_ids run on the dates being published,
 *   3. keep only the trips belonging to those services,
 *   4. stream stop_times, emitting each trip's journey the moment its last row goes by.
 *
 * Step 4 is what makes this bounded. A journey is handed to `onJourney` and forgotten, so the
 * caller decides whether to accumulate (a region, a test) or spill to disk (the nation).
 *
 * Trip grouping: GTFS does not *require* stop_times to be grouped by trip, but every producer
 * writes it that way, and assuming it is the difference between one trip in memory and all of
 * them. So it is assumed — and checked: a trip whose rows reappear after it was emitted is
 * counted in `outOfOrderTrips`, which turns an unstated assumption into a number in the report.
 */

/** GTFS route_type values that are buses or coaches. Everything else is another mode's problem. */
const BUS_ROUTE_TYPES = new Set([
  3, 700, 701, 702, 703, 704, 705, 706, 707, 708, 709, 710, 711, 712, 713, 714, 715, 716,
]);
const COACH_ROUTE_TYPES = new Set([200, 201, 202, 203, 204, 205, 206, 207, 208, 209]);
const TRAM_ROUTE_TYPES = new Set([0, 900, 901, 902, 903, 904, 905, 906]);

function modeFor(routeType: number): Mode | null {
  if (BUS_ROUTE_TYPES.has(routeType)) return "bus";
  if (COACH_ROUTE_TYPES.has(routeType)) return "coach";
  if (TRAM_ROUTE_TYPES.has(routeType)) return "tram";
  return null;
}

const WEEKDAY_COLUMNS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** GTFS writes dates as YYYYMMDD; everything else here uses YYYY-MM-DD. */
export function gtfsDate(serviceDate: string): string {
  return serviceDate.replace(/-/g, "");
}

export interface GtfsBuildOptions {
  archivePath: string;
  /** Service dates to publish, as YYYY-MM-DD. Usually today and tomorrow. */
  serviceDates: readonly string[];
  retrievedAt: string;
  /**
   * NaPTAN stops by ATCO code — the canonical stop identity.
   *
   * A GTFS stop whose id matches a NaPTAN ATCO code takes NaPTAN's identity, coordinate and name,
   * because NaPTAN is the register and the operator's extract is a copy of it. A stop with no
   * NaPTAN match is still usable for timetabling but is reported, because a journey calling
   * somewhere the national register has never heard of is worth knowing about.
   */
  naptanByAtco: ReadonlyMap<string, Stop>;
  /** Called once per journey, in the order stop_times presents them. */
  onJourney: (journey: ScheduledJourney, pattern: RoutePattern) => void | Promise<void>;
  /**
   * Called once, the first time each pattern is seen, with the line its stops trace.
   *
   * The archive's own `shapes.txt` is not read: it is the largest table after `stop_times` and it
   * describes the road the bus drives on, which a route line drawn at map zoom cannot show
   * anyway. What is emitted here is the stop-to-stop polyline, which is what the line on the map
   * actually needs — and `distanceMetres` is measured from it, so it is a stop-sequence distance
   * rather than a driven one and must not be presented as mileage.
   */
  /**
   * The service is passed with the pattern because this is the only place it is known.
   *
   * A pattern carries `serviceRouteId` and no name, and the departure index needs the number on
   * the front of the bus at the moment each row is written — the alternative is holding every
   * service in memory in the consumer purely to look one up.
   */
  onPattern?: (
    pattern: RoutePattern,
    shape: readonly Coordinate[],
    service: ServiceRoute,
  ) => void | Promise<void>;
  /** Stops the read after this many journeys. For measurement and tests, not for production. */
  maxJourneys?: number;
}

export interface GtfsBuildCounts {
  agencies: number;
  routes: number;
  routesSkippedByMode: number;
  gtfsStops: number;
  stopsMatchedToNaptan: number;
  stopsWithoutNaptan: number;
  calendarRows: number;
  calendarDateRows: number;
  activeServiceIds: number;
  trips: number;
  tripsInHorizon: number;
  stopTimeRows: number;
  journeysEmitted: number;
  patternsSeen: number;
  /** Trips whose rows were not contiguous. Non-zero means the grouping assumption failed. */
  outOfOrderTrips: number;
  /** Rows naming a stop the archive never declared. */
  danglingStopReferences: number;
  /** Journeys dropped for having fewer than two usable calls. */
  journeysTooShort: number;
  /**
   * Trips dropped because a call carried a time this cannot place.
   *
   * England's national extract contains at least one — `106:25:00`, four and a half days past its
   * service date. Before this was counted it was thrown, and one row in 1.3 GiB ended the entire
   * national build with nothing published. A number here means the archive contains rows nobody
   * meant; a number here that starts climbing means something upstream has changed and is worth
   * looking at, which is what a count gives you and an exception does not.
   */
  tripsRejectedForTime: number;
}

export interface GtfsBuildResult {
  operators: Operator[];
  services: ServiceRoute[];
  /** Shapes keyed by shapeRef, for the patterns that were emitted. */
  counts: GtfsBuildCounts;
  warnings: string[];
  /** Which of the expected tables the archive actually contained. */
  tables: Array<{ name: string; compressedBytes: number; uncompressedBytes: number }>;
}

interface GtfsStop {
  atcoCode: string;
  name: string;
  coordinate: Coordinate;
  /** GTFS `wheelchair_boarding`: 0/absent is "no information", not "no". */
  wheelchairBoarding: "yes" | "no" | "unknown";
  matchedNaptan: boolean;
}

interface GtfsTrip {
  routeId: string;
  serviceId: string;
  headsign: string | undefined;
  directionId: string | undefined;
  blockId: string | undefined;
  /** GTFS `wheelchair_accessible` on the trip: about the vehicle, not the stop. */
  wheelchairAccessible: "yes" | "no" | "unknown";
}

function entryNamed(entries: ZipDirectoryEntry[], name: string): ZipDirectoryEntry | undefined {
  // Archives sometimes nest their tables in a folder; the basename is what identifies them.
  return entries.find((entry) => entry.name.replace(/^.*\//, "") === name);
}

/** GTFS accessibility enums: 1 means yes, 2 means no, 0 or absent means nobody has said. */
function accessibilityFlag(value: string | undefined): "yes" | "no" | "unknown" {
  if (value === "1") return "yes";
  if (value === "2") return "no";
  return "unknown";
}

function coverageAreaForAtco(atcoCode: string): "london" | "non_london" {
  return atcoCode.startsWith("490") || atcoCode.startsWith("940") ? "london" : "non_london";
}

export async function buildNetworkFromGtfs(options: GtfsBuildOptions): Promise<GtfsBuildResult> {
  const { archivePath, retrievedAt, naptanByAtco, serviceDates } = options;
  const warnings: string[] = [];
  const counts: GtfsBuildCounts = {
    agencies: 0,
    routes: 0,
    routesSkippedByMode: 0,
    gtfsStops: 0,
    stopsMatchedToNaptan: 0,
    stopsWithoutNaptan: 0,
    calendarRows: 0,
    calendarDateRows: 0,
    activeServiceIds: 0,
    trips: 0,
    tripsInHorizon: 0,
    stopTimeRows: 0,
    journeysEmitted: 0,
    patternsSeen: 0,
    outOfOrderTrips: 0,
    tripsRejectedForTime: 0,
    danglingStopReferences: 0,
    journeysTooShort: 0,
  };

  const directory = await readZipDirectory(archivePath);
  const tables = directory.entries.map((entry) => ({
    name: entry.name,
    compressedBytes: entry.compressedSize,
    uncompressedBytes: entry.uncompressedSize,
  }));

  const provenance = { source: "bods" as const, retrievedAt, externalIds: [] };
  const base = { provenance, ingestedAt: retrievedAt, qualityFlags: [] as never[] };

  // ---------------------------------------------------------------- agencies
  const operators = new Map<string, Operator>();
  const agencyEntry = entryNamed(directory.entries, "agency.txt");
  if (agencyEntry) {
    await streamGtfsTable(
      archivePath,
      agencyEntry,
      (row) => {
        const agencyId = row.agency_id ?? row.agency_name ?? "";
        if (agencyId.length === 0) return;
        const id = deterministicUuid("operator", agencyId);
        operators.set(agencyId, {
          ...base,
          id,
          name: row.agency_name ?? agencyId,
          licenceRegistryIds: [agencyId],
          ...(row.agency_url && /^https?:\/\//i.test(row.agency_url)
            ? { contactUrl: row.agency_url }
            : {}),
          ticketDomains: [],
          serviceAreas: [],
          active: true,
        });
      },
      { columns: ["agency_id", "agency_name", "agency_url"] },
    );
    counts.agencies = operators.size;
  } else {
    warnings.push("archive has no agency.txt; operators will be unknown");
  }

  // ------------------------------------------------------------------ routes
  const services = new Map<string, ServiceRoute>();
  const routeModes = new Map<string, Mode>();
  const routesEntry = entryNamed(directory.entries, "routes.txt");
  if (!routesEntry) throw new Error(`${archivePath}: no routes.txt`);
  await streamGtfsTable(
    archivePath,
    routesEntry,
    (row) => {
      counts.routes += 1;
      const routeId = row.route_id ?? "";
      if (routeId.length === 0) return;
      const mode = modeFor(Number(row.route_type ?? "-1"));
      if (mode === null) {
        counts.routesSkippedByMode += 1;
        return;
      }
      const agencyId = row.agency_id ?? "";
      const operator = operators.get(agencyId);
      const publicName = servicePublicName(row.route_short_name, row.route_long_name, routeId);

      routeModes.set(routeId, mode);
      services.set(routeId, {
        ...base,
        id: deterministicUuid("service", routeId),
        validFrom: retrievedAt,
        validTo: null,
        operatorId: operator?.id ?? deterministicUuid("operator", agencyId || "unknown"),
        publicName,
        mode,
        ...(row.route_long_name?.trim() ? { description: row.route_long_name.trim() } : {}),
        // Set once the stops are known; GTFS routes carry no geography of their own.
        coverageArea: "non_london",
      });
    },
    {
      columns: ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type"],
    },
  );

  // ------------------------------------------------------------------- stops
  const stops = new Map<string, GtfsStop>();
  const stopsEntry = entryNamed(directory.entries, "stops.txt");
  if (!stopsEntry) throw new Error(`${archivePath}: no stops.txt`);
  await streamGtfsTable(
    archivePath,
    stopsEntry,
    (row) => {
      counts.gtfsStops += 1;
      const stopId = row.stop_id ?? "";
      if (stopId.length === 0) return;
      const lat = Number(row.stop_lat);
      const lon = Number(row.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      // BODS GTFS uses ATCO codes as stop_id, which is what makes NaPTAN the canonical identity
      // rather than a separate register to reconcile against.
      const naptan = naptanByAtco.get(stopId);
      if (naptan) counts.stopsMatchedToNaptan += 1;
      else counts.stopsWithoutNaptan += 1;

      stops.set(stopId, {
        atcoCode: naptan?.atcoCode ?? stopId,
        name: naptan?.name ?? row.stop_name ?? stopId,
        coordinate: naptan?.locationCoordinate ?? { lat, lon },
        wheelchairBoarding: accessibilityFlag(row.wheelchair_boarding),
        matchedNaptan: naptan !== undefined,
      });
    },
    {
      columns: ["stop_id", "stop_name", "stop_lat", "stop_lon", "wheelchair_boarding"],
    },
  );

  // ---------------------------------------------------------------- calendar
  const wanted = serviceDates.map((date) => ({ date, gtfs: gtfsDate(date) }));
  /** service_id → the dates in the horizon on which it runs. */
  const runsOn = new Map<string, Set<string>>();

  const addRun = (serviceId: string, date: string): void => {
    const existing = runsOn.get(serviceId);
    if (existing) existing.add(date);
    else runsOn.set(serviceId, new Set([date]));
  };
  const removeRun = (serviceId: string, date: string): void => {
    runsOn.get(serviceId)?.delete(date);
  };

  const calendarEntry = entryNamed(directory.entries, "calendar.txt");
  if (calendarEntry) {
    await streamGtfsTable(
      archivePath,
      calendarEntry,
      (row) => {
        counts.calendarRows += 1;
        const serviceId = row.service_id ?? "";
        if (serviceId.length === 0) return;
        const from = row.start_date ?? "";
        const to = row.end_date ?? "";
        for (const { date, gtfs } of wanted) {
          if (from > gtfs || (to.length > 0 && to < gtfs)) continue;
          const weekday = WEEKDAY_COLUMNS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
          if (row[weekday] === "1") addRun(serviceId, date);
        }
      },
      {
        columns: ["service_id", "start_date", "end_date", ...WEEKDAY_COLUMNS],
      },
    );
  }

  // Exceptions are applied second, because that is what they are: they override the pattern.
  const calendarDatesEntry = entryNamed(directory.entries, "calendar_dates.txt");
  if (calendarDatesEntry) {
    await streamGtfsTable(
      archivePath,
      calendarDatesEntry,
      (row) => {
        counts.calendarDateRows += 1;
        const serviceId = row.service_id ?? "";
        const match = wanted.find((candidate) => candidate.gtfs === row.date);
        if (serviceId.length === 0 || !match) return;
        if (row.exception_type === "1") addRun(serviceId, match.date);
        else if (row.exception_type === "2") removeRun(serviceId, match.date);
      },
      { columns: ["service_id", "date", "exception_type"] },
    );
  }

  for (const [serviceId, dates] of runsOn) {
    if (dates.size === 0) runsOn.delete(serviceId);
  }
  counts.activeServiceIds = runsOn.size;

  // ------------------------------------------------------------------- trips
  const trips = new Map<string, GtfsTrip>();
  const tripsEntry = entryNamed(directory.entries, "trips.txt");
  if (!tripsEntry) throw new Error(`${archivePath}: no trips.txt`);
  await streamGtfsTable(
    archivePath,
    tripsEntry,
    (row) => {
      counts.trips += 1;
      const tripId = row.trip_id ?? "";
      const serviceId = row.service_id ?? "";
      const routeId = row.route_id ?? "";
      // Only trips that run in the horizon, and only on routes this build kept.
      if (tripId.length === 0 || !runsOn.has(serviceId) || !services.has(routeId)) return;
      counts.tripsInHorizon += 1;
      trips.set(tripId, {
        routeId,
        serviceId,
        headsign: row.trip_headsign?.trim() || undefined,
        directionId: row.direction_id,
        blockId: row.block_id?.trim() || undefined,
        wheelchairAccessible: accessibilityFlag(row.wheelchair_accessible),
      });
    },
    {
      columns: [
        "trip_id",
        "route_id",
        "service_id",
        "trip_headsign",
        "direction_id",
        "block_id",
        "wheelchair_accessible",
      ],
    },
  );

  // -------------------------------------------------------------- stop_times
  const patterns = new Map<string, RoutePattern>();
  const emittedTrips = new Set<string>();
  let stopped = false;

  interface PendingCall {
    stopId: string;
    sequence: number;
    arrival: string | undefined;
    departure: string;
    pickup: string | undefined;
    dropOff: string | undefined;
    timepoint: string | undefined;
  }

  let currentTripId: string | null = null;
  let currentCalls: PendingCall[] = [];

  /** Turns one trip's accumulated calls into a journey per service date, then forgets them. */
  const flush = async (): Promise<void> => {
    const tripId = currentTripId;
    const calls = currentCalls;
    currentTripId = null;
    currentCalls = [];
    if (tripId === null || calls.length === 0) return;

    const trip = trips.get(tripId);
    if (!trip) return;

    calls.sort((a, b) => a.sequence - b.sequence);

    const resolved = calls
      .map((call) => ({ call, stop: stops.get(call.stopId) }))
      .filter((entry): entry is { call: PendingCall; stop: GtfsStop } => {
        if (!entry.stop) {
          counts.danglingStopReferences += 1;
          return false;
        }
        return true;
      });

    if (resolved.length < 2) {
      counts.journeysTooShort += 1;
      return;
    }

    /*
     * A trip is only publishable if every call on it can be placed in time.
     *
     * Checked here, once, before anything is emitted — rather than at the point of conversion
     * inside the per-service-date loop — because a trip with one unplaceable call has a broken
     * sequence, and half a journey on a departure board is worse than no journey. It also keeps
     * the failure out of the pattern: the shape would be geometrically fine and would draw a line
     * for a service that can never be timed.
     */
    if (
      resolved.some(
        (entry) =>
          parseTimeOfDay(entry.call.departure) === null ||
          (entry.call.arrival !== undefined && parseTimeOfDay(entry.call.arrival) === null),
      )
    ) {
      counts.tripsRejectedForTime += 1;
      return;
    }

    const stopIds = resolved.map((entry) => deterministicUuid("stop", entry.stop.atcoCode));

    /*
     * The pattern is the ordered stop list, not the route. Two trips on route 36 that turn short
     * are different patterns, and a map that drew them as one would show a line to a place half
     * the buses never reach.
     */
    const patternKey = `${trip.routeId}:${trip.directionId ?? ""}:${stopIds.join(",")}`;
    let pattern = patterns.get(patternKey);
    if (!pattern) {
      const service = services.get(trip.routeId)!;
      const shape = resolved.map((entry) => entry.stop.coordinate);
      pattern = {
        ...base,
        id: deterministicUuid("pattern", patternKey),
        validFrom: retrievedAt,
        validTo: null,
        serviceRouteId: service.id,
        direction: trip.directionId === "1" ? "inbound" : "outbound",
        stopSequence: stopIds,
        // The pattern is its own shape reference: one ordered stop list, one line.
        shapeRef: deterministicUuid("pattern", patternKey),
        distanceMetres: pathLengthMetres(shape),
      };
      patterns.set(patternKey, pattern);
      counts.patternsSeen += 1;
      await options.onPattern?.(pattern, shape, service);

      // A route's coverage is decided by where it actually calls, which is only knowable here.
      if (coverageAreaForAtco(resolved[0]!.stop.atcoCode) === "london") {
        services.set(trip.routeId, { ...service, coverageArea: "london" });
      }
    }

    for (const serviceDate of runsOn.get(trip.serviceId) ?? []) {
      const stopTimes: StopTime[] = resolved.map((entry, index) => {
        const departure = resolveScheduledInstant(serviceDate, entry.call.departure).toISOString();
        const arrival = entry.call.arrival
          ? resolveScheduledInstant(serviceDate, entry.call.arrival).toISOString()
          : undefined;
        return {
          stopId: stopIds[index]!,
          sequence: index,
          ...(arrival === undefined ? {} : { scheduledArrival: arrival }),
          scheduledDeparture: departure,
          // GTFS `timepoint`: 1 is exact, 0 is interpolated, absent means exact by convention.
          isTimingPoint: entry.call.timepoint !== "0",
          // pickup_type/drop_off_type: 1 means not available here. Anything else allows it.
          pickupAllowed: entry.call.pickup !== "1",
          dropOffAllowed: entry.call.dropOff !== "1",
        };
      });

      await options.onJourney(
        {
          ...base,
          id: deterministicUuid("journey", `${tripId}:${serviceDate}`),
          routePatternId: pattern.id,
          serviceDate,
          tripId,
          ...(trip.blockId === undefined ? {} : { blockId: trip.blockId }),
          stopTimes,
          state: "scheduled",
        },
        pattern,
      );
      counts.journeysEmitted += 1;
      if (options.maxJourneys !== undefined && counts.journeysEmitted >= options.maxJourneys) {
        stopped = true;
        return;
      }
    }
  };

  const stopTimesEntry = entryNamed(directory.entries, "stop_times.txt");
  if (!stopTimesEntry) throw new Error(`${archivePath}: no stop_times.txt`);

  await streamGtfsTable(
    archivePath,
    stopTimesEntry,
    async (row) => {
      if (stopped) return;
      counts.stopTimeRows += 1;

      const tripId = row.trip_id ?? "";
      if (tripId.length === 0) return;
      // Trips outside the horizon are the overwhelming majority of rows, and skipping them here
      // is what keeps this pass cheap.
      if (!trips.has(tripId)) return;

      if (tripId !== currentTripId) {
        await flush();
        if (emittedTrips.has(tripId)) {
          // The grouping assumption failed for this trip. Counted rather than silently merged,
          // because a half-built journey is worse than a missing one.
          counts.outOfOrderTrips += 1;
          return;
        }
        currentTripId = tripId;
        emittedTrips.add(tripId);
      }

      const departure = row.departure_time?.trim() || row.arrival_time?.trim();
      if (!departure) return;

      currentCalls.push({
        stopId: row.stop_id ?? "",
        sequence: Number(row.stop_sequence ?? "0"),
        arrival: row.arrival_time?.trim() || undefined,
        departure,
        pickup: row.pickup_type,
        dropOff: row.drop_off_type,
        timepoint: row.timepoint,
      });
    },
    {
      columns: [
        "trip_id",
        "stop_id",
        "stop_sequence",
        "arrival_time",
        "departure_time",
        "pickup_type",
        "drop_off_type",
        "timepoint",
      ],
    },
  );

  await flush();

  return {
    operators: [...operators.values()],
    services: [...services.values()],
    counts,
    warnings,
    tables,
  };
}

/**
 * What goes in the route badge on a departure board.
 *
 * GTFS gives three candidates and only one of them is a service designation. `route_short_name`
 * is the number on the front of the bus — 36, X84, 1A — and is what a passenger matches against.
 * `route_long_name` is a description. `route_id` is an internal key and is nobody's business.
 *
 * This fell through to `route_id`, and England's archive has feeds that publish neither name, so
 * York Rail Station's board offered a bus called `Golden_Tours_Hop_On_Hop_Off`. An identifier
 * rendered as a route number is not a cosmetic problem: it is the board telling someone to look
 * out for a bus that does not exist under that name, in a badge sized for three characters.
 *
 * So an id is humanised rather than shown raw — separators become spaces and the result is
 * collapsed and trimmed — and a name that is still unreasonably long is cut at a word boundary,
 * because a badge that overflows takes the times with it.
 */
export const MAX_ROUTE_NAME_LENGTH = 24;

export function servicePublicName(
  shortName: string | undefined,
  longName: string | undefined,
  routeId: string,
): string {
  const short = shortName?.trim();
  if (short) return short;

  const long = longName?.trim();
  if (long) return truncateAtWord(long, MAX_ROUTE_NAME_LENGTH);

  // Nothing published. The id is all there is, so it is made readable rather than shown as a key.
  const humanised = routeId
    .replace(/[_\-.:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateAtWord(humanised.length > 0 ? humanised : routeId, MAX_ROUTE_NAME_LENGTH);
}

function truncateAtWord(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  // Only break at a word if that leaves something worth reading; otherwise take the hard cut.
  return (lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
}
