# 11 — Journey planning

## Objective

Recommend the stop and itinerary that best meets the passenger’s chosen objective using current predictions—not merely the geographically nearest stop. A destination may be a search result or map-tapped coordinate.

## Graph and candidates

Build a time-dependent multimodal graph from current schedule versions, stop hierarchy, route patterns, transfers and an OSM-derived walking network or licence-compliant bounded routing service. Generate sensible origin/destination stop candidates using walk-network time, not crow-flight distance; cap radius/count and expand only if no plan exists.

## Cost

For each itinerary estimate:

`origin walk + wait/live arrival + in-vehicle predicted time + transfer walks/waits + destination walk + reliability penalty`

Use time-dependent Dijkstra/RAPTOR/CSA or equivalent. Incorporate live departure intervals, current segment delay/congestion, disruption and transfer probability. Avoid double-counting the same delay in ETA and penalty.

Rank modes:

- **Fastest:** earliest calibrated destination-arrival estimate, with reliability tie-break.
- **Least walking:** minimize walking subject to a reasonable maximum arrival penalty.
- **Fewest changes:** minimize boardings subject to reasonable arrival/walk bounds.

Return a small diverse Pareto set, not near-duplicates.

## Smart fastest stop explanation

Compare the winning boarding stop with the nearest feasible stop. When different, say: “Stop B is a 6-minute walk, but its useful bus is expected sooner; it should arrive about 9 minutes earlier than using Stop A.” Give ranges/confidence and avoid a claim when the difference falls inside uncertainty.

## ETA and transfer confidence

Combine source prediction where available with schedule, matched vehicle progress, dwell/segment baselines and current incidents. Return intervals and a reason code. Transfer succeeds only if lower-bound arrival plus walk/interchange buffer is compatible with the next leg; penalize fragile transfers. Re-plan when a selected leg changes materially.

## Navigation handoff

Provide Apple Maps and Google Maps universal direction URLs for walking to the exact selected stop and, optionally, the final walking leg. Auto-suggest based on platform but allow a saved choice. These are URL handoffs, not paid embedded API calls. Validate/encode coordinates and labels.

## Constraints

Support depart now first; later departure is desirable when schedule coverage is sound. Add wheelchair/step-free options only when data can support them and clearly state coverage. Never invent accessibility. Cache request fingerprints briefly without raw personal coordinates in logs. Rate-limit and bound search complexity.

## Testing

Fixtures cover nearest-not-fastest, missed/fragile transfers, stale live data, no live coverage, midnight/DST, circular routes, variants, terminus layover, cancelled/missing journeys, disrupted segments, walking barriers and map-tapped destinations. Compare algorithm output to brute-force results on small graphs.

