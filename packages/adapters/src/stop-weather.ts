import { z } from "zod";
import type {
  Coordinate,
  StopWeather,
  StopWeatherHour,
  WeatherAdvice,
  WeatherConditionKind,
} from "@busstops/contracts";

/**
 * Weather for a stop, from Open-Meteo, batched.
 *
 * The free non-commercial allowance is 10,000 calls a day and the naive design blows through it
 * immediately: one call per stop per visitor would be thousands an hour. Two things prevent that.
 *
 * The first is spatial. Answers are cached per grid cell, not per stop; every stop inside a cell
 * shares one answer. At 0.10° a cell is roughly 11 km north-south, which is finer than a shower
 * and far coarser than a bus stop.
 *
 * The second is batching. Open-Meteo accepts comma-separated coordinate lists and answers with
 * one object per location, so the cells England's stops actually occupy cost tens of requests
 * rather than thousands. The arithmetic is in `weatherRequestBudget`, and it is arithmetic rather
 * than an assurance: change the cell size or the refresh interval and it tells you what that
 * costs.
 *
 * None of this happens in the Worker. A scheduled job asks for every populated cell and publishes
 * one artifact; the edge reads a cell out of it. So the number of upstream calls is a property of
 * the schedule, not of how many people are looking at the site.
 */

export const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/**
 * Cell size for the passenger-facing cache.
 *
 * 0.10° is about 11 km north-south and 7 km east-west at English latitudes. Finer than that stops
 * being meaningful — the model's own resolution is coarser — and starts multiplying the request
 * count for no gain a passenger could notice.
 */
export const STOP_WEATHER_CELL_DEGREES = 0.1;

/** How many locations go in one request. Kept well inside what the API accepts. */
export const MAX_LOCATIONS_PER_REQUEST = 100;

export const OPEN_METEO_ATTRIBUTION =
  "Weather data by Open-Meteo.com (CC BY 4.0), used under its free non-commercial terms";

/** The hourly variables the stop page needs, in the order Open-Meteo returns them. */
export const HOURLY_VARIABLES = [
  "temperature_2m",
  "apparent_temperature",
  "precipitation",
  "precipitation_probability",
  "weather_code",
  "wind_speed_10m",
  "wind_gusts_10m",
  "uv_index",
  "is_day",
] as const;

export function stopWeatherCell(coordinate: Coordinate, size = STOP_WEATHER_CELL_DEGREES): string {
  const lat = Math.floor(coordinate.lat / size);
  const lon = Math.floor(coordinate.lon / size);
  return `${lat}_${lon}`;
}

/** The centre of a cell, which is the point actually asked about. */
export function stopWeatherCellCentre(cell: string, size = STOP_WEATHER_CELL_DEGREES): Coordinate {
  const [lat, lon] = cell.split("_").map(Number) as [number, number];
  return { lat: (lat + 0.5) * size, lon: (lon + 0.5) * size };
}

export interface RequestBudget {
  cells: number;
  requestsPerRefresh: number;
  refreshesPerDay: number;
  requestsPerDay: number;
  /** The published free non-commercial allowance this is being held against. */
  dailyAllowance: number;
  withinAllowance: boolean;
}

/**
 * What a given cell count and refresh interval actually costs per day.
 *
 * Printed by the job and asserted by a test, so the free-tier claim is arithmetic that can be
 * checked rather than a sentence in a document.
 */
export function weatherRequestBudget(
  cells: number,
  refreshMinutes: number,
  dailyAllowance = 10_000,
): RequestBudget {
  const requestsPerRefresh = Math.ceil(cells / MAX_LOCATIONS_PER_REQUEST);
  const refreshesPerDay = Math.floor((24 * 60) / refreshMinutes);
  const requestsPerDay = requestsPerRefresh * refreshesPerDay;
  return {
    cells,
    requestsPerRefresh,
    refreshesPerDay,
    requestsPerDay,
    dailyAllowance,
    withinAllowance: requestsPerDay <= dailyAllowance,
  };
}

