import { describe, expect, it } from "vitest";
import { ArtifactStore, InMemoryObjectStore } from "@busstops/pipeline-core";
import {
  MAX_LOCATIONS_PER_REQUEST,
  STOP_WEATHER_CELL_DEGREES,
  stopWeatherCell,
} from "@busstops/adapters";
import type { StopWeather } from "@busstops/contracts";
import { STOP_TILE_DEGREES as PUBLISHED_STOP_TILE_DEGREES } from "@busstops/pipeline-static-network";
import {
  MAX_WEATHER_CELLS,
  STOP_TILE_DEGREES,
  collectStopWeather,
  stopTileNamesFromKeys,
  weatherCellsForStopTiles,
  weatherShardDataset,
  weatherShardForCell,
} from "./collect.js";

/** Leeds City Bus Station, which is what the fixtures elsewhere use. */
const LEEDS = { lat: 53.7965, lon: -1.5379 };

function stopTileManifestKey(tile: string): string {
  return `manifests/network/stops-tile/${tile}/current.json`;
}

/** One Open-Meteo location, with as many hours as asked for around the given instant. */
function location(lat: number, lon: number, hours: string[]) {
  return {
    latitude: lat,
    longitude: lon,
    hourly: {
      time: hours,
      temperature_2m: hours.map(() => 11.4),
      apparent_temperature: hours.map(() => 8.9),
      precipitation: hours.map(() => 1.8),
      precipitation_probability: hours.map(() => 82),
      weather_code: hours.map(() => 63),
      wind_speed_10m: hours.map(() => 21),
      wind_gusts_10m: hours.map(() => 38),
      uv_index: hours.map(() => 1.2),
      is_day: hours.map(() => 1),
    },
  };
}

const HOURS = ["2026-09-05T08:00", "2026-09-05T09:00", "2026-09-05T10:00", "2026-09-05T11:00"];

describe("the grid the weather job shares with the network", () => {
  it("uses the same stop tile size the network publishes on", () => {
    // Duplicated as a number so this package does not depend on the other; pinned so it cannot
    // drift, because a mismatch would silently ask about the wrong part of the country.
    expect(STOP_TILE_DEGREES).toBe(PUBLISHED_STOP_TILE_DEGREES);
  });

  it("reads tile names out of a manifest listing and ignores anything else", () => {
    expect(
      stopTileNamesFromKeys([
        stopTileManifestKey("215_-7"),
        stopTileManifestKey("215_-6"),
        "manifests/network/patterns-tile/430_-13/current.json",
        "manifests/network/stops-tile/not-a-tile/current.json",
        "data/network/stops-tile/215_-7/2026-09-05.jsonl",
      ]),
    ).toEqual(["215_-6", "215_-7"]);
  });

  it("covers every cell a tile overlaps and claims no cell twice", () => {
    // A 0.25° tile is two and a half 0.10° cells across, so it overlaps three in each direction.
    const cells = weatherCellsForStopTiles(["215_-7"]);
    // Sorted as strings, which is stable and is all the order is for.
    expect(cells).toEqual([
      "537_-16",
      "537_-17",
      "537_-18",
      "538_-16",
      "538_-17",
      "538_-18",
      "539_-16",
      "539_-17",
      "539_-18",
    ]);

    // Neighbouring tiles share their edge cells, and the set is deduplicated rather than doubled.
    const pair = weatherCellsForStopTiles(["215_-7", "215_-6"]);
    expect(new Set(pair).size).toBe(pair.length);
  });

  it("puts a stop's cell in the shard the edge will read", () => {
    const cell = stopWeatherCell(LEEDS);
    expect(cell).toBe("537_-16");
    expect(weatherShardForCell(cell)).toBe("53_-2");
    expect(weatherShardDataset(weatherShardForCell(cell))).toBe("weather/cells/53_-2");
  });
});

