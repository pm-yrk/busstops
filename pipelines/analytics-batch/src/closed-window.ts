import type { VehicleObservation } from "@busstops/contracts";
import type { ArtifactStore } from "@busstops/pipeline-core";
import { AGGREGATION_DEFAULTS } from "./aggregates.js";

/**
 * The observations that belong to windows which have already closed.
 *
 * This is the correction to a pipeline that could never publish. A five-minute bucket stays open
 * for a further ten minutes so late data can revise it in place, and `publish.ts` deliberately
 * publishes only closed buckets — an open one is a figure that is about to change. The workflow,
 * meanwhile, collected about four minutes of observations and started the batch 0.7 seconds
 * later. Every bucket it produced was necessarily open, so every run ended
 * "43 buckets are still open and were not published" and rolled back, whatever the join did.
 *
 * The fix is not to shorten the grace, lower the sample floor or publish open buckets — each of
 * those trades a real guarantee for a populated dashboard. It is to aggregate the right window:
 * the batch reaches back through published observation versions and takes only those old enough
 * that their buckets have settled.
 *
 * Bounded on purpose. Raw traces are retained 48 hours, so "everything still in the bucket" would
 * be two days of vehicle positions read into one process; the lookback and the record cap keep a
 * scheduled run's cost flat whether it last ran ten minutes or ten hours ago.
 */

/** A bucket is settled once its end plus the lateness grace has passed. */
export const SETTLE_SECONDS =
  AGGREGATION_DEFAULTS.bucketSeconds + AGGREGATION_DEFAULTS.latenessGraceSeconds;

export interface ClosedWindowOptions {
  /** How far back to look for versions. Beyond this, data is old enough to be somebody else's. */
  lookbackSeconds?: number;
  /** A ceiling on how much is read into one run, whatever the lookback would allow. */
  maxRecords?: number;
  /** A ceiling on how many versions are opened, so a busy collector cannot fan this out. */
  maxVersions?: number;
}

export interface ClosedWindow {
  observations: VehicleObservation[];
  /** What was read, and what it cost, for the report. */
  versionsAvailable: number;
  versionsRead: number;
  recordsRead: number;
  recordsInClosedWindow: number;
  /** The settle horizon: nothing observed after this can be aggregated yet. */
  closedBefore: string;
  /** The span the accepted observations actually cover, or null when there are none. */
  earliestObservedAt: string | null;
  latestObservedAt: string | null;
  notes: string[];
}

/**
 * Gathers observations whose buckets have settled.
 *
 * Newest version first, because the most recent settled data is the most useful and the cap
 * should bite on the oldest rather than the newest. A version is opened only while the budget
 * allows; what it contributes is whatever it holds that is older than the horizon.
 */
export async function readClosedWindow(
  artifacts: ArtifactStore,
  dataset: string,
  now: Date,
  options: ClosedWindowOptions = {},
): Promise<ClosedWindow> {
  const lookbackSeconds = options.lookbackSeconds ?? 6 * 3600;
  const maxRecords = options.maxRecords ?? 250_000;
  const maxVersions = options.maxVersions ?? 40;

  const closedBeforeMs = now.getTime() - SETTLE_SECONDS * 1000;
  const oldestMs = now.getTime() - lookbackSeconds * 1000;
  const notes: string[] = [];

  const versions = await artifacts.listVersions(dataset);
  const observations: VehicleObservation[] = [];
  let recordsRead = 0;
  let versionsRead = 0;
  let earliest: number | null = null;
  let latest: number | null = null;

  for (const version of versions) {
    if (versionsRead >= maxVersions) {
      notes.push(`stopped after ${maxVersions} versions; older observations were not read`);
      break;
    }
    if (recordsRead >= maxRecords) {
      notes.push(`stopped at ${maxRecords} records read; older observations were not read`);
      break;
    }

    /*
     * The version string is when the collection ran, so it bounds what can be inside it: a run
     * that finished before the lookback began cannot hold anything newer than the lookback.
     * Skipping on the name avoids opening objects whose every record would be discarded.
     */
    const versionMs = Date.parse(version.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z"));
    if (Number.isFinite(versionMs) && versionMs < oldestMs) {
      notes.push(`reached versions older than the ${lookbackSeconds / 3600}h lookback`);
      break;
    }

    const records = await artifacts.readVersionRecords<VehicleObservation>(dataset, version);
    versionsRead += 1;
    recordsRead += records.length;

    for (const observation of records) {
      const observedMs = Date.parse(observation.observedAt);
      if (!Number.isFinite(observedMs)) continue;
      if (observedMs > closedBeforeMs) continue;
      if (observedMs < oldestMs) continue;
      observations.push(observation);
      earliest = earliest === null ? observedMs : Math.min(earliest, observedMs);
      latest = latest === null ? observedMs : Math.max(latest, observedMs);
    }
  }

  if (observations.length === 0 && recordsRead > 0) {
    notes.push(
      `every one of the ${recordsRead} observations read is newer than the settle horizon; ` +
        `nothing has been observed long enough for its bucket to close`,
    );
  }

  return {
    observations,
    versionsAvailable: versions.length,
    versionsRead,
    recordsRead,
    recordsInClosedWindow: observations.length,
    closedBefore: new Date(closedBeforeMs).toISOString(),
    earliestObservedAt: earliest === null ? null : new Date(earliest).toISOString(),
    latestObservedAt: latest === null ? null : new Date(latest).toISOString(),
    notes,
  };
}
