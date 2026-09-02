import { z } from "zod";

/**
 * Budget registry for every constrained free-tier resource (docs/13_FREE_TIER_RULES.md).
 *
 * `allowance` values are the smallest applicable free allowance for the resource and MUST be
 * re-verified against current provider terms immediately before each deployment: quotas change.
 * `verifiedAt` is null until a human or a preflight check has confirmed the number against the
 * provider's published terms — scripts/preflight.mjs fails the deploy while any required
 * resource is unverified, so a stale assumption can never silently authorise a paid overage.
 */

export const BudgetPeriodSchema = z.enum(["day", "month", "minute"]);
export type BudgetPeriod = z.infer<typeof BudgetPeriodSchema>;

export const BudgetResourceSchema = z.object({
  key: z.string().min(1),
  provider: z.string().min(1),
  displayName: z.string().min(1),
  /** Smallest applicable free allowance for the period. */
  allowance: z.number().positive(),
  unit: z.string().min(1),
  period: BudgetPeriodSchema,
  termsUrl: z.string().url(),
  /** ISO instant when this allowance was last confirmed against the provider's published terms. */
  verifiedAt: z.string().nullable(),
  /** When true, deployment preflight fails unless the allowance has been verified. */
  requiredForDeploy: z.boolean().default(true),
  /**
   * Self-imposed ceiling as a fraction of the allowance. Work stops here, never at the
   * provider's rejection — provider rejection must never be used as the governor.
   */
  selfImposedCeilingFraction: z.number().min(0).max(1).default(0.9),
});
export type BudgetResource = z.infer<typeof BudgetResourceSchema>;

export const BUDGET_REGISTRY: readonly BudgetResource[] = [
  {
    key: "cloudflare.workers.requests",
    provider: "Cloudflare",
    displayName: "Worker requests",
    allowance: 100_000,
    unit: "requests",
    period: "day",
    termsUrl: "https://developers.cloudflare.com/workers/platform/limits/",
    verifiedAt: null,
    requiredForDeploy: true,
    selfImposedCeilingFraction: 0.85,
  },
  {
    key: "cloudflare.workers.cpu_ms",
    provider: "Cloudflare",
    displayName: "Worker CPU time per invocation",
    allowance: 10,
    unit: "cpu-milliseconds",
    period: "minute",
    termsUrl: "https://developers.cloudflare.com/workers/platform/limits/",
    verifiedAt: null,
    requiredForDeploy: true,
    selfImposedCeilingFraction: 0.8,
  },
  {
    key: "cloudflare.r2.storage_bytes",
    provider: "Cloudflare",
    displayName: "R2 stored bytes",
    allowance: 10 * 1024 ** 3,
    unit: "bytes",
    period: "month",
    termsUrl: "https://developers.cloudflare.com/r2/pricing/",
    verifiedAt: null,
    requiredForDeploy: true,
    selfImposedCeilingFraction: 0.8,
  },
  {
    key: "cloudflare.r2.class_a_operations",
    provider: "Cloudflare",
    displayName: "R2 class A operations (writes/lists)",
    allowance: 1_000_000,
    unit: "operations",
    period: "month",
    termsUrl: "https://developers.cloudflare.com/r2/pricing/",
    verifiedAt: null,
    requiredForDeploy: true,
    selfImposedCeilingFraction: 0.8,
  },
  {
    key: "cloudflare.r2.class_b_operations",
    provider: "Cloudflare",
    displayName: "R2 class B operations (reads)",
    allowance: 10_000_000,
    unit: "operations",
    period: "month",
    termsUrl: "https://developers.cloudflare.com/r2/pricing/",
    verifiedAt: null,
    requiredForDeploy: true,
    selfImposedCeilingFraction: 0.85,
  },
  {
    key: "cloudflare.kv.reads",
    provider: "Cloudflare",
    displayName: "KV reads",
    allowance: 100_000,
    unit: "reads",
    period: "day",
    termsUrl: "https://developers.cloudflare.com/kv/platform/limits/",
    verifiedAt: null,
    requiredForDeploy: true,
    selfImposedCeilingFraction: 0.85,
  },
  {
    key: "cloudflare.kv.writes",
    provider: "Cloudflare",
    displayName: "KV writes",
    allowance: 1_000,
    unit: "writes",
    period: "day",
    termsUrl: "https://developers.cloudflare.com/kv/platform/limits/",
    verifiedAt: null,
    requiredForDeploy: true,
    selfImposedCeilingFraction: 0.8,
  },
  {
    key: "github.actions.minutes",
    provider: "GitHub",
    displayName: "Actions minutes (public repository)",
    allowance: 50_000,
    unit: "minutes",
    period: "month",
    termsUrl:
      "https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions",
    verifiedAt: null,
    requiredForDeploy: true,
    selfImposedCeilingFraction: 0.5,
  },
  {
    key: "email.daily_sends",
    provider: "Email provider",
    displayName: "Daily Brief email sends",
    allowance: 100,
    unit: "emails",
    period: "day",
    termsUrl: "https://resend.com/pricing",
    verifiedAt: null,
    requiredForDeploy: false,
    selfImposedCeilingFraction: 0.8,
  },
  {
    key: "email.monthly_sends",
    provider: "Email provider",
    displayName: "Monthly email sends",
    allowance: 3_000,
    unit: "emails",
    period: "month",
    termsUrl: "https://resend.com/pricing",
    verifiedAt: null,
    requiredForDeploy: false,
    selfImposedCeilingFraction: 0.8,
  },
  {
    key: "upstream.bods.requests",
    provider: "BODS",
    displayName: "BODS API requests",
    allowance: 20_000,
    unit: "requests",
    period: "day",
    termsUrl: "https://data.bus-data.dft.gov.uk/guidance/",
    verifiedAt: null,
    requiredForDeploy: true,
    selfImposedCeilingFraction: 0.5,
  },
  {
    key: "upstream.tfl.requests",
    provider: "TfL",
    displayName: "TfL Unified API requests",
    allowance: 500,
    unit: "requests",
    period: "minute",
    termsUrl: "https://api-portal.tfl.gov.uk/",
    verifiedAt: null,
    requiredForDeploy: true,
    selfImposedCeilingFraction: 0.5,
  },
  {
    key: "upstream.open_meteo.requests",
    provider: "Open-Meteo",
    displayName: "Open-Meteo requests",
    allowance: 10_000,
    unit: "requests",
    period: "day",
    termsUrl: "https://open-meteo.com/en/terms",
    verifiedAt: null,
    requiredForDeploy: false,
    selfImposedCeilingFraction: 0.5,
  },
  {
    key: "upstream.environment_agency.requests",
    provider: "Environment Agency",
    displayName: "EA flood-monitoring requests",
    allowance: 10_000,
    unit: "requests",
    period: "day",
    termsUrl: "https://environment.data.gov.uk/flood-monitoring/doc/reference",
    verifiedAt: null,
    requiredForDeploy: false,
    selfImposedCeilingFraction: 0.5,
  },
] as const;

export function getBudgetResource(key: string): BudgetResource | undefined {
  return BUDGET_REGISTRY.find((r) => r.key === key);
}

/** Resources whose allowance must be verified against live provider terms before deploying. */
export function unverifiedRequiredResources(): BudgetResource[] {
  return BUDGET_REGISTRY.filter((r) => r.requiredForDeploy && r.verifiedAt === null);
}
