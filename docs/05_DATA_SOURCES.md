# 05 — Data sources

Claude must verify current official documentation, licensing, attribution, endpoints, authentication, update cadence, and free limits at build time. Store a source registry containing owner, purpose, geography, licence URL, attribution, credential name, freshness SLA, cache policy, terms notes, and last contract verification.

| Source | Primary use | Geography | Required behavior |
|---|---|---|---|
| BODS | timetables, vehicle locations, matching feeds | England outside London | API key in secret; filtered live queries and bounded national collection; expose source freshness |
| TfL Unified API/open data | London arrivals, vehicles, routes/schedules/disruptions | London | `TFL_APP_KEY`; adapter normalizes TfL identifiers and semantics without losing provenance |
| NaPTAN/NPTG | stops, codes, localities and hierarchy | England | canonical stop identity; preserve status/version and reconcile moved/removed stops |
| National Highways/WebTRIS/developer feeds | strategic road incidents, closures, flow/speed | strategic road network | official evidence enrichment, not universal local-road coverage |
| Street Manager | street works and road works | England | ingest only through authorised published access; spatial/time match with confidence |
| OpenStreetMap | road graph, route context, walking/routing inputs and speed-limit context | England | comply with ODbL/attribution and provider usage policy; do not overload public tile/routing services |
| Open-Meteo | observed/forecast weather | England | geospatial/time cache; record model/run time and forecast horizon |
| Environment Agency flood APIs | alerts, warnings, flood areas, levels/flows | England | link to official evidence; distinguish alert/warning from inferred risk |

## Source hierarchy

Scheduled network: BODS/TfL schedules plus NaPTAN; use source-native versioning. Live location/arrival: BODS outside London and TfL in London. Stop identity: NaPTAN, with source-specific alias tables. Road geometry and walking graph: licence-compliant OSM-derived data. Official event causes: relevant official road/flood sources. Derived bus-probe intelligence never overwrites official facts.

## Quality and conflicts

Normalize timestamps to UTC while presenting Europe/London with DST. Validate coordinates, impossible jumps, stale feeds, duplicate journeys, missing stop sequences, route variants, identifier reuse, and cancellation semantics. Preserve raw source and normalized confidence. Prefer current official record for factual identity; never merge merely by similar name. Maintain crosswalk tables with method and confidence.

## Ticket links

Create a curated/provider-derived registry of official operator or authorised seller URLs. Each mapping records operator/route applicability, URL template, source evidence, verified date, domain allowlist, and active status. Never construct arbitrary external URLs from untrusted feed text. Check links periodically and remove/disable failed or unverifiable links.

## Attribution

Show concise attribution in product and full details in Data & Methodology. Ship required map/data licence notices. Preserve source identifiers where terms require them. Do not redistribute raw bulk files in the public repo unless licensing explicitly permits it; store tiny sanitized contract fixtures.

