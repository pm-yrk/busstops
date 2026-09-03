/**
 * Display formatting. Mirrors the pipeline's time helpers so the browser and the server agree
 * on what "due", "3 mins" and "updated 2 minutes ago" mean.
 */

export const DISPLAY_TIMEZONE = "Europe/London";

export function formatLondonTime(instant: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}

export function formatLondonDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(instant);
}

/** Countdown text. Never negative, and never falsely precise beyond 90 minutes. */
export function countdownLabel(expected: Date, now: Date): string {
  const seconds = (expected.getTime() - now.getTime()) / 1000;
  if (seconds <= 30) return "Due";
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "Due";
  if (minutes === 1) return "1 min";
  if (minutes > 90) return formatLondonTime(expected);
  return `${minutes} mins`;
}

export function freshnessLabel(seconds: number): string {
  if (seconds < 15) return "just now";
  if (seconds < 60) return `${Math.round(seconds)} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

/** Delay phrasing that reads naturally and never says "-3 minutes late". */
export function delayLabel(delaySeconds: number | null): string {
  if (delaySeconds === null) return "Delay unknown";
  const minutes = Math.round(Math.abs(delaySeconds) / 60);
  if (minutes < 1) return "On time";
  if (delaySeconds > 0) return minutes === 1 ? "1 minute late" : `${minutes} minutes late`;
  return minutes === 1 ? "1 minute early" : `${minutes} minutes early`;
}

export function distanceLabel(metres: number): string {
  if (metres < 100) return `${Math.round(metres / 10) * 10} m`;
  if (metres < 1000) return `${Math.round(metres / 50) * 50} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Walking time at a deliberately unhurried 1.3 m/s, rounded up to whole minutes. */
export function walkingMinutes(metres: number, metresPerSecond = 1.3): number {
  return Math.max(1, Math.ceil(metres / metresPerSecond / 60));
}

export function percentLabel(fraction: number | null, digits = 0): string {
  if (fraction === null || Number.isNaN(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function minutesLabel(seconds: number | null): string {
  if (seconds === null) return "—";
  const minutes = seconds / 60;
  if (Math.abs(minutes) < 1) return `${Math.round(seconds)}s`;
  return `${minutes.toFixed(1)} min`;
}

export function confidenceLabel(level: "low" | "medium" | "high"): string {
  return { low: "Low confidence", medium: "Medium confidence", high: "High confidence" }[level];
}

/** Human sentence for a degradation state, used in the service banner. */
export function degradationMessage(status: string): string | null {
  switch (status) {
    case "partial_sources":
      return "Some live sources are unavailable, so coverage is incomplete right now.";
    case "stale_data":
      return "Live data is older than usual. Times shown may have moved on.";
    case "scheduled_only":
      return "Live tracking is unavailable, so timetabled times are shown instead.";
    case "safe_mode":
      return "The service is running in safe mode. Saved stops, timetables and maps still work.";
    default:
      return null;
  }
}
