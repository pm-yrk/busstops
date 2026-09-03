import { ArtifactStore, type ArtifactManifest, type ObjectStore } from "@busstops/pipeline-core";
import type { Incident } from "@busstops/contracts";
import type { SegmentIntervalBucket } from "./aggregates.js";
import type { TrackedIncident } from "./incidents.js";

/**
 * Atomic publication of intelligence artifacts (docs/07_DATA_PIPELINES.md, docs/04_ARCHITECTURE.md).
 *
 * Same discipline as the static network: write the versioned object, validate it, then swap the
 * manifest pointer. A reader either sees the whole previous version or the whole new one, never
 * a half-written dataset. A failed publish leaves the previous good version live, so a bad batch
 * degrades freshness rather than correctness.
 */

export const INTELLIGENCE_SCHEMA_VERSION = "1.0.0";

export const INTELLIGENCE_DATASETS = {
  segmentMetrics: "intelligence/segment-metrics",
  incidents: "intelligence/incidents",
  runReports: "intelligence/run-reports",
} as const;

export interface IntelligencePublishOptions {
  version: string;
  now?: () => Date;
  /**
   * Share of planned partitions that were actually collected. Recorded on the artifact so a
   * consumer can see the national picture is incomplete instead of assuming it is whole.
   */
  coverage: number;
  sources: readonly string[];
  /** Below this the publish is rejected: a near-empty national batch means something broke. */
  minimumSegmentBuckets?: number;
}

export interface IntelligencePublishResult {
  published: ArtifactManifest[];
  failed: Array<{ dataset: string; reason: string }>;
  complete: boolean;
  notes: string[];
}

export async function publishIntelligence(
  store: ObjectStore,
  input: {
    buckets: readonly SegmentIntervalBucket[];
    incidents: readonly TrackedIncident[];
  },
  options: IntelligencePublishOptions,
): Promise<IntelligencePublishResult> {
  const artifacts = new ArtifactStore(store);
  const published: ArtifactManifest[] = [];
  const failed: IntelligencePublishResult["failed"] = [];
  const notes: string[] = [];
  const now = options.now ?? (() => new Date());

  const partialCoverage = options.coverage < 1;
  if (partialCoverage) {
    notes.push(
      `published with ${(options.coverage * 100).toFixed(0)}% partition coverage; consumers must treat national totals as incomplete`,
    );
  }

  // Only settled buckets are published as metrics. An open bucket is still being revised, and
  // publishing it would put a figure into circulation that is about to change.
  const settled = input.buckets.filter((bucket) => bucket.state === "closed");
  const openCount = input.buckets.length - settled.length;
  if (openCount > 0) {
    notes.push(`${openCount} buckets are still open and were not published`);
  }

  const incidents: Incident[] = input.incidents.map((tracked) => tracked.incident);

  const publishDataset = async (
    dataset: string,
    records: readonly unknown[],
    minimumRecordCount: number,
    allowEmpty: boolean,
    maximumShrinkFraction?: number,
  ): Promise<void> => {
    if (records.length === 0 && !allowEmpty) {
      failed.push({ dataset, reason: "no records produced" });
      return;
    }
    try {
      const manifest = await artifacts.publish({
        dataset,
        version: options.version,
        records,
        schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
        sources: options.sources,
        partialCoverage,
        minimumRecordCount,
        allowEmpty,
        now,
        ...(maximumShrinkFraction === undefined ? {} : { maximumShrinkFraction }),
        ...(notes.length > 0 ? { notes: notes.join("; ") } : {}),
      });
      published.push(manifest);
    } catch (error) {
      failed.push({
        dataset,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await publishDataset(
    INTELLIGENCE_DATASETS.segmentMetrics,
    settled,
    options.minimumSegmentBuckets ?? 1,
    false,
  );

  // Zero incidents is a legitimate and common result, so this dataset has no minimum: rejecting
  // an empty publish here would leave yesterday's incidents on screen indefinitely. The shrink
  // guard is disabled for the same reason — it exists to catch a broken parse of bulk reference
  // data, and an incident count genuinely does fall from fifty to zero when the roads clear.
  await publishDataset(INTELLIGENCE_DATASETS.incidents, incidents, 0, true, 1);

  return { published, failed, complete: failed.length === 0, notes };
}

/** Rolls the intelligence datasets back to their previous good versions. */
export async function rollbackIntelligence(store: ObjectStore): Promise<string[]> {
  const artifacts = new ArtifactStore(store);
  const rolledBack: string[] = [];
  for (const dataset of Object.values(INTELLIGENCE_DATASETS)) {
    const manifest = await artifacts.rollback(dataset);
    if (manifest) rolledBack.push(`${dataset}@${manifest.version}`);
  }
  return rolledBack;
}
