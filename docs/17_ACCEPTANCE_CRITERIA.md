# 17 — Acceptance criteria

Completion requires objective evidence for every achievable item. External credential/provider blocks must be isolated, documented and cannot excuse unrelated unfinished work.

## Product and design

- [ ] Brand is consistently `Bus Stops.` with approved stacked warm-white/black/red direction.
- [ ] Original coherent pixel library is used throughout, including reduced-motion loading bus.
- [ ] Selected stop opens a functional pixel arrival board with live/scheduled/freshness states.
- [ ] Responsive, keyboard accessible, WCAG 2.2 AA-oriented UI works across required widths and error states.
- [ ] Home, supporting/legal/methodology, all Live pages and all Pro pages exist and are substantive.

## England-wide data

- [ ] Production architecture/configuration supports all England and has no regional hard-code.
- [ ] BODS outside London and TfL London adapters are live-verified with provenance/freshness.
- [ ] NaPTAN identity, schedules, routes, patterns and stop sequences reconcile nationally.
- [ ] Daily timetable fingerprint/change ingest and weekly full reconciliation run idempotently.
- [ ] National Highways, Street Manager, OSM, Open-Meteo and Environment Agency adapters/enrichment are implemented and contract-tested.
- [ ] Source failure, stale, partial coverage and previous-good fallback are user-visible and tested.

## Bus Stops Live

- [ ] Viewport map, nearby/search, stop departures, live vehicles, tracking, next stops and `Show all stops` work with real data.
- [ ] Recent actual path versus scheduled shape and cautious diversion/skipped-stop evidence work.
- [ ] `Will I make it?` gives calibrated range/confidence and next service.
- [ ] `Bus Stopped?` provides evidence-aware recovery actions without unsupported claims.
- [ ] Journey planner handles searched/map-tapped destinations and Fastest/Least walking/Fewest changes.
- [ ] It evaluates nearest versus fastest boarding stop and explains material differences.
- [ ] Google/Apple walking handoffs are valid; favourites work local-first.
- [ ] Verified official/authorised ticket links are allowlisted, labelled and safely opened.

## Bus Stops Pro

- [ ] Public read-only Pro demo has no login wall and is honestly live or dated-snapshot labelled.
- [ ] Control Tower, Live Operations, Routes, Operators, Congestion, Analytics, Disruptions, Reports, Daily Brief and Settings work with filters/drilldowns.
- [ ] Network health, punctuality, reliability, delay, headways, bunching, gaps, diversion, congestion, abnormality, delay origin, speed anomaly, weather/flood, route risk and context-adjusted performance follow documented algorithms.
- [ ] Metrics show denominator, window, freshness, coverage/confidence and evidence; incomparable rankings are suppressed.
- [ ] Biggest delay burden and most abnormal disruptions are distinct.

## Daily Brief

- [ ] Browser and responsive HTML/plain-text email derive from the same frozen snapshot.
- [ ] Yesterday/today sections, coverage caveats, evidence and deterministic narrative are complete.
- [ ] Verified opt-in, timezone/time/scope settings, authorization, one-click unsubscribe, idempotency and audit work.
- [ ] Hard send caps, degraded behavior and one authorized production test are verified.

## £0, security and operations

- [ ] Current official quotas/terms are recorded; billing cannot increase automatically.
- [ ] Budget registry, thresholds, projections, kill switches and preflight are implemented.
- [ ] Simulated amber/red/critical states degrade in documented order while preserving deletion/unsubscribe/security.
- [ ] Raw GPS expires within 24–48h; rollups/pruning/storage inventory pass tests; no Replay exists.
- [ ] Secrets, input validation, authorization, CSP/headers, URL allowlist, privacy minimization and audit controls pass review/tests.
- [ ] All required source/map attribution and privacy/terms/methodology pages ship.

## Engineering, tests and deployment

- [ ] Typed contracts/schemas, idempotent pipelines, versioned atomic artifacts and rollback are implemented.
- [ ] Formatting, lint, types, unit, property, contract, integration, analytical golden, E2E, accessibility, security and build checks pass.
- [ ] Live checks cover London, multiple non-London areas and national catalog/coverage evidence.
- [ ] Cloud deployment succeeds at a free project URL; mobile/desktop smoke tests pass.
- [ ] README/runbooks/environment template are complete; `BUILD_STATE.md` is current and evidence-based.

## Rejection conditions

Reject completion if the product is a static mock, uses only fixtures, is limited to one area/operator, hides Pro behind login, silently fabricates live data, lacks hard quota controls, retains raw telemetry indefinitely, includes Replay, depends on paid services/AI, has untested critical algorithms, or is not deployed when deploy credentials are available.

