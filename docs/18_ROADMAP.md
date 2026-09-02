# 18 — Autonomous roadmap

Phases are dependency ordered, not opportunities to stop. Keep production scope national throughout. Each exit requires tests and an updated `BUILD_STATE.md`.

## P0 — Audit and foundations

Read specs; audit repository; choose/record stack; create monorepo, contracts, quality gates, environments, design tokens, source registry, quota registry and threat model. Exit: local shell and CI pass, no secrets, acceptance checklist mapped to work.

## P1 — National static network

Implement BODS/TfL schedule and NaPTAN/NPTG ingestion, normalization, identity crosswalks, route patterns/shapes, search index, versioned artifacts, daily check and weekly reconciliation. Exit: national counts/diffs validated and London/non-London fixtures/contracts pass.

## P2 — Live data and edge delivery

Implement BODS/TfL live adapters, viewport/stop/route APIs, caching/coalescing, source health, stale/partial fallback, vehicle matching/current state and bounded recent traces. Exit: live verified in London and multiple non-London areas without national-per-user fetch.

## P3 — Bus Stops Live

Build home, search/nearby, map/list, stop pixel board, vehicle/route pages, next/all stops, departures, recent/scheduled paths, favourites, Will I make it?, Bus Stopped?, ticket registry and all state/accessibility behavior. Exit: passenger E2E/visual/accessibility gates pass.

## P4 — Journey planning

Build walking/transport graph, time-dependent routing, live ETA intervals, transfers, ranking modes, fastest-stop explanation, map-tap destination, re-plan and Google/Apple handoff. Exit: golden/brute-force cases and E2E pass.

## P5 — National intelligence pipeline

Build bounded collectors, map matching, segment/route/operator/area aggregates, retention/rollups, baseline engine, road/weather/flood enrichment and atomic artifacts. Exit: idempotency, quality, raw expiry, storage projection and failure rollback pass.

## P6 — Analytics

Implement punctuality, reliability, network health, headway/bunching/gaps, diversion/skipped-stop, congestion/delay origin, normal-versus-abnormal, speed anomaly, weather/flood sensitivity, route risk, confidence/calibration and context adjustment. Exit: documented golden/backtests pass with sample/coverage suppression.

## P7 — Bus Stops Pro

Build public demo and every Pro view, filters/drilldowns, evidence, source health, accessible charts/tables, reports and deterministic summaries. Exit: public access, truthful live/snapshot labeling and Pro E2E pass.

## P8 — Accounts and Daily Brief

Implement minimal account/organisation/preferences authorization, verified recipients/consent/unsubscribe, snapshots, web report, responsive email, bounded scheduler/idempotency and provider caps. Exit: authorized test send and quota/failure tests pass.

## P9 — Hardening and free-tier proof

Complete budget governor, safe mode, abuse limits, lifecycle/pruning, privacy/security controls, legal/attribution, runbooks, performance, browser/email testing and full acceptance audit. Exit: simulated thresholds and release suite pass.

## P10 — Deployment and verification

Provision free resources, bootstrap national static data, deploy immutable app/Worker/artifacts, enable conservative schedules, smoke-test England overview plus representative areas/features, verify no billing path, record URL/evidence. Fix every achievable acceptance failure.

## Post-launch roadmap (not a substitute for required scope)

After acceptance: improve calibration with accumulated aggregates, expand verified ticket coverage, add operator-private connectors only with a real partner/security design, enhance accessibility data when sourced, evaluate Wales/Scotland only as separate scope, and consider commercial infrastructure before any scale that exceeds free guardrails. Replay remains excluded unless the product owner explicitly reopens it with a funded storage/privacy plan.

