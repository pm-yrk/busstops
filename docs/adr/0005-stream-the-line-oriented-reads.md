# ADR 0005 — The serving reads stream; they do not buffer the object

Status: accepted, 2026-10-26. Superseded as a _diagnosis_ by
[ADR 0006](0006-the-limit-is-cpu-and-it-is-ten-milliseconds.md), which asked Cloudflare what 1102
actually was and got `exceededCpu` — not memory. The decision below stands: it removes real work
and it was the platform's own first listed remedy for the limit this was believed to be. It is not
the fix for the limit it turns out to be.

## Context

ADR 0004 ends with the one remedy it had not taken. Cloudflare's list, for a Worker that exceeds
its memory limit, begins with "stream responses or large payloads instead of buffering entire
payloads in memory", and until now every read in this Worker did the opposite. `R2BindingStore.get`
called `object.text()`, so a pattern tile in a dense city arrived as a single three-to-five-megabyte
string before one line of it had been looked at — and the filtered readers above it, which exist
precisely to avoid building objects nobody wants, were handed that string and asked to walk it.

The limit is the thing that makes this matter rather than merely untidy. It is **128 MB per
isolate, not per invocation**, and an isolate serves many requests in sequence. So a request's own
cost does not predict its fate, which is why four diagnoses in a row — a cold path, cache
accumulation, request rate, request size — each predicted failures that did not happen and missed
ones that did. The measurements that finally fit:

|                                |   peak-1 |   peak-2 |
| ------------------------------ | -------: | -------: |
| Requests answered, one isolate | 54 of 54 | 33 of 52 |
| `isolateServedMax`             |       54 |      103 |

An 87,543-character `nearby` failed at `served=106`; a 5,008,974-character read passed at
`served<60` on the same deployment minutes earlier; `residency.chars` read zero at both, truthfully,
because the megabytes were V8's and not ours.

Three further buffering sites were worse than the central one and none of them was in the table in
ADR 0004, because the table measured characters decoded and these were allocations on top of them:

- the journey planner held `raw` for every shard in a batch **and** ran `raw.split("\n")` over each,
  so a batch of four 8 MB shards was 32 MB of strings and then 32 MB of substrings;
- the departure reader cached a whole shard's **text** so that a second passenger at a different
  stop in the same hashed bucket would share the download, and the deployed peak walk caught a
  journey dying with `departureCharsResident=4441456` — four and a quarter mebibytes of somebody
  else's departures, held before the request that died had begun;
- `servicesText` and `operatorsText` kept the national tables resident for the life of the isolate,
  4,669,154 characters and a smaller one beside it, on the reasoning that text is cheap to hold.

That last reasoning was about CPU and it was right about CPU. `readCurrent` hashes the whole object
and parses all 13,593 services before a caller sees one, and a board wants about ten. It was wrong
about the ceiling: a string held for a hypothetical later reader is charged against every request
that follows it on that isolate.

## Every read, and what it buffered

Measured against the live artifact by `scripts/measure-lines.ts`, which lists the bucket and opens
the largest objects of each family. "Keeps" is what the caller actually retains out of what it
opened — the column that decides whether a stream is worth writing.

| Read path                          | Family                | Format            | Median object |      Largest object | Keeps                                                 | Streamed |
| ---------------------------------- | --------------------- | ----------------- | ------------: | ------------------: | ----------------------------------------------------- | -------- |
| `JourneyService` trip shards       | `pattern-trips`       | JSONL             |        24,705 |           8,348,894 | trips on a corridor pattern inside a four-hour window | yes      |
| `readShardSized` (pattern tiles)   | `patterns-tile`       | JSONL             |       129,679 |           4,435,597 | the patterns near one bus, or a viewport's slice      | yes      |
| `readShardSized` (stop tiles)      | `stops-tile`          | JSONL             |       259,404 |           3,959,337 | the stops in a box                                    | yes      |
| `DepartureReader`                  | `departures`          | JSONL + header    |     2,131,979 |           2,761,566 | **one stop's line of about thirty thousand**          | yes      |
| `patternsByIds`                    | `pattern-index`       | JSONL + header    |        82,981 |           1,859,002 | the rows a journey named by id                        | yes      |
| `readShardSized` (search tiles)    | `search-tile`         | JSONL             |       114,178 |           1,832,340 | the entries matching typed words                      | yes      |
| `readShardSized` (search prefixes) | `search-prefix`       | JSONL             |         4,590 |           1,643,827 | the same                                              | yes      |
| `routeTiles`                       | `route-tiles`         | JSONL             |             — |           1,102,481 | which tiles one service touches                       | yes      |
| `readShardSized` (map projection)  | `map-stops`           | JSONL             |         3,873 |           1,009,071 | a viewport's stops, on the fine grid                  | yes      |
| `routePatternsForService`          | `route-patterns`      | JSONL             |       341,008 |             744,295 | **one service's line**, then stop                     | yes      |
| `servicesByIds` fallback           | `services`            | JSONL             |             — |           4,887,895 | about ten services of 13,593                          | yes      |
| `operatorsByIds` fallback          | `operators`           | JSONL             |             — |             219,256 | the operators of about two routes                     | yes      |
| `servicesFromBuckets`              | `services-bucket`     | JSONL             |        19,004 |              30,109 | the ids in that bucket                                | yes      |
| `servingRoutesAtStop`              | `stop-serving-routes` | JSONL + header    |        59,935 |              73,063 | one stop's line and the header                        | yes      |
| `stopServices`                     | `stop-services`       | JSONL             |        41,024 |              51,312 | one stop's line                                       | yes      |
| `stopLocator`                      | `stop-locator`        | JSONL             |       138,230 |             144,238 | one stop's row                                        | yes      |
| `serviceNames`                     | `service-names`       | JSONL             |             — |             881,452 | **all of it**, as a resident map                      | no       |
| `placeEntriesMatching`             | `places/gazetteer`    | JSONL             |             — |             665,828 | the landmarks a query could mean                      | no       |
| `recentTrace`                      | `recent-traces`       | JSONL + header    |             — |   one of 64 buckets | one vehicle's points                                  | no       |
| `networkIndex`                     | `network/index`       | **one JSON line** |             — |             144,948 | all of it, and it is one record                       | no       |
| manifests                          | `manifests/*`         | one JSON object   |             — | a few hundred bytes | all of it                                             | no       |

