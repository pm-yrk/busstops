# ADR 0007 — The edge reads cheaply and computes expensively, and the computing is the problem

Status: in progress, 2026-10-27. Part A decided and deployed, its target not met; Part B profiled,
and the profile settles that the current algorithm cannot reach the budget by any arrangement.

## Context

[ADR 0006](0006-the-limit-is-cpu-and-it-is-ten-milliseconds.md) ended the diagnosis: Cloudflare
classifies these failures as `exceededCpu`, the Workers Free limit is ten milliseconds of CPU per
request, and this Worker was spending ten to twenty-four times it. It also located the spend, and
the location was the surprise — **not** the R2 reads that three ADRs of work had been about:

| Endpoint       |     CPU | Over | Where it went                                  |
| -------------- | ------: | ---: | ---------------------------------------------- |
| `/v1/map`      |  ~96 ms |  ×10 | ~88 ms normalising BODS SIRI-VM                |
| `/v1/journeys` | ~243 ms |  ×24 | ~183 ms graph search, ~37 ms parsing trip rows |

Two independent projects, then, and this ADR takes them one at a time. Mixing them would make
neither measurable.

## Part A — the live map

### What the normalisation actually cost

Split by stage on a 542,940-character, 437-vehicle viewport:

| Stage                                       |      CPU | Share |
| ------------------------------------------- | -------: | ----: |
| `fast-xml-parser` DOM of the whole document | 23.84 ms |   68% |
| Zod `safeParse` per vehicle                 |  7.61 ms |   22% |
| building `VehicleObservation` records       |  3.29 ms |    9% |

The stage split is noisy — a DOM parse of half a megabyte triggers collection, and one run put the
DOM above the DOM-plus-Zod total — so the end-to-end figures are the ones to trust. The shape is
not in doubt: the document tree dominates.

### The cheapest source, checked rather than assumed

BODS was asked, against the live service, for everything it would serve this project:

| Source                |      Bytes |           Vehicles | Decode                                 | Passenger fields                                                                                 |
| --------------------- | ---------: | -----------------: | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| SIRI-VM, viewport box |    652,340 |                505 | 44.77 ms generic / **1.99 ms scanned** | line name, destination, origin, direction, operator, block, journey ref, bearing, position, time |
| GTFS-RT, viewport box | **75,801** | ~1,985 entity tags | not implemented                        | vehicle id, trip id, route id, position, bearing, timestamp                                      |
| GTFS-RT, no box       |   HTTP 403 |                  — | —                                      | —                                                                                                |
| SIRI-VM, no box       |   HTTP 403 |                  — | —                                      | —                                                                                                |

GTFS-RT **is** available and is 8.6 times smaller — `0a0d0a03322e30…` confirms a protobuf
`FeedMessage` whose header says "2.0". It is not adopted, for a reason that is about passengers
rather than bytes: it identifies a route by `route_id` and a trip by `trip_id` from the static GTFS
feed, and carries no passenger-facing line name and no destination text. This artifact is built
from TransXChange and NaPTAN, so those identifiers have nothing here to join to — adopting GTFS-RT
would mean a new dependency, a protobuf decoder, a new identifier crosswalk, and a map whose
markers lost their route number and destination until that crosswalk existed. The SIRI scan already
meets the budget, so the cheaper wire format buys nothing worth that.

Both endpoints refuse a request with no bounding box, which also settles something from ADR 0006:
the Worker's `west,south,east,north` is the order BODS reads, and a feed is already scoped to the
viewport.

### The decision: scan, do not parse

`scanSiriVehicles` walks the XML text, finds each `<VehicleActivity>`, reads the twelve tags inside
it with bounded `indexOf`, and builds no document tree and no schema. **1.99 ms against 44.77, on
the real feed, for the same 505 vehicles.**

The full normaliser is untouched and still right — for the collector, which runs in CI where CPU is
free and publishes the complete `VehicleObservation` shape for the analytics batch, and for
`/v1/vehicles/:ref`, which builds exactly one.

Four things cost measurement to get right, and each is a test:

- The scan first reported **436 of 437 vehicles with no rejections** — a silently missing bus,
  because the cursor began past the first opening tag. A count that disagrees with the normaliser's
  is now asserted.
