/**
 * Where a bus has just been, stored so that one tap costs one small read.
 *
 * ## The problem this solves
 *
 * The collector already publishes every observation it accepts, as `intelligence/observations` —
 * one artifact holding the whole national rolling window, between thirteen and thirty-nine
 * thousand records on the runs measured. Answering "where has this one bus been" from that means
 * reading and parsing all of it, which is several megabytes inside a 10ms CPU budget. It is
 * exactly the national read a bus tap must not cost.
 *
 * ## The design, and the numbers it was chosen on
 *
 * One object per vehicle was measured and rejected: roughly 6,500 distinct vehicles per run and
 * four collection runs a day is about 26,000 writes a day, against an R2 Class A allowance of a
 * million a month — around 33,000 a day — for every write this project makes. Spending three
 * quarters of it on a decoration is not a trade worth making.
 *
 * So the traces are bucketed by a hash of the rotating reference, into a fixed, small number of
 * objects at fixed keys:
 *
 *     recent-traces/<bucket>.jsonl
 *
 *   - 64 buckets, so a run writes 64 objects however many buses it saw: ~256 writes a day, under
 *     one per cent of the allowance.
 *   - ~8 KB a bucket at the observed volumes, so the Worker's read and parse is small and bounded
 *     by the bucket count rather than by the size of the country.
 *   - Fixed keys, overwritten each run, so there are 64 objects in total forever: no versions, no
 *     manifest to look up first, no pruning to schedule, and no growth to monitor.
 *   - The reference is the salted, daily-rotating one the collector and the Worker already share,
 *     so no new vehicle identity is created and yesterday's bucket cannot be read with today's
 *     reference.
 *
 * ## Why the generation stamp
 *
 * A fixed key cannot expire by itself, and this project's schedules are delivered roughly four
 * times a day rather than on their stated cadence. A bucket can therefore be five hours old, and a
 * five-hour-old "recent path" is not recent — it is a trail across a city the bus left long ago.
 * Each bucket carries when it was written, and the reader discards the whole thing when it is too
 * old. Expiry is a property of reading rather than of a cleanup job that may not run.
 */

/**
 * Sixty-four, from the arithmetic above: few enough that a run's writes are negligible, many
 * enough that one bucket is a few kilobytes rather than half a megabyte.
 */
export const RECENT_TRACE_BUCKETS = 64;

/** Roughly half an hour, which is the outer edge of "where has this bus just come from". */
export const RECENT_TRACE_MAX_AGE_SECONDS = 30 * 60;

/**
 * Points kept per vehicle.
 *
 * A collection run takes three snapshots two minutes apart, so a vehicle contributes two or three
 * points per run and this is never reached in practice. It is a ceiling against a feed that
 * reports far more often than expected, so one unusual vehicle cannot inflate a bucket.
 */
export const RECENT_TRACE_MAX_POINTS = 12;

export function recentTraceKey(bucket: number): string {
  return `recent-traces/${bucket}.jsonl`;
}

/**
 * Which bucket a reference belongs to.
 *
 * FNV-1a, because it needs to be stable, cheap, and identical in the pipeline and in the Worker —
 * not cryptographic. The reference is already a salted digest, so this is only spreading values
 * that are uniform to begin with.
 */
export function recentTraceBucket(vehicleRef: string, buckets = RECENT_TRACE_BUCKETS): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < vehicleRef.length; i += 1) {
    hash ^= vehicleRef.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % buckets;
}

/** One point: seconds since the epoch, latitude, longitude. Tuples, because this is 64 objects. */
export type RecentTracePoint = [number, number, number];

export interface RecentTraceRecord {
  /** The salted, daily-rotating reference. Never the operator's own vehicle identifier. */
  r: string;
  /** Oldest first. */
  p: RecentTracePoint[];
}

/** The first line of a bucket: when this bucket was written, so a reader can reject it wholesale. */
export interface RecentTraceHeader {
  generatedAt: string;
}

export function encodeRecentTraceBucket(
  generatedAt: Date,
  records: readonly RecentTraceRecord[],
): string {
  const header: RecentTraceHeader = { generatedAt: generatedAt.toISOString() };
  return [JSON.stringify(header), ...records.map((record) => JSON.stringify(record))].join("\n");
}

export interface DecodedRecentTrace {
  points: RecentTracePoint[];
  /** When the bucket holding this was written. */
  generatedAt: Date | null;
}

/**
 * One vehicle's points out of a bucket, or nothing.
 *
 * Scans lines rather than building a map of the whole bucket: the caller wants one reference, and
 * materialising several hundred records to answer for one of them is work nobody asked for inside
 * a 10ms budget. A malformed line is skipped rather than thrown on — a bucket is a decoration, and
 * losing a trail is not worth failing a bus lookup over.
 */