The four that stay buffered are deliberate and each for its own reason. The index is a single
144,948-character line: there is no line-oriented saving to be had from an object with one line in
it. A manifest is a few hundred bytes read once. The gazetteer is 665,828 bytes and the
service-name projection 881,452, both read once per isolate and then answered from memory — and
streaming them would mean re-reading on every search and every map request, which trades a
measured per-request cost for a smaller resident one. That is a trade worth making when the object
is megabytes and the request keeps a handful of rows; it is not worth making here, and the honest
thing is to say so with the numbers rather than to stream everything and call it consistency.

Two numbers in that table are the ones that justify the work. A board buffered a **2,131,979-byte**
median departure shard to read one line out of about thirty thousand, and then kept the whole
string resident for the next passenger. A journey's planner held a batch of trip shards whose
largest published member is **8,348,894 bytes** and ran `split("\n")` over each of them.

## Decision

One streaming line reader, in `apps/worker/src/stream-lines.ts`, underneath the reads that were
buffering — not six stream parsers for six callers.

`streamLines(body, onLine)` decodes a chunk at a time with an incremental `TextDecoder`, hands each
complete line to the caller as **offsets into whatever buffer currently holds it**, and cuts the
buffer back to the partial line at its end. `readFilteredLinesStreaming` sits on top for the common
case: a predicate on the raw line, a parse only for the lines that pass it, and an early stop that
cancels the body.

Four things about it are deliberate.

**The callback gets `(body, start, end)`, not a string.** That is the signature every existing
filter already has — the pattern-id test, the search-word test, the proximity test — so each one
works unchanged and still rejects a line without allocating it. A reader that handed over a `string`
would slice every line it looked at, which is the same allocation spread over forty thousand small
ones.

**A line's ordinal travels with it.** A header is recognised by being first, and the buffered
filters could say `start === 0`. Streaming makes that wrong rather than imprecise: when a chunk
boundary falls just after a newline the next line genuinely begins at offset zero of the buffer, so
an offset test would keep an arbitrary row and treat it as the header.

**A line that never ends is refused, not carried.** The carry buffer is the one allocation here
that can reach the size of the object, which would reproduce exactly what is being removed. So it
is capped, the cap is a measurement rather than a guess (`scripts/measure-lines.ts` opens the
largest objects of every family and reports the longest line in each), and exceeding it fails the
read. Not a truncation: half a JSON row either throws or — the dangerous one — parses into a
different row, and a board built from that is wrong rather than incomplete.

**A failed read stays a failed read.** Every caller here already distinguishes "no rows" from "we
could not say", and a stream that errors mid-body propagates. The reader's lock is released on
every path, including that one.

What is _not_ streamed, on purpose: manifests, the index record, the gazetteer and the service-name
projection. The rule is to stream what is large and line-oriented, not to stream for consistency —
a stream parser for a few hundred bytes read once is cost with no saving.

## Consequences

The tests are structural, and the structure asserted is that `text()` is gone from these paths.
`worker.test.ts` builds a bucket whose `text()` **throws** for every migrated family and whose body
streams, and then asks the deployment's own endpoints — map, board, route, search, nearby, journey —
for real answers. A read that quietly goes back to buffering fails there, on the endpoint that did
it, rather than passing a test that only checked the answer. `stream-lines.test.ts` holds the chunk
arithmetic: a line split across a boundary, several lines in one chunk, a final line with no
newline, a multi-byte character on a boundary at every chunk size, CRLF, the early stop cancelling
and releasing, a mid-body failure propagating, and the oversized-line guard refusing rather than
truncating. The fixtures deliver bodies in several chunks for the same reason: a fixture delivered
whole exercises none of this, and a reader that buffered would pass every test in the suite.

Two costs are accepted.

The national tables are read again on a second request instead of being held. That is a subrequest
and no compute, and they are a fallback path in any case — the bucketed families answer first, and
these are what remains for an artifact published before those existed.

And the departure cache now holds one stop's rows rather than a shard's text, so two passengers at
different stops in the same hashed bucket no longer share a download. It keeps the repeat this
cache actually saw — a passenger refreshing a board — and gives up the one it was guessing at, for
a residency measured in kilobytes instead of megabytes. Both bounds are asserted, the entry count
and the rows across them, because sixteen entries is not a size.

`charsDecoded` also means something different now, and more honest: characters actually consumed
rather than the length of the object. A read that stops at the line it wanted decodes less than the
object holds, and the ledger says so — with `maxBufferChars` beside it, which is the number that
distinguishes a reader that streams from one that consumes a stream and concatenates every chunk.
Those two allocate identically and decode identically; only the buffer high-water mark tells them
apart, so that is the figure the acceptance walk and the deployed verification both assert on.
