import { median, quantile } from "@busstops/analytics";
import {
  RETENTION_CLASSES,
  evaluateExpiry,
  getRetentionClass,
  toIso,
} from "@busstops/pipeline-core";
import type { SegmentIntervalBucket } from "./aggregates.js";

/**
 * Roll-up and pruning (docs/06_DATA_MODEL.md "Retention classes",
 * docs/07_DATA_PIPELINES.md "Storage discipline").
 *
 * The order matters and is enforced here: derive the coarser aggregate first, then delete the
 * finer one. Pruning before rolling up would destroy the only copy of information nobody can
 * re-fetch, because the upstream feeds do not serve history. Raw expiry runs regardless — it
 * outranks every optional analytics workload, including this one.
 */

export interface RollupResult {
  buckets: SegmentIntervalBucket[];
  sourceBucketsConsumed: number;
  /** Fine buckets that could not be rolled up and so must not be pruned yet. */
  blocked: number;
  notes: string[];
}

/**
 * Combines fine-grained buckets into coarser ones. Quantiles are recomputed from the underlying
 * bucket medians rather than averaged: averaging medians of unequal sample sizes would weight a
 * bucket with three samples the same as one with three hundred.
 */
export function rollUpBuckets(
  buckets: readonly SegmentIntervalBucket[],
  targetBucketSeconds: number,
  now: Date,
): RollupResult {
  const notes: string[] = [];
  const grouped = new Map<string, SegmentIntervalBucket[]>();
  let blocked = 0;

  for (const bucket of buckets) {
    // Only settled buckets may be rolled up: an open one is still being revised.
    if (bucket.state !== "closed") {
      blocked += 1;
      continue;
    }
    const startMs = new Date(bucket.intervalStart).getTime();
    const coarseStart =
      Math.floor(startMs / (targetBucketSeconds * 1000)) * targetBucketSeconds * 1000;
    const key = `${bucket.segmentId}|${coarseStart}`;
    const group = grouped.get(key);
    if (group) group.push(bucket);
    else grouped.set(key, [bucket]);
  }

  if (blocked > 0) {
    notes.push(`${blocked} buckets are still open and were not rolled up or pruned`);
  }

  const rolled: SegmentIntervalBucket[] = [];
  for (const [key, group] of grouped) {
    const first = group[0]!;
    const coarseStart = Number(key.split("|")[1]);
    const sampleCount = group.reduce((total, bucket) => total + bucket.sampleCount, 0);

    // Weight each contributing median by its sample count so large buckets dominate correctly.
    const weighted: number[] = [];
    for (const bucket of group) {
      if (bucket.medianTraversalSeconds === null) continue;
      for (let i = 0; i < bucket.sampleCount; i += 1) weighted.push(bucket.medianTraversalSeconds);
    }

    rolled.push({
      segmentId: first.segmentId,
      intervalStart: toIso(new Date(coarseStart)),
      intervalEnd: toIso(new Date(coarseStart + targetBucketSeconds * 1000)),
      state: "closed",
      version: 1,
      sampleCount,
      distinctVehicles: group.reduce((total, bucket) => total + bucket.distinctVehicles, 0),
      distinctRoutes: Math.max(...group.map((bucket) => bucket.distinctRoutes)),
      medianTraversalSeconds: weighted.length > 0 ? median(weighted) : null,
      p90TraversalSeconds: weighted.length > 0 ? quantile(weighted, 0.9) : null,
      robustSpeedMetresPerSecond: averageOrNull(
        group.map((bucket) => bucket.robustSpeedMetresPerSecond),
      ),
      meanMatchConfidence:
        group.reduce(
          (total, bucket) => total + bucket.meanMatchConfidence * bucket.sampleCount,
          0,
        ) / Math.max(1, sampleCount),
      suppressed: sampleCount === 0,
      lateArrivals: group.reduce((total, bucket) => total + bucket.lateArrivals, 0),
    });
  }

  void now;
  return { buckets: rolled, sourceBucketsConsumed: buckets.length - blocked, blocked, notes };
}

function averageOrNull(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

export interface PruneCandidate {
  key: string;
  retentionClassKey: string;
  timestamp: string;
  approximateBytes: number;
}

export interface PrunePlan {
  /** Records to delete now, in the mandated order. */
  deletions: PruneCandidate[];
  /** Records that are expired but whose roll-up has not been produced, so must not be deleted. */
  heldForRollUp: PruneCandidate[];
  bytesReclaimed: number;
  mandatoryDeletions: number;
  notes: string[];
}

/**
 * Builds the pruning plan. Mandatory-expiry classes (current state and raw traces) are deleted
 * whatever the governor state; optional classes are deleted only once their roll-up target
 * exists, and are otherwise held.
 */
export function planPruning(
  candidates: readonly PruneCandidate[],
  now: Date,
  rolledUpKeys: ReadonlySet<string> = new Set(),
): PrunePlan {
  const deletions: PruneCandidate[] = [];
  const heldForRollUp: PruneCandidate[] = [];
  const notes: string[] = [];
  let mandatoryDeletions = 0;

  const ordered = [...candidates].sort((a, b) => {
    const aOrder = getRetentionClass(a.retentionClassKey)?.pruneOrder ?? 99;
    const bOrder = getRetentionClass(b.retentionClassKey)?.pruneOrder ?? 99;
    return aOrder - bOrder || a.timestamp.localeCompare(b.timestamp);
  });

  for (const candidate of ordered) {
    const retentionClass = getRetentionClass(candidate.retentionClassKey);
    if (!retentionClass) {
      notes.push(`unknown retention class ${candidate.retentionClassKey}; not deleted`);
      continue;
    }

    const expiry = evaluateExpiry(candidate.retentionClassKey, candidate.timestamp, now);
    if (!expiry.expired) continue;

    if (retentionClass.rollUpBeforePruning && !rolledUpKeys.has(candidate.key)) {
      if (retentionClass.mandatoryExpiry) {
        // Raw traces expire regardless: the retention ceiling outranks the derived aggregate.
        deletions.push(candidate);
        mandatoryDeletions += 1;
        notes.push(
          `${candidate.key} reached its retention ceiling before its roll-up was produced and was deleted anyway`,
        );
        continue;
      }
      heldForRollUp.push(candidate);
      continue;
    }

    deletions.push(candidate);
    if (retentionClass.mandatoryExpiry) mandatoryDeletions += 1;
  }

  if (heldForRollUp.length > 0) {
    notes.push(
      `${heldForRollUp.length} expired records are held because their coarser aggregate has not been produced yet`,
    );
  }

  return {
    deletions,
    heldForRollUp,
    bytesReclaimed: deletions.reduce((total, candidate) => total + candidate.approximateBytes, 0),
    mandatoryDeletions,
    notes,
  };
}

/** The roll-up chain, derived from the retention classes rather than restated here. */
export function rollUpChain(): Array<{ from: string; to: string }> {
  return RETENTION_CLASSES.filter((c) => c.rollUpBeforePruning && c.rollUpTargetKey !== null).map(
    (c) => ({ from: c.key, to: c.rollUpTargetKey! }),
  );
}
