import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { InMemoryObjectStore, objectKeyFor } from "@busstops/pipeline-core";
import { assembleGtfsNetwork } from "./gtfs-assemble.js";
import { publishSpilledJourneyTiles } from "./publish-spilled-journeys.js";
import { MAX_SHARD_BYTES } from "./shards.js";
import {
  decodeDepartureShard,
  decodeDepartureShardForStop,
  departureBucketFor,
  departureShardDataset,
  encodeDepartureShardFromJsonl,
  type PatternTripRow,
} from "./departures-index.js";

/**
 * A city's worth of timetable, from archive to published shard.
 *
 * The defect this exists to prevent was not visible in any small fixture. Six markers rendered
 * perfectly and six journeys published perfectly; it took a real city to produce a 294,922,754
 * byte tile, and by then it was in production. So the fixture here is dense on purpose: enough
 * stops, routes and trips that a shard has to hold a realistic number of rows, and the assertions
 * are about the bytes rather than about whether anything came out at all.
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

const MONDAY = "2026-09-14";
const RETRIEVED_AT = "2026-09-14T04:00:00.000Z";

/** Leeds-ish: a compact city centre, so every stop lands in a handful of tiles. */
const STOP_COUNT = 240;
const ROUTE_COUNT = 30;
/** Trips per route across the service day. Thirty routes at forty trips is a real timetable. */
const TRIPS_PER_ROUTE = 40;
const CALLS_PER_TRIP = 12;

function atcoFor(index: number): string {
  return `450010${String(index).padStart(4, "0")}`;
}

function denseFeed(): Record<string, string> {
  const agency = `agency_id,agency_name,agency_url,agency_timezone
FWY,First West Yorkshire,https://www.firstbus.co.uk,Europe/London
`;

  const routes = [
    "route_id,agency_id,route_short_name,route_long_name,route_type",
    ...Array.from(
      { length: ROUTE_COUNT },
      (_, index) => `R${index},FWY,${index + 1},Route ${index + 1},3`,
    ),
  ].join("\n");

  const stops = [
    "stop_id,stop_name,stop_lat,stop_lon",
    ...Array.from({ length: STOP_COUNT }, (_, index) => {
      const lat = 53.78 + (index % 16) * 0.002;
      const lon = -1.56 + Math.floor(index / 16) * 0.002;
      return `${atcoFor(index)},Stop ${index},${lat.toFixed(5)},${lon.toFixed(5)}`;
    }),
  ].join("\n");

  const calendar = `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
EVERYDAY,1,1,1,1,1,1,1,20260101,20261231
`;

  const trips = ["route_id,service_id,trip_id,trip_headsign,direction_id"];
  const stopTimes = [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,timepoint",
  ];

  for (let route = 0; route < ROUTE_COUNT; route += 1) {
    for (let trip = 0; trip < TRIPS_PER_ROUTE; trip += 1) {
      const tripId = `T${route}_${trip}`;
      trips.push(`R${route},EVERYDAY,${tripId},Somewhere,0`);
      // Spread across the service day from 05:00, so every window has rows in it.
      const startMinutes = 5 * 60 + trip * 24;
      for (let call = 0; call < CALLS_PER_TRIP; call += 1) {
        const minutes = startMinutes + call * 3;
        const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
        const stopIndex = (route * 7 + call * 13) % STOP_COUNT;
        stopTimes.push(
          `${tripId},${time},${time},${atcoFor(stopIndex)},${call + 1},0,0,${call % 3 === 0 ? 1 : 0}`,
        );
      }
    }
  }

  return {
    "agency.txt": agency,
    "routes.txt": routes,
    "stops.txt": stops,
    "calendar.txt": calendar,
    "trips.txt": trips.join("\n"),
    "stop_times.txt": stopTimes.join("\n"),
  };
}

/** NaPTAN for the same stops, since stop identity comes from the register rather than the feed. */
function naptanCsv(): string {
  const header =
    "ATCOCode,NaptanCode,CommonName,Longitude,Latitude,StopType,Status,LocalityName,Indicator";
  const rows = Array.from({ length: STOP_COUNT }, (_, index) => {
    const lat = 53.78 + (index % 16) * 0.002;
    const lon = -1.56 + Math.floor(index / 16) * 0.002;
    return `${atcoFor(index)},ldsg${index},Stop ${index},${lon.toFixed(5)},${lat.toFixed(5)},BCT,active,Leeds,Stand ${index % 8}`;
  });
  return [header, ...rows].join("\n");
}

async function assembleDenseCity() {
  const archivePath = join(mkdtempSync(join(tmpdir(), "busstops-dense-")), "gtfs.zip");
  writeFileSync(
    archivePath,
    buildZip(Object.entries(denseFeed()).map(([name, content]) => ({ name, content }))),
  );

  return assembleGtfsNetwork({
    naptanCsv: naptanCsv(),
    archivePath,
    serviceDates: [MONDAY],
    retrievedAt: RETRIEVED_AT,
  });
}

