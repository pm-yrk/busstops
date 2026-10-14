/**
 * Numbers read from the environment, where "not set" and "set to nothing" are the same thing.
 *
 * ## The bug this exists to stop happening again
 *
 * `intelligence-collection.yml` passes its tuning through as optional repository variables:
 *
 *     MAX_PARTITIONS_PER_RUN: ${{ vars.MAX_PARTITIONS_PER_RUN }}
 *
 * When the variable is not set, GitHub Actions does not omit the environment variable — it sets it
 * to the empty string. So `process.env.MAX_PARTITIONS_PER_RUN ?? "12"` keeps `""`, because `??`
 * only falls back on `null` and `undefined`, and `Number("")` is **0**.
 *
 * Every scheduled collection run therefore planned zero partitions and fetched nothing:
 *
 *     plan: { partitions: 0, skipped: 24, projectedDailyRequests: 0 }
 *     notes: "24 lower-density partitions are not collected because the per-run cap is 0 requests"
 *     outcome: "suspended"
 *
 * and the analytics batch an hour later reported `no_input` with `versionsAvailable: 0`, which is
 * why Pro had no observations to show. Five numbers were affected the same way — the per-run cap,
 * the daily request budget, the pass count, and the collection and batch time budgets — and all
 * five became zero the moment the schedules started running. A zero budget is indistinguishable
 * from a deliberate pause, which is why it ran for a day looking like a quota decision.
 *
 * ## The rule
 *
 * Absent, blank, or not a finite number means "use the default". Only a real number overrides one.
 * A default is a considered value; `NaN` and `0`-from-nothing are not, and silently preferring them
 * to a working default is how a pipeline turns itself off.
 */

/**
 * @param raw the environment value, which may be undefined, blank, or nonsense
 * @param fallback the considered default, used whenever `raw` is not a finite number
 */
export function numberFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The same rule for a positive count, where zero is also not a usable answer.
 *
 * Separate because the two cases are genuinely different: `BUDGET_UTILIZATION` of zero is a real
 * reading, while a per-run request cap of zero is a pipeline that does nothing. Where zero would
 * mean "off", an explicit zero in the environment is still honoured — it is only an *accidental*
 * zero, from a blank or unparseable value, that falls back.
 */
export function positiveNumberFromEnv(raw: string | undefined, fallback: number): number {
  const value = numberFromEnv(raw, fallback);
  return value > 0 ? value : fallback;
}
