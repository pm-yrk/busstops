# ADR 0006 — The limit is CPU, it is ten milliseconds, and we are spending a hundred times it

Status: accepted, 2026-10-26.

## Context

Five diagnoses of error 1102 were made from request behaviour: a cold path, cache accumulation, a
request rate, the size of one serving unit, and finally the 128 MB per-isolate memory ceiling. Each
was argued from the outside — status codes, decode counts, residency figures — because the thing
that answers the question is inside Cloudflare and nobody had asked it.

Asked, it answers in one field. `wrangler tail --format json` carries an `outcome` per invocation,
and its values separate the two meanings of 1102. A burst of sixty heavy passenger requests against
the deployed preview Worker, with a tail attached:

```
"byOutcome": { "ok": 46, "exceededCpu": 8 }
```

Every one of the eight failures, named by the platform, with its own ray id:

| `cf-ray`           | Endpoint       | Outcome       |       CPU |     Wall | Exception                         |
| ------------------ | -------------- | ------------- | --------: | -------: | --------------------------------- |
| `a50c64d0a9b75f15` | `/v1/journeys` | `exceededCpu` |    831 ms | 2,438 ms | `Worker exceeded CPU time limit.` |
| `a50c64f089ed5f15` | `/v1/journeys` | `exceededCpu` | **10 ms** |   159 ms | same                              |
| `a50c64f809215f15` | `/v1/journeys` | `exceededCpu` | **10 ms** |   112 ms | same                              |
| `a50c64feae7e5f15` | `/v1/journeys` | `exceededCpu` | **10 ms** |   211 ms | same                              |
| `a50c65027a4a5f15` | `/v1/journeys` | `exceededCpu` | **10 ms** |   217 ms | same                              |
| `a50c65067f645f15` | `/v1/journeys` | `exceededCpu` | **10 ms** |   202 ms | same                              |
| `a50c6509eadf5f15` | `/v1/journeys` | `exceededCpu` | **10 ms** |   209 ms | same                              |
| `a50c650d9e8c5f15` | `/v1/journeys` | `exceededCpu` | **10 ms** |   198 ms | same                              |

The GraphQL analytics API agrees, through a different field and a different pipeline:
`workersInvocationsAdaptive` reports `status: exceededResources` for 2 requests with
`cpuTimeP99: 10000` — ten thousand microseconds, which is ten milliseconds exactly — against
`status: success` for 37 with `cpuTimeP99: 1198643`.

Three things follow, and the third is the one that matters.

**It is not memory.** `exceededMemory` is a value this tail would have printed and did not. Not
once, in fifty-four invocation records.

**It is not the daily request limit.** `exceededResources` in the metrics covers 1102 _and_ 1027,
and the free plan allows a hundred thousand requests a day. The account's own figure for the
preceding twenty-four hours is **263** requests, of which 234 succeeded and 28 exceeded resources.

**The limit is ten milliseconds and this Worker spends between seventy-four and 1,198 of them.**
The twelve largest CPU times in that one burst, in milliseconds:

```
1198, 831, 559, 220, 182, 143, 112, 106, 84, 78, 75, 74
```

Workers Free allows 10 ms of CPU per HTTP request. Every passenger request measured here is over
it by seven to a hundred and twenty times.

## Why it looked like an accumulation, and why that observation was right

Cloudflare's limits page says the part that reconciles everything:

> Each isolate has some built-in flexibility to allow for cases where your Worker infrequently runs
> over the configured limit. If your Worker starts hitting the limit consistently, its execution
> will be terminated according to the limit configured.

So an isolate carries slack. A Worker that overspends occasionally is allowed to; a Worker that
overspends _consistently_ has the limit enforced. That is the mechanism behind every observation
that made the memory theory attractive:

- **One isolate passes fifty-four requests and then starts losing them.** It was spending its slack
  the whole time. Fifty-four requests at a hundred-odd milliseconds each is several seconds of CPU
  against a budget of half a second.