/** Exactly the publish run-daily performs, encoder included, so the test proves the real path. */
async function publishDepartures(
  store: InMemoryObjectStore,
  spill: Parameters<typeof publishSpilledJourneyTiles>[1],
) {
  return publishSpilledJourneyTiles(store, spill, {
    version: RETRIEVED_AT,
    datasetFor: (dataset) => dataset,
    encode: (lines, dataset) => encodeDepartureShardFromJsonl(dataset, lines),
  });
}

describe("a dense city, from archive to published departure shards", () => {
  it("emits a row for every boardable call and publishes them within the byte budget", async () => {
    const assembled = await assembleDenseCity();

    // 30 routes x 40 trips x 11 boardable calls: the last call of a trip is not a departure.
    expect(assembled.departureRowCount).toBe(ROUTE_COUNT * TRIPS_PER_ROUTE * (CALLS_PER_TRIP - 1));

    const store = new InMemoryObjectStore();
    const published = await publishDepartures(store, assembled.departureSpill);

    expect(published.failed).toEqual([]);
    expect(published.oversized).toEqual([]);
    expect(published.records).toBe(assembled.departureRowCount);

    /*
     * The number the whole redesign is about. The tile this replaces reached 294,922,754 bytes
     * for one region; no shard here may come near the budget, and at this density none is close.
     */
    expect(published.largest!.bytes).toBeLessThan(MAX_SHARD_BYTES);
    expect(published.largest!.bytes).toBeLessThan(200_000);
  });

  it("puts a real stop's rows where the edge will look for them", async () => {
    const assembled = await assembleDenseCity();
    const store = new InMemoryObjectStore();
    await publishDepartures(store, assembled.departureSpill);

    // Pick a stop and a morning instant, then read exactly the shard the reader would.
    const atcoCode = atcoFor(42);
    const at = Date.parse(`${MONDAY}T08:30:00Z`) / 1000;
    const dataset = departureShardDataset(MONDAY, departureBucketFor(atcoCode));

    const raw = await store.get(objectKeyFor(dataset, RETRIEVED_AT));
    expect(raw).not.toBeNull();

    // Read the way the edge reads it: one stop's line out of the shard, not the whole shard.
    const rows = decodeDepartureShardForStop(raw!, atcoCode) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.t * 1000 > at * 1000 - 3_600_000)).toBe(true);
    for (const row of rows) {
      // Everything an arrival board renders a row from, and all of it plausible.
      expect(row.r).toMatch(/^\d+$/);
      expect(row.d).toMatch(/^Stop \d+$/);
      expect(row.j).toMatch(/^T\d+_\d+$/);
      expect(row.p).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(row.t * 1000).toISOString()).toMatch(/^2026-09-1[45]T/);
    }
  });

  it("never writes the last call of a trip, because nobody boards there for anywhere", async () => {
    const assembled = await assembleDenseCity();
    const store = new InMemoryObjectStore();
    await publishDepartures(store, assembled.departureSpill);

    const keys = await store.list("data/network/departures/");
    let terminating = 0;
    for (const key of keys) {
      const raw = (await store.get(key)) ?? "";
      for (const row of decodeDepartureShard(raw)) {
        // A row whose stop is also its destination would be a bus departing for where it already is.
        if (row.d === `Stop ${Number(row.s.slice(-4))}`) terminating += 1;
      }
    }
    expect(terminating).toBe(0);
  });

  /*
   * The planner's half of the same split. A trip is its pattern plus its times, so the stops it
   * calls at are stored once on the pattern rather than 45 times per trip — which is the whole
   * difference between 296 bytes and 10,313.
   */
  it("publishes the planner's trips within the same budget", async () => {
    const assembled = await assembleDenseCity();
    const store = new InMemoryObjectStore();
    const published = await publishSpilledJourneyTiles(store, assembled.patternTripSpill, {
      version: RETRIEVED_AT,
      datasetFor: (dataset) => dataset,
    });

    expect(assembled.patternTripCount).toBe(ROUTE_COUNT * TRIPS_PER_ROUTE);
    expect(published.failed).toEqual([]);
    expect(published.oversized).toEqual([]);
    expect(published.records).toBe(assembled.patternTripCount);
    expect(published.largest!.bytes).toBeLessThan(MAX_SHARD_BYTES);

    /*
     * And a trip carries only times. The old journey record measured 10,313 bytes for 45 calls;
     * this fixture's trips have twelve, so the comparison that matters is bytes per call.
     */
    const keys = await store.list("data/network/pattern-trips/");
    const raw = (await store.get(keys[0]!)) ?? "";
    const firstLine = raw.split("\n")[0]!;
    const trip = JSON.parse(firstLine) as PatternTripRow;
    expect(trip.t).toHaveLength(CALLS_PER_TRIP);
    expect(firstLine.length / CALLS_PER_TRIP).toBeLessThan(20);
  });
});
