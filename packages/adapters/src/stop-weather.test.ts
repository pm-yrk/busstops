import { describe, expect, it } from "vitest";
import { StopWeatherSchema } from "@busstops/contracts";
import {
  MAX_LOCATIONS_PER_REQUEST,
  STOP_WEATHER_CELL_DEGREES,
  normalizeStopWeatherBatch,
  openMeteoBatchUrl,
  stopWeatherCell,
  stopWeatherCellCentre,
  weatherAdvice,
  weatherConditionKind,
  weatherRequestBudget,
} from "./stop-weather.js";

const NOW = new Date("2026-09-04T09:30:00.000Z");

/** One location's hourly block, shaped as Open-Meteo returns it. */
function location(overrides: Record<string, unknown> = {}) {
  return {
    latitude: 53.85,
    longitude: -1.55,
    hourly: {
      time: ["2026-09-04T08:00", "2026-09-04T09:00", "2026-09-04T10:00", "2026-09-04T11:00"],
      temperature_2m: [12.1, 13.4, 14.8, 15.2],
      apparent_temperature: [10.8, 12.0, 13.9, 14.4],
      precipitation: [0, 0.4, 1.2, 0],
      precipitation_probability: [10, 45, 70, 20],
      weather_code: [3, 61, 63, 3],
      wind_speed_10m: [14, 18, 21, 17],
      wind_gusts_10m: [28, 34, 41, 30],
      uv_index: [1.2, 2.1, 2.8, 3.1],
      is_day: [1, 1, 1, 1],
      ...overrides,
    },
  };
}

describe("weather cells", () => {
  it("puts nearby stops in the same cell and distant ones apart", () => {
    // Two stops 300 m apart in Leeds.
    const a = stopWeatherCell({ lat: 53.7965, lon: -1.5445 });
    const b = stopWeatherCell({ lat: 53.7998, lon: -1.546 });
    expect(a).toBe(b);

    // Leeds and Bristol are not in the same cell, which would be a spectacular forecast.
    expect(stopWeatherCell({ lat: 51.4545, lon: -2.5879 })).not.toBe(a);
  });

  it("round-trips a cell to a point inside itself", () => {
    const cell = stopWeatherCell({ lat: 53.7965, lon: -1.5445 });
    const centre = stopWeatherCellCentre(cell);
    expect(stopWeatherCell(centre)).toBe(cell);
    expect(Math.abs(centre.lat - 53.7965)).toBeLessThan(STOP_WEATHER_CELL_DEGREES);
  });
});

describe("the free-tier budget is arithmetic, not an assurance", () => {
  it("stays inside the published allowance for England's populated cells", () => {
    /*
     * England's stops occupy on the order of 2,000 cells at 0.10°. Refreshed every fifteen
     * minutes and batched a hundred at a time, that is twenty requests per refresh — the number
     * this has to keep under 10,000 a day.
     */
    const budget = weatherRequestBudget(2000, 15);
    expect(budget.requestsPerRefresh).toBe(20);
    expect(budget.refreshesPerDay).toBe(96);
    expect(budget.requestsPerDay).toBe(1920);
    expect(budget.withinAllowance).toBe(true);
  });

  it("says so when a choice would not fit", () => {
    // One request per cell — what an unbatched design would cost — does not fit and must say so.
    const naive = weatherRequestBudget(2000 * MAX_LOCATIONS_PER_REQUEST, 15);
    expect(naive.withinAllowance).toBe(false);
  });

  it("asks for the variables the stop page shows", () => {
    const url = new URL(openMeteoBatchUrl(["538_-16", "514_-26"]));
    const hourly = url.searchParams.get("hourly") ?? "";
    for (const variable of [
      "temperature_2m",
      "apparent_temperature",
      "precipitation",
      "precipitation_probability",
      "weather_code",
      "wind_speed_10m",
      "wind_gusts_10m",
      "uv_index",
      "is_day",
    ]) {
      expect(hourly).toContain(variable);
    }
    // Both cells in one request, which is the whole point.
    expect(url.searchParams.get("latitude")!.split(",")).toHaveLength(2);
  });
});

