/**
 * How many days of timetable a build publishes, and why that number is the whole bug.
 *
 * Departure shards are keyed `network/departures/<serviceDate>/<bucket>` and the planner's trips
 * `network/pattern-trips/<serviceDate>/<window>/<tile>`. Both are keyed by the day they describe,
 * so an artifact only answers for the days it was built for. The horizon was two — today and
 * tomorrow — which means an artifact is a complete, healthy, correctly-published national network
 * that stops being able to say what is due at any stop in England on its third day. The preview
 * had no scheduled refresh, so that is exactly what happened: boards went blank everywhere except
 * London, where TfL arrivals are live predictions rather than date-keyed shards.
 *
 * Widening it is the cheap half of the fix — a day of departures measured 2.45 GB of spill and 512
 * objects, so the cost is linear and small — and a scheduled refresh is the other half. Both are
 * needed: the schedule keeps the artifact current, and the horizon is the slack that lets a
 * refresh fail without a passenger seeing an empty board.
 */

/**
 * Days of timetable a build publishes, counting today. Four survives three consecutive failed
 * refreshes, which is the slack the preview needed and did not have.
 */
export const DEFAULT_SERVICE_DATE_HORIZON_DAYS = 4;

/**
 * The hard ceiling, which is the free tier rather than taste.
 *
 * Measured on the 30 September national build: 15.2M departure rows a day at about 70 encoded bytes
 * each is 1.06 GB, and 400k pattern trips at about 533 bytes is a further 0.21 GB — so every extra
 * service date costs roughly 1.27 GB of R2 against a free allowance of 10 GB for the whole account,
 * on top of the 2.0 GB the undated families occupy. Disk bites at about the same point: both spills
 * are written during the single GTFS pass and published afterwards, so peak disk is the whole
 * horizon at once, 2.7 GB a date beside a 1.4 GB archive on a runner with about 25 GB free.
 *
 * So the horizon is slack against a failed refresh, not a substitute for one. Eight days is the
 * point at which either limit is reached, and reaching either means publishing nothing.
 */
export const MAX_SERVICE_DATE_HORIZON_DAYS = 8;

const DAY_MS = 86_400_000;

/**
 * The service dates a build publishes for.
 *
 * UTC, matching what the edge asks for: `serviceDatesForBoard` spans yesterday, today and tomorrow
 * as UTC dates, so a horizon counted the same way lines up with the keys that will be read. A
 * contiguous range starting at today also absorbs the hour either side of midnight that a London
 * clock and a UTC clock disagree about, which a two-day horizon could not.
 *
 * `offsetDays` exists so a second pass can extend an artifact that already holds its first days
 * without re-publishing them — the one-off that takes a live artifact from two days to seven
 * without a rebuild.
 */
export function serviceDateHorizon(startedAt: Date, days: number, offsetDays = 0): string[] {
  const span = Math.max(1, Math.min(Math.trunc(days), MAX_SERVICE_DATE_HORIZON_DAYS));
  const from = Math.max(0, Math.trunc(offsetDays));
  const dates: string[] = [];
  for (let day = from; day < from + span; day += 1) {
    dates.push(new Date(startedAt.getTime() + day * DAY_MS).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * The horizon this run was configured for.
 *
 * Read from the environment rather than hard-coded so a run that is up against disk can be dialled
 * back without a deploy, and so the one-off extension pass can ask for a window further out. An
 * unparseable value falls back to the default rather than failing the build: a bad env var should
 * not cost England its timetable.
 */
export function serviceDateHorizonFromEnv(
  startedAt: Date,
  env: Record<string, string | undefined>,
): { serviceDates: string[]; days: number; offsetDays: number } {
  const days = integerOr(env.SERVICE_DATE_HORIZON_DAYS, DEFAULT_SERVICE_DATE_HORIZON_DAYS);
  const offsetDays = integerOr(env.SERVICE_DATE_OFFSET_DAYS, 0);
  return { serviceDates: serviceDateHorizon(startedAt, days, offsetDays), days, offsetDays };
}

function integerOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
