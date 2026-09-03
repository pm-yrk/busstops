import { median, quantile, trimmedMean } from "@busstops/analytics";
import { toIso } from "@busstops/pipeline-core";
import type { SegmentSample } from "./segments.js";

/**
 * Interval aggregation with a bounded late-observation window
 * (docs/07_DATA_PIPELINES.md: "Late observations can revise an open bucket within a defined
 * window; closed artifacts are versioned").
 *
 * Live feeds deliver out of order and late. A bucket therefore stays open for a defined grace
 * period after its end, during which a late observation revises it in place. Once closed, it is
 * immutable: a late arrival then produces a new version of the artifact rather than silently
 * mutating a figure that has already been published, so a number someone read yesterday can still
 * be explained today.
 */

export const AGGREGATION_DEFAULTS = {
  bucketSeconds: 300,
  /** How long after a bucket ends it stays open to revision in place. */
  latenessGraceSeconds: 600,
  /**
   * How far back an observation may still be aggregated at all. Past the grace window a closed
   * bucket is revised as a new version rather than mutated; past this horizon the observation is
   * dropped, because re-opening a window from days ago would rewrite figures nobody can still
   * reconcile — and the raw data behind it has expired anyway.
   */
  maximumRevisionAgeSeconds: 24 * 3600,
  /** Below this, the bucket publishes counts only — no headline speed or delay figure. */
  minimumSamples: 5,
} as const;

export type BucketState = "open" | "closed";

export interface SegmentIntervalBucket {
  segmentId: string;
  intervalStart: string;
  intervalEnd: string;
  state: BucketState;
  /** Increments whenever a closed bucket is superseded by a revision. */
  version: number;
  sampleCount: number;
  distinctVehicles: number;
  distinctRoutes: number;
  medianTraversalSeconds: number | null;
  p90TraversalSeconds: number | null;
  robustSpeedMetresPerSecond: number | null;
  meanMatchConfidence: number;
  /** True when the sample count is below the publication minimum. */
  suppressed: boolean;
  lateArrivals: number;
}

export function bucketStartFor(instant: string, bucketSeconds: number): number {
  const ms = new Date(instant).getTime();
  return Math.floor(ms / (bucketSeconds * 1000)) * bucketSeconds * 1000;
}

export interface AggregationOptions {
  bucketSeconds?: number;
  latenessGraceSeconds?: number;
  maximumRevisionAgeSeconds?: number;
  minimumSamples?: number;
  /** Buckets already published, keyed by `segmentId|intervalStart`, for revision accounting. */
  existing?: ReadonlyMap<string, SegmentIntervalBucket>;
}

export interface AggregationResult {
  buckets: SegmentIntervalBucket[];
  /** Closed buckets that a late observation revised, which must be republished as new versions. */
  revised: SegmentIntervalBucket[];
  /** Observations too late even to revise a closed bucket. Counted, never silently dropped. */
  droppedTooLate: number;
  suppressedBuckets: number;
}

export function bucketKey(segmentId: string, intervalStart: string): string {
  return `${segmentId}|${intervalStart}`;
}

export function aggregateSegmentSamples(
  samples: readonly SegmentSample[],
  now: Date,
  options: AggregationOptions = {},
): AggregationResult {
  const bucketSeconds = options.bucketSeconds ?? AGGREGATION_DEFAULTS.bucketSeconds;
  const grace = options.latenessGraceSeconds ?? AGGREGATION_DEFAULTS.latenessGraceSeconds;
  const maximumRevisionAge =
    options.maximumRevisionAgeSeconds ?? AGGREGATION_DEFAULTS.maximumRevisionAgeSeconds;
  const minimumSamples = options.minimumSamples ?? AGGREGATION_DEFAULTS.minimumSamples;
  const existing = options.existing ?? new Map<string, SegmentIntervalBucket>();

  const grouped = new Map<string, SegmentSample[]>();
  let droppedTooLate = 0;

  for (const sample of samples) {
    const startMs = bucketStartFor(sample.exitedAt, bucketSeconds);
    const endMs = startMs + bucketSeconds * 1000;

    // Beyond the revision horizon the observation is no longer aggregated at all. Inside it, a
    // bucket is either still open (revised in place) or already closed (republished as a new
    // version) — and a window being aggregated for the first time is perfectly normal, since a
    // batch run always processes a period that has already ended.
    if (now.getTime() > endMs + maximumRevisionAge * 1000) {
      droppedTooLate += 1;
      continue;
    }

    const key = bucketKey(sample.segmentId, toIso(new Date(startMs)));
    const group = grouped.get(key);
    if (group) group.push(sample);
    else grouped.set(key, [sample]);
  }

  const buckets: SegmentIntervalBucket[] = [];
  const revised: SegmentIntervalBucket[] = [];
  let suppressedBuckets = 0;

  for (const [key, group] of grouped) {
    const first = group[0]!;
    const startMs = bucketStartFor(first.exitedAt, bucketSeconds);
    const endMs = startMs + bucketSeconds * 1000;
    const closed = now.getTime() > endMs + grace * 1000;

    const traversals = group.map((sample) => sample.traversalSeconds);
    const speeds = group.map((sample) => sample.meanSpeedMetresPerSecond);
    const suppressed = group.length < minimumSamples;
    if (suppressed) suppressedBuckets += 1;

    const previous = existing.get(key);
    const lateArrivals = previous ? Math.max(0, group.length - previous.sampleCount) : 0;
    // Only a bucket that was already published closed and has grown is a revision; a bucket
    // seen for the first time is simply new, however old the window it covers.
    const isRevision = previous?.state === "closed" && lateArrivals > 0;

    const bucket: SegmentIntervalBucket = {
      segmentId: first.segmentId,
      intervalStart: toIso(new Date(startMs)),
      intervalEnd: toIso(new Date(endMs)),
      state: closed ? "closed" : "open",
      version: isRevision ? previous.version + 1 : (previous?.version ?? 1),
      sampleCount: group.length,
      distinctVehicles: new Set(group.map((sample) => sample.vehicleRef)).size,
      distinctRoutes: new Set(group.map((sample) => sample.routeId).filter(Boolean)).size,
      // Suppressed buckets carry their counts but no headline figure, so a thin bucket can never
      // be quoted as if it measured something.
      medianTraversalSeconds: suppressed ? null : median(traversals),
      p90TraversalSeconds: suppressed ? null : quantile(traversals, 0.9),
      robustSpeedMetresPerSecond: suppressed ? null : trimmedMean(speeds, 0.1),
      meanMatchConfidence:
        group.reduce((total, sample) => total + sample.matchConfidence, 0) / group.length,
      suppressed,
      lateArrivals,
    };

    buckets.push(bucket);
    if (isRevision) revised.push(bucket);
  }

  buckets.sort(
    (a, b) =>
      a.segmentId.localeCompare(b.segmentId) || a.intervalStart.localeCompare(b.intervalStart),
  );

  return { buckets, revised, droppedTooLate, suppressedBuckets };
}