describe("reading a batch", () => {
  it("takes the hour covering now, not the nearest one", () => {
    const { weather } = normalizeStopWeatherBatch([location()], {
      cells: ["538_-16"],
      retrievedAt: NOW.toISOString(),
      now: NOW,
    });

    expect(weather).toHaveLength(1);
    expect(StopWeatherSchema.safeParse(weather[0]).success).toBe(true);
    // 09:30 is inside the 09:00 hour; 10:00 has not happened.
    expect(weather[0]!.current.time).toBe("2026-09-04T09:00:00.000Z");
    expect(weather[0]!.current.temperatureCelsius).toBe(13.4);
    expect(weather[0]!.current.apparentTemperatureCelsius).toBe(12);
    expect(weather[0]!.current.windGustKph).toBe(34);
    expect(weather[0]!.current.precipitationProbability).toBe(45);
  });

  it("keeps the next few hours, so 'about to rain' is sayable", () => {
    const { weather } = normalizeStopWeatherBatch([location()], {
      cells: ["538_-16"],
      retrievedAt: NOW.toISOString(),
      now: NOW,
    });
    expect(weather[0]!.next.map((hour) => hour.time)).toEqual([
      "2026-09-04T10:00:00.000Z",
      "2026-09-04T11:00:00.000Z",
    ]);
  });

  it("accepts a single location answered as an object rather than an array", () => {
    const { weather } = normalizeStopWeatherBatch(location(), {
      cells: ["538_-16"],
      retrievedAt: NOW.toISOString(),
      now: NOW,
    });
    expect(weather).toHaveLength(1);
  });

  it("names the cells it could not answer for", () => {
    const { weather, missing } = normalizeStopWeatherBatch([location()], {
      cells: ["538_-16", "514_-26"],
      retrievedAt: NOW.toISOString(),
      now: NOW,
    });
    expect(weather).toHaveLength(1);
    // A gap must never be mistaken for fair weather.
    expect(missing).toEqual(["514_-26"]);
  });

  it("falls back to the measured temperature when no apparent one was published", () => {
    const { weather } = normalizeStopWeatherBatch(
      [location({ apparent_temperature: [null, null, null, null] })],
      { cells: ["538_-16"], retrievedAt: NOW.toISOString(), now: NOW },
    );
    expect(weather[0]!.current.apparentTemperatureCelsius).toBe(13.4);
  });

  it("gives back nothing, and says so, for a payload it cannot read", () => {
    const result = normalizeStopWeatherBatch(
      { nope: true },
      {
        cells: ["538_-16"],
        retrievedAt: NOW.toISOString(),
        now: NOW,
      },
    );
    expect(result.weather).toEqual([]);
    expect(result.missing).toEqual(["538_-16"]);
  });
});

describe("advice", () => {
  const hour = {
    time: NOW.toISOString(),
    temperatureCelsius: 15,
    apparentTemperatureCelsius: 15,
    precipitationMm: 0,
    precipitationProbability: 5,
    weatherCode: 3,
    windSpeedKph: 12,
    windGustKph: 20,
    uvIndex: 2,
    isDay: true,
  };

  it("says nothing when the weather needs no comment", () => {
    expect(weatherAdvice(hour).kind).toBe("none");
    expect(weatherAdvice(hour).message).toBe("");
  });

  it("leads with rain, and shows the numbers it chose from", () => {
    const advice = weatherAdvice({ ...hour, weatherCode: 63, precipitationMm: 1.2 });
    expect(advice.kind).toBe("rain");
    expect(advice.message).toBe("Don't forget your umbrella.");
    expect(advice.because).toContain("1.2 mm this hour");
  });

  it("puts snow above rain, because it changes the journey rather than the coat", () => {
    expect(weatherAdvice({ ...hour, weatherCode: 73 }).kind).toBe("snow");
  });

  it("mentions wind only when a gust would actually take an umbrella", () => {
    expect(weatherAdvice({ ...hour, windGustKph: 40 }).kind).toBe("none");
    expect(weatherAdvice({ ...hour, windGustKph: 55 }).kind).toBe("wind");
  });

  it("mentions UV only in daylight", () => {
    expect(weatherAdvice({ ...hour, uvIndex: 7 }).kind).toBe("uv");
    expect(weatherAdvice({ ...hour, uvIndex: 7, isDay: false }).kind).toBe("none");
  });

  it("uses how it feels rather than what the thermometer says", () => {
    expect(
      weatherAdvice({ ...hour, temperatureCelsius: 8, apparentTemperatureCelsius: 1 }).kind,
    ).toBe("cold");
    expect(
      weatherAdvice({ ...hour, temperatureCelsius: 22, apparentTemperatureCelsius: 27 }).kind,
    ).toBe("hot");
  });

  it("never gives medical advice", () => {
    const messages = [
      weatherAdvice({ ...hour, uvIndex: 9 }),
      weatherAdvice({ ...hour, apparentTemperatureCelsius: 30 }),
      weatherAdvice({ ...hour, apparentTemperatureCelsius: -4 }),
    ].map((advice) => advice.message.toLowerCase());

    for (const message of messages) {
      expect(message).not.toMatch(/risk|danger|health|heatstroke|hypothermia|warning/);
    }
  });

  it("maps codes to the small set of scenes the vignette can draw", () => {
    expect(weatherConditionKind(0)).toBe("clear");
    expect(weatherConditionKind(45)).toBe("fog");
    expect(weatherConditionKind(63)).toBe("rain");
    expect(weatherConditionKind(75)).toBe("snow");
    expect(weatherConditionKind(86)).toBe("snow");
    expect(weatherConditionKind(95)).toBe("thunderstorm");
  });
});
