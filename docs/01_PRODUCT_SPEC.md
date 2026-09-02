# 01 — Product specification

## Product and promise

Visible brand: **Bus Stops.** The full stop is part of the name. Products are **Bus Stops Live** and **Bus Stops Pro**. Repository and code identifier: `busstops`.

Bus Stops. converts public live vehicle, timetable, stop, road, weather, and flood information into passenger guidance and operational intelligence. Its core promise is explanation, not dots on a map:

- Live: “Know where your bus really is, what is delaying it, and what to do next.”
- Pro: “Know how the network is really performing, what is abnormal, and what needs attention.”

## Users

Passengers need trustworthy arrivals, physical bus location, smart stop choice, journey guidance, and recovery help. Pro users include controllers, operations and performance managers, operators, local/combined authorities, planners, analysts, consultancies, and senior leaders. Recruiters and evaluators must be able to explore the public Pro demo without credentials.

## Scope

Initial production scope is all supported local bus services in England: BODS outside London and TfL within London, joined through shared contracts. Development fixtures may be small; production schemas, pipelines, maps, search, and configuration may not be geographically hard-coded.

Required public surfaces: home, Live map, search/nearby, stop, vehicle, route, journey planner, disruptions, disruption detail, weather/risk detail, operator, network/area, favourites, methodology, about, privacy, terms, contact, and sign-in/preferences.

Required Pro surfaces: Control Tower, Live Operations, Routes, Operators, Congestion, Analytics, Disruptions/Alerts, Reports, Daily Brief, Daily Brief Settings, and Pro Settings.

## Product principles

1. Show provenance, freshness, uncertainty, and missing coverage honestly.
2. Prefer a useful explanation over an unexplained score.
3. Separate observed fact, derived inference, and forecast.
4. Use cautious wording: “likely diversion,” “possible speed anomaly,” and “rain-associated disruption” unless official evidence confirms a cause.
5. Explain whether a problem is typical for the comparable time, not merely whether it is slow.
6. Make the fastest action obvious on mobile.
7. Do not expose personal location beyond the device/session unless the user explicitly saves a preference.

## Required features

Live vehicles; nearby stops; live/scheduled departures; vehicle next stops and full route; actual recent path versus scheduled path; delay and movement; route/stop/operator/place search; “Will I make it?”; **Bus Stopped?** help; journey planning ranked by fastest, least walking, or fewest changes; nearest-versus-fastest stop explanation; Google and Apple Maps walking handoff; favourites; disruption, congestion, diversion, bunching, service-gap, speed-anomaly, weather and flood context; official ticket-purchase links where verified.

Pro requires network health, punctuality, reliability, average delay, headway adherence, bunching, gaps, skipped-stop evidence, likely diversions, congestion and abnormal congestion, delay origins, speed anomalies, weather sensitivity, flood susceptibility, route risk, raw and context-adjusted operator performance, reports, data-quality monitoring, and a professional morning Daily Brief.

## Explicit exclusions

- No network Replay or indefinite raw-location history.
- No claims to replace private fleet, driver, maintenance, revenue, duty, or ticketing systems.
- No payment processing; link only to verified official/authorised ticket sellers.
- No paid AI dependency. Narrative generation must work deterministically.
- No background location tracking by default.

## Success measures

Coverage and freshness by source/area; stop/vehicle/journey task completion; ETA calibration; journey recommendation regret versus alternatives; alert precision; analytics confidence/sample coverage; Daily Brief delivery; accessibility; responsiveness; error rate; and zero chargeable normal operation.

