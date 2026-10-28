/**
 * Grouping trips into routes, over indices rather than over objects.
 *
 * `groupRoutes` takes built `Trip`s and is what the search and the oracle use. This takes the same
 * decision over arrays — a pattern key, a call count and the times — so that a publisher holding a
 * binary trip shard can compute the grouping without building a single object, and publish it.
 *
 * The two must agree exactly, and a test holds them to each other over the generated timetable
 * corpus. The rules are the same three:
 *
 *   1. Trips group by pattern and by the stop sequence they actually run. A shard's times are
 *      indexed by position in the pattern's sequence and the array is dense, so a trip with fewer
 *      times runs the pattern's first *n* stops — which makes "same sequence" exactly "same
 *      pattern and same call count", with no sequence to compare.
 *   2. Inside a group, trips are ordered by their first departure, with the trip id breaking ties.
 *      The order has to be total: the split below compares each trip against the last one admitted,
 *      so an order that depended on how the shard happened to be written would make which journey
 *      is found depend on it too.
 *   3. A group splits into routes no bus overtakes another on. Each trip joins the first route
 *      whose last admitted trip it is at or behind at every stop, and starts a new one when there
 *      is none — which is what lets the search board the earliest catchable trip and stop looking.
 */

export interface TripTimesSource {
  tripCount: number;
  /** Which pattern a trip is on, as a number. Trips on different patterns never group. */
  patternKeyOf: (trip: number) => number;
  /** How many calls a trip has. With the pattern, this is its stop sequence. */
  callCountOf: (trip: number) => number;
  /** The scheduled departure at one call. */
  departureOf: (trip: number, call: number) => number;
  /** The trip's own id, for the tie-break that makes the order total. */
  tripIdOf: (trip: number) => string;
}

export interface IndexedRouteGroup {
  patternKey: number;
  callCount: number;
  /** Trip indices, in the order the search will scan them. */
  trips: number[];
}

export function groupRouteIndices(source: TripTimesSource): IndexedRouteGroup[] {
  /* Keyed on the pattern and the call count, which together are the stop sequence. */
  const byKey = new Map<string, number[]>();
  for (let trip = 0; trip < source.tripCount; trip += 1) {
    const callCount = source.callCountOf(trip);
    /* A trip calling once cannot be ridden, and the search ignores it. */
    if (callCount < 2) continue;
    const key = `${String(source.patternKeyOf(trip))}:${String(callCount)}`;
    const existing = byKey.get(key);
    if (existing) existing.push(trip);
    else byKey.set(key, [trip]);
  }

  const groups: IndexedRouteGroup[] = [];
  for (const [key, trips] of byKey) {
    const [patternKey, callCount] = key.split(":").map(Number) as [number, number];
    const ordered = [...trips].sort((a, b) => {
      const byTime = source.departureOf(a, 0) - source.departureOf(b, 0);
      if (byTime !== 0) return byTime;
      const left = source.tripIdOf(a);
      const right = source.tripIdOf(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });

    const buckets: number[][] = [];
    for (const trip of ordered) {
      let placed = false;
      for (const bucket of buckets) {
        const last = bucket[bucket.length - 1]!;
        let behind = true;
        for (let call = 0; call < callCount; call += 1) {
          if (source.departureOf(trip, call) < source.departureOf(last, call)) {
            behind = false;
            break;
          }
        }
        if (behind) {
          bucket.push(trip);
          placed = true;
          break;
        }
      }
      if (!placed) buckets.push([trip]);
    }

    for (const bucket of buckets) groups.push({ patternKey, callCount, trips: bucket });
  }

  /*
   * A deterministic order for the artifact: by pattern, then by call count, then by the first
   * trip's departure and id. Two publishes of the same shard then produce the same bytes, and a
   * difference in an artifact is a difference in the timetable rather than in the sort.
   */
  groups.sort((a, b) => {
    if (a.patternKey !== b.patternKey) return a.patternKey - b.patternKey;
    if (a.callCount !== b.callCount) return a.callCount - b.callCount;
    const byTime = source.departureOf(a.trips[0]!, 0) - source.departureOf(b.trips[0]!, 0);
    if (byTime !== 0) return byTime;
    const left = source.tripIdOf(a.trips[0]!);
    const right = source.tripIdOf(b.trips[0]!);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return groups;
}
