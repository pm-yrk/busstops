import type { ObjectStore } from "@busstops/pipeline-core";
import { DEPARTURES_PREFIX, PATTERN_TRIPS_PREFIX } from "./departures-index.js";

/**
 * Removing the days that have already happened.
 *
 * A refresh publishes new service dates at the version already serving traffic, which means the
 * dates it replaces are not replaced at all — they are simply joined. Each service date measures
 * about 1.27 GB across the two date-keyed families, and R2's free allowance is 10 GB for the whole
 * account, so an artifact that only ever gains dates spends the free tier on days that are over.
 *
 * Yesterday is kept deliberately. The board asks for yesterday, today and tomorrow, because a
 * journey that left at 23:50 is still running after midnight and is carried on the service date it
 * started. Pruning to today would take that bus off the board.
 */
export interface ServiceDatePrune {
  keysDeleted: number;
  datesDeleted: string[];
  /** Dated objects left behind by a version nothing serves any more. Counted separately because it is a different leak. */
  staleVersionKeysDeleted: number;
  failed: Array<{ key: string; reason: string }>;
}

const DATED_PREFIXES = [DEPARTURES_PREFIX, PATTERN_TRIPS_PREFIX];

/**
 * The dated keys that are now unreachable, given the earliest date still worth keeping.
 *
 * A pure function over the key list so the date arithmetic is testable without a store: deleting
 * the wrong set here is deleting England's timetable, so it is worth being able to prove.
 */
export function expiredDatedKeys(keys: readonly string[], keepFrom: string): string[] {
  const expired: string[] = [];
  for (const key of keys) {
    const date = serviceDateInKey(key);
    // A key whose shape this does not recognise is left alone. Deleting something because it could
    // not be parsed is the one outcome worse than keeping it.
    if (date !== null && date < keepFrom) expired.push(key);
  }
  return expired;
}

/** `data/network/departures/2026-10-01/125/<version>.jsonl` → `2026-10-01`. */
export function serviceDateInKey(key: string): string | null {
  for (const prefix of DATED_PREFIXES) {
    const marker = `data/${prefix}/`;
    if (!key.startsWith(marker)) continue;
    const date = key.slice(marker.length).split("/")[0] ?? "";
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  }
  return null;
}

/**
 * Dated objects written by a version that is no longer served.
 *
 * Dated shards are written as plain objects rather than published artifacts, precisely so a national
 * build does not pay for thousands of manifests — which also means `prune-versions`, which works from
 * manifests, has never been able to see them. So every full rebuild left a complete second copy of
 * every date behind it, at 1.27 GB a date.
 *
 * Two versions are kept: the one the index names and the one it names as its predecessor, which is
 * what a rollback restores. Deleting the predecessor's timetable would make a rollback produce an
 * artifact with a map and no departures.
 */
export function staleVersionDatedKeys(
  keys: readonly string[],
  keepVersions: readonly string[],
): string[] {
  const keep = new Set(keepVersions);
  return keys.filter((key) => {
    if (serviceDateInKey(key) === null) return false;
    const version = /\/([^/]+)\.jsonl$/.exec(key)?.[1];
    return version !== undefined && !keep.has(version);
  });
}

export async function pruneExpiredServiceDates(
  store: ObjectStore,
  options: { keepFrom: string; keepVersions?: readonly string[] },
): Promise<ServiceDatePrune> {
  const result: ServiceDatePrune = {
    keysDeleted: 0,
    datesDeleted: [],
    staleVersionKeysDeleted: 0,
    failed: [],
  };
  const dates = new Set<string>();

  for (const prefix of DATED_PREFIXES) {
    const keys = await store.list(`data/${prefix}/`);
    const expired = new Set(expiredDatedKeys(keys, options.keepFrom));
    const stale =
      options.keepVersions === undefined
        ? []
        : staleVersionDatedKeys(keys, options.keepVersions).filter((key) => !expired.has(key));
    for (const key of [...expired, ...stale]) {
      try {
        await store.delete(key);
        result.keysDeleted += 1;
        if (!expired.has(key)) result.staleVersionKeysDeleted += 1;
        const date = serviceDateInKey(key);
        if (date && expired.has(key)) dates.add(date);
      } catch (error) {
        // Reported, never thrown: a delete that fails costs storage, and losing the run over it
        // would cost the timetable the run was there to publish.
        result.failed.push({
          key,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  result.datesDeleted = [...dates].sort();
  return result;
}

/** Yesterday, in the UTC form the shard keys use. */
export function earliestServiceDateToKeep(startedAt: Date): string {
  return new Date(startedAt.getTime() - 86_400_000).toISOString().slice(0, 10);
}
