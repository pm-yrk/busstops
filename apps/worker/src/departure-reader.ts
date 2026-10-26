import { canStream, objectKeyFor, type ObjectStore } from "@busstops/pipeline-core";
import {
  departureBucketFor,
  departureShardDataset,
  departureShardHeader,
  departureStopLinePrefix,
  decodeDepartureShardForStop,
  expandDepartureStopLine,
  type DepartureRow,
  type DepartureShardHeader,
} from "@busstops/pipeline-static-network";
import { streamLines } from "./stream-lines.js";

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

/**
 * One stop's rows out of one shard, which is all a board ever wanted from it.
 *
 * This held the shard's **text** — two to four megabytes — so that two passengers at different
 * stops in the same bucket would share the download. The deployed peak walk showed what that
 * costs: a journey died at its pattern read reporting `departureCharsResident=4441456`, four and
 * a quarter mebibytes of somebody else's departures held in the isolate before the request that
 * died had begun. Cloudflare's 128 MB ceiling is per isolate rather than per invocation, so text
 * held for a hypothetical next passenger is charged against every request that follows.
 *
 * So what is kept is the answer rather than the material: about a hundred rows for the stop that
 * asked, a few kilobytes. It keeps the case the cache was written for — a passenger refreshing a
 * board, which is the only repeat this ever actually saw — and gives up the case it was guessing
 * at, which was a second passenger at a different stop in the same hashed bucket.
 */
interface CachedStopRows {
  rows: DepartureRow[];
  usedAt: number;
}

/**
 * How long an answer is held, and how many.
 *
 * A published timetable does not change during a day, so the age limit is generous. The count is
 * what bounds this, and it is a count of *boards* now rather than of shards: sixteen stops'
 * worth of rows is tens of kilobytes where one shard's text was two to four megabytes, so the
 * limit that used to be "one, or the next request starts worse off than a cold one" can be
 * generous enough to cover a passenger moving between the stops around them.
 */
const TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_BOARDS = 16;
/**
 * And a bound on the rows themselves, because sixteen boards is not a size.
 *
 * A board is about a hundred rows, so sixteen of them is sixteen hundred — but a count of entries
 * says nothing about an entry at a terminus where every service in a city lays over. Eight
 * thousand rows is about 1.6 MB by the estimate in `cachedChars`, which is comfortably less than
 * the single shard's text this cache used to hold, and it is the figure that cannot be made large
 * by an unusual stop.
 */
const MAX_CACHED_ROWS = 8_000;

export class DepartureReader {
  private readonly boards = new Map<string, CachedStopRows>();

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
        const stopRows = await this.rowsForStop(dataset, version, atcoCode, now);
        if (stopRows === null) {
          shardsMissing += 1;
          continue;
        }
        shardsRead += 1;
        for (const row of stopRows) {
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

  /**
   * One stop's rows out of one shard. Null when the shard was never written; throws when it
   * exists and cannot be used.
   *
   * An empty array is a third answer and a real one: the shard is there and this stop is not in
   * it, which is the truth about a stop with nothing scheduled on that date. The board counts it
   * as read, because it was.
   */
  private async rowsForStop(
    dataset: string,
    version: string,
    atcoCode: string,
    now: number,
  ): Promise<DepartureRow[] | null> {
    const key = `${version}:${dataset}:${atcoCode}`;
    const cached = this.boards.get(key);
    if (cached && now - cached.usedAt < this.ttlMs) {
      cached.usedAt = now;
      return cached.rows;
    }

    const objectKey = objectKeyFor(dataset, version);
    let rows: DepartureRow[] | null;

    if (canStream(this.store)) {
      /*
       * Two lines out of about thirty thousand: the header, and this stop's own.
       *
       * Deliberately not wrapped: a store that rejects is a failure the caller has to hear about,
       * and turning it into null here would recreate the exact bug this class exists to remove —
       * every stop in England answering 200 with no departures and a degradation of `normal`.
       */
      const body = await this.store.getStream(objectKey);
      if (body === null) return null;

      const prefix = departureStopLinePrefix(atcoCode);
      let header: DepartureShardHeader | null = null;
      let line: string | null = null;

      /*
       * `streamLines` rather than the filtered reader above it, because this read wants one line
       * as *text* and then expands it with the header. The filtered reader would `JSON.parse` the
       * line as a generic row first and this would parse it again to expand it — one parse of the
       * largest line in the object, done twice, which is the cost this whole exercise is about.
       */
      await streamLines(
        body,
        (buffer, start, end, index) => {
          if (index === 0) {
            header = departureShardHeader(buffer.slice(start, end));
            return;
          }
          if (!buffer.startsWith(prefix, start) || start + prefix.length > end) return;
          line = buffer.slice(start, end);
          /*
           * Found, and a shard is written in stop-code order, so everything after this line is
           * some other stop's. Stopping cancels the body: the characters past this point are
           * never decoded at all, which on a dense bucket is most of the object.
           */
          return "stop";
        },
        { key: objectKey },
      );

      /*
       * A shard with no header is not a shard. Reported as a failure rather than as an empty
       * board, because a board that cannot read its timetable and says "nothing due" is the one
       * wrong answer this file exists to have stopped giving.
       */
      if (header === null) {
        throw new Error(`departure shard ${dataset} has no header line`);
      }
      rows = line === null ? [] : expandDepartureStopLine(header, atcoCode, line);
    } else {
      /* A store that cannot stream: the same read it always was. */
      const raw = await this.store.get(objectKey);
      if (raw === null) return null;
      rows = decodeDepartureShardForStop(raw, atcoCode) ?? [];
    }

    this.boards.delete(key);
    this.boards.set(key, { rows, usedAt: now });
    this.evict();
    return rows;
  }

  /** Oldest first, until both bounds fit. Never the entry just inserted. */
  private evict(): void {
    for (const key of [...this.boards.keys()].slice(0, -1)) {
      if (this.boards.size <= MAX_CACHED_BOARDS && this.cachedRows <= MAX_CACHED_ROWS) break;
      this.boards.delete(key);
    }
  }

  /** Rows held across every resident board. */
  get cachedRows(): number {
    let rows = 0;
    for (const board of this.boards.values()) rows += board.rows.length;
    return rows;
  }

  /** How many boards are resident, for the breadcrumb that used to report none of them. */
  get cachedShardCount(): number {
    return this.boards.size;
  }

  /**
   * How much the resident boards hold, in characters, as an estimate from their row count.
   *
   * It used to be exact, because what was held was text. What is held now is rows, and the figure
   * the isolate residency wants is still a size — so this states a row's own footprint rather
   * than measuring a string that no longer exists. About two hundred characters a row: a stop
   * code, a time, a route name, a destination, a trip id and a pattern id.
   */
  get cachedChars(): number {
    return this.cachedRows * 200;
  }
}
