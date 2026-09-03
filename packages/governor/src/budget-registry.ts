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
  /** Smallest applicable free allowance for the period. Ignored when `metered` is false. */
  allowance: z.number().positive(),
  unit: z.string().min(1),
  period: BudgetPeriodSchema,
  termsUrl: z.string().url(),
  /**
   * Whether the provider meters this resource against a quota at all.
   *
   * Some resources are genuinely unlimited under the conditions we run in, and inventing a
   * number for them is worse than recording none: a fabricated allowance makes the governor
   * throttle work that costs nothing, and it hides the real condition that keeps it free.
   * When false, `allowance` is a placeholder and `unmeteredBecause` states the condition.
   */
  metered: z.boolean().default(true),
  /** Required when `metered` is false: the condition under which no quota applies. */
  unmeteredBecause: z.string().nullable().default(null),
  /** ISO instant when this allowance was last confirmed against the provider's published terms. */
  verifiedAt: z.string().nullable(),
  /** How the figure was confirmed. Required whenever `verifiedAt` is set. */
  verifiedNote: z.string().nullable().default(null),
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
    metered: true,
    unmeteredBecause: null,
    verifiedAt: null,
    verifiedNote: null,
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
    metered: true,
    unmeteredBecause: null,
    verifiedAt: null,
    verifiedNote: null,
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
    metered: true,
    unmeteredBecause: null,
    verifiedAt: null,
    verifiedNote: null,
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
    metered: true,
    unmeteredBecause: null,
    verifiedAt: null,
    verifiedNote: null,
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
    metered: true,
    unmeteredBecause: null,
    verifiedAt: null,
    verifiedNote: null,
    requiredForDeploy: true,
    selfImposedCeilingFraction: 0.85,
  },
  {
    key: "github.actions.minutes",
    provider: "GitHub",
    displayName: "Actions minutes (standard runners, public repository)",
    /*
     * Standard GitHub-hosted runners are free and unlimited for public repositories, so there is
     * no monthly allowance to model. The previous 50,000-minute figure was the included quota for
     * private repositories on a paid plan and did not apply here at all.
     *
     * The entry is kept rather than deleted because the condition matters: if this repository is
     * ever made private, minutes become metered immediately and this becomes a real budget. The
     * placeholder allowance is never consumed while `metered` is false.
     */
    allowance: 1,
    unit: "minutes",
    period: "month",
    termsUrl:
      "https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions",
    metered: false,
    unmeteredBecause:
      "Standard GitHub-hosted runners are free and unlimited for public repositories. This " +
      "becomes a metered monthly allowance if the repository is made private.",
    verifiedAt: "2026-09-03T00:00:00.000Z",
    verifiedNote:
      "Confirmed against GitHub's published Actions billing terms for public repositories.",
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
    metered: true,
    unmeteredBecause: null,
    verifiedAt: null,
    verifiedNote: null,
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
    metered: true,
    unmeteredBecause: null,
    verifiedAt: null,
    verifiedNote: null,
    requiredForDeploy: false,
    selfImposedCeilingFraction: 0.8,
  },
  {
    key: "upstream.bods.requests",
    provider: "BODS",
    displayName: "BODS live data requests",
    /*
     * BODS publishes a request *interval*, not a daily quota: consumers are asked not to request
     * the central live data more often than once every five seconds. Twelve requests per minute
     * is that rule expressed in the registry's units, and it is the real constraint — the
     * previous 20,000-per-day figure was not published anywhere and let the collector issue a
     * burst that breached the interval while appearing to be well inside budget.
     *
     * BODS_MINIMUM_REQUEST_INTERVAL_MS is the same rule enforced at the point of request.
     */
    allowance: 12,
    unit: "requests",
    period: "minute",
    termsUrl: "https://data.bus-data.dft.gov.uk/guidance/requirements/",
    metered: true,
    unmeteredBecause: null,
    verifiedAt: "2026-09-03T00:00:00.000Z",
    verifiedNote:
      "BODS consumer guidance: the central live data should be requested no more frequently " +
      "than once every five seconds, which is 12 requests per minute.",
    requiredForDeploy: true,
    selfImposedCeilingFraction: 0.5,
  },
  {
    key: "upstream.tfl.requests",
    provider: "TfL",
    displayName: "TfL Unified API requests (registered product)",
    allowance: 500,
    unit: "requests",
    period: "minute",
    termsUrl: "https://api-portal.tfl.gov.uk/",
    metered: true,
    unmeteredBecause: null,
    verifiedAt: "2026-09-03T00:00:00.000Z",
    verifiedNote:
      "TfL registered Unified API product is rate limited to 500 requests per minute. An " +
      "unregistered caller gets far less, so the app key is what makes this figure apply.",
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
    metered: true,
    unmeteredBecause: null,
    verifiedAt: null,
    verifiedNote: null,
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
    metered: true,
    unmeteredBecause: null,
    verifiedAt: null,
    verifiedNote: null,
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