export function decodeRecentTrace(
  body: string,
  vehicleRef: string,
  now: Date,
  maxAgeSeconds = RECENT_TRACE_MAX_AGE_SECONDS,
): DecodedRecentTrace {
  const lines = body.split("\n");
  if (lines.length === 0) return { points: [], generatedAt: null };

  let generatedAt: Date | null = null;
  try {
    const header = JSON.parse(lines[0]!) as Partial<RecentTraceHeader>;
    if (typeof header.generatedAt === "string") {
      const parsed = new Date(header.generatedAt);
      if (!Number.isNaN(parsed.getTime())) generatedAt = parsed;
    }
  } catch {
    // A bucket with no readable header is treated as having no usable age, and rejected below.
  }

  /*
   * The whole bucket, discarded on age.
   *
   * Cheaper than filtering every point, and more honest: if the run that wrote this was hours ago
   * then nothing in it describes where any bus has just been.
   */
  if (generatedAt === null) return { points: [], generatedAt: null };
  const bucketAgeSeconds = (now.getTime() - generatedAt.getTime()) / 1000;
  if (bucketAgeSeconds > maxAgeSeconds) return { points: [], generatedAt };

  const needle = `"r":"${vehicleRef}"`;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    // A substring test before parsing: one JSON.parse for the match rather than one per record.
    if (!line.includes(needle)) continue;
    try {
      const record = JSON.parse(line) as Partial<RecentTraceRecord>;
      if (record.r !== vehicleRef || !Array.isArray(record.p)) continue;
      const points = record.p
        .filter(
          (point): point is RecentTracePoint =>
            Array.isArray(point) &&
            point.length === 3 &&
            point.every((value) => typeof value === "number" && Number.isFinite(value)),
        )
        /* Per-point age as well, so a bucket written recently cannot carry an ancient point. */
        .filter((point) => now.getTime() / 1000 - point[0] <= maxAgeSeconds)
        .sort((a, b) => a[0] - b[0]);
      return { points: points.slice(-RECENT_TRACE_MAX_POINTS), generatedAt };
    } catch {
      continue;
    }
  }

  return { points: [], generatedAt };
}

/**
 * Observations grouped into the bucket files they belong in.
 *
 * Takes the flat list the collector already has and returns the objects to write, so the pipeline
 * does not have to know the key scheme and the Worker does not have to know the grouping.
 */
export function buildRecentTraceBuckets(
  observations: readonly { vehicleRef: string; observedAt: string; lat: number; lon: number }[],
  generatedAt: Date,
  buckets = RECENT_TRACE_BUCKETS,
): Map<string, string> {
  const byRef = new Map<string, RecentTracePoint[]>();

  for (const observation of observations) {
    const seconds = Math.round(new Date(observation.observedAt).getTime() / 1000);
    if (!Number.isFinite(seconds)) continue;
    if (!Number.isFinite(observation.lat) || !Number.isFinite(observation.lon)) continue;
    const existing = byRef.get(observation.vehicleRef);
    const point: RecentTracePoint = [
      seconds,
      // Six decimals is about 10cm, which is far finer than a bus position is known to.
      Number(observation.lat.toFixed(6)),
      Number(observation.lon.toFixed(6)),
    ];
    if (existing) existing.push(point);
    else byRef.set(observation.vehicleRef, [point]);
  }

  const byBucket = new Map<number, RecentTraceRecord[]>();
  for (const [vehicleRef, points] of byRef) {
    const ordered = points.sort((a, b) => a[0] - b[0]).slice(-RECENT_TRACE_MAX_POINTS);
    /* One point is a position, not a path, so it is not worth a line in a bucket. */
    if (ordered.length < 2) continue;
    const bucket = recentTraceBucket(vehicleRef, buckets);
    const existing = byBucket.get(bucket);
    if (existing) existing.push({ r: vehicleRef, p: ordered });
    else byBucket.set(bucket, [{ r: vehicleRef, p: ordered }]);
  }

  /*
   * Every bucket is written, including the empty ones.
   *
   * A bucket nobody wrote this run keeps the previous run's contents at its fixed key, and the
   * reader would serve them as current until its stamp aged out. Writing an empty bucket with a
   * fresh stamp is the cheapest correct answer: 64 small objects a run either way.
   */
  const files = new Map<string, string>();
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    files.set(
      recentTraceKey(bucket),
      encodeRecentTraceBucket(generatedAt, byBucket.get(bucket) ?? []),
    );
  }
  return files;
}
