import type { GovernorState, SourceHealth, VehicleObservation } from "@busstops/contracts";
import { toIso } from "@busstops/pipeline-core";
import type { CollectionPartition } from "./partitions.js";
import { planCollection, type CadenceConfig, type CollectionPlan } from "./cadence.js";
import { applyQualityGates, acceptanceRate, type QualityConfig } from "./quality.js";
import { RollingObservationWindow } from "./rolling-window.js";

/**
 * The bounded intelligence collector (docs/07_DATA_PIPELINES.md "Live collection").
 *
 * This is the scheduled path, entirely separate from the user path: browsers never trigger it,
 * and it never fetches a national feed on a browser's behalf. It fetches the partitions the plan
 * admits, one at a time, and a partition that fails does not take the run with it — the run
 * reports partial coverage instead, because two thirds of the country is worth publishing as long
 * as the gap is stated rather than hidden.
 */

export interface PartitionFetcher {
  (partition: CollectionPartition, signal: AbortSignal): Promise<readonly unknown[]>;
}

export interface CollectionRunOptions {
  sourceKey: string;
  cadence: CadenceConfig;
  governorState: GovernorState;
  fetchPartition: PartitionFetcher;
  window: RollingObservationWindow;
  now?: () => Date;
  quality?: QualityConfig;
  /** Wall-clock ceiling for the whole run, so a scheduled job cannot overrun its slot. */
  budgetMs?: number;
  partitions?: readonly CollectionPartition[];
  health?: () => SourceHealth;
  /**
   * Snapshots to take per run, spaced by the planned interval.
   *
   * One snapshot per vehicle is a dot on a map and nothing more: a traversal, a speed and a
   * delay all need at least two positions of the same vehicle. A scheduled job that fires every
   * half hour therefore has to collect a short burst while it is alive, rather than one frame.
   */
  passes?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PartitionOutcome {
  partitionKey: string;
  ok: boolean;
  fetched: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  /** Populated on failure; a short reason, never the upstream payload or any header. */
  error?: string;
}

export interface CollectionRunReport {
  sourceKey: string;
  passesCompleted: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  plan: CollectionPlan;
  partitions: PartitionOutcome[];
  observations: VehicleObservation[];
  totals: {
    fetched: number;
    accepted: number;
    duplicates: number;
    rejected: number;
    implausible: number;
    evicted: number;
  };
  /** Share of planned partitions that succeeded. Published, never assumed to be 1. */
  coverage: number;
  acceptanceRate: number | null;
  /** True when the run ran out of its time budget before finishing the plan. */
  truncated: boolean;
  health: SourceHealth | null;
  notes: string[];
}

export async function runCollection(options: CollectionRunOptions): Promise<CollectionRunReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const budgetMs = options.budgetMs ?? 60_000;
  const notes: string[] = [];

  const plan = planCollection(options.cadence, options.governorState, options.partitions);
  notes.push(...plan.reasons);

  const partitionOutcomes: PartitionOutcome[] = [];
  const observations: VehicleObservation[] = [];
  const totals = {
    fetched: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    implausible: 0,
    evicted: 0,
  };
  let truncated = false;

  const passes = Math.max(1, options.passes ?? 1);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let passesCompleted = 0;

  outer: for (let pass = 0; pass < passes; pass += 1) {
    if (pass > 0) {
      // Wait the planned interval before the next snapshot. Collecting again immediately would
      // spend a request to receive the same positions back.
      const remainingBudget = budgetMs - (now().getTime() - startedAt.getTime());
      const waitMs = plan.intervalSeconds * 1000;
      if (waitMs >= remainingBudget) {
        truncated = true;
        notes.push(
          `stopped after ${pass} of ${passes} snapshots; another would not fit in the run's time budget`,
        );
        break;
      }
      await sleep(waitMs);
    }

    for (const entry of plan.entries) {
      if (now().getTime() - startedAt.getTime() > budgetMs) {
        truncated = true;
        notes.push(
          `run stopped after ${partitionOutcomes.length} of ${plan.entries.length} partitions to stay inside its ${Math.round(budgetMs / 1000)}s time budget`,
        );
        break outer;
      }

      const controller = new AbortController();
      const remaining = budgetMs - (now().getTime() - startedAt.getTime());
      const timer = setTimeout(() => controller.abort(), Math.max(1000, remaining));

      try {
        const raw = await options.fetchPartition(entry.partition, controller.signal);
        const quality = applyQualityGates(raw, now(), options.quality);
        const admission = options.window.admit(quality.accepted, now());

        observations.push(...admission.admitted);
        totals.fetched += raw.length;
        totals.accepted += admission.admitted.length;
        totals.duplicates += admission.duplicates;
        totals.rejected += quality.rejected.length + admission.tooOld;
        totals.implausible += admission.implausible;
        totals.evicted += admission.evicted;

        partitionOutcomes.push({
          partitionKey: entry.partition.key,
          ok: true,
          fetched: raw.length,
          accepted: admission.admitted.length,
          duplicates: admission.duplicates,
          rejected: quality.rejected.length + admission.tooOld,
        });

        const rate = acceptanceRate(quality);
        if (rate !== null && rate < 0.8) {
          notes.push(
            `partition ${entry.partition.key} accepted only ${(rate * 100).toFixed(0)}% of records, which may indicate upstream schema drift`,
          );
        }
      } catch (error) {
        partitionOutcomes.push({
          partitionKey: entry.partition.key,
          ok: false,
          fetched: 0,
          accepted: 0,
          duplicates: 0,
          rejected: 0,
          error: error instanceof Error ? error.message : "unknown collection failure",
        });
      } finally {
        clearTimeout(timer);
      }
    }

    passesCompleted += 1;
  }

  const attempted = partitionOutcomes.length;
  const succeeded = partitionOutcomes.filter((outcome) => outcome.ok).length;
  const coverage = attempted === 0 ? 0 : succeeded / attempted;
  if (coverage < 1 && attempted > 0) {
    notes.push(
      `${attempted - succeeded} of ${attempted} partition fetches failed, so this run covers ${(coverage * 100).toFixed(0)}% of the planned area`,
    );
  }
  if (plan.skippedPartitions.length > 0) {
    notes.push(`${plan.skippedPartitions.length} partitions are outside this run's budget`);
  }

  const finishedAt = now();
  const overall =
    totals.fetched + totals.rejected === 0
      ? null
      : totals.accepted / (totals.accepted + totals.rejected);

  return {
    sourceKey: options.sourceKey,
    passesCompleted,
    startedAt: toIso(startedAt),
    finishedAt: toIso(finishedAt),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    plan,
    partitions: partitionOutcomes,
    observations,
    totals,
    coverage,
    acceptanceRate: overall,
    truncated,
    health: options.health?.() ?? null,
    notes,
  };
}
