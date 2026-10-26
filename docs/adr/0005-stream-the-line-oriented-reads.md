# ADR 0005 — The serving reads stream; they do not buffer the object

Status: accepted, 2026-10-26.

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
