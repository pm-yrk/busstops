/**
 * Time handling. Everything is stored and computed in UTC; Europe/London with DST is a
 * presentation concern. Service dates are the local operating day, which is what timetables
 * are keyed on — this is why a 00:30 journey belongs to the previous service day.
 */

export const DISPLAY_TIMEZONE = "Europe/London";

/** Local operating day boundary: journeys before this hour belong to the previous service date. */
export const SERVICE_DAY_START_HOUR = 4;

export function toIso(date: Date): string {
  return date.toISOString();
}

/** Parts of an instant as seen in Europe/London, DST-correct via the Intl database. */
export interface LondonParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const londonFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  weekday: "short",
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function londonParts(instant: Date): LondonParts {
  const parts = londonFormatter.formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    // Intl renders midnight as 24 in some ICU versions for hour12:false.
    hour: hour === 24 ? 0 : hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** UTC offset of Europe/London at an instant, in minutes (0 in GMT, 60 in BST). */
export function londonOffsetMinutes(instant: Date): number {
  const parts = londonParts(instant);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

export function isBritishSummerTime(instant: Date): boolean {
  return londonOffsetMinutes(instant) === 60;
}

/** Local calendar date in Europe/London as YYYY-MM-DD. */
export function londonDateString(instant: Date): string {
  const p = londonParts(instant);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * The service date an instant belongs to. Journeys running after midnight but before
 * SERVICE_DAY_START_HOUR are part of the previous operating day, matching how timetables
 * express times such as 25:10.
 */
export function serviceDate(instant: Date): string {
  const parts = londonParts(instant);
  if (parts.hour >= SERVICE_DAY_START_HOUR) return londonDateString(instant);
  const previous = new Date(instant.getTime() - 24 * 3_600_000);
  return londonDateString(previous);
}

export type WeekdayType = "weekday" | "saturday" | "sunday_or_holiday";

/** England and Wales bank holidays. Extend from the official feed at ingest time. */
const KNOWN_HOLIDAYS = new Set<string>([
  "2026-01-01",
  "2026-04-03",
  "2026-04-06",
  "2026-05-04",
  "2026-05-25",
  "2026-08-31",
  "2026-12-25",
  "2026-12-28",
]);

export function weekdayType(
  instant: Date,
  holidays: ReadonlySet<string> = KNOWN_HOLIDAYS,
): WeekdayType {
  const date = serviceDate(instant);
  if (holidays.has(date)) return "sunday_or_holiday";
  const weekday = londonParts(instant).weekday;
  if (weekday === 0) return "sunday_or_holiday";
  if (weekday === 6) return "saturday";
  return "weekday";
}

/** Minute of the local day, used as a baseline dimension key. */
export function londonMinuteOfDay(instant: Date): number {
  const p = londonParts(instant);
  return p.hour * 60 + p.minute;
}

/** Start minute of the 15-minute baseline window containing this instant. */
export function baselineWindowStartMinute(instant: Date, windowMinutes = 15): number {
  return Math.floor(londonMinuteOfDay(instant) / windowMinutes) * windowMinutes;
}

/**
 * Resolve a timetable time-of-day (which may exceed 24:00) against a service date into a UTC
 * instant. DST-correct: it resolves through the Europe/London offset in effect at that moment,
 * so a 01:30 journey on a spring-forward morning lands on the correct instant.
 */
export function resolveScheduledInstant(serviceDateString: string, timeOfDay: string): Date {
  const match = timeOfDay.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error(`Invalid time of day: ${timeOfDay}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);

  const [year, month, day] = serviceDateString.split("-").map(Number) as [number, number, number];
  const dayOffset = Math.floor(hours / 24);
  const hourInDay = hours % 24;

  // First guess in UTC, then correct by the London offset actually in effect at that instant.
  const guess = Date.UTC(year, month - 1, day + dayOffset, hourInDay, minutes, seconds);
  const offsetAtGuess = londonOffsetMinutes(new Date(guess));
  const corrected = guess - offsetAtGuess * 60_000;
  // Re-check: near a DST boundary the offset at the corrected instant may differ.
  const offsetAtCorrected = londonOffsetMinutes(new Date(corrected));
  if (offsetAtCorrected !== offsetAtGuess) {
    return new Date(guess - offsetAtCorrected * 60_000);
  }
  return new Date(corrected);
}

export function ageSeconds(observedAt: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(observedAt).getTime()) / 1000);
}

/** Human countdown text for the arrival board. Never negative, never falsely precise. */
export function countdownLabel(expected: Date, now: Date): string {
  const seconds = (expected.getTime() - now.getTime()) / 1000;
  if (seconds <= 30) return "Due";
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "Due";
  if (minutes === 1) return "1 min";
  if (minutes > 90) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: DISPLAY_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(expected);
  }
  return `${minutes} mins`;
}

export function formatLondonTime(instant: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}

/** "Updated 12 seconds ago" style label, used wherever freshness must be visible. */
export function freshnessLabel(seconds: number): string {
  if (seconds < 15) return "just now";
  if (seconds < 60) return `${Math.round(seconds)} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}
