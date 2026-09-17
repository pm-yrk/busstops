import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { RoutePattern, ScheduledJourney, Stop } from "@busstops/contracts";
import { deterministicUuid } from "@busstops/adapters";
import { buildNetworkFromGtfs } from "./gtfs-network.js";

/**
 * Real archives, built byte by byte, for the same reason the zip reader's tests do: the failures
 * this code can have are ordering and offset failures that produce plausible-looking rubbish.
 *
 * The dates are fixed. 2026-09-07 is a Monday and 2026-09-12 a Saturday, which is what makes the
 * weekday columns and the calendar exceptions testable rather than "whatever today happens to be".
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(files: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const raw = Buffer.from(file.content, "utf8");
    const data = deflateRawSync(raw);
    const name = Buffer.from(file.name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

function writeFeed(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "gtfs-feed-"));
  const path = join(directory, "feed.zip");
  writeFileSync(
    path,
    buildZip(Object.entries(files).map(([name, content]) => ({ name, content }))),
  );
  return path;
}

const RETRIEVED_AT = "2026-09-07T05:00:00.000Z";
const MONDAY = "2026-09-07";
const TUESDAY = "2026-09-08";

const AGENCY = `agency_id,agency_name,agency_url,agency_timezone
FLDS,First Leeds,https://www.firstbus.co.uk,Europe/London
`;

const ROUTES = `route_id,agency_id,route_short_name,route_long_name,route_type
R36,FLDS,36,Leeds – Ripon,3
R99,FLDS,99,Ferry,4
`;

const STOPS = `stop_id,stop_name,stop_lat,stop_lon,wheelchair_boarding
450010001,Boar Lane,53.79650,-1.54450,1
450010002,Headrow,53.79980,-1.54600,0
450010003,Ripon Market Place,54.13800,-1.52200,2
`;

const CALENDAR = `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WEEKDAY,1,1,1,1,1,0,0,20260101,20261231
SUNDAY,0,0,0,0,0,0,1,20260101,20261231
`;

const CALENDAR_DATES = `service_id,date,exception_type
WEEKDAY,20260908,2
SUNDAY,20260907,1
`;

const TRIPS = `route_id,service_id,trip_id,trip_headsign,direction_id,block_id,wheelchair_accessible
R36,WEEKDAY,T1,Ripon,0,B1,1
R36,WEEKDAY,T2,Leeds,1,B1,0
R36,SUNDAY,T3,Ripon,0,,2
R99,WEEKDAY,T9,Nowhere,0,,0
`;

const STOP_TIMES = `trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,timepoint
T1,09:00:00,09:00:00,450010001,1,0,1,1
T1,09:04:00,09:05:00,450010002,2,0,0,0
T1,09:55:00,09:55:00,450010003,3,1,0,1
T2,10:00:00,10:00:00,450010003,1,0,1,1
T2,10:50:00,10:50:00,450010001,2,1,0,1
T3,11:00:00,11:00:00,450010001,1,0,1,1
T3,11:55:00,11:55:00,450010003,2,1,0,1
T9,12:00:00,12:00:00,450010001,1,0,0,1
T9,12:30:00,12:30:00,450010002,2,0,0,1
`;

const FEED = {
  "agency.txt": AGENCY,
  "routes.txt": ROUTES,
  "stops.txt": STOPS,
  "calendar.txt": CALENDAR,
  "calendar_dates.txt": CALENDAR_DATES,
  "trips.txt": TRIPS,
  "stop_times.txt": STOP_TIMES,
};

function naptan(): Map<string, Stop> {
  const provenance = { source: "naptan" as const, retrievedAt: RETRIEVED_AT, externalIds: [] };
  const make = (atcoCode: string, name: string, lat: number, lon: number): Stop => ({
    id: deterministicUuid("stop", atcoCode),
    provenance,
    ingestedAt: RETRIEVED_AT,
    qualityFlags: [],
    atcoCode,
    name,
    locationCoordinate: { lat, lon },
    stopType: "on_street_bus",
    localityId: null,
    amenities: [],
    active: true,
    naptanStatus: "active",
    supersededByStopId: null,
  });
  return new Map([
    // Deliberately a different name from the archive's: NaPTAN is the register, so it wins.
    ["450010001", make("450010001", "Boar Lane (Stand A)", 53.7965, -1.5445)],
    ["450010002", make("450010002", "The Headrow", 53.7998, -1.546)],
  ]);
}

async function build(
  files: Record<string, string> = FEED,
  serviceDates: string[] = [MONDAY, TUESDAY],
) {
  const journeys: ScheduledJourney[] = [];
  const patterns: RoutePattern[] = [];
  const result = await buildNetworkFromGtfs({
    archivePath: writeFeed(files),
    serviceDates,
    retrievedAt: RETRIEVED_AT,
    naptanByAtco: naptan(),
    onJourney: (journey) => void journeys.push(journey),
    onPattern: (pattern) => void patterns.push(pattern),
  });
  return { result, journeys, patterns };
}

describe("building the network from a GTFS archive", () => {
  it("reads the operators and the bus routes, and skips the modes it does not serve", async () => {
    const { result } = await build();

    expect(result.operators.map((operator) => operator.name)).toEqual(["First Leeds"]);
    expect(result.services.map((service) => service.publicName)).toEqual(["36"]);
    // route_type 4 is a ferry.
    expect(result.counts.routesSkippedByMode).toBe(1);
  });

  it("takes stop identity from NaPTAN where NaPTAN has the stop", async () => {
    const { result, journeys } = await build();

    expect(result.counts.stopsMatchedToNaptan).toBe(2);
    expect(result.counts.stopsWithoutNaptan).toBe(1);
    // The register's name and id, not the operator's copy.
    const first = journeys.find((journey) => journey.tripId === "T1")!;
    expect(first.stopTimes[0]!.stopId).toBe(deterministicUuid("stop", "450010001"));
  });

  it("applies the calendar and its exceptions to the horizon", async () => {
    const { result, journeys } = await build();

    // WEEKDAY runs Monday but is cancelled on the Tuesday by an exception; SUNDAY is added to the
    // Monday by another. So Monday has T1, T2 and T3, and Tuesday has nothing.
    expect(journeys.filter((journey) => journey.serviceDate === MONDAY)).toHaveLength(3);
    expect(journeys.filter((journey) => journey.serviceDate === TUESDAY)).toHaveLength(0);
    expect(result.counts.activeServiceIds).toBe(2);
  });

  it("resolves times into instants in London, not UTC", async () => {
    const { journeys } = await build();
    const trip = journeys.find((journey) => journey.tripId === "T1")!;
    // 09:00 on 7 September is BST, so 08:00Z.
    expect(trip.stopTimes[0]!.scheduledDeparture).toBe("2026-09-07T08:00:00.000Z");
  });

  it("keeps arrival and departure apart where the archive does", async () => {
    const { journeys } = await build();
    const call = journeys.find((journey) => journey.tripId === "T1")!.stopTimes[1]!;
    expect(call.scheduledArrival).toBe("2026-09-07T08:04:00.000Z");
    expect(call.scheduledDeparture).toBe("2026-09-07T08:05:00.000Z");
  });

  it("carries boarding restrictions rather than assuming every call can be boarded", async () => {
    const { journeys } = await build();
    const trip = journeys.find((journey) => journey.tripId === "T1")!;

    expect(trip.stopTimes[0]!.pickupAllowed).toBe(true);
    expect(trip.stopTimes[0]!.dropOffAllowed).toBe(false);
    expect(trip.stopTimes[2]!.pickupAllowed).toBe(false);
    expect(trip.stopTimes[2]!.dropOffAllowed).toBe(true);
  });

  it("does not claim a timing point's confidence for an interpolated call", async () => {
    const { journeys } = await build();
    const trip = journeys.find((journey) => journey.tripId === "T1")!;
    expect(trip.stopTimes.map((call) => call.isTimingPoint)).toEqual([true, false, true]);
  });

  it("separates patterns by direction and by the stops actually called", async () => {
    const { patterns } = await build();
    // T1 outbound and T2 inbound are different patterns; T3 repeats neither exactly.
    expect(patterns).toHaveLength(3);
    expect(patterns.map((pattern) => pattern.direction).sort()).toEqual([
      "inbound",
      "outbound",
      "outbound",
    ]);
    expect(new Set(patterns.map((pattern) => pattern.id)).size).toBe(3);
  });

  it("measures a pattern's distance from the line its stops trace", async () => {
    const { patterns } = await build();
    const long = patterns.find((pattern) => pattern.stopSequence.length === 3)!;
    // Leeds to Ripon is about 38 km as the line runs through the stops.
    expect(long.distanceMetres).toBeGreaterThan(30_000);
    expect(long.distanceMetres).toBeLessThan(60_000);
  });

  it("emits nothing at all when the horizon is outside the calendar", async () => {
    // Both calendars end on 20261231, so a date past it has no service whatever the weekday is.
    const { journeys } = await build(FEED, ["2027-01-05"]);
    expect(journeys).toEqual([]);
  });

  it("counts a trip whose rows are not contiguous instead of half-building it", async () => {
    const scattered = `trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,timepoint
T1,09:00:00,09:00:00,450010001,1,0,0,1
T2,10:00:00,10:00:00,450010003,1,0,0,1
T2,10:50:00,10:50:00,450010001,2,0,0,1
T1,09:55:00,09:55:00,450010003,2,0,0,1
`;
    const { result, journeys } = await build({ ...FEED, "stop_times.txt": scattered });

    expect(result.counts.outOfOrderTrips).toBe(1);
    // T2 was contiguous and is built; T1's stray tail is refused rather than merged.
    expect(journeys.map((journey) => journey.tripId)).toEqual(["T2"]);
    expect(result.counts.journeysTooShort).toBe(1);
  });

  it("counts a call at a stop the archive never declared", async () => {
    // Inside T1's own block: a stray row after the trip has been emitted is a different fault,
    // and the one being measured here is a call the stop table cannot resolve.
    const dangling = STOP_TIMES.replace(
      "T1,09:55:00,09:55:00,450010003,3,1,0,1\n",
      "T1,09:55:00,09:55:00,450010003,3,1,0,1\nT1,09:59:00,09:59:00,999999999,4,0,0,1\n",
    );
    const { result } = await build({ ...FEED, "stop_times.txt": dangling });
    expect(result.counts.danglingStopReferences).toBe(1);
    expect(result.counts.outOfOrderTrips).toBe(0);
  });

  it("stops where it is told to, so a measurement pass need not read the nation", async () => {
    const journeys: ScheduledJourney[] = [];
    const result = await buildNetworkFromGtfs({
      archivePath: writeFeed(FEED),
      serviceDates: [MONDAY, TUESDAY],
      retrievedAt: RETRIEVED_AT,
      naptanByAtco: naptan(),
      onJourney: (journey) => void journeys.push(journey),
      maxJourneys: 1,
    });
    expect(journeys).toHaveLength(1);
    expect(result.counts.journeysEmitted).toBe(1);
  });

  /*
   * The failure that ended run 27 with nothing published.
   *
   * One stop_time in England's national extract reads 106:25:00 — four and a half days past its
   * service date. The resolver threw on it, the exception came out through the zip stream, and a
   * 1.3 GiB archive that had downloaded perfectly produced no artifact at all. So the assertion
   * that matters is not that the bad trip is dropped: it is that everything else still arrives.
   */
  it("drops a trip it cannot place in time and keeps building the rest", async () => {
    const withImpossibleTime = {
      ...FEED,
      "stop_times.txt": STOP_TIMES.replace(
        "T1,09:55:00,09:55:00,450010003,3,1,0,1",
        "T1,106:25:00,106:25:00,450010003,3,1,0,1",
      ),
    };

    const { result, journeys } = await build(withImpossibleTime);

    expect(result.counts.tripsRejectedForTime).toBe(1);

    // T1 is gone in its entirety — a journey missing its last call is worse than no journey.
    expect(journeys.some((journey) => journey.tripId === "T1")).toBe(false);

    /*
     * And the rest of the archive is untouched. One journey each: the calendar removes WEEKDAY on
     * the Tuesday, so T2 runs on the Monday only, and the same exception adds SUNDAY to it, which
     * is what puts T3 on a Monday.
     */
    expect(journeys.map((journey) => journey.tripId).sort()).toEqual(["T2", "T3"]);
    expect(result.services.map((service) => service.publicName)).toEqual(["36"]);
  });

  it("reports the tables the archive actually shipped", async () => {
    const { result } = await build();
    expect(result.tables.map((table) => table.name).sort()).toEqual([
      "agency.txt",
      "calendar.txt",
      "calendar_dates.txt",
      "routes.txt",
      "stop_times.txt",
      "stops.txt",
      "trips.txt",
    ]);
    expect(result.tables.every((table) => table.uncompressedBytes > 0)).toBe(true);
  });
});
