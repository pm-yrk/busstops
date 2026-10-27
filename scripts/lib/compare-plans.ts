/**
 * Whether two planners answer the same journeys, query by query.
 *
 * A planner that fits ten milliseconds by finding worse journeys has not been made faster, it has
 * been made worse, and the difference is invisible in a CPU figure. So every candidate is held
 * against the deployed planner's own answers — `scripts/journey-corpus.ts` records those — and the
 * comparison is reported as the five numbers that distinguish the ways it can go wrong:
 *
 * | number | what a change in it means |
 * | ------ | ------------------------- |
 * | same best itinerary | the candidate recommends the identical ride, stop for stop |
 * | same fastest arrival | a different ride, arriving at the same time: usually fine |
 * | same fewest changes | the candidate did not buy speed with an extra change |
 * | journey lost | the baseline found a journey and the candidate found none: the worst outcome |
 * | materially worse | an answer more than five minutes later, or with more changes |
 *
 * They are deliberately separate. A candidate that is 95% identical and loses one journey in
 * twenty is not acceptable, and a single "agreement" percentage would hide it.
 *
 * Journeys found where the baseline found none are reported too, as `journeysGained`. They are not
 * failures, and counting them as agreement would let a candidate look good by answering a
 * different question.
 *
 * The comparison is here rather than in the script so it can be tested against cases built by
 * hand: a lost journey, a slower arrival, an extra change, a tie.
 */

/** Later than this, and later counts as materially worse rather than as noise. */
export const MATERIALLY_LATER_SECONDS = 5 * 60;

export interface Ride {
  routeId: string | null;
  fromStopId: string | null;
  toStopId: string | null;
  departureSeconds: number;
  arrivalSeconds: number;
}

export interface Option {
  arrivalSeconds: number;
  changeCount: number;
  rides: Ride[];
}

export interface Entry {
  query: string;
  outcome?: string;
  options?: Option[];
}

export interface Corpus {
  version?: string;
  serviceDate?: string;
  entries: Entry[];
}

export interface Comparison {
  queries: number;
  comparable: number;
  sameBestItinerary: string;
  sameFastestArrival: string;
  sameFewestChanges: string;
  journeyLost: string;
  materiallyWorse: string;
  journeysGained: number;
  /** Every disagreement, named, because a percentage cannot be acted on. */
  disagreements: Array<Record<string, unknown>>;
  /** True when a journey was lost or an answer was materially worse. */
  failed: boolean;
}

/** The option a passenger is shown first. */
function best(entry: Entry | undefined): Option | null {
  return entry?.options?.[0] ?? null;
}

function sameRide(a: Ride, b: Ride): boolean {
  return (
    a.routeId === b.routeId &&
    a.fromStopId === b.fromStopId &&
    a.toStopId === b.toStopId &&
    a.departureSeconds === b.departureSeconds &&
    a.arrivalSeconds === b.arrivalSeconds
  );
}

/**
 * The same journey: the same rides, and the same answer about when it arrives.
 *
 * The rides alone were nearly enough — two identical ride lists that disagree about the arrival
 * are contradictory data rather than two journeys — but "nearly enough" is the wrong standard for
 * the one check that stops a worse planner shipping. A candidate whose rides match and whose
 * arrival does not has either a different reliability adjustment or a bug, and both are things to
 * look at rather than to count as identical.
 */
function sameItinerary(a: Option, b: Option): boolean {
  if (a.arrivalSeconds !== b.arrivalSeconds || a.changeCount !== b.changeCount) return false;
  return (
    a.rides.length === b.rides.length && a.rides.every((ride, at) => sameRide(ride, b.rides[at]!))
  );
}

function earliestArrival(entry: Entry | undefined): number | null {
  const options = entry?.options ?? [];
  if (options.length === 0) return null;
  return Math.min(...options.map((option) => option.arrivalSeconds));
}

function fewestChanges(entry: Entry | undefined): number | null {
  const options = entry?.options ?? [];
  if (options.length === 0) return null;
  return Math.min(...options.map((option) => option.changeCount));
}

export function comparePlans(baseline: Corpus, candidate: Corpus): Comparison {
  const candidateByQuery = new Map(candidate.entries.map((entry) => [entry.query, entry]));

  /*
   * Only the queries the baseline could answer are the denominator for the agreement numbers.
   * A query nothing can answer says nothing about the candidate, and including it would inflate
   * every percentage by the same amount.
   */
  const comparable = baseline.entries.filter((entry) => (entry.options?.length ?? 0) > 0);

  let sameBest = 0;
  let sameFastest = 0;
  let sameFewestChanges = 0;
  let lost = 0;
  let worse = 0;
  let gained = 0;
  const disagreements: Array<Record<string, unknown>> = [];

  for (const entry of baseline.entries) {
    const mine = candidateByQuery.get(entry.query);
    const baselineBest = best(entry);
    const candidateBest = best(mine);

    if (baselineBest === null) {
      if (candidateBest !== null) gained += 1;
      continue;
    }

    if (candidateBest === null) {
      lost += 1;
      disagreements.push({ query: entry.query, verdict: "journey lost" });
      continue;
    }

    if (sameItinerary(baselineBest, candidateBest)) sameBest += 1;
    if (earliestArrival(entry) === earliestArrival(mine)) sameFastest += 1;
    if (fewestChanges(entry) === fewestChanges(mine)) sameFewestChanges += 1;

    const later = candidateBest.arrivalSeconds - baselineBest.arrivalSeconds;
    const extraChanges = candidateBest.changeCount - baselineBest.changeCount;
    if (later > MATERIALLY_LATER_SECONDS || extraChanges > 0) {
      worse += 1;
      disagreements.push({
        query: entry.query,
        verdict: "materially worse",
        laterSeconds: later,
        extraChanges,
      });
    }
  }

  const share = (count: number): string =>
    comparable.length === 0 ? "n/a" : `${((count / comparable.length) * 100).toFixed(1)}%`;

  return {
    queries: baseline.entries.length,
    comparable: comparable.length,
    sameBestItinerary: share(sameBest),
    sameFastestArrival: share(sameFastest),
    sameFewestChanges: share(sameFewestChanges),
    journeyLost: share(lost),
    materiallyWorse: share(worse),
    journeysGained: gained,
    disagreements,
    failed: lost > 0 || worse > 0,
  };
}
