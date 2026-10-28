# ADR 0007 — The edge reads cheaply and computes expensively, and the computing is the problem

Status: in progress, 2026-10-28. Part A deployed and measured: the map is at 13 ms warm against a
target of 7, and the live feed is no longer measurable in it. Part B deployed and measured: the
search is twenty times faster and the planner is still what refuses most of the other endpoints'
requests, which makes it the highest-value work on the platform rather than the second item.

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
sub-budget of four.

And the deployed walk now says the same thing from the other side. The CPU walk takes the five
cities twice, once normally and once after redeploying with `liveVehicles` off, each walk proving
the flag landed before it measures anything. Thirty requests each, CPU bucketed by how many
requests the isolate had already served:

| Isolate age  | Live feed on | Live feed off |
| ------------ | -----------: | ------------: |
| first        |        61 ms |         69 ms |
| 2nd to 5th   |        18 ms |         18 ms |
| 6th to 20th  |        13 ms |         15 ms |
| 21st onwards |        13 ms |             — |

**The live feed is not measurable in the map's CPU.** The walk without it is, if anything, a
millisecond or two higher, which is isolate warm-up rather than a cost of not fetching. So Part
A's live sub-budget is met twice over, and the thirteen milliseconds a warm map spends are its
projection read, its four hundred markers and its response — not BODS.

### Part A's verdict

| Measure                               | Target |                               Measured |
| ------------------------------------- | -----: | -------------------------------------: |
| Live decode and normalise             | ≤ 4 ms | 1.99 ms local, not measurable deployed |
| `/v1/map` total, warm                 | ≤ 7 ms |                              **13 ms** |
| `/v1/map` total, first in its isolate | ≤ 7 ms |                           **61–69 ms** |
| `exceededCpu` on the map              |   zero |         1 of 14, and it was a cold one |

The live normalisation is gone from the request path, the viewport read is proportional to what the
map draws rather than to what the city contains, and the one branch that could put a pattern tile
on the path is gone. From about 96 ms to 13. **The seven-millisecond target is not met**, and the
two reasons are measured rather than guessed: a warm map spends its thirteen milliseconds on work a
passenger can see, and a cold one spends sixty on module evaluation, the index record and an empty
cache, which no handler-level change reaches.

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

### The search, after the scan became route-centric

Measured on the published artifact, against the same corridors as the table above:

| Query                  | `plan` before | `plan` after | Offers before | Offers after |
| ---------------------- | ------------: | -----------: | ------------: | -----------: |
| Leeds, neighbourhood   |     488.65 ms | **35.24 ms** |     6,810,668 |       32,910 |
| Manchester, normal     |     294.86 ms | **28.48 ms** |     6,510,009 |       39,313 |
| Birmingham, cross-city |     947.09 ms | **50.68 ms** |    10,080,270 |       42,750 |
| Bristol, several       |     197.25 ms |  **9.49 ms** |     4,454,522 |       14,186 |
| York, park and ride    |      50.13 ms |  **8.15 ms** |       729,135 |        8,165 |

Ten to twenty times faster, and the counters say why: Manchester offers 39,313 alighting labels
where it offered 6,510,009, and scans 2,673 trips where it scanned 442,670. The answers are the
same answers — the oracle in `route-scan.test.ts` holds two hundred generated timetables against
exhaustive enumeration, and it is what caught the overtaking case that made the first version of
this wrong.

`buildGraph` is **larger** in that run, not smaller: Manchester 519 ms to 567, Birmingham 911 to 964. That run carried the route scan and not the transfer grid, so it pays the quadratic walk and
the route grouping both. On a synthetic corridor of the same shape the grid takes the graph build
from 636.8 ms to 42.2 — same 44,226 edges either way — so the next measurement on real corridors is
what settles where it lands.

### A rewrite that measured slower, and was reverted

The obvious next step looked like interning stops to integers and holding the search's labels in
typed arrays: the search makes two `Map.get` calls on a thirty-six-character UUID per alighting
offer, and at 105,894 offers in fifty milliseconds — about 470 nanoseconds each — that is hashing
rather than arithmetic.

It was built: stop ids numbered once in `buildGraph`, routes carrying `Int32Array` stop indices,
walking transfers as a flat adjacency of three typed arrays, and the search's three hot lookups as
array reads with the label objects built only on acceptance. Every test passed, including the
oracle. Benchmarked over eleven iterations against the maps it replaced, on identical input:

|              | string-keyed maps | integer indices |
| ------------ | ----------------: | --------------: |
| `buildGraph` |           44.5 ms |         81.3 ms |
| `plan`       |          103.0 ms |        133.5 ms |
| `runRaptor`  |           51.9 ms |         73.8 ms |

**Forty per cent slower, so it is not in the tree.** Part of that was a real mistake — the flat
transfers were built by walking the grid twice and by calling the object form first, so they
allocated the 44,226 objects they existed to avoid and the arrays as well — and fixing it recovered
some of the graph build. Part was reading the typed arrays off a graph object that now carries
lazily-built maps as getters, which puts it in dictionary mode so every `graph.transferTo` inside a
loop is a hash lookup; hoisting them into locals recovered six milliseconds of the search. Neither
closed the gap, and the remainder is not explained by anything I can point at, which is the
honest state of it.

