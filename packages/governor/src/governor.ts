import type { GovernorState, QuotaState } from "@busstops/contracts";
import { BUDGET_REGISTRY, getBudgetResource, type BudgetResource } from "./budget-registry.js";

/**
 * The £0 governor. Thresholds are from docs/13_FREE_TIER_RULES.md:
 *   green < 70%, amber 70-85%, red 85-95%, critical >= 95% or projected breach.
 *
 * The governor acts on our own measurements and projections. Provider rejection is never
 * the governor: by the time an upstream returns 429/402 the budget has already been spent.
 */

export const GOVERNOR_THRESHOLDS = {
  amber: 0.7,
  red: 0.85,
  critical: 0.95,
} as const;

export interface UsageSample {
  resourceKey: string;
  /** Units consumed so far in the current period. */
  used: number;
  /** Fraction of the period elapsed, 0..1. Used to project end-of-period usage. */
  periodElapsedFraction: number;
  observedAt: string;
}

export function projectUtilization(sample: UsageSample, resource: BudgetResource): number {
  const utilization = sample.used / resource.allowance;
  if (sample.periodElapsedFraction <= 0) return utilization;
  // Linear projection to end of period; never projects below what is already spent.
  return Math.max(utilization, utilization / Math.min(1, sample.periodElapsedFraction));
}

export function classify(utilization: number, projected: number): GovernorState {
  const worst = Math.max(utilization, projected);
  if (worst >= GOVERNOR_THRESHOLDS.critical) return "critical";
  if (worst >= GOVERNOR_THRESHOLDS.red) return "red";
  if (worst >= GOVERNOR_THRESHOLDS.amber) return "amber";
  return "green";
}

export function evaluateResource(sample: UsageSample): QuotaState {
  const resource = getBudgetResource(sample.resourceKey);
  if (!resource) {
    throw new Error(`Unknown budget resource: ${sample.resourceKey}`);
  }
  const utilization = sample.used / resource.allowance;
  const projected = projectUtilization(sample, resource);
  return {
    resource: resource.key,
    utilizationFraction: utilization,
    projectedUtilizationFraction: projected,
    state: classify(utilization, projected),
    updatedAt: sample.observedAt,
    allowance: resource.allowance,
    allowanceUnit: resource.unit,
    allowanceSourceUrl: resource.termsUrl,
    allowanceVerifiedAt: resource.verifiedAt ?? sample.observedAt,
  };
}

const STATE_SEVERITY: Record<GovernorState, number> = {
  green: 0,
  amber: 1,
  red: 2,
  critical: 3,
};

/** Overall platform state is the worst state of any single tracked resource. */
export function aggregateState(states: readonly GovernorState[]): GovernorState {
  return states.reduce<GovernorState>(
    (worst, s) => (STATE_SEVERITY[s] > STATE_SEVERITY[worst] ? s : worst),
    "green",
  );
}

export function isAtLeast(state: GovernorState, threshold: GovernorState): boolean {
  return STATE_SEVERITY[state] >= STATE_SEVERITY[threshold];
}

/**
 * Capability gates, applied in the degradation order of docs/13_FREE_TIER_RULES.md.
 * Anything not listed here stays available in every state — in particular consent deletion,
 * raw-retention deletion, source-health reporting, unsubscribe and security controls, which
 * must survive critical mode.
 */
export interface CapabilityDecision {
  allowed: boolean;
  reason: string;
}

export const PRESERVED_IN_CRITICAL = [
  "consent_deletion",
  "raw_retention_deletion",
  "source_health_reporting",
  "unsubscribe",
  "security_controls",
  "homepage",
  "static_network",
  "schedules",
  "saved_items",
] as const;
export type PreservedCapability = (typeof PRESERVED_IN_CRITICAL)[number];

export type GovernedCapability =
  | PreservedCapability
  | "optional_animation"
  | "optional_export"
  | "email_preview"
  | "daily_brief_send"
  | "historical_enrichment"
  | "model_recalculation"
  | "fine_grained_aggregates"
  | "live_vehicle_polling"
  | "live_aggregates";

/** The state at which each optional capability is switched off. */
const CAPABILITY_DISABLED_AT: Partial<Record<GovernedCapability, GovernorState>> = {
  optional_animation: "amber",
  optional_export: "amber",
  email_preview: "amber",
  historical_enrichment: "red",
  model_recalculation: "red",
  fine_grained_aggregates: "critical",
  daily_brief_send: "critical",
  live_vehicle_polling: "critical",
  live_aggregates: "critical",
};

export function capabilityAllowed(
  capability: GovernedCapability,
  state: GovernorState,
): CapabilityDecision {
  if ((PRESERVED_IN_CRITICAL as readonly string[]).includes(capability)) {
    return { allowed: true, reason: "preserved in every governor state" };
  }
  const disabledAt = CAPABILITY_DISABLED_AT[capability];
  if (disabledAt && isAtLeast(state, disabledAt)) {
    return { allowed: false, reason: `disabled at governor state ${disabledAt} and above` };
  }
  return { allowed: true, reason: `permitted at governor state ${state}` };
}

/** Cache TTLs are multiplied as pressure rises, reducing upstream and Worker load. */
export function cacheTtlMultiplier(state: GovernorState): number {
  switch (state) {
    case "green":
      return 1;
    case "amber":
      return 2;
    case "red":
      return 4;
    case "critical":
      return 8;
  }
}

/** Live polling interval scaling, applied to the configured base cadence. */
export function pollingIntervalMultiplier(state: GovernorState): number {
  switch (state) {
    case "green":
      return 1;
    case "amber":
      return 2;
    case "red":
      return 4;
    case "critical":
      return Number.POSITIVE_INFINITY;
  }
}

export interface DegradationStep {
  order: number;
  action: string;
  appliesAt: GovernorState;
}

export const DEGRADATION_LADDER: readonly DegradationStep[] = [
  { order: 1, action: "Reduce animation/detail and optional previews/exports", appliesAt: "amber" },
  { order: 2, action: "Increase cache TTL and reduce polling frequency", appliesAt: "amber" },
  {
    order: 3,
    action: "Pause lower-priority historical enrichment and model recalculation",
    appliesAt: "red",
  },
  {
    order: 4,
    action: "Roll up/prune oldest fine-grained aggregates, retaining daily summaries and incidents",
    appliesAt: "red",
  },
  {
    order: 5,
    action: "Suspend email previews, then new Daily Brief sends before the cap",
    appliesAt: "critical",
  },
  {
    order: 6,
    action: "Serve previous-good live aggregates with visible age, then scheduled-only data",
    appliesAt: "critical",
  },
] as const;

export function activeDegradationSteps(state: GovernorState): DegradationStep[] {
  return DEGRADATION_LADDER.filter((step) => isAtLeast(state, step.appliesAt));
}

/** Safe mode preserves the homepage, static network, schedules, saved items and source status. */
export function safeModeActive(state: GovernorState): boolean {
  return state === "critical";
}

export function allTrackedResourceKeys(): string[] {
  return BUDGET_REGISTRY.map((r) => r.key);
}
