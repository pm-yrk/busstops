# 08 — Analytics engine

All algorithms must be deterministic, tested on edge cases, versioned, explainable, and accompanied by coverage/confidence. Initial thresholds below are defaults to calibrate with observed distributions, never silently changed.

## Core service metrics

**Delay:** predicted/observed timing point minus schedule, with early values negative. Report robust median and percentiles as well as mean. Exclude unmatched/low-quality points.

**Punctuality:** percentage of eligible observations/journeys within the configured window; default reporting window `-1 to +5 minutes`, but label the exact definition and allow standards-specific profiles. Denominator and coverage are mandatory.

**Reliability:** operated/observed eligible journeys divided by scheduled eligible journeys, distinguishing confirmed cancellation, not observed, and source outage. Never label missing telemetry as cancellation.

**Headway adherence:** for frequent services, compare observed versus scheduled headway with absolute/relative deviation. Use timetable adherence for low-frequency services.

**Network health (0–100):** weighted, documented combination of punctuality, reliability, excess delay, headway stability, severe incident burden and data coverage. Cap confidence when coverage is low and show components. Do not present false precision; UI rounds appropriately.

## Bunching and gaps

Order same-direction vehicles on the same pattern using along-route distance. Bunching candidate when consecutive observed headway is below `max(2 minutes, 0.5 × scheduled headway)` for at least two reliable samples, with closing trend or sustained state. Gap candidate when headway exceeds `max(10 minutes, 1.5 × scheduled headway)` or a missing scheduled journey is supported. Merge adjacent samples into lifecycle events and prevent terminal/short-turn artifacts.

## Diversion and skipped stops

After robust route matching, diversion candidate requires consecutive good observations materially outside the expected route corridor, plausible continuity, and a later rejoin or sustained off-route trace. Default evidence: at least three points spanning two minutes and distance beyond GPS/map error; tune by environment. Report departure/rejoin, bypassed scheduled stops, added distance/time and confidence. A stop is “possibly skipped” only when the path bypasses its catchment and stop progression continues; do not infer from absent dwell alone.

## Congestion and delay origin

Aggregate robust segment travel speed from multiple independent vehicles/routes. Compare current median travel time to matched baseline. `excess vehicle-minutes = Σ max(0, observed segment time − expected segment time)` over valid traversals. Confidence rises with samples, route diversity, duration and agreement; one stationary bus is not corridor congestion.

Delay origin is the earliest/strongest contiguous segment where cumulative excess delay grows, with competing explanations and evidence. Phrase as “delay appears to originate near…” unless official evidence confirms cause.

## Typical versus abnormal

Baseline dimensions: segment/corridor and direction × local weekday type × 15-minute window, with seasonal/holiday/event/weather refinement only when sample size supports it. Use rolling recent history with robust quantiles and decay. Minimum suggested classification sample: 20 comparable periods across at least four weeks; below it show “insufficient baseline.”

Compute current excess versus median, robust z-score using MAD/IQR, and empirical percentile:

- Typical: percentile <75 or excess <1 robust sigma
- Elevated: 75–90 or 1–2 sigma
- Abnormal: 90–97.5 or 2–3 sigma
- Highly abnormal: ≥97.5 and meaningful absolute impact, or ≥3 sigma

Require persistence and absolute materiality; thresholds are configurable/versioned. “Occurs on 81% of comparable periods” is empirical frequency within a defined similarity band, with sample count.

## Speed anomalies

Derived speed uses map-matched distance/time, removes low time gaps, impossible jumps, stops/dwell and poor geometry, and compares with sourced speed-limit context. Require consecutive independent samples and high match quality. Output `possible speed anomaly` with low/medium/high confidence, never driver blame or legal conclusion. Public UI may omit low-confidence events.

## Weather/flood intelligence

Compare segment/route outcomes under matched rainfall/wind/temperature conditions versus dry/normal controls while accounting for weekday/time/season. Require sample and effect-size thresholds and report association, not causation. Flood susceptibility combines historic rain-associated disruption, terrain/official flood-area proximity where licenced, current forecast, and active Environment Agency notice. Say “flood warning active” only when official; otherwise “elevated flooding risk” or “rain-associated disruption.”

## Route risk and context-adjusted performance

Risk forecast combines historical matched performance, timetable, roadworks/incidents, weather/flood notices, early live behavior, coverage and model calibration. Return probability band and expected additional time range, not certainty.

Context-adjusted operator/route performance compares actual metrics to expected performance given corridor/time/weather/road conditions. Show raw and adjusted side by side, sample/coverage, and methodology. Suppress ranking when coverage is materially unequal or below threshold.

## Confidence

Each result scores source freshness, match quality, sample size/diversity, persistence, baseline adequacy and corroboration. Convert to low/medium/high plus numeric detail for methodology. Confidence cannot exceed the weakest essential evidence component. Backtest ETA intervals and risk probabilities; publish calibration measures.

