# 13 — £0 normal-operation safeguards

## Absolute rule

Normal production operation must be chargeable at **£0**. No automatic plan upgrade, usage-based billing, paid API fallback, paid maps, paid AI call, or uncapped email/storage/compute path. Confirm current official provider terms immediately before deployment; quotas change.

## Budget registry

Implement configuration and a visible/admin-readable registry for every constrained resource: Worker requests/CPU, object storage bytes and operations, database bytes/reads/writes, build minutes, workflow frequency/runtime, email daily/monthly sends, and each external API. Track estimated and, where APIs permit, actual utilization plus rolling projections.

Use conservative thresholds based on the smallest applicable allowance:

- Green: below 70% projected/actual.
- Amber: 70–85%; increase cache/coalescing, reduce optional refresh, warn.
- Red: 85–95%; reduce historical resolution and nonessential jobs, pause optional exports/previews.
- Critical: ≥95% or projected breach; stop nonessential writes/sends/jobs and serve previous-good/cached/scheduled data.

Never treat provider rejection as the governor.

## Required controls

- Viewport/stop scoped live API with shared cache and request coalescing.
- Strict rate limits, bbox/zoom/result caps, timeouts and bot/abuse protection.
- Scheduled workflows with concurrency groups, time budgets and kill switches.
- Compressed partitioned artifacts; compact small files; atomic manifests.
- Automatic raw GPS expiry within 24–48h and progressive aggregate rollups.
- Storage inventory, quota projection and tested pruning order.
- Email verified-recipient allowlist, hard daily/monthly caps and no catch-up burst.
- Optional features remotely/configurably disabled without redeployment.
- A global safe mode that preserves homepage, static network, schedules, saved items and source status.

## Degradation order

1. Reduce animation/detail and optional previews/exports.
2. Increase cache TTL and reduce polling frequency.
3. Pause lower-priority historical enrichment and model recalculation.
4. Roll up/prune oldest fine-grained aggregates, retaining daily summaries/incidents.
5. Suspend email previews and then new Daily Brief sends before cap.
6. Serve previous-good live aggregates with age, then scheduled-only data.

Preserve security, consent deletion, raw-retention deletion, source-health reporting and unsubscribe even in critical mode.

## Verification

Tests simulate every threshold and assert job/API/email/storage behavior. A pre-deployment script fails if required caps, TTLs, lifecycle policies, rate limits, secret bindings or budget values are absent. `BUILD_STATE.md` records verified current allowances and headroom. Document a manual emergency shutdown procedure.