What that says about the plan is not that integer indices are wrong — a published artifact will
hand the Worker exactly that, and will not pay to build it — but that they are not worth having
while the structure is still built per request.

### A closure costs a microsecond here, and the profiler is what said so

Three data-structure arguments in a row had been settled by benchmarking whole stages, so the next
question went to a V8 profile of forty searches instead. It put **383 ms in esbuild's `__name`
wrapper** — about 9.6 ms a search, a quarter of its cost — and the source was one line:
`earliestBoardable` built a `boardable` helper on every call, 328,600 closures over the run, each
of them wrapped.

`__name` is `Object.defineProperty(target, "name", …)`, which is why it costs about a microsecond
rather than nothing. Written as a loop instead, on the same corridor over eleven iterations:

| Stage       |   Before |   After |
| ----------- | -------: | ------: |
| `runRaptor` |  51.9 ms | 32.7 ms |
| `plan`      | 103.0 ms | 52.6 ms |

`plan` halves because it runs the search twice whenever the boarding explanation needs its
comparison.

**And it is not a local artefact.** The first assumption was that `__name` comes from tsx and the
deployed Worker would not have it. Wrangler's own bundle, taken with `--dry-run --outdir`, contains
454 of them and defines the helper: esbuild keeps function names in both, so a closure created
inside a hot loop costs the wrapper in production too. The viewport's `NearestLines.offer` took a
`() => string` for exactly the right reason — a candidate beaten by the admission price should cost
no slice — and it was costing a microsecond a candidate on a path that offers several hundred per
request. It takes the bounds now, and the heap counts its own slices so that the property the thunk
existed for is still under test.

That also puts the reverted typed-array rewrite in a different light: it was judged against a
search spending a quarter of its time on closure wrapping, which is noise in the middle of the
comparison. It stays out of the tree — the measurement that rejected it is the measurement that was
taken — but the question is open again, and the time to ask it is when the structure arrives from an
artifact rather than being built per request.

The request-time work has taken a Manchester-scale corridor from 1,322.8 ms to 93.5, which is
fourteen times and nine times the budget. The rest is the artifact.

### The most expensive thing in a journey, which the harness could not see

Three rounds of profiling had been spent on the search and the graph, and the search is now
twenty times faster. Then the `__name` finding sent me reading the _deployed_ path line by line
rather than the one the benchmark exercises, and the biggest cost in the endpoint turned out never
to have been measured at all.

`buildGraphFor` converted every stop time like this:

```ts
secondsIntoServiceDay(new Date(departureEpoch * 1000).toISOString(), serviceDate);
```

once for the arrival and once for the departure of every call of every trip. For a Manchester
corridor — 9,526 trips of about twenty-five calls each — that is **476,300 `Date` objects, 476,300
ISO strings and 952,600 `Date.parse` calls**, half of them re-parsing the same midnight, to compute
a subtraction. `Date.parse` of a string `toISOString` has just produced is the epoch it came from,
so the whole expression is `epoch - dayStart` with midnight hoisted out of the loop.

**The harness could not see it because the harness does not do it.**
`scripts/profile-journey-search.ts` builds its trips arithmetically — it always did — so it
measured a Manchester search at 28 ms over a corridor Cloudflare was recording at 337 to 566. I
had read that gap as the runner being faster than the edge. It was the profile skipping the most
expensive function in the request.

The same function created three closures per trip, which at about a microsecond each in the
deployed bundle is thirty milliseconds of its own, and rebuilt every trip's stop-time array for the
corridor whether the corridor had cut anything or not. All four are loops now, and six tests hold
the arithmetic against the function it replaced — second for second, across a winter date and two
summer ones, exact midnight, an awkward minute and second, 23:59:59 and a night bus at 25 hours.

The lesson is about the method, not the bug: a benchmark that reconstructs its own inputs measures
the code it reconstructs them for, and nothing else. The deployed path and the measured path had
drifted apart, and the only thing that found it was reading the deployed one.

### What the journey planner costs every other endpoint

`FeatureFlags.journeyPlanner` had existed since the flags did and nothing read it. That came out
because the acceptance job was changed to run its peak passes once with the planner off — and the
comparison reported the planner failing nine requests of ten with it supposedly off. A measurement
of nothing, reported as a measurement. The flag is honoured now, with its own error code, and both
comparison walks prove the flag landed before they measure anything.

With it working, the same two peak passes on the same build, fifty-odd requests each:

| Pass   | Planner on              | Planner off                |
| ------ | ----------------------- | -------------------------- |
| peak-1 | 22 of 52 ok, 30 refused | **46 of 54 ok, 0 refused** |
| peak-2 | 38 of 50 ok, 12 refused | 36 of 51 ok, 7 refused     |

And the per-endpoint breakdown, which is the point: with the planner on, in every sample, the map
failed between three and eleven requests of eight to eleven, and search between three and eleven of
eight to eleven. With it off, one pass had **nothing fail at all**.