- **A tiny request fails after many heavy ones.** Once the limit is enforced, ten milliseconds is
  ten milliseconds, and an 87,543-character read with a JSON parse and a response serialisation in
  it does not fit either.
- **A five-megabyte read succeeds early in the same isolate.** Early is when the slack is there.
- **Residency reads zero throughout.** Correctly. It was never the heap.

The first of the eight failures is the transition caught in the act: 831 ms of CPU consumed and
then terminated. The seven after it were killed at ten milliseconds flat, because by then the
isolate had no slack left to lend.

## Decision

Record this as the mechanism, and stop attributing these failures to anything else.

Two consequences for what has already been built, stated plainly rather than quietly.

**The streaming work in [ADR 0005](0005-stream-the-line-oriented-reads.md) is not wasted, and it is
not the fix.** It removes multi-megabyte string allocations and the `split("\n")` copies on top of
them, which is real CPU — allocation and collection are work — and it was Cloudflare's own first
listed remedy for the limit everyone thought this was. It does not change the order of magnitude.
A journey spending 831 ms of CPU does not get under ten by allocating more carefully.

**The budgets in this Worker are sized against the right resource and the wrong number.**
`REQUEST_TEXT_BUDGET_CHARS` is three mebibytes, chosen because walking shard text measured at about
3 ms a mebibyte and a request is allowed 10 ms. Three mebibytes of walking is nine milliseconds
_before a single `JSON.parse`_, and the measurements above say the real figure per request is a
hundred times the budget's intent. The budget is not protecting anything; it is permitting a
request that cannot fit.

## Where the milliseconds go

A Worker cannot measure this from inside: `Date.now()` in Workers advances only across I/O, so
every stage below has always reported zero milliseconds while costing a hundred times the budget.
That is most of why five diagnoses in a row looked at bytes instead of compute.

So `scripts/measure-serving-cpu.ts` times the stages in Node, against the objects the live artifact
holds and the feed the live upstream serves. A runner's CPU is not Cloudflare's; what transfers is
the ratio and the order of magnitude.

| Stage                                             |           CPU | Characters | ms per MiB |
| ------------------------------------------------- | ------------: | ---------: | ---------: |
| map: walk the projection lines                    |       2.09 ms |    616,598 |       3.55 |
| map: parse the rows it keeps                      |       5.55 ms |    616,598 |       9.43 |
| **map: normalise the SIRI-VM feed**               |  **88.34 ms** |    586,113 |     158.05 |
| journey: walk the trip shards                     |       0.66 ms |  8,385,789 |       0.08 |
| journey: parse every trip row                     |      37.03 ms |  8,385,789 |       4.63 |
| journey: walk the pattern rows                    |       0.29 ms |  3,377,942 |       0.09 |
| journey: parse every pattern row                  |       5.24 ms |  3,377,942 |       1.63 |
| journey: build the graph (250 stops, 1,390 trips) |      16.88 ms |          — |          — |
| **journey: search it**                            | **183.43 ms** |          — |          — |

Added up per endpoint, against the ten milliseconds an invocation is allowed:

| Endpoint       |        CPU | Over the limit | Where it goes                                     |
| -------------- | ---------: | -------------: | ------------------------------------------------- |
| `/v1/map`      |  **96 ms** |            ×10 | 92% is normalising the live feed                  |
| `/v1/journeys` | **243 ms** |            ×24 | 75% is the graph search; 15% is parsing trip rows |

**The reads are not the problem and never were.** Walking 616,598 characters of projection and
building the 3,006 rows inside the viewport costs 7.6 ms — inside the budget on its own. Walking
8,385,789 characters of trip shards costs 0.66 ms. Every decision in ADR 0004 and ADR 0005 was
about these reads, and between them they account for about a tenth of a map request and a sixth of
a journey.

What accounts for the rest is computation that has nothing to do with how objects are read: an XML
parse of somebody else's feed, and a graph search. Those two are 88 and 183 milliseconds, and the
budget is ten.