describe("collecting the weather", () => {
  async function storeWithTiles(tiles: string[]) {
    const store = new InMemoryObjectStore();
    for (const tile of tiles) await store.put(stopTileManifestKey(tile), "{}");
    return store;
  }

  /*
   * Run 60 lost every batch to `429` and published nothing; run 59 got six through in 1.8 seconds
   * and then lost three the same way. That is a burst limit, and the job was asking nine
   * questions as fast as the network would carry them. The gap is what makes it a trickle.
   */
  it("spaces its batches instead of firing them all at once", async () => {
    // The same forty tiles the batching test uses: 303 cells, so four batches and three gaps.
    const store = await storeWithTiles(
      Array.from({ length: 40 }, (_, index) => `${215 + index}_-7`),
    );
    const waits: number[] = [];

    const result = await collectStopWeather({
      store,
      refreshMinutes: 30,
      now: new Date("2026-09-05T09:30:00.000Z"),
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async (input) => {
        const count = new URL(String(input)).searchParams.get("latitude")!.split(",").length;
        return new Response(
          JSON.stringify(
            Array.from({ length: count }, (_, index) =>
              location(53.75 + index * 0.1, -1.55, HOURS),
            ),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(result.batches).toHaveLength(4);
    // Three gaps, not four: the first batch waits for nothing.
    expect(waits).toEqual([2_000, 2_000, 2_000]);
    expect(result.outcome).toBe("published");
  });

  it("publishes one shard per degree square, with a cell for every answer", async () => {
    const store = await storeWithTiles(["215_-7"]);
    const requested: string[] = [];

    const result = await collectStopWeather({
      store,
      refreshMinutes: 30,
      now: new Date("2026-09-05T09:30:00.000Z"),
      fetchImpl: async (input) => {
        const url = String(input);
        requested.push(url);
        const count = new URL(url).searchParams.get("latitude")!.split(",").length;
        return new Response(
          JSON.stringify(
            Array.from({ length: count }, (_, index) =>
              location(53.75 + index * 0.1, -1.55, HOURS),
            ),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(result.outcome).toBe("published");
    expect(result.requested).toBe(9);
    expect(result.answered).toBe(9);
    expect(result.missing).toBe(0);
    expect(requested).toHaveLength(1);

    // Everything in this tile is inside one degree square.
    expect(result.shards).toEqual([{ tile: "53_-2", cells: 9 }]);

    const artifacts = new ArtifactStore(store);
    const { records } = await artifacts.readCurrent<StopWeather>("weather/cells/53_-2");
    expect(records).toHaveLength(9);
    expect(records[0]!.cellSizeDegrees).toBe(STOP_WEATHER_CELL_DEGREES);
    expect(records[0]!.attribution).toContain("Open-Meteo");
    // The hour covering the moment asked about, not the first hour of the day.
    expect(records[0]!.current.time).toBe("2026-09-05T09:00:00.000Z");
  });

  it("asks in batches rather than one request per cell", async () => {
    // Enough tiles to need more than one request: 100 locations per request.
    const tiles = Array.from({ length: 40 }, (_, index) => `${215 + index}_-7`);
    const store = await storeWithTiles(tiles);
    const batchSizes: number[] = [];

    const result = await collectStopWeather({
      store,
      refreshMinutes: 30,
      now: new Date("2026-09-05T09:30:00.000Z"),
      publish: false,
      // This one is about how the cells are grouped, not about the pause between groups.
      sleep: async () => {},
      fetchImpl: async (input) => {
        const count = new URL(String(input)).searchParams.get("latitude")!.split(",").length;
        batchSizes.push(count);
        return new Response(
          JSON.stringify(Array.from({ length: count }, () => location(53.75, -1.55, HOURS))),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    /*
     * Fewer than nine cells a tile: a column of tiles shares the cells on the edges between them,
     * and the set is deduplicated. Which is the point of asking per cell rather than per tile —
     * a stop's neighbours cost nothing.
     */
    expect(result.requested).toBe(303);
    expect(batchSizes).toEqual([100, 100, 100, 3]);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(MAX_LOCATIONS_PER_REQUEST);
    expect(result.budget.withinAllowance).toBe(true);
  });

  it("reports a cell the model did not answer for instead of filling it in", async () => {
    const store = await storeWithTiles(["215_-7"]);

    const result = await collectStopWeather({
      store,
      refreshMinutes: 30,
      now: new Date("2026-09-05T09:30:00.000Z"),
      // Four answers for nine cells.
      fetchImpl: async () =>
        new Response(
          JSON.stringify(Array.from({ length: 4 }, () => location(53.75, -1.55, HOURS))),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    expect(result.answered).toBe(4);
    expect(result.missing).toBe(5);

    const artifacts = new ArtifactStore(store);
    const { records } = await artifacts.readCurrent<StopWeather>("weather/cells/53_-2");
    expect(records).toHaveLength(4);
  });

  it("publishes nothing when no source answered, so the last real reading stays live", async () => {
    const store = await storeWithTiles(["215_-7"]);

    const result = await collectStopWeather({
      store,
      refreshMinutes: 30,
      now: new Date("2026-09-05T09:30:00.000Z"),
      sleep: async () => {},
      fetchImpl: async () => new Response("upstream is down", { status: 503 }),
    });

    expect(result.outcome).toBe("no_answer");
    expect(result.missing).toBe(9);
    expect(await store.get("manifests/weather/cells/53_-2/current.json")).toBeNull();
    // The failure class is reported; the coordinates it was asking about are not.
    expect(result.batches[0]!.error).toBeDefined();
  });

  it("asks nothing at all when the network has not been published", async () => {
    const store = new InMemoryObjectStore();
    let called = 0;

    const result = await collectStopWeather({
      store,
      refreshMinutes: 30,
      fetchImpl: async () => {
        called += 1;
        return new Response("{}", { status: 200 });
      },
    });

    expect(result.outcome).toBe("network_not_published");
    expect(called).toBe(0);
  });

  it("refuses a cell count far larger than England, rather than spending the allowance on it", async () => {
    const tiles = Array.from({ length: 900 }, (_, index) => `${index}_-7`);
    const store = await storeWithTiles(tiles);
    let called = 0;

    const result = await collectStopWeather({
      store,
      refreshMinutes: 30,
      fetchImpl: async () => {
        called += 1;
        return new Response("{}", { status: 200 });
      },
    });

    expect(result.requested).toBeGreaterThan(MAX_WEATHER_CELLS);
    expect(result.outcome).toBe("too_many_cells");
    expect(called).toBe(0);
  });

  it("refuses a schedule that would not fit the daily allowance", async () => {
    const store = await storeWithTiles(["215_-7"]);
    let called = 0;

    const result = await collectStopWeather({
      store,
      // Once a minute: nine cells is one request, 1,440 a day — inside the allowance. Make the
      // interval absurd instead and the arithmetic, not an opinion, is what stops it.
      refreshMinutes: 0.05,
      fetchImpl: async () => {
        called += 1;
        return new Response("{}", { status: 200 });
      },
    });

    expect(result.budget.withinAllowance).toBe(false);
    expect(result.outcome).toBe("budget_exceeded");
    expect(called).toBe(0);
  });
});