The map's own CPU is thirteen milliseconds. What takes it down is sharing an isolate with a planner
Cloudflare records at 337 to 566, because an isolate carries some flexibility for a Worker that
infrequently exceeds the limit and loses it for one that exceeds it consistently — Cloudflare's own
words. So the journey planner is not only over its own budget: it is the cause of most of the
passenger-visible failures on endpoints that are inside theirs. That makes Part B the highest-value
work on the platform rather than the second item on a list.

### What the levers cost, for the record

Both were measured against the corpus rather than argued about. Twenty queries, the deployed
planner's own answers as the baseline:

| Change                     | Same best ride | Journey lost | Materially worse |
| -------------------------- | -------------: | -----------: | ---------------: |
| Change walk 10 minutes → 5 |          70.0% |     **0.0%** |        **10.0%** |

No journey is lost, which is the outcome that would have ruled it out. But the recommendation
changes on three queries in ten, and two of twenty are materially worse — one buying its time with
an extra change, one arriving eight and a half minutes later. That is a real cost for about a
quarter of the transfer edges, and it is a product decision with a number against it rather than a
constant somebody lowered.

### The shards change form, because the parse is the request

Stage attribution against the real published artifacts, on one GitHub runner, for a Manchester
corridor — the corridor every measured failure came from:

| Stage                                  |    ms |
| -------------------------------------- | ----: |
| walk the trip shards                   |  0.61 |
| **parse every trip row**               | 37.18 |
| parse only the rows inside the horizon | 26.84 |
| walk the pattern rows                  |  0.28 |
| parse every pattern row                |  5.39 |
| build the graph                        | 15.87 |
| **search it**                          |  6.30 |

The search is the cheapest thing in the request. The parse is the largest, by a factor of six over
the search, and filtering before it — which both read paths now do — removes the rows a plan does
not want and leaves the ones it does. A corridor opens about eight megabytes of trip text; there is
no arrangement of `JSON.parse` over eight megabytes that fits in ten milliseconds.

So the shard changes form. Columnar, little-endian, call times and pattern indices in typed arrays,
the trip-id and pattern-id blobs at the end where a plan touches them only for the trips it
recommends. The same eight shards, measured in CI against the published objects:

| Form                                             |     bytes |                   ms |
| ------------------------------------------------ | --------: | -------------------: |
| JSON lines, horizon tested before parsing        | 8,380,928 |                21.37 |
| bytes, rows materialised as the graph takes them | 3,780,454 | _(measured per run)_ |
| bytes, times read straight out of the arrays     | 3,780,454 |             **0.64** |

Both forms are made to agree on the trips kept, the calls read and the sum of the times, or the
milliseconds would be comparing two different answers.

Two things make this affordable rather than merely faster. The form is **45%** of the text, so the
conversion frees storage in a bucket with about a gigabyte of headroom — a larger form would not
have been available at any speed. And it converts **in place**: a national rebuild takes about
forty-five minutes and writes a second copy of England, so republishing to change a format was
never on the table. The migration writes the bytes, reads them back out of the bucket, checks they
hold every row — pattern, trip id, every departure, every arrival — and only then deletes the text.
It touches only the version the index names, so the rollback stays a thing that works.

The reader prefers the bytes and falls back to the text sibling, which is what makes a half
converted bucket safe, and counts both: `shardsBinary` and `shardsBinaryFallback`, because "the
fast path was not taken" and "the fast path is not fast" are different problems and a deployed
measurement has to tell them apart.

What this does not fix is the rest of the request. With the parse gone, the graph build and the
search are what is left, and both work on an object graph keyed by stop id strings. Publishing the
walking transfers would remove most of the build; making the search read indices rather than
strings is the step after that, and the one earlier attempt at it measured 40% _slower_ because it
built the object graph first and then indexed it. The order matters: the artifact has to carry the
indices, or the rewrite pays for both forms.

### Three acceptance samples of one frozen commit

The build with the binary reader in it, before any shard had been converted, so the only thing this
measures is that the reader is neutral when there is nothing for it to read. Fifty-odd requests per
pass, five cities, two passes per sample:

| Sample          | Pass   | Requests |  OK | Platform errors |
| --------------- | ------ | -------: | --: | --------------: |
| 1               | peak-1 |       55 |  36 |              19 |
| 1               | peak-2 |       50 |  12 |              38 |
| 2               | peak-1 |       54 |  33 |              21 |
| 2               | peak-2 |       51 |  14 |              37 |
| 3               | peak-1 |       50 |  33 |              17 |
| 3               | peak-2 |       53 |  21 |              32 |
| **planner off** | peak-1 |       54 |  46 |           **0** |
| **planner off** | peak-2 |       54 |  46 |           **0** |

In every sample's second pass the journey endpoint failed **ten of ten**, and the map failed eight
to ten of ten beside it. With the planner off, on the same build and the same passes, nothing
failed on any endpoint in either pass. That is the third independent repetition of the same result,
and it is why the trip shards are being converted rather than something else being tuned.

The eight requests that are not "ok" with the planner off are not failures: they are the
`feature_unavailable` the flag is supposed to return, counted honestly rather than excluded.
