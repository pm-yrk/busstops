# 09 — Bus Stops Live

## Live map

Default to current location after permission, otherwise a national overview/search. Fetch by viewport and zoom; cluster and cap results. Toggles: stops, buses, congestion and disruptions. List view provides equivalent information. Selected buses update without resetting map or screen-reader focus.

## Stop arrival board

The first selected-stop surface is a pixel digital board. It displays stop name, stop code, `NEXT BUS`, route, destination, countdown/clock time, live/scheduled indicator, and last update. Show a few rows with `View all departures`. Handle `due`, departed, cancelled only when sourced, timetable-only, stale, and no-service states. Countdown never becomes negative or implies false precision.

## Tracking a vehicle

Show the physical bus marker, direction, route/destination, source time/age, delay, approximate movement, confidence, next four stops and expandable full sequence. Passed stops are subdued; future stops show predicted ranges. Overlay recent actual trace and scheduled shape. Explain likely congestion/diversion with evidence and cautious language.

## Will I make it?

Compare privacy-preserving walking time to the stop with bus ETA interval and a configurable boarding buffer. Output “You should make it,” “It may be tight,” or “You’ll probably miss this one,” plus walking time, ETA range, spare/deficit range, confidence and next useful service. Do not use precise user location server-side unless required for a requested plan; do not persist it.

## Bus Stopped?

Provide recovery help as specified in UX: current evidence, alternatives, other stops, next buses, Maps handoff and official contact/travel information. A stationary marker may reflect a terminus, layover, congestion, stale feed, GPS issue, or stopped service; enumerate plausible states and never assert a breakdown without official evidence.

## Favourites and notifications

Stops, routes and regular journeys save locally without account. If notifications are implemented, they are opt-in, bounded, useful, and do not create paid workloads. Account sync is optional. Provide clear removal/export controls.

## Ticket purchase

Show `Buy tickets` only for verified operator/route destinations from the allowlisted registry. Open external links with safe attributes and identify the seller. Avoid promises about price, availability, validity or acceptance. If mapping is ambiguous, show the operator’s information page instead.

## Accessibility and degraded operation

Map is never the only way to use Live. All markers have list equivalents. Announce material updates politely without streaming every coordinate. Under source failure/quota pressure, show cached locations with age, scheduled departures, route geometry and alternative official links. Offline PWA may retain favourites and recent static data but must mark it offline.

