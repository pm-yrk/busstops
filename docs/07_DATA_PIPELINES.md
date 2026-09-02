# 07 — Data pipelines

## Static network

Daily, check BODS/TfL schedule fingerprints, catalogue metadata, NaPTAN/NPTG and relevant source versions. If unchanged, record the check and stop. If changed: download once; verify checksum/size; parse streaming; validate; normalize; reconcile aliases and validity; build stops, services, patterns, journeys, shapes, search index and routing inputs; compare counts/diffs; publish atomically.

Weekly, perform full England reconciliation regardless of change hints: missing/new operators, services, patterns, stops, added/removed journeys, geometry changes, invalid references and orphan aliases. Produce a compact Network Changes report. Keep sufficient schedule versions for audit without duplicating unchanged bulk data.

## Live collection

Two paths:

- User path: Worker serves viewport/stop/route requests through bounded cache and source adapters. Coalesce identical requests and never fetch a national feed per browser.
- Intelligence path: scheduled bounded collectors obtain supported national/partitioned live data at the least frequency necessary, normalize and deduplicate, maintain a rolling window, then generate aggregates/incidents.

Cadence is configuration driven and quota aware. Never promise “real-time” beyond source/update reality. Use source timestamps rather than receipt time for analysis.

## Processing stages

Ingest → schema validation → timestamp/coordinate quality → identity/journey matching → route map matching → stop progression/delay → segment samples → interval aggregates → incident algorithms → baseline comparison → weather/road/flood enrichment → artifact validation → atomic publish → retention/pruning.

Each stage is idempotent, checkpointed, bounded, and emits counts/rejections/timing. Late observations can revise an open bucket within a defined window; closed artifacts are versioned.

## Geospatial matching

Use candidate road/route geometries, direction, observation accuracy, bearing, sequence continuity, scheduled journey and plausible speed. Apply a robust hidden-state/Viterbi or equivalent bounded algorithm, not nearest-line alone. Low-confidence points do not create incidents. Simplify display traces separately from analytical matching.

## Enrichment

Cache weather on a grid/time basis; attach forecast run and uncertainty. Spatially and temporally join official flood and road events with a stated distance/window and match confidence. National Highways coverage must not imply local street coverage. Street Manager records are planned/active works evidence, not proof they caused the delay.

## Failure and freshness

On source or job failure, keep previous-good artifacts, increase visible age, retry with jitter, and open a health incident. After thresholds, switch Live to scheduled-only or partial-source modes rather than inventing predictions. A recovery run must reconcile the missed window only within retention/quota budgets.

## Storage discipline

Compact small files, compress, partition sensibly, avoid one object per observation, and maintain manifests. Before pruning, derive useful aggregates. Raw expiration is automatic and higher priority than optional analytics. Run daily storage inventory and quota projection. No Replay pipeline exists.

