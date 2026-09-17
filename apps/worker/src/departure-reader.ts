import { objectKeyFor, type ObjectStore } from "@busstops/pipeline-core";
import {
  departureBucketFor,
  departureShardDataset,
  decodeDepartureShardForStop,
  type DepartureRow,
} from "@busstops/pipeline-static-network";

/**
 * The departures due at one stop, read from the published index.
 *
 * What this replaces read an entire half-degree journey tile — 294,922,754 bytes at its largest,
 * into a 128 MiB isolate — and filtered it down to one stop. It could not succeed, and the way it
 * failed was worse than the failure: the read threw, a `catch` returned an empty array, and every
 * stop in England answered `200` with no departures and a degradation of `normal`. A passenger
 * and a monitoring check saw the same thing as a stop with genuinely nothing due.
 *
 * So this reads one object per service date — the bucket its own stop's code hashes into — and
 * parses one line out of it, the line that stop's calls are grouped onto. A shard holds about
 * thirty thousand calls and a board reads about a hundred of them, without JSON.parse ever seeing
 * the rest.
 *
 * It also distinguishes three answers that were previously one:
 *
 *   - a shard that was never written, or that does not contain this stop, is nothing scheduled,
 *     which is ordinary and true at four in the morning and true all day at a stop out of use;
 *   - a shard that cannot be read or parsed is a failure, and is reported as one.
 *
 * The distinction is free because the object store already makes it: `get` resolves to null for
 * something that is not there and rejects when it cannot tell.
 */

/** A read that knows the difference between "nothing due" and "could not say". */
export interface DepartureReadResult {
  rows: DepartureRow[];
  /** Shards asked for, and how many of them answered. */
  shardsRead: number;
  shardsMissing: number;
  /**
   * Shards that failed, with the reason. Non-empty means the board is incomplete and must say so
   * rather than presenting what it managed to read as the whole truth.
   */
  failures: Array<{ dataset: string; reason: string }>;
}

interface CachedShard {
  text: string;
  usedAt: number;
}

/**
 * How long a shard is held, and how much of them.
 *
 * A published timetable does not change during a day, so the age limit is generous; the byte
 * budget is what actually bounds this. The text is cached rather than the parsed rows, because
 * the parse is now per-stop and two passengers at different stops in the same bucket share the
 * download but not the work. Both limits are far below the isolate's 128 MiB, because a request
 * needs room to work on top of whatever is resident.
 */
const TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_SHARDS = 4;
const MAX_CACHED_CHARS = 6 * 1024 * 1024;

export class DepartureReader {
  private readonly shards = new Map<string, CachedShard>();

  constructor(
    private readonly store: ObjectStore,
    private readonly ttlMs = TTL_MS,
  ) {}

  /**
   * Rows for this stop between two instants.
   *
   * The service dates are supplied by the caller because deciding which ones a board must
   * consider is a calendar question, not a storage one: a journey that began at 23:40 yesterday
   * and calls here at 00:20 is published under yesterday's service date.
   */
  async forStop(
    atcoCode: string,
    serviceDates: readonly string[],
    fromEpochSeconds: number,
    toEpochSeconds: number,
    /**
     * The publish these shards belong to, taken from the network index by the caller.
     *
     * Passed per call rather than held here, exactly as the other shard families do it: a publish
     * writes every shard and then the index last, so a version that is visible is complete and a
     * reader that picked one up mid-publish keeps serving the previous one consistently.
     */
    version: string,
    now: number = Date.now(),
  ): Promise<DepartureReadResult> {
    const bucket = departureBucketFor(atcoCode);
    const rows: DepartureRow[] = [];
    const failures: DepartureReadResult["failures"] = [];
    let shardsRead = 0;
    let shardsMissing = 0;

    for (const serviceDate of serviceDates) {
      const dataset = departureShardDataset(serviceDate, bucket);
      try {
        const text = await this.shard(dataset, version, now);
        if (text === null) {
          shardsMissing += 1;
          continue;
        }
        shardsRead += 1;
        for (const row of decodeDepartureShardForStop(text, atcoCode) ?? []) {
          if (row.t < fromEpochSeconds || row.t > toEpochSeconds) continue;
          rows.push(row);
        }
      } catch (error) {
        failures.push({
          dataset,
          reason: error instanceof Error ? `${error.name}: ${error.message}` : "unreadable",
        });
      }
    }

    rows.sort((a, b) => a.t - b.t);
    return { rows, shardsRead, shardsMissing, failures };
  }

  /** Null when the shard was never written; throws when it exists and cannot be used. */
  private async shard(dataset: string, version: string, now: number): Promise<string | null> {
    const key = `${version}:${dataset}`;
    const cached = this.shards.get(key);
    if (cached && now - cached.usedAt < this.ttlMs) {
      cached.usedAt = now;
      return cached.text;
    }

    // Deliberately not wrapped: a store that rejects is a failure the caller has to hear about,
    // and turning it into null here would recreate the exact bug this class exists to remove.
    const raw = await this.store.get(objectKeyFor(dataset, version));
    if (raw === null) return null;

    this.shards.delete(key);
    this.shards.set(key, { text: raw, usedAt: now });
    this.evict();
    return raw;
  }

  private evict(): void {
    for (const [key, shard] of [...this.shards]) {
      if (this.shards.size <= MAX_CACHED_SHARDS && this.cachedChars <= MAX_CACHED_CHARS) break;
      // Never the one just inserted: evicting it would make the cache a no-op under exactly the
      // pressure it exists for.
      if (this.shards.size === 1) break;
      this.shards.delete(key);
      void shard;
    }
  }

  /** How much text the resident shards hold. Exposed so a test can bound it. */
  get cachedChars(): number {
    let total = 0;
    for (const shard of this.shards.values()) total += shard.text.length;
    return total;
  }
}
