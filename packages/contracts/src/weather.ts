import { z } from "zod";
import { CoordinateSchema, IsoInstantSchema } from "./common.js";

/**
 * Weather as a passenger standing at a stop needs it.
 *
 * Separate from the analytics `WeatherObservation`/`WeatherForecast` pair, which exist to explain
 * why buses ran badly and are keyed by a coarse grid cell. This is one small answer about one
 * place at one moment: what it is like now, and what the next few hours look like.
 *
 * Everything is a published number. There is no "feels nice" score and no invented advice: the
 * copy shown at the stop is chosen from thresholds against these values, and the values are
 * shown alongside it so a reader can disagree.
 */

export const WeatherConditionKindSchema = z.enum([
  "clear",
  "cloud",
  "fog",
  "drizzle",
  "rain",
  "snow",
  "showers",
  "thunderstorm",
]);
export type WeatherConditionKind = z.infer<typeof WeatherConditionKindSchema>;

export const StopWeatherHourSchema = z.object({
  time: IsoInstantSchema,
  temperatureCelsius: z.number(),
  /** Open-Meteo's apparent temperature: wind chill and humidity folded in. */
  apparentTemperatureCelsius: z.number(),
  precipitationMm: z.number().nonnegative(),
  /** 0..100. Null where the model did not publish one for this hour. */
  precipitationProbability: z.number().min(0).max(100).nullable(),
  weatherCode: z.number().int(),
  windSpeedKph: z.number().nonnegative(),
  windGustKph: z.number().nonnegative().nullable(),
  uvIndex: z.number().nonnegative().nullable(),
  isDay: z.boolean(),
});
export type StopWeatherHour = z.infer<typeof StopWeatherHourSchema>;

export const StopWeatherSchema = z.object({
  /** The cell this came from, not the stop: one cell answers for every stop inside it. */
  cell: z.string().min(1),
  cellCentre: CoordinateSchema,
  /** Degrees per side of the cache cell, so the UI can say how local the answer is. */
  cellSizeDegrees: z.number().positive(),
  /** The hour covering now. */
  current: StopWeatherHourSchema,
  /** The next few hours, for "it is about to rain" rather than "it is not raining". */
  next: z.array(StopWeatherHourSchema).default([]),
  /** When the model was asked — the age of the answer, not of this response. */
  retrievedAt: IsoInstantSchema,
  attribution: z.string().min(1),
});
export type StopWeather = z.infer<typeof StopWeatherSchema>;

/**
 * The advice a stop shows, chosen from thresholds.
 *
 * A closed set, so the vignette has one scene per kind and the copy is written once rather than
 * generated. `none` is a real answer: most of the time the weather needs no comment, and filling
 * the space anyway would train people to ignore it.
 */
export const WeatherAdviceKindSchema = z.enum([
  "none",
  "rain",
  "wind",
  "uv",
  "hot",
  "cold",
  "snow",
  "fog",
]);
export type WeatherAdviceKind = z.infer<typeof WeatherAdviceKindSchema>;

export const WeatherAdviceSchema = z.object({
  kind: WeatherAdviceKindSchema,
  /** One sentence. Never medical, never alarming, never invented. */
  message: z.string(),
  /** The numbers the message was chosen from, shown next to it. */
  because: z.array(z.string()).default([]),
});
export type WeatherAdvice = z.infer<typeof WeatherAdviceSchema>;
