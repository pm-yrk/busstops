# Converting the trip shards, and putting them back

## Why

The journey endpoint does not fail in its search. On the real published artifacts a Manchester
corridor spends 0.6 ms walking its trip shards, 26.8 ms parsing the rows inside the plan's horizon,
15.9 ms building a graph and 6.3 ms searching it — against the ten milliseconds of CPU a Workers
Free invocation is allowed. Cloudflare's own tail puts the deployed endpoint at a p50 of 166 ms and
a p95 of 274. The parse is the largest item and the search is the smallest, so the shard's _form_
is what has to change.

The same eight shards, measured in CI against the published objects:

| Form                                                     |     bytes |    ms |
| -------------------------------------------------------- | --------: | ----: |
| JSON lines, horizon tested off the text before parsing   | 8,380,928 | 17.97 |
| bytes, rows materialised as the graph builder takes them | 3,780,454 |  3.97 |
| bytes, call times read straight out of the typed arrays  | 3,780,454 |  0.59 |

Both forms are made to agree on the trips kept, the calls read and the sum of the times, or the
milliseconds would be comparing two different answers.

The form is 45% of the text, so converting **frees** storage — about 55% of the trips family — in a
bucket with roughly a gigabyte of headroom against an account-wide free allowance. That is what
makes it affordable: a larger form would not have been available at any speed.

## What it does, exactly

`scripts/migrate-trip-shards.ts` works on **only the version the index names**. For each text shard
at that version with no binary sibling:

1. read the lines, parse the rows, encode the bytes;
2. prove the bytes hold every row — pattern, trip id, every departure, every arrival
   (`shardHoldsEveryRow`);
3. `PUT` the bytes at `data/network/pattern-trips/<date>/<window>/<tile>/<version>.bin`;
4. read that object **back out of the bucket** and prove it again;
5. only then `DELETE` the `.jsonl`.

A shard that fails any step is left exactly as it was and named in the report. The September
rollback version is never touched, so a rollback stays a thing that works.

## Before you run it

The Worker in front of passengers must already read the binary form. That is why the job
`migrate_trip_shards` in `.github/workflows/evidence.yml` has `needs: regress` — the regression
suite deploys the commit and walks the passenger surface first — and why a `[migrate-trips]` commit
has to carry `[regress]` as well. Without it the job is skipped, which is the right failure.

Reading the bytes landed in `b0e7db6`. Any build from there on reads both forms and prefers the
bytes; a build older than that cannot read them at all, so **do not deploy a pre-`b0e7db6` Worker
after converting** without reverting the shards first.

## Authorisation

The conversion deletes published timetable, so it is not a thing to run on inference. It was
authorised explicitly, for this artifact family and this migration only, on 28 October 2026,
together with publishing the precomputed walking-transfer and route-grouping artifacts. That
authorisation does not extend to any other destructive operation on the bucket.

## Running it

A dry run writes and deletes nothing. It reads, encodes, verifies in memory and reports what it
would save:

```
npx tsx scripts/migrate-trip-shards.ts --limit 20 --minutes 5 --json trip-shard-migration-dry.json
```

The real run, bounded so a capped run can simply be run again — it is idempotent and resumable,
because a shard with a binary sibling is skipped:

```
npx tsx scripts/migrate-trip-shards.ts --apply --minutes 30 --json trip-shard-migration.json
```

Or push a commit whose message carries `[migrate-trips] [regress]`, which runs both steps in CI
with the regression gate in front of them.

The report names: how many shards are at this version, how many are already converted, how many
were converted in this run, the bytes before and after with their ratio, how many were refused and
why, and whether it stopped on its limit or its clock.

## Putting it back

```
npx tsx scripts/migrate-trip-shards.ts --reverse --apply --minutes 30
```

The same rule in the other direction: the lines are written from the shard's own rows, read back
out of the bucket, parsed, compared row for row, and only then are the bytes deleted. A conversion
followed by an undo returns byte-identical lines — that round trip is a test
(`tests/integration/convert-trip-shard.test.ts`).

## While it is part way through

Nothing special is required. The reader prefers the bytes, falls back to the text sibling, and
counts both in the journey diagnostics:

- `shardsBinary` — shards read without a parse.
- `shardsBinaryFallback` — shards whose bytes would not open, read as text instead.

A fallback is a publishing fault, not a passenger's problem: it is counted rather than refused.
After three consecutive misses an isolate stops probing for bytes that are not there, because every
probe is one of the fifty subrequests an invocation gets; one converted shard read resets it, and a
new isolate tries again.

## Costs

Per shard: one `GET` of the lines, one `PUT` of the bytes, one `GET` to verify, one `DELETE`. R2's
free allowance is a million class A operations a month, and the `PUT` and the `DELETE` are the two
that count against it. The report's `shardsAtVersion` tells you how many shards there are before
you start.