- Folding the salt into the vehicle hash once instead of per vehicle took the scan from 4.2 ms to
  2.73. FNV-1a is sequential, so this is bit-identical by construction and tested against the
  one-shot form.
- Reading the four selected-bus fields for every vehicle cost 1.5 ms of a 4 ms budget — five
  hundred buses' worth of strings so that one could be described. They are opt-in, and
  `/v1/vehicles/:ref` is the only caller that asks.
- A text scan has failure modes a DOM parser does not: namespace prefixes, a longer tag ending with
  the name wanted, attributes on an element, undecoded XML entities, and a field read from the next
  vehicle because the range was unbounded. Five tests, one for each.

### Deployed, and what is left

Measured from `wrangler tail`, three paced rounds across the five probe cities — per-invocation CPU
with the outcome beside it, because the absence of a 1102 is not proof:

| Endpoint       |   p50 CPU | p95 CPU | max CPU | `exceededCpu` |
| -------------- | --------: | ------: | ------: | ------------: |
| `/v1/map`      | **38 ms** |   97 ms |   97 ms |       1 of 12 |
| `/v1/journeys` |    105 ms |  754 ms |  754 ms |       8 of 15 |
| `/v1/nearby`   |      6 ms |   36 ms |   36 ms |       0 of 14 |
| `/v1/search`   |     10 ms |   16 ms |   16 ms |       4 of 12 |

| City       | Vehicles | Source age | Map answered | 1102 |
| ---------- | -------: | ---------: | -----------: | ---: |
| Leeds      |      229 |      393 s |       3 of 3 |    0 |
| Manchester |      300 |      577 s |       3 of 3 |    0 |
| Birmingham |      300 |      561 s |       2 of 3 |    1 |
| Bristol    |      226 |      570 s |       2 of 3 |    1 |
| York       |       73 |      542 s |       3 of 3 |    0 |

**The map went from about 96 ms to a p50 of 38, and the target was 7.** Part A's decision is right
and deployed; Part A is not finished.

What remains is not the live feed. It is proportional to the rows a city viewport _contains_
rather than to the markers it draws: Manchester holds 3,006 projection rows inside the box and the
map shows four hundred. Local stages, which Cloudflare bills at roughly 2.7 times:

| Stage                                                  |     CPU |
| ------------------------------------------------------ | ------: |
| walk the projection lines (3,006 kept of more scanned) | 2.09 ms |
| parse those 3,006 rows                                 | 5.55 ms |
| rank and build the four hundred                        | ~4.4 ms |
| scan the live feed                                     | 1.99 ms |

Building only the rows that survive the ranking is now done — exactly output-preserving, asserted
row by row against the eager form — and is worth seven tenths of a millisecond, because both forms
still haversine and sort all 3,006.

### A floor I stated, and why it was wrong

The paragraph that stood here costed a next step — select the four hundred markers before parsing
any of them — at about nineteen milliseconds on Cloudflare, and then declared a floor of fifteen,
on this reasoning: the selection makes the _parse_ proportional to the four hundred markers drawn,
but the _walk_ stays proportional to the 878,854 characters a city viewport contains, and walking
that text is unavoidable. The conclusion drawn from it was that only a display-oriented projection
— a new artifact family, and a product decision about what the map shows when zoomed out — could
move the number, so the target could not be met by optimisation.

**The premise was false, and it was my own assumption rather than a measurement.** A viewport does
not have to walk every tile in its box. Tiles are opened nearest-first, and a bounded selection
knows, as soon as it is full, the distance of the worst marker it is holding: `tileFloorMetres`
floors the distance from the middle of the box to anywhere inside a tile, so a tile whose floor
exceeds that distance cannot contain a marker that would be kept. It is then not fetched, not
decoded and not walked. The bound is exact — it gives up a factor of at most √2 by taking the
larger of the two axis separations rather than their hypotenuse, and one per cent on the
longitudinal term, both so that it can never be too high — so the answer is the same set of
markers, not an approximation of it.

Deployed, on real tiles: a Manchester viewport opens **2 tiles of 8** and walks **217,947
characters of 616,598**.

### Deployed again, with the selection in

