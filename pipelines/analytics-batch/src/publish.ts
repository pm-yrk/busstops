import { ArtifactStore, type ArtifactManifest, type ObjectStore } from "@busstops/pipeline-core";
import type { SegmentSample } from "./segments.js";
import type { Incident } from "@busstops/contracts";
import type { SegmentIntervalBucket } from "./aggregates.js";
import type { TrackedIncident } from "./incidents.js";
import { buildNetworkSummary, type NetworkSummaryRecord } from "./summary.js";

/**
 * Atomic publication of intelligence artifacts (docs/07_DATA_PIPELINES.md, docs/04_ARCHITECTURE.md).
 *
 * Same discipline as the static network: write the versioned object, validate it, then swap the
 * manifest pointer. A reader either sees the whole previous version or the whole new one, never
 * a half-written dataset. A failed publish leaves the previous good version live, so a bad batch
 * degrades freshness rather than correctness.
 */

export const INTELLIGENCE_SCHEMA_VERSION = "1.0.0";

/**
 * How many incidents are published.
 *
 * `ProService` reads this dataset whole into a 128 MiB isolate, and the number of open incidents
 * is a property of how disrupted England is rather than of this pipeline — so without a ceiling
 * here the edge has one that nobody chose. The same reasoning and the same number as the
 * disruption notices, which are capped at publish for exactly this reason. If this cap ever comes
 * off, the Worker's read has to be sharded or scoped before it does.
 */
export const MAX_PUBLISHED_INCIDENTS = 1500;

/** Worst first, so a cap drops the mildest abnormality rather than an arbitrary slice. */
const SEVERITY_ORDER = ["typical", "elevated", "abnormal", "highly_abnormal"] as const;

export const INTELLIGENCE_DATASETS = {
  segmentMetrics: "intelligence/segment-metrics",
  /**
   * The national picture in one record, for a reader that cannot afford the whole of
   * `segmentMetrics`. See `summary.ts` for why this exists rather than the edge reading the
   * segment dataset and filtering it.
   */
  networkSummary: "intelligence/network-summary",
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
  /** What the edge will read as the newest closed window, or null when none closed. */
  summary: NetworkSummaryRecord | null;
}

export async function publishIntelligence(
  store: ObjectStore,
  input: {
    buckets: readonly SegmentIntervalBucket[];
    incidents: readonly TrackedIncident[];
    /** The samples the buckets were built from, for counts a bucket cannot carry. */
    samples?: readonly SegmentSample[];
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

  /*
   * Ordered worst-first and capped, because the edge reads this dataset whole.
   *
   * `ProService` loads every published incident into a 128 MiB isolate to build the control
   * tower, and nothing bounded how many there could be: the count is a property of how disrupted
   * England is today rather than of this pipeline. That is the same shape as the disruption
   * notices, which are capped at publish for exactly this reason, and it gets the same answer —
   * including the ordering, so that the cap drops the mildest abnormality rather than an
   * arbitrary slice that happens to contain a route suspension. What is dropped is reported.
   */
  const ranked = [...input.incidents].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(b.incident.severity) - SEVERITY_ORDER.indexOf(a.incident.severity) ||
      Date.parse(b.incident.startedAt) - Date.parse(a.incident.startedAt),
  );
  const incidents: Incident[] = ranked
    .slice(0, MAX_PUBLISHED_INCIDENTS)
    .map((tracked) => tracked.incident);
  if (ranked.length > MAX_PUBLISHED_INCIDENTS) {
    notes.push(
      `${ranked.length - MAX_PUBLISHED_INCIDENTS} of ${ranked.length} incidents were not ` +
        `published: the edge reads this dataset whole and holds at most ${MAX_PUBLISHED_INCIDENTS}`,
    );
  }

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

  /*
   * The national summary, published only when a window actually closed.
   *
   * It is derived from the same `settled` buckets that produced the metrics dataset, so the two
   * can never disagree, and it is one record — the edge reads it for the cost of one object
   * rather than pulling an unbounded national dataset into a 128 MiB isolate. When nothing
   * closed there is nothing to publish and the previous summary stays live, which is the same
   * "degrade freshness, never correctness" rule the rest of this file follows.
   */
  const summary = buildNetworkSummary(
    { buckets: input.buckets, samples: input.samples ?? [], coverage: options.coverage },
    now(),
  );
  if (summary !== null) {
    await publishDataset(INTELLIGENCE_DATASETS.networkSummary, [summary], 1, false);
  } else {
    notes.push("no bucket had closed, so no network summary was published");
  }

  return { published, failed, complete: failed.length === 0, notes, summary };
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
