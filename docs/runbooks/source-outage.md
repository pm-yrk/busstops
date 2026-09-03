# Upstream source outage

## How you know

- `/v1/sources/health` shows a source as `degraded`, `stale` or `down`.
- The Pro Control Tower source-health tile names it, and the coverage warning appears.
- A collection run reports a fall in acceptance rate, which usually means schema drift rather
  than an outage.

## What the platform already does, without you

- The circuit breaker opens after repeated failures, so a dead source is not hammered.
- Responses carry `degradation: partial_sources` or `scheduled_only`, and the interface says so.
- Previous-good artifacts stay live; freshness ages visibly rather than data disappearing.
- Reliability metrics exclude the outage window from the denominator, so a dead feed is never
  reported as cancelled services.

## What to do

1. Confirm the scope. One source down is partial coverage; all live sources down for a viewport
   is scheduled-only. Both are handled; neither needs an emergency change.
2. Check whether it is an outage or **schema drift**. A falling acceptance rate with a healthy
   HTTP status is drift. Capture a sanitised sample, add it to the contract fixtures, and fix the
   parser — do not loosen validation to make the errors stop.
3. If the outage is prolonged, confirm the interface is honest about it: open the affected area
   and read what a passenger would see.

## What not to do

- Do not fill the gap with the last known value presented as current.
- Do not disable validation to increase throughput. The rejects are the signal.
- Do not raise the polling rate to "catch up". A struggling source is not helped by more traffic,
  and the budget is spent either way.
