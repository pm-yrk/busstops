# 16 — Deployment and operations

## Target

Deploy the static/PWA frontend to Cloudflare Pages (or current equivalent no-cost static hosting), thin API to Cloudflare Workers, and artifacts to R2. Use GitHub Actions for bounded collection/build schedules appropriate to a public repository. If current free offerings differ, select an equivalent architecture that still satisfies `13_FREE_TIER_RULES.md` and document the decision.

No custom domain is required. Use the provider project URL. Configure a custom domain only later and never block launch on it.

## Configuration

Provide `.env.example` and a deployment checklist with names such as BODS/TfL keys, Cloudflare account/project/bucket bindings, account/auth provider configuration if used, email provider secret/from identity, base URL and feature/kill switches. Exact names are implementation decisions. Values are never committed.

## CI/CD

Pull requests: install from lockfile; format/lint/type/test/build; contract fixtures; security/license/secret scans; preview deploy without production secrets where safe. Main: repeat gates, deploy immutable version, run smoke tests, then promote/record. Scheduled pipelines use minimal permissions, concurrency cancellation, runtime caps, artifacts/log retention and failure notifications.

## Data bootstrap

Bootstrap static national network once with checksums and validation; publish versioned manifest; then enable daily fingerprint check and weekly reconciliation. Enable live collection conservatively, observe quotas and quality, then widen within the already national design. “Widen” may tune cadence, not hard-code a regional product.

## Preflight

Verify current provider free plans and billing settings; bindings and lifecycle rules; API licences/attribution; secrets; source health; national/London coverage; map provider policy; quota caps/safe mode; unsubscribe; privacy/terms/methodology; caching/security headers; backups/rollback; monitoring; and acceptance suite.

## Operations

Runbooks cover upstream outage/schema change, quota amber/red/critical, stale artifact, failed timetable reconciliation, bad analytics publish, email failure, credential rotation, account incident and full safe-mode shutdown. Keep previous-good manifests for rollback. Status UX tells users what remains available.

## Launch validation

Test provider URL on mobile and desktop; England overview; search; representative London/non-London stop, vehicle and route; journey and Maps links; Pro dashboard/drilldown; source status; stale simulation; authenticated preferences; one authorized test Daily Brief; and zero-billing evidence. Add deployment URL and checks to `BUILD_STATE.md` and README.

