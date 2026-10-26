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

| Stage                               |           CPU |     Characters | ms per MiB |
| ----------------------------------- | ------------: | -------------: | ---------: |
| map: walk the projection lines      |       1.38 ms |        616,598 |       2.34 |
| map: parse the rows it keeps        |       3.38 ms |        616,598 |       5.74 |
| **map: normalise the SIRI-VM feed** | **956.31 ms** | **19,272,814** |      52.03 |
| journey: walk the trip shards       |       0.50 ms |      8,385,789 |       0.06 |
| journey: parse every trip row       |      28.73 ms |      8,385,789 |       3.59 |
| journey: walk the pattern rows      |       0.21 ms |      3,377,942 |       0.07 |
| journey: parse every pattern row    |       5.38 ms |      3,377,942 |       1.67 |

**Ninety-six per cent of a request's CPU is one XML parse.** 956 of 996 milliseconds. Everything
else put together is forty — and that forty includes parsing _every_ row of an eight-megabyte
corridor of trip shards, which no request actually does.

Which reframes the whole exercise. Every decision in ADR 0004 and ADR 0005 was about the artifact
reads, and the artifact reads are cheap: a map viewport's entire projection read is 4.8 ms of the
10 ms allowed. The fine grid, the enriched serving index, the streaming — all of that is real and
all of it operates on the forty milliseconds, not on the 956.

The feed is also the wrong size. 19,272,814 characters came back for a 0.16° by 0.10° box around
Manchester, carrying 7,008 vehicle observations. A city-sized box does not contain seven thousand
buses, so either BODS is ignoring the bounding box or it is being sent in an order BODS does not
read — `bodsDatafeedUrl` sends `west,south,east,north`. Bounding-box ordering is inconsistent
between APIs and asserting one from memory is how this project has been wrong before, so
`scripts/measure-bods-bbox.ts` asks the real feed every plausible order and lets the latitudes and
longitudes that come back decide.

That measurement decides which of two very different situations this is. If a correctly ordered box
returns a city's worth of XML, the parse falls with it and 52 ms per mebibyte becomes affordable. If
BODS returns the nation whatever it is asked, then normalising the feed inside the request that
serves it cannot be made to fit, and live positions have to be normalised somewhere else — which
the scheduled collector already does for its own purposes.

## What would actually fit

Not recorded here as a plan, because this ADR is about what was measured. But the arithmetic bounds
the options, and it rules most of them out:

- Ten milliseconds of CPU buys roughly three mebibytes of _text walking_ and nothing else, or a few
  hundred kilobytes of `JSON.parse`, or about a tenth of a mebibyte of SIRI-VM XML.
- `/v1/map` parses the national live feed. A local benchmark puts SIRI-VM at about 100 ms a
  mebibyte, so a multi-megabyte feed is several hundred milliseconds of CPU on its own — which is
  consistent with the 1,198 ms maximum in the burst above, and is one invocation's whole budget
  spent a hundred times over before any stop is drawn.
- `/v1/journeys` builds a graph and searches it. That is computation by nature, and it is the
  endpoint all eight failures landed on.

So the shape of an answer is a serving path that _parses almost nothing at the edge_: responses
assembled from objects that are already in the shape the response needs, and live positions
normalised somewhere other than inside the request that serves them. That is a different
architecture from the one that exists, and it is the honest remaining blocker rather than a tuning
exercise.

Raising the CPU limit is the one option deliberately not taken: it requires the Workers Paid plan,
and this project's target is the free tier at £0.
