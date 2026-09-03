import type { Confidence, DeparturePrediction } from "@busstops/contracts";

/**
 * "Will I make it?" (docs/09_BUS_STOPS_LIVE.md).
 *
 * Compares walking time to the stop with the bus's arrival interval plus a boarding buffer.
 * The whole point is the interval: a single ETA would let the product say "you'll make it" when
 * the honest answer is "it may be tight". Walking time is computed from the device's own
 * position in the browser; no precise location is sent anywhere.
 */

export type Verdict = "should_make_it" | "tight" | "probably_miss";

export interface WillIMakeItInput {
  walkingSeconds: number;
  /** Earliest and latest plausible arrival of the bus, from the prediction's uncertainty. */
  arrivalLowSeconds: number;
  arrivalHighSeconds: number;
  /** Time needed at the stop before departure, e.g. to signal and board. */
  boardingBufferSeconds?: number;
  confidence: Confidence;
}

export interface WillIMakeItResult {
  verdict: Verdict;
  headline: string;
  detail: string;
  walkingSeconds: number;
  /** Spare time in the pessimistic case; negative means a deficit. */
  spareLowSeconds: number;
  spareHighSeconds: number;
  confidence: Confidence;
}

export const DEFAULT_BOARDING_BUFFER_SECONDS = 45;

export function willIMakeIt(input: WillIMakeItInput): WillIMakeItResult {
  const buffer = input.boardingBufferSeconds ?? DEFAULT_BOARDING_BUFFER_SECONDS;
  const needed = input.walkingSeconds + buffer;

  // Spare against the earliest the bus could arrive is the case that decides "tight".
  const spareLowSeconds = Math.round(input.arrivalLowSeconds - needed);
  const spareHighSeconds = Math.round(input.arrivalHighSeconds - needed);

  let verdict: Verdict;
  if (spareLowSeconds >= 60) verdict = "should_make_it";
  else if (spareHighSeconds >= 0) verdict = "tight";
  else verdict = "probably_miss";

  const walkMinutes = Math.max(1, Math.round(input.walkingSeconds / 60));
  const rangeLow = Math.max(0, Math.round(input.arrivalLowSeconds / 60));
  const rangeHigh = Math.max(rangeLow, Math.round(input.arrivalHighSeconds / 60));

  const headline = {
    should_make_it: "You should make it",
    tight: "It may be tight",
    probably_miss: "You'll probably miss this one",
  }[verdict];

  const rangeText =
    rangeLow === rangeHigh ? `about ${rangeLow} min` : `${rangeLow}–${rangeHigh} min`;

  const detail =
    verdict === "probably_miss"
      ? `A ${walkMinutes} minute walk, and the bus is expected in ${rangeText}. You would be about ${formatDeficit(spareHighSeconds)} short.`
      : `A ${walkMinutes} minute walk, and the bus is expected in ${rangeText}, leaving ${formatSpare(spareLowSeconds, spareHighSeconds)} to spare.`;

  return {
    verdict,
    headline,
    detail,
    walkingSeconds: input.walkingSeconds,
    spareLowSeconds,
    spareHighSeconds,
    confidence: input.confidence,
  };
}

function formatSpare(low: number, high: number): string {
  const lowMinutes = Math.max(0, Math.round(low / 60));
  const highMinutes = Math.max(0, Math.round(high / 60));
  if (lowMinutes === highMinutes) return `${lowMinutes} min`;
  return `${lowMinutes}–${highMinutes} min`;
}

function formatDeficit(seconds: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(seconds) / 60));
  return `${minutes} min`;
}

/** The next useful service after the one being assessed, so a miss still has an answer. */
export function nextUsefulService(
  departures: readonly DeparturePrediction[],
  afterDeparture: DeparturePrediction,
): DeparturePrediction | null {
  const afterTime = afterDeparture.expectedTime ?? afterDeparture.scheduledTime;
  if (!afterTime) return null;

  return (
    departures
      .filter((departure) => {
        if (departure.id === afterDeparture.id) return false;
        if (departure.liveState === "cancelled") return false;
        const time = departure.expectedTime ?? departure.scheduledTime;
        return time !== null && time > afterTime;
      })
      .sort((a, b) =>
        (a.expectedTime ?? a.scheduledTime ?? "").localeCompare(
          b.expectedTime ?? b.scheduledTime ?? "",
        ),
      )[0] ?? null
  );
}

/**
 * Arrival interval in seconds from now, derived from the prediction and its uncertainty.
 * Returns null when there is no time at all to reason about.
 */
export function arrivalIntervalSeconds(
  departure: DeparturePrediction,
  now: Date,
): { low: number; high: number } | null {
  const time = departure.expectedTime ?? departure.scheduledTime;
  if (!time) return null;

  const seconds = (new Date(time).getTime() - now.getTime()) / 1000;
  const uncertainty = departure.uncertaintySeconds ?? 60;

  return {
    low: Math.max(0, seconds - uncertainty),
    high: Math.max(0, seconds + uncertainty),
  };
}