export function openMeteoBatchUrl(
  cells: readonly string[],
  size = STOP_WEATHER_CELL_DEGREES,
): string {
  const centres = cells.map((cell) => stopWeatherCellCentre(cell, size));
  const url = new URL(OPEN_METEO_FORECAST_URL);
  url.searchParams.set("latitude", centres.map((c) => c.lat.toFixed(4)).join(","));
  url.searchParams.set("longitude", centres.map((c) => c.lon.toFixed(4)).join(","));
  url.searchParams.set("hourly", HOURLY_VARIABLES.join(","));
  url.searchParams.set("timezone", "UTC");
  // One day forward is all a stop page uses; asking for more is bytes nobody reads.
  url.searchParams.set("forecast_days", "1");
  return url.toString();
}

const LocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(z.number().nullable()).optional(),
    apparent_temperature: z.array(z.number().nullable()).optional(),
    precipitation: z.array(z.number().nullable()).optional(),
    precipitation_probability: z.array(z.number().nullable()).optional(),
    weather_code: z.array(z.number().nullable()).optional(),
    wind_speed_10m: z.array(z.number().nullable()).optional(),
    wind_gusts_10m: z.array(z.number().nullable()).optional(),
    uv_index: z.array(z.number().nullable()).optional(),
    is_day: z.array(z.number().nullable()).optional(),
  }),
});

/**
 * Open-Meteo answers a single location with an object and several with an array.
 *
 * Accepting both is not defensiveness for its own sake: a batch that happened to contain one cell
 * would otherwise fail to parse, and the batch size is decided by how many cells have stops in
 * them — which is data, not configuration.
 */
const BatchSchema = z.union([LocationSchema, z.array(LocationSchema)]);

export interface NormalizeStopWeatherOptions {
  cells: readonly string[];
  retrievedAt: string;
  now: Date;
  cellSizeDegrees?: number;
  /** How many hours ahead to keep. Four is enough for "it is about to rain". */
  forecastHours?: number;
}

export interface NormalizeStopWeatherResult {
  weather: StopWeather[];
  /** Cells the response did not answer for, so a gap is never mistaken for fair weather. */
  missing: string[];
  rejected: number;
}

export function normalizeStopWeatherBatch(
  payload: unknown,
  options: NormalizeStopWeatherOptions,
): NormalizeStopWeatherResult {
  const parsed = BatchSchema.safeParse(payload);
  if (!parsed.success) return { weather: [], missing: [...options.cells], rejected: 1 };

  const locations = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  const size = options.cellSizeDegrees ?? STOP_WEATHER_CELL_DEGREES;
  const forecastHours = options.forecastHours ?? 4;
  const weather: StopWeather[] = [];
  const missing: string[] = [];
  let rejected = 0;

  options.cells.forEach((cell, index) => {
    const location = locations[index];
    if (!location) {
      missing.push(cell);
      return;
    }

    const hours: StopWeatherHour[] = [];
    location.hourly.time.forEach((raw, hourIndex) => {
      // The request pins timezone=UTC, and Open-Meteo returns naive local times for it.
      const time = new Date(raw.endsWith("Z") ? raw : `${raw}:00Z`);
      if (Number.isNaN(time.getTime())) {
        rejected += 1;
        return;
      }
      const temperature = location.hourly.temperature_2m?.[hourIndex];
      const apparent = location.hourly.apparent_temperature?.[hourIndex];
      if (temperature === null || temperature === undefined) {
        rejected += 1;
        return;
      }

      hours.push({
        time: time.toISOString(),
        temperatureCelsius: temperature,
        // Apparent temperature is what the advice is chosen from, so its absence falls back to
        // the measured temperature rather than to nothing.
        apparentTemperatureCelsius: apparent ?? temperature,
        precipitationMm: location.hourly.precipitation?.[hourIndex] ?? 0,
        precipitationProbability: location.hourly.precipitation_probability?.[hourIndex] ?? null,
        weatherCode: location.hourly.weather_code?.[hourIndex] ?? 0,
        windSpeedKph: location.hourly.wind_speed_10m?.[hourIndex] ?? 0,
        windGustKph: location.hourly.wind_gusts_10m?.[hourIndex] ?? null,
        uvIndex: location.hourly.uv_index?.[hourIndex] ?? null,
        isDay: (location.hourly.is_day?.[hourIndex] ?? 1) === 1,
      });
    });

    // The hour covering now, not the nearest hour: at 09:59 the 09:00 row is what is happening.
    const nowMs = options.now.getTime();
    let currentIndex = -1;
    for (let index = hours.length - 1; index >= 0; index -= 1) {
      if (new Date(hours[index]!.time).getTime() <= nowMs) {
        currentIndex = index;
        break;
      }
    }
    if (currentIndex === -1) {
      missing.push(cell);
      return;
    }

    weather.push({
      cell,
      cellCentre: stopWeatherCellCentre(cell, size),
      cellSizeDegrees: size,
      current: hours[currentIndex]!,
      next: hours.slice(currentIndex + 1, currentIndex + 1 + forecastHours),
      retrievedAt: options.retrievedAt,
      attribution: OPEN_METEO_ATTRIBUTION,
    });
  });

  return { weather, missing, rejected };
}

