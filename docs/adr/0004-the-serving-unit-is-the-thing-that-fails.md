# ADR 0004 — The serving unit, not the request count, is what fails

Status: accepted, 2026-10-22.

## Context

A Workers Free invocation gets ten milliseconds of CPU and a 128 MB isolate, and Cloudflare answers
an invocation that runs out of either with error 1102 and its own HTML page. That page carries no
CORS header, so a browser reports it as a CORS failure and a probe reports it as HTTP 503 — neither
description names the limit, which is why this took several wrong diagnoses to pin down.

Three were tried and measured away.

**It is not a cold path.** Thirty-three first-contact requests across five cities all passed while
twenty-five warm ones lost seventeen. A failure that gets _worse_ with warmth is not a failure of
the first read.

**It was partly accumulation, and that part is fixed.** Residency grew only after a bus tap, by
each tap's own decode to within a percent — +2.54, +2.95, +3.30, +1.79, +1.30 MiB. The vehicle
endpoint's pattern read now does not populate the shard cache (`retain: false`), and the deployed
walk went from losing seventeen of twenty-five to sixty-six of sixty-six passing on a single isolate
with residency flat at zero throughout. Every ledger in that run reported `residentBefore: 0`,
because the reads that matter are all filtered reads and a filtered read has never been allowed to
answer as though it were a whole tile.

**It is not a request rate either, and a gate would have hidden it.** With accumulation gone, the
same deployment answers 1102 as soon as four requests arrive together — which is what one page load
is. In run 39757394852 `/v1/map` returned the platform's error page in all four page loads, while
sixty-six paced requests in a row to the same endpoints passed.

What is left is the size of one serving unit. The deployed read ledger, per request, at its worst
city:

| Endpoint            | Chars decoded | Where they came from                               |
| ------------------- | ------------- | -------------------------------------------------- |
| `/v1/vehicles/:ref` | 3,326,175     | one pattern-index tile, 3,304,326                  |
| `/v1/journeys`      | 4,209,004     | map projection 2,182,908 + pattern index 2,026,096 |
| `/v1/map`           | 2,182,908     | map projection, four quarter-degree tiles          |
| `/v1/routes/:id`    | 2,137,297     | map projection 1,681,864 + route patterns 498,231  |
| `/v1/stops/:id`     | 2,026,096     | one pattern-index tile                             |
| `/v1/nearby`        | 1,867,706     | the text-search index                              |
| `/v1/search`        | 629,397       | one search prefix bucket                           |

A single two-megabyte decode fits in ten milliseconds when it has the isolate to itself. Four of
them do not, and no amount of correctness in the response makes that survivable.

## Decision

Make the object a passenger endpoint reads smaller, and make the lookup behind it more targeted.
Not: a concurrency gate, a retry, a longer timeout, a hidden 1102, paid infrastructure, or a
response that has quietly stopped being true.

Four things follow from the table, in the order their numbers argue for.

**A stop's routes are looked up by the stop's id.** `network/stop-services` is a thousand hashed
buckets of `[stopId, serviceIds]`; a board reads one bucket, parses one line, and spends 56 KB
instead of 2.03 MiB. It replaced two geographic reads, and the second one was the surprise: a busy
board's departures name their patterns, so `patternsByIdsNearStop` was already testing an id per
line rather than parsing a tile — but the tile's text has to be walked either way, and that is
where the megabytes were. It is also the better answer. The patterns a board's departures name are
the routes with a bus due in the next ninety minutes, so the old list quietly dropped a route whose
last bus had gone.

**The map projection is read on its own grid, and which grid is a build-time choice the artifact
records.** A quarter of a degree is about 28 km by 17 km here and a city viewport is a tenth of
that, so the over-read is geometric and the only lever is the square. The projection is read by
`/v1/map`, `/v1/journeys`, `/v1/routes/:id` and now `/v1/nearby`, which is why it is the one change
worth making first. `NetworkReader` takes the grid from the index's declared layout rather than
from a constant of its own, so a build may change it without a deploy and an artifact written on
either grid is readable by either Worker.

**"What is near me" is answered from the map projection, not from the text-search index.** A search
tile carries places, routes, operators, areas and postcodes, and for every one of them the tokens
and codes that make typing work; `nearbyStops` then kept the stops and threw the rest away.

**The build is given the wall clock it needs.** The bootstrap step's limit was 110 minutes, chosen
when a bootstrap took 43. The national build now spends 99, so two attempts at a finer grid both
died at 110 minutes to the second with nothing published at all — and an artifact that is never
published serves nothing, which made the serving saving of those runs exactly zero. Actions minutes
are free and unlimited on a public repository; the job allows 240 and the steps after the bootstrap
take about 35, so 165 keeps what the limit is for while leaving the retiling affordable.

## Consequences

The tests that protect this are structural, and deliberately so: CI time is not Cloudflare CPU, and
a timing assertion on a GitHub runner would be noise pinned to a number. What is asserted is which
objects an endpoint opens — a board must open no pattern-index tile, a nearby list must open no
search tile, a bus tap must open only the tiles around the bus and must not leave them resident.

Three costs are accepted.

A new family is new storage, and the bucket is close enough to R2's ten-gibibyte allowance that
"small" is not a good enough answer. The publish counts its own bytes as it goes, refuses to write
an index past a quarter of the allowance, and reports every family's objects, bytes and minutes, so
the next family's cost is a measurement rather than an estimate.

A finer grid is more objects to write, and the publish is write-bound. That is why the grid is a
dispatch input: a run can be asked for one, and the publish either fits in the time or it does not.

And a board now names every route that calls at a stop rather than only the ones with a bus due,
which is a change in what the endpoint says. It is the more useful statement and the more accurate
one, but it is a change, and `routesComplete` continues to mean what it meant: whether that list is
all of them. The direct lookup is trusted unless the board's own departures contradict it — a stop
with buses due and no row in the index is a disagreement inside one artifact, and publishing "no
routes, and that list is complete" is not the honest response to it.
