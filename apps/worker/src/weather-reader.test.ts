import { describe, expect, it } from "vitest";
import { ArtifactStore, InMemoryObjectStore, type ObjectStore } from "@busstops/pipeline-core";
import type { StopWeather } from "@busstops/contracts";
import { WeatherReader } from "./weather-reader.js";

const LEEDS = { lat: 53.7965, lon: -1.5379 };
/** Manchester Piccadilly Gardens, which is in a different degree square from Leeds. */
const MANCHESTER = { lat: 53.4808, lon: -2.2426 };

function answerFor(cell: string, temperature: number): StopWeather {
  return {
    cell,
    cellCentre: { lat: 53.75, lon: -1.55 },
    cellSizeDegrees: 0.1,
    current: {
      time: "2026-09-05T09:00:00.000Z",
      temperatureCelsius: temperature,
      apparentTemperatureCelsius: temperature - 2,
      precipitationMm: 0,
      precipitationProbability: 5,
      weatherCode: 1,
      windSpeedKph: 9,
      windGustKph: 14,
      uvIndex: 2.1,
      isDay: true,
    },
    next: [],
    retrievedAt: "2026-09-05T08:55:00.000Z",
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
  };
}

async function publish(store: ObjectStore, tile: string, records: StopWeather[]): Promise<void> {
  await new ArtifactStore(store).publish({
    dataset: `weather/cells/${tile}`,
    version: "2026-09-05T09-00-00-000Z",
    records,
    schemaVersion: "1",
  });
}

describe("reading the weather at a stop", () => {
  it("returns the cell the stop is in, from the degree square it belongs to", async () => {
    const store = new InMemoryObjectStore();
    await publish(store, "53_-2", [answerFor("537_-16", 14.2), answerFor("537_-17", 9.9)]);

    const reader = new WeatherReader(store);
    const weather = await reader.forCoordinate(LEEDS);

    expect(weather?.cell).toBe("537_-16");
    expect(weather?.current.temperatureCelsius).toBe(14.2);
  });

  /*
   * The three ways there can be no answer, all of which are null rather than someone else's
   * weather. A stop with no vignette is honest; a stop showing the sky eleven kilometres away
   * because that square happened to be published is not.
   */
  it("returns null when the square has not been published", async () => {
    const reader = new WeatherReader(new InMemoryObjectStore());
    expect(await reader.forCoordinate(LEEDS)).toBeNull();
  });

  it("returns null when the square is published but does not hold this cell", async () => {
    const store = new InMemoryObjectStore();
    await publish(store, "53_-2", [answerFor("539_-18", 12)]);

    const reader = new WeatherReader(store);
    expect(await reader.forCoordinate(LEEDS)).toBeNull();
  });

  it("returns null when the square cannot be read at all", async () => {
    const store = new InMemoryObjectStore();
    await publish(store, "53_-2", [answerFor("537_-16", 14.2)]);
    const broken: ObjectStore = {
      get: async (key) =>
        key.startsWith("data/") ? Promise.reject(new Error("R2 is unavailable")) : store.get(key),
      put: (key, value) => store.put(key, value),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
    };

    const reader = new WeatherReader(broken);
    expect(await reader.forCoordinate(LEEDS)).toBeNull();
  });

  it("reads a square once and serves it for the rest of its life", async () => {
    const store = new InMemoryObjectStore();
    await publish(store, "53_-2", [answerFor("537_-16", 14.2)]);

    let reads = 0;
    const counting: ObjectStore = {
      get: (key) => {
        if (key.startsWith("data/")) reads += 1;
        return store.get(key);
      },
      put: (key, value) => store.put(key, value),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
    };

    const reader = new WeatherReader(counting, 60_000);
    await reader.forCoordinate(LEEDS, 0);
    await reader.forCoordinate(LEEDS, 30_000);
    expect(reads).toBe(1);

    // Past the TTL it is read again, because an hour-old sky is not this hour's.
    await reader.forCoordinate(LEEDS, 90_000);
    expect(reads).toBe(2);
  });

  it("reads only the square the stop is in", async () => {
    const store = new InMemoryObjectStore();
    await publish(store, "53_-2", [answerFor("537_-16", 14.2)]);
    await publish(store, "53_-3", [answerFor("534_-23", 15.8)]);

    const datasets: string[] = [];
    const watching: ObjectStore = {
      get: (key) => {
        if (key.startsWith("data/")) datasets.push(key);
        return store.get(key);
      },
      put: (key, value) => store.put(key, value),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
    };

    const reader = new WeatherReader(watching);
    expect((await reader.forCoordinate(MANCHESTER))?.cell).toBe("534_-23");
    expect(datasets).toHaveLength(1);
    expect(datasets[0]).toContain("weather/cells/53_-3");
  });

  it("coalesces concurrent reads of the same square into one", async () => {
    const store = new InMemoryObjectStore();
    await publish(store, "53_-2", [answerFor("537_-16", 14.2)]);

    let reads = 0;
    const counting: ObjectStore = {
      get: async (key) => {
        if (key.startsWith("data/")) reads += 1;
        return store.get(key);
      },
      put: (key, value) => store.put(key, value),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
    };

    const reader = new WeatherReader(counting);
    const [a, b, c] = await Promise.all([
      reader.forCoordinate(LEEDS),
      reader.forCoordinate(LEEDS),
      reader.forCoordinate(LEEDS),
    ]);

    expect([a?.cell, b?.cell, c?.cell]).toEqual(["537_-16", "537_-16", "537_-16"]);
    expect(reads).toBe(1);
  });
});
