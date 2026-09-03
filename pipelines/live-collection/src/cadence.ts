import type { GovernorState } from "@busstops/contracts";
import { pollingIntervalMultiplier } from "@busstops/governor";
import type { CollectionPartition } from "./partitions.js";
import { partitionsByPriority } from "./partitions.js";

/**
 * Quota-aware collection cadence (docs/07_DATA_PIPELINES.md, docs/13_FREE_TIER_RULES.md).
 *
 * Cadence is configuration driven and never faster than the source actually updates. Collecting
 * a 30-second feed every 10 seconds spends three times the budget to receive the same data twice,
 * so the floor here is the source's own update interval, not our appetite for freshness.
 *
 * Under budget pressure the plan sheds whole partitions in ascending priority order rather than
 * slowing every partition equally: half the country at a useful cadence is more useful than all
 * of it at a cadence too coarse to detect anything.
 */

export interface CadenceConfig {
  sourceKey: string;
  /** How often the upstream feed itself changes. Collecting faster buys nothing. */
  sourceUpdateIntervalSeconds: number;
  /** Desired interval when the budget is comfortable. */
  baseIntervalSeconds: number;
  /** Requests this source may spend per collection run across all partitions. */
  maxRequestsPerRun: number;
  /** Requests permitted per day, from the budget registry. */
  dailyRequestBudget: number;
}

export interface CollectionPlanEntry {
  partition: CollectionPartition;
  intervalSeconds: number;
}

export interface CollectionPlan {
  sourceKey: string;
  entries: CollectionPlanEntry[];
  intervalSeconds: number;
  skippedPartitions: string[];
  /** Requests per day this plan will actually spend. */
  projectedDailyRequests: number;
  /** True when the plan collects nothing at all, which is a valid outcome in critical state. */
  suspended: boolean;
  reasons: string[];
}

export function planCollection(
  config: CadenceConfig,
  governorState: GovernorState,
  partitions: readonly CollectionPartition[] = partitionsByPriority(),
): CollectionPlan {
  const reasons: string[] = [];
  const multiplier = pollingIntervalMultiplier(governorState);

  if (!Number.isFinite(multiplier)) {
    return {
      sourceKey: config.sourceKey,
      entries: [],
      intervalSeconds: 0,
      skippedPartitions: partitions.map((p) => p.key),
      projectedDailyRequests: 0,
      suspended: true,
      reasons: ["budget is critical, so scheduled intelligence collection is suspended entirely"],
    };
  }

  // Never poll faster than the feed changes, whatever the configuration asks for.
  const requestedInterval = config.baseIntervalSeconds * multiplier;
  let intervalSeconds = Math.max(requestedInterval, config.sourceUpdateIntervalSeconds);
  if (config.baseIntervalSeconds < config.sourceUpdateIntervalSeconds) {
    reasons.push(
      `configured interval of ${config.baseIntervalSeconds}s is faster than the source updates (${config.sourceUpdateIntervalSeconds}s), so the source interval is used`,
    );
  }
  if (multiplier > 1) {
    reasons.push(`interval widened ${multiplier}x because the budget state is ${governorState}`);
  }

  // Requests per run is a hard cap: it bounds a single run's cost and its wall-clock time.
  const ordered = [...partitions].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  let admitted = ordered.slice(0, Math.max(0, config.maxRequestsPerRun));
  let skipped = ordered.slice(admitted.length);
  if (skipped.length > 0) {
    reasons.push(
      `${skipped.length} lower-density partitions are not collected because the per-run cap is ${config.maxRequestsPerRun} requests`,
    );
  }

  // Then check the daily budget, widening the interval before dropping further partitions:
  // a slower national picture beats a fast picture of part of the country.
  const runsPerDay = () => 86_400 / intervalSeconds;
  while (admitted.length > 0 && runsPerDay() * admitted.length > config.dailyRequestBudget) {
    const doubled = intervalSeconds * 2;
    if (doubled <= 1800) {
      intervalSeconds = doubled;
      continue;
    }
    // The interval cannot usefully widen further, so shed the least dense partition.
    const dropped = admitted[admitted.length - 1]!;
    admitted = admitted.slice(0, -1);
    skipped = [...skipped, dropped];
  }

  const projectedDailyRequests = Math.round(runsPerDay() * admitted.length);
  if (projectedDailyRequests > 0) {
    reasons.push(
      `${admitted.length} partitions every ${Math.round(intervalSeconds)}s is about ${projectedDailyRequests} requests a day against a budget of ${config.dailyRequestBudget}`,
    );
  }

  return {
    sourceKey: config.sourceKey,
    entries: admitted.map((partition) => ({ partition, intervalSeconds })),
    intervalSeconds,
    skippedPartitions: skipped.map((p) => p.key),
    projectedDailyRequests,
    suspended: admitted.length === 0,
    reasons,
  };
}