| Endpoint       |            p50 CPU |            p95 CPU |        `exceededCpu` |
| -------------- | -----------------: | -----------------: | -------------------: |
| `/v1/map`      | **16 ms** (was 38) | **56 ms** (was 97) | 0 of 8 (was 1 of 12) |
| `/v1/nearby`   |       3 ms (was 6) |     28 ms (was 36) |               0 of 9 |
| `/v1/search`   |     10 ms (was 10) |     14 ms (was 16) |               1 of 5 |
| `/v1/journeys` |   194 ms (was 105) |   573 ms (was 754) |               4 of 8 |

Every one of the fifteen map requests across the five cities answered, and the characters each one
decoded fell with them: Manchester 217,947, Birmingham 177,381, Bristol 140,539, York 105,577.

Two corrections to my own measurements belong with that, because both were reported and both were
wrong:

- The local harness timed the two viewport forms once each and reported the one that reads a third
  of the bytes as the **slower** of the two, 8.42 ms against 7.54. That is a measurement of JIT
  state: the eager form ran on code paths two earlier stages had already warmed, and the selected
  form ran cold on a heap, a haversine and a tile bound the process had never executed.
  Cloudflare's tail measured the same pair at 38 ms and 16. Comparisons in that script now warm
  both and take a median of seven.
- That script's live stage timed `normalizeSiriVm` only, so it kept reporting ninety-nine
  milliseconds for a parse no passenger request has made since the scan replaced it. It times the
  scan now, with the normaliser beside it.

### A fallback removed, and the gap it turned out not to explain

The map read the viewport's **pattern geometry** whenever any bus in it arrived without a line
name, so that the bus could be matched to a route by its shape. A dense city's pattern tile reaches
3,935,975 bytes, a viewport spans several, and `serviceNames` follows them. That is not a fallback a
passenger request can hold — a fallback that itself exceeds the limit is not one — and whether a
request paid it depended on whether a third party had filled in `PublishedLineName`. So the map
does not read it at all any more.

Two things are given up, and both are now visible rather than silent:

- A bus whose feed publishes no line name is drawn as a bus with no route label. The ledger counts
  how many, because that count is what says whether a cheap way of naming them is worth publishing.
- No marker carries a service id, so the web app emphasises a selected route by the number on the
  front where it has no identity to go on. In a viewport holding two different 36s, both are
  emphasised. That reverses a deliberate earlier decision and the code says so: identity still wins
  wherever a bus has it, and the alternative was drawing a selected route with every bus on it as
  context, which is a road that looks empty.

**It did not move the p95, and I had said it would.** The commit that removed it claimed the
geometry read was what the gap between a p50 of 16 and a p95 of 56 consisted of. The next walk
measured the map at a p50 of 14 and a p95 of **66**, with 2 of 7 invocations exceeding CPU where
the walk before it had 0 of 8 — and the characters each city decoded were identical to the
character across both: Leeds 265,801, Manchester 217,947, Birmingham 177,381, Bristol 140,539,
York 105,577. Identical totals mean the geometry was never read in either walk. The branch was
reachable and worth removing on its own terms; it was not the explanation, and the claim was a
guess dressed as a measurement.

What the two walks do establish is that seven map invocations are not a p95. Two deployments
decoding byte-for-byte the same characters reported 56 and 66, and 0 and 2 exceeded. So the next
measurement widens the sample — six rounds rather than three — and splits the invocations by
whether they were the **first their isolate ever served**, which is the hypothesis that fits the
shape: a cold request pays for the index record, a single 144,948-character line, and for an empty
shard cache, and nothing in the per-endpoint table could tell that apart from an expensive branch.

### Why the live feed stays in the request

The fallback position, if no request-time format could fit, was to move the normalisation out of
requests entirely: a collector reads BODS, normalises once, publishes a compact current-live
artifact, and the passenger Worker reads and filters it. It is the right shape, and it is not
available here at no cost with live freshness. Two measurements settle it:

- **A Cloudflare Cron Trigger on Workers Free gets the same ten milliseconds of CPU** as an HTTP
  request — Cloudflare's own limits table lists "CPU time per Cron Trigger: Workers Free 10 ms",
  and an account may have five of them. A collector running there hits exactly the wall it exists
  to get the passenger path away from, and worse: BODS answers 403 to a request with no bounding
  box, so national coverage is one fetch and one scan per region rather than one of each.
- **GitHub's scheduled workflows are the free compute this project already has, and they miss
  runs.** That is recorded in this repository's own history, not assumed. A collector whose
  freshness guarantee is "about every five minutes, unless the schedule slips" cannot be what a
  live bus map reads, and solving CPU by letting positions go stale is not solving it.