/** WMO code to the small set of scenes the vignette can draw. */
export function weatherConditionKind(code: number): WeatherConditionKind {
  if (code === 0) return "clear";
  if (code <= 3) return "cloud";
  if (code <= 48) return "fog";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "showers";
  if (code <= 86) return "snow";
  return "thunderstorm";
}

/**
 * The one thing worth saying about the weather at a stop, or nothing.
 *
 * Thresholds, in a deliberate order: what would stop you leaving the house comes before what
 * would make you take a coat. None of it is medical advice and none of it is invented — every
 * message names the numbers it was chosen from, and those numbers are shown next to it.
 */
export function weatherAdvice(hour: StopWeatherHour): WeatherAdvice {
  const kind = weatherConditionKind(hour.weatherCode);
  const gust = hour.windGustKph ?? hour.windSpeedKph;

  if (kind === "snow") {
    return {
      kind: "snow",
      message: "Snow is around — allow a little extra time.",
      because: [
        `${describeCondition(hour.weatherCode)}`,
        `${Math.round(hour.temperatureCelsius)}°C`,
      ],
    };
  }

  if (kind === "rain" || kind === "showers" || kind === "drizzle" || kind === "thunderstorm") {
    return {
      kind: "rain",
      message: "Don't forget your umbrella.",
      because: [
        `${hour.precipitationMm.toFixed(1)} mm this hour`,
        ...(hour.precipitationProbability === null
          ? []
          : [`${hour.precipitationProbability}% chance of rain`]),
      ],
    };
  }

  // 50 km/h gusts is the point at which an umbrella stops working and a bin lid does not stay on.
  if (gust >= 50) {
    return {
      kind: "wind",
      message: "It's breezy at the stop — hold onto anything loose.",
      because: [
        `${Math.round(hour.windSpeedKph)} km/h wind`,
        ...(hour.windGustKph === null ? [] : [`gusting ${Math.round(hour.windGustKph)} km/h`]),
      ],
    };
  }

  if (kind === "fog") {
    return {
      kind: "fog",
      message: "Visibility is reduced — buses may run more slowly than usual.",
      because: [describeCondition(hour.weatherCode)],
    };
  }

  // UV 6 is the "high" band in the WHO scale, which is the point advice is usually given.
  if (hour.uvIndex !== null && hour.uvIndex >= 6 && hour.isDay) {
    return {
      kind: "uv",
      message: "UV is high — sunscreen and shade are a good idea.",
      because: [`UV index ${hour.uvIndex.toFixed(1)}`],
    };
  }

  if (hour.apparentTemperatureCelsius >= 25) {
    return {
      kind: "hot",
      message: "It's warm out — water and a bit of shade may help.",
      because: [
        `${Math.round(hour.temperatureCelsius)}°C`,
        `feels like ${Math.round(hour.apparentTemperatureCelsius)}°C`,
      ],
    };
  }

  if (hour.apparentTemperatureCelsius <= 3) {
    return {
      kind: "cold",
      message: "Wrap up warm while you wait.",
      because: [
        `${Math.round(hour.temperatureCelsius)}°C`,
        `feels like ${Math.round(hour.apparentTemperatureCelsius)}°C`,
      ],
    };
  }

  // Most of the time the weather needs no comment, and saying something anyway would train
  // people to stop reading it.
  return { kind: "none", message: "", because: [] };
}

export function describeCondition(code: number): string {
  const kind = weatherConditionKind(code);
  switch (kind) {
    case "clear":
      return "Clear";
    case "cloud":
      return "Cloudy";
    case "fog":
      return "Fog";
    case "drizzle":
      return "Drizzle";
    case "rain":
      return "Rain";
    case "showers":
      return "Showers";
    case "snow":
      return "Snow";
    case "thunderstorm":
      return "Thunderstorm";
  }
}
