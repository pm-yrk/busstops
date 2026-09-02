# 03 — Site map and UX

## Global navigation

Primary: Live Map, Journey, Disruptions, Pro, Search. Secondary/account: Saved, Methodology, About, preferences/sign-in. Keep current area and data-freshness state visible. URLs must be shareable and deep-link to stop, route, vehicle session, operator, area, disruption, and Pro views.

## Core passenger journey

1. Open Live with consent-based geolocation or search.
2. See nearby stops and active vehicles within the viewport, not a national payload.
3. Select a stop: open the pixel arrival board, then detailed arrivals.
4. Select an arrival/vehicle: highlight it and show location, age, delay, motion, next stops, disruption evidence, and `Show all stops`.
5. Plan to a searched or map-tapped destination. Evaluate candidate boarding/alighting stops and live arrivals.
6. Explain why the recommended stop wins; offer Fastest, Least walking, Fewest changes.
7. Handoff walking legs to Apple/Google Maps with universal URLs; preserve an in-product itinerary.
8. Link to official ticket purchase only when operator/route mapping and URL are verified. Label the external seller.

## Page requirements

**Home:** only the bold stacked wordmark, pixel-road scene, and one accessible cue/CTA above the fold. Scrolling reveals Live and Pro value, real product views, methodology, sources, and demo CTA.

**Live Map:** locate/search, layer controls, stops/vehicles/congestion/disruptions, map/list parity, freshness legend, viewport fetch, selected-object sheet.

**Search/Nearby:** ranked places, stops, routes, operators and areas; keyboard accessible; tolerate stop codes and route names; show distance and live coverage.

**Stop:** arrival board; stop name, NaPTAN code, locality, routes, accessibility/amenities only if sourced, departures, map, favourite, walk directions, ticket links, and data-source state. Separate live predictions from timetable-only departures.

**Vehicle:** route/destination, last observed location/time, delay, speed with uncertainty, next four stops, expandable all-stops list, recent actual path, scheduled shape, likely diversion/skipped-stop evidence, and no stable public vehicle identifier beyond what licensing/privacy permits.

**Route:** variants/directions, stop sequence, timetable/frequency, operating vehicles, disruption, reliability summary, operator and tickets.

**Journey:** origin/destination, depart-now default, accessible modes, alternative cards, transfer/walk risk, predicted arrival range, confidence, `Will I make it?`, Maps handoff, and ticket links.

**Disruptions/detail:** two rankings—largest delay burden and most abnormal. Each item gives current versus baseline, occurrence frequency, duration, routes/vehicles, evidence/cause status, forecast/official context and recovery trend.

**Weather/risk:** forecast and observed weather, official flood notices, rain-sensitive corridors, carefully worded associations, and links to official warnings.

**Operator/network:** public factual overview, coverage caveats, current health, routes and trends. Avoid league-table claims below sample thresholds.

**Saved:** local-first favourites without sign-in; sync is optional after explicit account consent.

**Pro:** public read-only demo entry. Filters and drilldowns must work. Demo data is either live public data or an explicitly dated snapshot—never masquerading as live.

## Bus Stopped?

Trigger is user-invoked and may be gently suggested when the selected bus has not moved beyond the noise radius for a configured period, its ETA confidence has collapsed, or the user has waited beyond the predicted range. Never claim breakdown/cancellation without evidence.

The panel shows: last reliable observation; whether other buses are moving; known incident/road/weather evidence; next useful service; alternative stop/route; walking/public navigation handoff; operator/travel-information link; accessibility/safety note; and emergency guidance limited to “contact emergency services if you are in immediate danger.” Do not infer or collect vulnerable-person status.

## State design

Every page handles loading, empty coverage, no vehicles, upstream outage, quota-degraded, stale, partial London/non-London source, denied geolocation, offline/cached, and invalid deep link. Loading bus yields to skeleton/content. Stale data remains usable with timestamp and scheduled fallback.

