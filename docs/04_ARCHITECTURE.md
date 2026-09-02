# 04 — Architecture

## Target shape

Use a monorepo with clear boundaries, for example `apps/web`, `apps/worker`, `packages/contracts`, `packages/analytics`, `packages/ui`, `pipelines`, `tests`, and `infra`. Exact tooling may adapt to the repository, but contracts must be shared and runtime coupling kept low.

```text
Browsers/PWA -> CDN static app -> thin edge API/cache -> source adapters or R2 artifacts
                                          ^
Scheduled collectors -> transient raw window -> batch analytics -> versioned compressed artifacts
Static schedules/stops --------------------^                 -> manifests/health
Weather/roads/floods -----------------------^
```

Preferred components: React + TypeScript + Vite/PWA; Cloudflare Pages; a thin Cloudflare Worker; R2 for compressed, partitioned artifacts and short rolling telemetry; MapLibre with a licence-compliant no-cost tile style/provider; GitHub Actions for bounded scheduled batch work; a minimal free database only for accounts/preferences/subscriptions and coordination if genuinely needed.

## Boundaries

- Browser owns presentation, device geolocation, local favourites, lightweight filtering, and navigation handoff.
- Worker owns validation, cache keys, viewport/area queries, upstream credential protection, response shaping, rate limits, and health manifests—not heavy national analytics.
- Pipelines own ingestion, reconciliation, map matching, aggregation, baseline training, incident derivation, artifact compaction, and retention.
- R2/object storage owns immutable/versioned compressed datasets with atomic manifest swaps.
- Account store owns only identities, organisations, preferences, verified recipients, consent and audit metadata. Never place raw national telemetry there by default.

## API design

Version endpoints. Use bounding boxes/tiles, area IDs, stop IDs, route IDs and opaque cursors. Enforce maximum bounds, zoom, result size, timeout and cache behavior. Responses include `generatedAt`, `observedAt`, source list, source freshness, coverage, confidence and degradation status. Use ETags/content hashes and stale-while-revalidate.

Suggested resources: `/v1/map`, `/stops/:id`, `/vehicles/:id`, `/routes/:id`, `/journeys`, `/disruptions`, `/areas/:id/health`, `/pro/*`, `/sources/health`, `/tickets`, and authenticated `/me/*`. Do not expose provider keys.

## Artifacts and atomicity

Partition by dataset/date/area/geohash or tile and time bucket. Prefer Parquet/JSONL/compact JSON as supported by clients. Write to a versioned temporary key, validate counts/schema/checksum, then atomically publish a small manifest pointer. Readers keep the previous good version when a build fails.

## Resilience

Circuit-break failing sources; exponential backoff with jitter; idempotent jobs; bounded concurrency; checkpoints; poison-record quarantine; schema drift alerts; previous-good artifact fallback; explicit partial coverage. A single source failure must not blank the application.

## Environments and observability

Local, preview, and production use identical contracts with different secrets/buckets. Structured logs exclude secrets, precise user location, and email content. Publish source freshness, job success, record counts, rejected records, artifact age/size, request/cache rate, latency/error, quota state, and Daily Brief outcomes. Alerts themselves must remain free and bounded.

## Architectural prohibitions

No always-on paid server, national full-feed fetch per user request, unbounded table scan, browser-held secrets, paid maps dependency, indefinite raw GPS, automatic billing, source scraping where an official feed exists, or AI requirement for core summaries.

