/**
 * Retention classes and pruning order (docs/06_DATA_MODEL.md "Retention classes",
 * docs/13_FREE_TIER_RULES.md "Degradation order").
 *
 * There is deliberately no long-horizon raw position class and no network history feature:
 * raw positions expire automatically within 48 hours, and expiry has higher priority than
 * any optional analytics work.
 */

/** Hard ceiling for raw vehicle traces. Target is 24h; 48h is the absolute maximum. */
export const RAW_TRACE_MAX_AGE_HOURS = 48;
export const RAW_TRACE_TARGET_AGE_HOURS = 24;

export interface RetentionClass {
  key: string;
  displayName: string;
  maxAgeHours: number;
  /** Lower prunes first when storage pressure rises. */
  pruneOrder: number;
  /** When true, this data must be rolled up into a coarser aggregate before deletion. */
  rollUpBeforePruning: boolean;
  rollUpTargetKey: string | null;
  /** Expiry of this class runs even in critical governor state. */
  mandatoryExpiry: boolean;
}

export const RETENTION_CLASSES: readonly RetentionClass[] = [
  {
    key: "vehicle_state_current",
    displayName: "Current vehicle state",
    maxAgeHours: 1,
    pruneOrder: 0,
    rollUpBeforePruning: false,
    rollUpTargetKey: null,
    mandatoryExpiry: true,
  },
  {
    key: "raw_trace",
    displayName: "Raw and recent vehicle traces",
    maxAgeHours: RAW_TRACE_MAX_AGE_HOURS,
    pruneOrder: 1,
    rollUpBeforePruning: true,
    rollUpTargetKey: "aggregate_5min",
    mandatoryExpiry: true,
  },
  {
    key: "aggregate_5min",
    displayName: "Five-minute aggregates",
    maxAgeHours: 30 * 24,
    pruneOrder: 2,
    rollUpBeforePruning: true,
    rollUpTargetKey: "aggregate_15min",
    mandatoryExpiry: false,
  },
  {
    key: "aggregate_15min",
    displayName: "Fifteen-minute aggregates",
    maxAgeHours: 90 * 24,
    pruneOrder: 3,
    rollUpBeforePruning: true,
    rollUpTargetKey: "aggregate_hourly",
    mandatoryExpiry: false,
  },
  {
    key: "aggregate_hourly",
    displayName: "Hourly aggregates",
    maxAgeHours: 365 * 24,
    pruneOrder: 4,
    rollUpBeforePruning: true,
    rollUpTargetKey: "aggregate_daily",
    mandatoryExpiry: false,
  },
  {
    key: "aggregate_daily",
    displayName: "Daily summaries",
    maxAgeHours: 5 * 365 * 24,
    pruneOrder: 5,
    rollUpBeforePruning: false,
    rollUpTargetKey: null,
    mandatoryExpiry: false,
  },
  {
    key: "incident_summary",
    displayName: "Compact incident summaries",
    maxAgeHours: 5 * 365 * 24,
    pruneOrder: 6,
    rollUpBeforePruning: false,
    rollUpTargetKey: null,
    mandatoryExpiry: false,
  },
] as const;

export function getRetentionClass(key: string): RetentionClass | undefined {
  return RETENTION_CLASSES.find((c) => c.key === key);
}

/** Order in which classes are pruned when storage pressure rises: oldest, coarsest value first. */
export function pruningOrder(): RetentionClass[] {
  return [...RETENTION_CLASSES].sort((a, b) => a.pruneOrder - b.pruneOrder);
}

export interface ExpiryDecision {
  expired: boolean;
  ageHours: number;
  reason: string;
}

export function evaluateExpiry(
  retentionClassKey: string,
  recordTimestamp: string,
  now: Date,
): ExpiryDecision {
  const retentionClass = getRetentionClass(retentionClassKey);
  if (!retentionClass) {
    throw new Error(`Unknown retention class: ${retentionClassKey}`);
  }
  const ageHours = (now.getTime() - new Date(recordTimestamp).getTime()) / 3_600_000;
  const expired = ageHours > retentionClass.maxAgeHours;
  return {
    expired,
    ageHours,
    reason: expired
      ? `age ${ageHours.toFixed(1)}h exceeds ${retentionClass.maxAgeHours}h for ${retentionClass.key}`
      : `within ${retentionClass.maxAgeHours}h retention for ${retentionClass.key}`,
  };
}

/**
 * Deletion jobs that must run regardless of governor state. Preserving these under quota
 * pressure is required by docs/13_FREE_TIER_RULES.md: raw expiry and consent deletion outrank
 * every optional workload.
 */
export function mandatoryExpiryClasses(): RetentionClass[] {
  return RETENTION_CLASSES.filter((c) => c.mandatoryExpiry);
}