The scan fits instead, measured: 1.99 ms locally for the real 505-vehicle feed, against a
sub-budget of four. So the live feed is fetched per request, and whatever is left between the
map's measured CPU and the seven-millisecond target is not in it.

## Part B — the journey planner

Measured, not yet decided, because Part A is not finished and two architectural changes in one
deployment are two changes nobody can attribute.

The search is already RAPTOR-shaped — round-based earliest arrival, where the round a stop is first
reached in _is_ the number of changes — which is the right family for scheduled transport. So 183
milliseconds over 250 stops and 1,390 trips is a question about repeated work, and three candidates
are visible in the code before any profile:

- `boardingIndex(trip, stopId, readyAt)` calls `effectiveStopTimes(trip)`, which allocates a fresh
  array of stop-time objects for a delayed trip, and then the caller calls it **again** on the next
  line. Twice per `(stop, trip)` pair per round.
- `improve()` is handed a fully built `StopLabel` _and_ a nested `leg` object for every alighting
  stop of every boarded trip — before it decides whether to keep it. Most are rejected, so most of
  that allocation is garbage.
- Each round copies the previous round's entire label map.

`runRaptor` now takes optional counters so those can be counted rather than guessed at, and
`scripts/profile-journey-search.ts` runs the real planner over a real corridor across the four
query shapes a planner has to serve.

### What the profile measured, and what it settles

All three guesses were right about the mechanism and wrong about the scale, because the corridor a
real query opens is much larger than the capped slice the first measurement used. On the published
artifact, with both semantics-preserving fixes in:

| Query                   | Stops |  Trips | Transfer edges | `buildGraph` | `plan` |
| ----------------------- | ----: | -----: | -------------: | -----------: | -----: |
| Leeds, neighbourhood    | 1,396 |  6,919 |         61,060 |       230 ms | 489 ms |
| Manchester, normal      | 2,063 |  9,526 |        108,284 |       520 ms | 295 ms |
| Birmingham, cross-city  | 2,737 | 13,793 |        126,952 |       911 ms | 947 ms |
| Bristol, several change | 1,443 |  6,006 |         47,036 |       253 ms | 197 ms |
| York, park and ride     |   860 |  1,204 |         28,670 |        87 ms |  50 ms |

The two fixes are in and both preserve the answer exactly, asserted against the brute-force oracle:
`improve` is split into a test that answers from the two label maps alone and an `accept` that
builds nothing until the label is wanted, and a trip's effective times are computed once per scan
rather than twice. The counters show the second: `effectiveStopTimesCalls` now equals `tripScans`
where it was double. Manchester's search went 377 ms to 295, Leeds 624 to 489, Birmingham 1,139 to 947. The accept rate is what the first fix was aimed at and it is unchanged by design —
**6,510,009 offers against 24,105 acceptances, a rate of 0.004** — so what the fix removed was
thirteen million object allocations rather than the comparisons.

**B2 is therefore answered, and the answer is no.** A budget of four to five milliseconds for the
search and two to three for decoding the artifact is between forty and two hundred times below
what the optimised form of this algorithm does, and the remaining costs are structural rather than
incidental: `buildGraph` is an O(n²) haversine over 860 to 2,737 stops to produce 28,670 to 126,952
transfer edges, and it is rebuilt from scratch on every request although nothing in it changes
between requests. Parsing the trips is 37 ms for 8.4 MB of JSON before the search begins. No
arrangement of this code reaches ten milliseconds.

So the work is a query-ready representation: transfers precomputed and published, trips held as
integer times in typed arrays rather than as objects, stops interned to integer indices, and a
search that reads them in place. The free-plan constraints that shape it are already known —
`getStream` hands a Worker raw bytes, so a binary artifact needs no text decode at all, and the
store's `put` is text-only today, so writing one needs a byte path beside it.

The golden corpus is recorded first, and it is: `scripts/journey-corpus.ts` planned twenty
queries — four shapes in each of the five probe cities — against the deployed artifact and the
current planner answered **20 of 20**. `scripts/compare-journey-plans.ts` holds a candidate against
it and reports the five numbers separately, because a candidate that is 95% identical and loses one
journey in twenty is not acceptable and a single agreement percentage would hide it.
