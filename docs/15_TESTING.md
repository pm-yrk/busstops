# 15 — Testing and quality

## Test pyramid

**Unit:** normalization, time/DST, geometry, matching, metrics, baseline classification, confidence, ETA, journey costs, ticket allowlist, quota state, templates.

**Contract:** sanitized recorded fixtures for every source; success, empty, rate-limit, timeout, stale, schema drift and malformed records. Confirm attribution/licence metadata.

**Integration:** static ingest/reconciliation, live-to-aggregate, artifact atomic publish/rollback, Worker caches, partial source, auth/preferences, Daily Brief snapshot/send idempotency and retention jobs.

**Property/generative:** coordinate bounds, monotonic stop progression, metric ranges, no negative counts, routing termination, deduplication and idempotency.

**End-to-end:** home to stop/vehicle, pixel board, all-stops expansion, journey map tap, nearest-not-fastest explanation, Maps links, tickets, Bus Stopped?, favourites, public Pro drilldowns, authenticated email settings, stale/degraded state.

## Analytical validation

Use hand-calculated golden cases for punctuality/reliability/headway, congestion vehicle-minutes, abnormality, diversion, weather association and context adjustment. Backtest ETA intervals and risk calibration on held-out periods. Test insufficient samples, unequal coverage, source outage, stationary terminus, GPS jumps and contradictory sources. Metrics must never silently divide by zero or rank incomparable operators.

## UI quality

Automated accessibility plus keyboard/screen-reader spot checks; WCAG 2.2 AA target. Responsive visual snapshots at 320/375/768/1440 widths. Verify 200% zoom, reduced motion, high contrast, long place/operator names, no-data and large tables. Map has list alternative. Email renders in representative Gmail, Outlook and Apple clients plus plain text.

## Non-functional

Performance budgets for initial shell, map interaction and API payload; bounded national zoom; cache effectiveness; load/abuse tests within safe local simulation; offline/PWA behavior; browser compatibility; security headers; secret scan; dependency/license audit; backup/rollback; quota threshold simulations; raw-data expiry.

## Live verification

With credentials, smoke-test at least one London and multiple non-London areas, while checking national search/catalog counts and source-health coverage. Do not claim all-England success from one city. Record timestamps and non-secret evidence in `BUILD_STATE.md`.

## Release gate

Formatting, lint, type check, unit, contract, integration, E2E, accessibility, security, build, quota preflight and deployed smoke tests all pass. Flaky tests are failures until fixed/quarantined with a tracked reason; acceptance cannot rely on manual assertion alone.