It also explains the tail exactly. Cloudflare recorded a journey at 831 ms and another invocation
at 1,198 ms; the figures above are for a corridor capped at 250 stops and 1,390 trips, and a real
Manchester corridor is larger.

### The number this ADR got wrong first time

The first run of this measurement reported the SIRI-VM parse at **956 of a request's 996
milliseconds** and this ADR said so. That was a measurement of the script's own bug. It asked BODS
for `west,east,south,north` — the convention several other APIs use — and BODS answered with
19,254,654 characters and 18,184 vehicles spanning latitude 0 to 53.5 and longitude −2.3 to 1.76. A
nonsense box, and a national feed timed as though it were a city's.

`scripts/measure-bods-bbox.ts` settled it against the real feed by asking every plausible order and
letting the positions that came back decide:

| Order sent                                          |       Chars | Vehicles | Inside the box | Latitude range  |
| --------------------------------------------------- | ----------: | -------: | -------------: | --------------- |
| **`west,south,east,north`** (what the Worker sends) | **563,015** |  **437** |        **437** | 53.4204–53.5193 |
| `west,east,south,north`                             |  19,254,654 |   18,184 |            438 | 0–53.5196       |
| `south,west,north,east`                             |         668 |        0 |              0 | —               |
| no bounding box                                     |    HTTP 403 |        — |              — | —               |

**The Worker's order is correct.** BODS honours it exactly: 437 vehicles, every one inside the box
asked for. So a Manchester viewport's live feed is 563,015 characters — 0.54 MiB — which at the
measured 52 ms per mebibyte is about **28 ms**, not 956.

**The Worker's order is correct.** So the live feed for a Manchester viewport is half a mebibyte,
not nineteen, and its parse is 88 ms rather than 956 — which is still nine times the whole budget,
and still the largest single item in a map request.

The correction is recorded rather than quietly edited because it is the sixth time in this
investigation that a number has been asserted from a convention instead of measured, and the whole
point of this ADR is that the platform was eventually asked.

A second correction, for the same reason: the first attempt to time the graph search died with
SIGABRT. It gave every trip its own synthetic stops, produced twelve thousand of them, and
`buildGraph` walks every pair within transfer range — 144 million pairs. The deployed breadcrumbs
say what a real corridor is (`slice.stops=222`, `patterns.wanted=35`), so the measurement is now
sized to that and reports its own caps beside the timing, because a graph search's cost is mostly
a function of its size.

## What would actually fit

Ten milliseconds, measured on the numbers above, buys roughly: three mebibytes of text _walking_,
or a mebibyte of `JSON.parse`, or a sixteenth of a mebibyte of SIRI-VM XML, or a graph search over
about seventy trips. A passenger request currently wants ten to twenty-four times that.

Which bounds the options, and rules most of them out:

- **The artifact reads are already affordable** and nothing more is to be won there. A viewport's
  projection read is 7.6 ms and a corridor's trip walk is 0.66.
- **`/v1/map`'s cost is one XML parse of somebody else's feed.** 88 ms of 96. The feed is already
  scoped to the viewport — BODS honours the box and returns 437 vehicles for Manchester — so the
  lever is not the box. It is either a cheaper encoding (BODS also publishes GTFS-RT, which is
  protobuf rather than XML) or not parsing it in the request at all: the scheduled collector
  already normalises positions for its own purposes and publishes them, so a map could read
  normalised positions instead of raw XML and pay a freshness cost measured in the collector's
  cadence.
- **`/v1/journeys`'s cost is the search itself.** 183 ms of 243, over a corridor capped at 250
  stops and 1,390 trips — and a real corridor is bigger. A graph search is computation by
  definition; making it fit ten milliseconds means searching something much smaller (a precomputed
  connection index, or a far tighter corridor) rather than optimising the loop.

Both of those are design changes with product consequences — one trades live freshness for CPU, the
other trades journey quality or coverage for it — and neither is a tuning exercise. That is the
honest remaining blocker.

Raising the CPU limit is the one option deliberately not taken: it requires the Workers Paid plan,
and this project's target is the free tier at £0.
