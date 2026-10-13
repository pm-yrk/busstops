import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ScheduledJourney, Stop } from "@busstops/contracts";
import { deterministicUuid } from "@busstops/adapters";
import { InMemoryObjectStore, objectKeyFor, tilesForCoordinates } from "@busstops/pipeline-core";
import { buildNetworkFromGtfs } from "./gtfs-network.js";
import { TileSpill } from "./gtfs-spill.js";
import { journeyTileDataset } from "./publish.js";
import { publishSpilledJourneyTiles } from "./publish-spilled-journeys.js";

/**
 * The whole path, in one test: an archive on disk, a build that never holds it, a spill, and
 * published tiles the edge could read.
 *
 * This is the piece the old pipeline could not do at all. Its journeys were assembled into one
 * in-memory network and published from there, which is what the 60-of-945 dataset cap was really
 * protecting — the cap was a memory limit wearing a coverage limit's clothes.
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

function writeFeed(files: Record<string, string>): string {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8");
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  const dir = mkdtempSync(join(tmpdir(), "gtfs-pub-"));
  const path = join(dir, "feed.zip");
  writeFileSync(path, Buffer.concat([...locals, directory, end]));
  return path;
}

const RETRIEVED_AT = "2026-09-07T05:00:00.000Z";
const MONDAY = "2026-09-07";

/*
 * Two routes in places far enough apart to land in different tiles: Leeds and Bristol are more
 * than a degree apart, so a tile that held both would mean the tiling had stopped working.
 */
const STOPS = [
  { id: "450010001", name: "Boar Lane", lat: 53.7965, lon: -1.5445 },
  { id: "450010002", name: "Headrow", lat: 53.7998, lon: -1.546 },
  { id: "010000001", name: "Bristol Centre", lat: 51.4545, lon: -2.5879 },
  { id: "010000002", name: "Temple Meads", lat: 51.4491, lon: -2.5814 },
];

function feed(tripCount: number): Record<string, string> {
  const trips: string[] = [];
  const stopTimes: string[] = [];
  for (let index = 0; index < tripCount; index += 1) {
    const leeds = index % 2 === 0;
    const tripId = `T${index}`;
    trips.push(`${leeds ? "R36" : "R8"},WEEKDAY,${tripId},Somewhere,0,,0`);
    const [a, b] = leeds ? ["450010001", "450010002"] : ["010000001", "010000002"];
    const hour = String(6 + (index % 12)).padStart(2, "0");
    stopTimes.push(`${tripId},${hour}:00:00,${hour}:00:00,${a},1,0,0,1`);
    stopTimes.push(`${tripId},${hour}:20:00,${hour}:20:00,${b},2,0,0,1`);
  }

  return {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nOP,Operator,,Europe/London\n",
    "routes.txt":
      "route_id,agency_id,route_short_name,route_long_name,route_type\n" +
      "R36,OP,36,Leeds,3\nR8,OP,8,Bristol,3\n",
    "stops.txt":
      "stop_id,stop_name,stop_lat,stop_lon,wheelchair_boarding\n" +
      STOPS.map((stop) => `${stop.id},${stop.name},${stop.lat},${stop.lon},0`).join("\n") +
      "\n",
    "calendar.txt":
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
      "WEEKDAY,1,1,1,1,1,1,1,20260101,20261231\n",
    "trips.txt":
      "route_id,service_id,trip_id,trip_headsign,direction_id,block_id,wheelchair_accessible\n" +
      `${trips.join("\n")}\n`,
    "stop_times.txt":
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,timepoint\n" +
      `${stopTimes.join("\n")}\n`,
  };
}

function naptan(): Map<string, Stop> {
  const provenance = { source: "naptan" as const, retrievedAt: RETRIEVED_AT, externalIds: [] };
  return new Map(
    STOPS.map((stop) => [
      stop.id,
      {
        id: deterministicUuid("stop", stop.id),
        provenance,
        ingestedAt: RETRIEVED_AT,
        qualityFlags: [],
        atcoCode: stop.id,
        name: stop.name,
        locationCoordinate: { lat: stop.lat, lon: stop.lon },
        stopType: "on_street_bus" as const,
        localityId: null,
        amenities: [],
        active: true,
        naptanStatus: "active" as const,
        supersededByStopId: null,
      },
    ]),
  );
}

