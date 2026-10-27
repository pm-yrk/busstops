# ADR 0007 — The edge reads cheaply and computes expensively, and the computing is the problem

Status: in progress, 2026-10-27. Part A decided and deployed; Part B measured, not yet decided.

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

### The floor, which is worth stating before building anything else

The obvious next step is to **select the four hundred before parsing any of them**: score each line
from the coordinates the textual filter already extracts, keep the best four hundred in a bounded
heap, and parse only those. It is a real change and it is proportional to what the map draws rather
than to what the box contains. Costed against the stages above:

|                                                 |       Local |  Cloudflare at ~2.7× |
| ----------------------------------------------- | ----------: | -------------------: |
| Today                                           |    ~13.4 ms | 38 ms (measured p50) |
| With select-before-parse                        |     ~6.9 ms |               ~19 ms |
| **Floor: walk 878 KB, score it, scan the feed** | **~5.6 ms** |           **~15 ms** |

So select-before-parse would roughly halve the map's CPU and still not reach ten milliseconds — and
neither would anything after it, because **the floor is set by the 878,854 characters of projection
a city viewport reads**, not by what is done with them. Walking that text and scoring every line in
it is about 3.6 ms locally before a single row is built, and the live feed scan is 2 ms on top.

Which makes the change that _would_ meet the target a different one: read less. A display-oriented
projection — fewer stops per tile, chosen for what a map at a given zoom actually draws, rather than
every stop in the box — is the only lever left that moves the floor rather than the overhead. That
is a new artifact family and a product decision about what the map shows when zoomed out, so it is
recorded here as the measured consequence rather than taken unilaterally.

Part A's verdict, stated plainly: the live-feed normalisation is gone from the request path and the
map's CPU has fallen by about 60%, from ~96 ms to a p50 of 38. The 7 ms target is not met, the
reason is measured, and the remaining work is a product decision rather than an optimisation.

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
query shapes a planner has to serve. The decision — optimise this algorithm, or move to a
query-ready precomputed representation — waits on those numbers and on a golden corpus taken from
the current planner, because a faster planner that finds a worse journey is not a faster planner.
