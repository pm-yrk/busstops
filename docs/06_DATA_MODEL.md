# 06 — Data model and contracts

All entities have a stable internal UUID, source-qualified external IDs, `validFrom/validTo`, provenance, ingestion timestamp, and quality flags where relevant. Publish versioned JSON schemas and TypeScript types; validate at ingress and artifact boundaries.

## Static entities

- `Operator`: names, licence/registry IDs, contact/ticket domains, service areas.
- `Locality/Area`: NPTG/admin/analysis hierarchy and geometry reference.
- `Stop`: NaPTAN identity, code, name, coordinates, bearing, type, locality, accessibility/amenities provenance, active state.
- `Service/Route`: public name/number, operator, mode, variants/directions, branding and validity.
- `RoutePattern`: ordered stops, canonical shape, direction, distance and validity.
- `ScheduledJourney`: service date/calendar, trip ID, pattern, times, blocks where available, cancellation/update state.
- `RoadSegment/Corridor`: OSM-derived geometry reference, direction, length, class, speed-limit provenance and analysis grouping.

## Live entities

- `VehicleObservation`: opaque vehicle/journey ref, coordinates, bearing, source speed if present, timestamp, source, quality. Short-lived.
- `VehicleState`: best current matched journey/pattern, position, delay, motion, next stop, freshness, matching confidence.
- `DeparturePrediction`: stop, journey, scheduled/expected time, live state, source, uncertainty interval and confidence.
- `RecentTrace`: bounded simplified positions for current visualization/derivation only.

## Derived entities

- `RouteIntervalMetric`, `OperatorIntervalMetric`, `AreaIntervalMetric`.
- `SegmentIntervalMetric`: sample count, robust speed, baseline, excess travel time and affected vehicles/routes.
- `Baseline`: dimension keys, comparable window, quantiles/distribution, sample and recency.
- `Incident`: type, start/end, geometry, entities affected, severity, confidence, evidence refs, official/derived status and lifecycle.
- `DiversionEvent`, `BunchingEvent`, `ServiceGapEvent`, `SpeedAnomaly`, `SkippedStopEvidence`.
- `WeatherObservation/Forecast`, `FloodNotice`, `RoadEvent`, `RiskForecast`.
- `JourneyPlan`: request fingerprint, legs, options, predicted ranges, confidence and explanation; short cache only.
- `DailyBriefSnapshot`: scoped metrics, ranked evidence, deterministic narrative and artifact version.
- `SourceHealth` and `QuotaState`.

## Identity and privacy

Vehicle IDs may rotate or be hashed/opaque. Do not attempt to identify drivers or track individuals. User location and journey requests remain client/session scoped by default and are excluded from logs. `User`, `Organisation`, `Preference`, `Recipient`, and `ConsentEvent` belong in a separate access-controlled account domain.

## Units and semantics

Store timestamps as ISO UTC/epoch with explicit timezone at display. Durations in seconds; distances in metres; speeds in m/s internally; percentages as 0–1 or clearly named percentage points consistently. Delay is actual/predicted minus scheduled. All metrics carry denominator, coverage and confidence. Never mix observed and scheduled-only journeys without a coverage flag.

## Retention classes

Current vehicle state: replace/expire quickly. Raw/recent trace: target 24 hours, never above 48 hours except quarantined tiny samples. Five-minute aggregates: 30 days; 15-minute: 90 days; hourly: one year; daily and compact incident summaries: long-term subject to the governor. Significant diversion polylines are simplified and bounded. Deletion jobs are tested and auditable.