async function buildAndPublish(tripCount: number) {
  const spill = new TileSpill(mkdtempSync(join(tmpdir(), "spill-pub-")), 4096);
  const stopsById = new Map([...naptan().values()].map((stop) => [stop.id, stop]));

  const result = await buildNetworkFromGtfs({
    archivePath: writeFeed(feed(tripCount)),
    serviceDates: [MONDAY],
    retrievedAt: RETRIEVED_AT,
    naptanByAtco: naptan(),
    onJourney: (journey) => {
      const coordinates = journey.stopTimes
        .map((call) => stopsById.get(call.stopId)?.locationCoordinate)
        .filter((coordinate): coordinate is NonNullable<typeof coordinate> => Boolean(coordinate));
      for (const tile of tilesForCoordinates(coordinates)) {
        spill.append(tile, JSON.stringify(journey));
      }
    },
  });

  const store = new InMemoryObjectStore();
  const published = await publishSpilledJourneyTiles(store, spill, { version: "v1" });
  return { result, published, store, spill };
}

describe("a GTFS archive, published as journey tiles", () => {
  it("puts every journey in a tile, and every tile in the store", async () => {
    const { result, published, store, spill } = await buildAndPublish(40);

    expect(result.counts.journeysEmitted).toBe(40);
    // Leeds and Bristol are more than a tile apart, so both must appear.
    expect(published.tiles.length).toBeGreaterThanOrEqual(2);
    expect(published.failed).toEqual([]);
    expect(published.records).toBe(40);

    for (const tile of published.tiles) {
      const body = await store.get(objectKeyFor(journeyTileDataset(tile), "v1"));
      expect(body).not.toBeNull();
      const records = body!.split("\n").map((line) => JSON.parse(line) as ScheduledJourney);
      expect(records.every((journey) => journey.serviceDate === MONDAY)).toBe(true);
    }
    spill.dispose();
  });

  it("writes the buffered tail, so a tile is never published short", async () => {
    // The write buffer is 4 KiB in these tests, so 40 journeys straddle several flushes and the
    // last few are still buffered when publishing starts. A publisher that did not flush first
    // would silently ship a shorter timetable than the build produced.
    const { result, published, spill } = await buildAndPublish(40);
    expect(published.records).toBe(result.counts.journeysEmitted);
    spill.dispose();
  });

  it("reports the biggest tile, which is what says whether the tile size still works", async () => {
    const { published, spill } = await buildAndPublish(40);
    expect(published.largest).not.toBeNull();
    expect(published.largest!.records).toBeGreaterThan(0);
    expect(published.largest!.bytes).toBeGreaterThan(0);
    spill.dispose();
  });

  it("separates the two cities into different tiles", async () => {
    const { published, store, spill } = await buildAndPublish(20);

    const contents = await Promise.all(
      published.tiles.map(async (tile) => {
        const body = await store.get(objectKeyFor(journeyTileDataset(tile), "v1"));
        return (body ?? "").split("\n").map((line) => JSON.parse(line) as ScheduledJourney);
      }),
    );

    const leedsStop = deterministicUuid("stop", "450010001");
    const bristolStop = deterministicUuid("stop", "010000001");
    const hasLeeds = contents.some((records) =>
      records.some((journey) => journey.stopTimes.some((call) => call.stopId === leedsStop)),
    );
    const hasBristol = contents.some((records) =>
      records.some((journey) => journey.stopTimes.some((call) => call.stopId === bristolStop)),
    );
    // No single tile holds both, which is the whole point of tiling.
    const bothInOne = contents.some(
      (records) =>
        records.some((journey) => journey.stopTimes.some((call) => call.stopId === leedsStop)) &&
        records.some((journey) => journey.stopTimes.some((call) => call.stopId === bristolStop)),
    );

    expect(hasLeeds).toBe(true);
    expect(hasBristol).toBe(true);
    expect(bothInOne).toBe(false);
    spill.dispose();
  });
});
