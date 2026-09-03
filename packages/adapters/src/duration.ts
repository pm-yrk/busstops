/**
 * ISO 8601 duration parsing. TransXChange expresses run and wait times as durations
 * ("PT3M", "PT1M30S", "PT0S"), and a mis-parsed run time silently shifts every downstream
 * stop time on a journey.
 */

const DURATION_PATTERN =
  /^(-)?P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

export function parseIso8601DurationSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const match = trimmed.match(DURATION_PATTERN);
  if (!match) return null;

  const [, sign, days, hours, minutes, seconds] = match;
  // "P" or "PT" alone carries no components and is not a valid duration.
  if (!days && !hours && !minutes && !seconds) return null;

  const total =
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);

  return sign === "-" ? -total : total;
}

/** Formats seconds as an ISO 8601 duration, used when re-emitting normalized schedules. */
export function formatIso8601Duration(totalSeconds: number): string {
  const negative = totalSeconds < 0;
  let remaining = Math.abs(Math.round(totalSeconds));
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining - minutes * 60;

  let output = "PT";
  if (hours > 0) output += `${hours}H`;
  if (minutes > 0) output += `${minutes}M`;
  if (seconds > 0 || output === "PT") output += `${seconds}S`;
  return negative ? `-${output}` : output;
}

/** Adds seconds to a HH:MM:SS time of day, allowing the result to pass 24:00. */
export function addSecondsToTimeOfDay(timeOfDay: string, seconds: number): string {
  const match = timeOfDay.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error(`Invalid time of day: ${timeOfDay}`);

  const total =
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0) + Math.round(seconds);
  if (total < 0) throw new Error(`Time of day underflow for ${timeOfDay} + ${seconds}s`);

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
