import type { GovernorState } from "@busstops/contracts";
import { classify } from "@busstops/governor";
import { RETENTION_CLASSES } from "@busstops/pipeline-core";

/**
 * Daily storage inventory and quota projection
 * (docs/07_DATA_PIPELINES.md "Storage discipline", docs/13_FREE_TIER_RULES.md).
 *
 * The free tier fails silently if you only look at today's usage: storage that grows by a
 * comfortable-looking amount each day still crosses the ceiling on a date you can compute now.
 * So the inventory projects forward and reports the date, which is what makes the governor able
 * to act before the bill exists rather than after.
 */

export interface StorageClassInventory {
  retentionClassKey: string;
  objectCount: number;
  bytes: number;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
}

export interface StorageInventory {
  takenAt: string;
  classes: StorageClassInventory[];
  totalBytes: number;
  totalObjects: number;
  /**
   * Stored data whose retention class is not in the registry. This is reported loudly rather
   * than ignored: data with no retention rule is data nothing will ever delete, which is exactly
   * the failure mode the retention design exists to prevent.
   */
  unclassifiedKeys: string[];
}

export interface StorageProjection {
  totalBytes: number;
  limitBytes: number;
  utilization: number;
  /** Bytes added per day, measured across the supplied history. */
  dailyGrowthBytes: number | null;
  /** Projected utilization at the end of the current budget period. */
  projectedUtilization: number;
  /** ISO date on which the limit is projected to be reached, when growth is positive. */
  projectedFullOn: string | null;
  state: GovernorState;
  /** Small-file waste: many tiny objects cost operations, not just bytes. */
  averageObjectBytes: number | null;
  notes: string[];
}

export function takeInventory(
  classes: readonly StorageClassInventory[],
  takenAt: Date,
): StorageInventory {
  const known = new Set(RETENTION_CLASSES.map((c) => c.key));
  return {
    takenAt: takenAt.toISOString(),
    classes: [...classes],
    totalBytes: classes.reduce((total, entry) => total + entry.bytes, 0),
    totalObjects: classes.reduce((total, entry) => total + entry.objectCount, 0),
    unclassifiedKeys: classes
      .filter((entry) => !known.has(entry.retentionClassKey))
      .map((entry) => entry.retentionClassKey),
  };
}

export interface ProjectionOptions {
  limitBytes: number;
  /** Previous inventories, oldest first, used to measure growth. */
  history: readonly StorageInventory[];
  /** Days remaining in the current budget period. */
  daysRemainingInPeriod: number;
}

export function projectStorage(
  current: StorageInventory,
  options: ProjectionOptions,
): StorageProjection {
  const notes: string[] = [];
  const utilization = options.limitBytes > 0 ? current.totalBytes / options.limitBytes : 0;

  const earliest = options.history[0];
  let dailyGrowthBytes: number | null = null;
  if (earliest) {
    const days =
      (new Date(current.takenAt).getTime() - new Date(earliest.takenAt).getTime()) / 86_400_000;
    if (days >= 1) {
      dailyGrowthBytes = (current.totalBytes - earliest.totalBytes) / days;
    } else {
      notes.push("less than a day of inventory history, so growth cannot be measured yet");
    }
  } else {
    notes.push("no inventory history, so growth cannot be measured yet");
  }

  const projectedBytes =
    dailyGrowthBytes === null
      ? current.totalBytes
      : current.totalBytes + dailyGrowthBytes * options.daysRemainingInPeriod;
  const projectedUtilization = options.limitBytes > 0 ? projectedBytes / options.limitBytes : 0;

  let projectedFullOn: string | null = null;
  if (dailyGrowthBytes !== null && dailyGrowthBytes > 0) {
    const remainingBytes = options.limitBytes - current.totalBytes;
    const daysToFull = remainingBytes / dailyGrowthBytes;
    if (daysToFull >= 0 && Number.isFinite(daysToFull)) {
      const full = new Date(new Date(current.takenAt).getTime() + daysToFull * 86_400_000);
      projectedFullOn = full.toISOString().slice(0, 10);
      if (daysToFull < 30) {
        notes.push(
          `at the current rate storage reaches its limit in about ${Math.round(daysToFull)} days`,
        );
      }
    }
  }

  if (current.unclassifiedKeys.length > 0) {
    notes.push(
      `${current.unclassifiedKeys.length} storage classes have no retention rule and would never be pruned: ${current.unclassifiedKeys.join(", ")}`,
    );
  }

  const averageObjectBytes =
    current.totalObjects > 0 ? current.totalBytes / current.totalObjects : null;
  if (averageObjectBytes !== null && averageObjectBytes < 4096 && current.totalObjects > 1000) {
    notes.push(
      `average object is ${Math.round(averageObjectBytes)} bytes; compaction would cut operation counts substantially`,
    );
  }

  return {
    totalBytes: current.totalBytes,
    limitBytes: options.limitBytes,
    utilization,
    dailyGrowthBytes,
    projectedUtilization,
    projectedFullOn,
    state: classify(utilization, projectedUtilization),
    averageObjectBytes,
    notes,
  };
}
