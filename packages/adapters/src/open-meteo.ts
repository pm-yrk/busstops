import { z } from "zod";
import type { Coordinate, WeatherForecast, WeatherObservation } from "@busstops/contracts";
import { deterministicUuid } from "./identity.js";

/**
 * Open-Meteo adapter — observed and forecast weather (docs/05_DATA_SOURCES.md).
 *
 * Requests are bucketed onto a coarse grid and cached per grid cell and hour so national
 * coverage costs a few dozen calls rather than one per stop. The model run time and forecast
 * horizon are preserved: a 48-hour-old forecast must not be presented like a fresh observation.
 */

export const OPEN_METEO_BASE_URL = "https://api.open-meteo.com/v1/forecast";

export const OpenMeteoResponseSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  generationtime_ms: z.number().optional(),
  utc_offset_seconds: z.number().optional(),
  timezone: z.string().optional(),
  elevation: z.number().optional(),
  hourly_units: z.record(z.string()).optional(),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(z.number().nullable()).optional(),
    precipitation: z.array(z.number().nullable()).optional(),
    wind_speed_10m: z.array(z.number().nullable()).optional(),
    weather_code: z.array(z.number().nullable()).optional(),
  }),
});
export type OpenMeteoResponse = z.infer<typeof OpenMeteoResponseSchema>;

/** Grid cell key. 0.25° is roughly 28km north-south: fine enough for rain, coarse enough to cache. */
export const WEATHER_GRID_DEGREES = 0.25;

export function weatherGridCell(coordinate: Coordinate): string {
  const lat = Math.round(coordinate.lat / WEATHER_GRID_DEGREES) * WEATHER_GRID_DEGREES;
  const lon = Math.round(coordinate.lon / WEATHER_GRID_DEGREES) * WEATHER_GRID_DEGREES;
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

export function openMeteoUrl(coordinate: Coordinate): string {
  const url = new URL(OPEN_METEO_BASE_URL);
  const [lat, lon] = weatherGridCell(coordinate).split(",") as [string, string];
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("hourly", "temperature_2m,precipitation,wind_speed_10m,weather_code");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("past_days", "1");
  return url.toString();
}

export interface WeatherNormalizeOptions {
  retrievedAt: string;
  /** Model run time; Open-Meteo does not state it directly, so the retrieval time is used and labelled. */
  modelRunAt?: string;
  now: Date;
}

export interface WeatherNormalizeResult {
  observations: WeatherObservation[];
  forecasts: WeatherForecast[];
  rejected: number;
}

/**
 * Splits the hourly series at "now": hours in the past are observations, hours ahead are
 * forecasts with an explicit horizon. Keeping them in separate entity types is what stops the
 * UI presenting a forecast as an observed fact.
 */
export function normalizeOpenMeteo(
  payload: unknown,
  options: WeatherNormalizeOptions,
): WeatherNormalizeResult {
  const parsed = OpenMeteoResponseSchema.safeParse(payload);
  if (!parsed.success) return { observations: [], forecasts: [], rejected: 1 };

  const response = parsed.data;
  const gridCell = weatherGridCell({ lat: response.latitude, lon: response.longitude });
  const modelRunAt = options.modelRunAt ?? options.retrievedAt;

  const observations: WeatherObservation[] = [];
  const forecasts: WeatherForecast[] = [];
  let rejected = 0;

  response.hourly.time.forEach((timeString, index) => {
    // Open-Meteo returns naive local times; the request pins timezone=UTC.
    const instant = new Date(timeString.endsWith("Z") ? timeString : `${timeString}:00Z`);
    if (Number.isNaN(instant.getTime())) {
      rejected += 1;
      return;
    }

    const temperature = response.hourly.temperature_2m?.[index];
    const precipitation = response.hourly.precipitation?.[index];
    const windSpeed = response.hourly.wind_speed_10m?.[index];
    const weatherCode = response.hourly.weather_code?.[index];

    if (
      temperature === null ||
      temperature === undefined ||
      precipitation === null ||
      precipitation === undefined ||
      windSpeed === null ||
      windSpeed === undefined
    ) {
      rejected += 1;
      return;
    }

    const condition = {
      temperatureCelsius: temperature,
      precipitationMmPerHour: precipitation,
      // Open-Meteo reports wind in km/h by default; the model stores m/s.
      windSpeedMetresPerSecond: windSpeed / 3.6,
      weatherCode: weatherCode ?? 0,
    };

    const isPast = instant.getTime() <= options.now.getTime();

    if (isPast) {
      observations.push({
        id: deterministicUuid("segment", `weather-obs:${gridCell}:${instant.toISOString()}`),
        provenance: {
          source: "open_meteo",
          retrievedAt: options.retrievedAt,
          externalIds: [{ source: "open_meteo", id: gridCell }],
        },
        ingestedAt: options.retrievedAt,
        qualityFlags: [],
        gridCell,
        observedAt: instant.toISOString(),
        condition,
      });
    } else {
      forecasts.push({
        id: deterministicUuid("segment", `weather-fc:${gridCell}:${instant.toISOString()}`),
        provenance: {
          source: "open_meteo",
          retrievedAt: options.retrievedAt,
          externalIds: [{ source: "open_meteo", id: gridCell }],
        },
        ingestedAt: options.retrievedAt,
        qualityFlags: [],
        gridCell,
        modelRunAt,
        forecastFor: instant.toISOString(),
        forecastHorizonHours: (instant.getTime() - options.now.getTime()) / 3_600_000,
        condition,
      });
    }
  });

  return { observations, forecasts, rejected };
}

/** WMO weather codes grouped for plain-language display. */
export function describeWeatherCode(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Fog";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Rain showers";
  if (code <= 86) return "Snow showers";
  return "Thunderstorm";
}

/** Rainfall bands used when matching outcomes to weather conditions in the analytics engine. */
export function rainfallBand(
  precipitationMmPerHour: number,
): "dry" | "light" | "moderate" | "heavy" {
  if (precipitationMmPerHour < 0.1) return "dry";
  if (precipitationMmPerHour < 2.5) return "light";
  if (precipitationMmPerHour < 7.6) return "moderate";
  return "heavy";
}
