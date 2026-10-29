# The journey artifacts: publishing, reading and rolling back

## What they are

Three things a journey request used to compute and now reads. All three are properties of a
published network rather than of a passenger's question, and all three are addressed by the
artifact version, so a reader that cannot find one computes it instead.

| Family                      | What it holds                                          | Key                                    |
| --------------------------- | ------------------------------------------------------ | -------------------------------------- |
| `network/pattern-trips`     | trips, columnar and binary rather than JSON lines      | `<date>/<window>/<tile>/<version>.bin` |
| `network/journey-transfers` | walking transfers: offsets, neighbour, walk            | `<tile>/<version>.bin`                 |
| `network/journey-routes`    | route grouping: which trips run as one route, in order | `<date>/<window>/<tile>/<version>.bin` |

Measured against what they replace, on one runner and the real published objects:

| Stage             |         Computed |                                    Read |
| ----------------- | ---------------: | --------------------------------------: |
| trip preparation  | 18–21 ms (parse) | 0.6 ms (select) + the rows a plan keeps |
| walking transfers |         21–25 ms |      a bounded number of integer copies |
| route grouping    |          9–38 ms |               one `Map` insert per trip |

## Publishing

Each runs from its own marker in `.github/workflows/evidence.yml`, and each is idempotent,
resumable and bounded, so a capped run can simply be run again:

| Marker            | Job                             | Notes                                                                                         |
| ----------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `[migrate-trips]` | converts the trip shards        | needs `[regress]`: it deletes the lines, so a deployed reader has to be verified first        |
| `[transfers]`     | publishes the walking transfers | additive; refuses if the family is larger than the run was allowed                            |
| `[routes]`        | publishes the route grouping    | only for shards already in the binary form; runs after the conversion when both are asked for |

## Version consistency

There is no capability flag to set, and that is deliberate. Every object is addressed by the
artifact version, and a reader that finds nothing does the work itself — so a half-published family
is a slower request, never a wrong one. The two couplings that _could_ go wrong are checked rather
than assumed:

- a transfer tile carries the **walking cap** it was built under, and a reader asked about a
  different cap ignores it;
- a route grouping carries the **fingerprint** of the trip shard it describes — trip count, total
  calls, first and last departure — because it names trips by index, and a reader whose shard
  disagrees groups the long way instead of mapping an index onto another bus.

### The one that bites: two forms of the same shard

The trip conversion happened **in place**, and the publisher that writes the live horizon three
times a day runs from the default branch. Until that branch carries the binary publisher, every
successful refresh writes `.jsonl` back over shards that are already `.bin` — and since every
reader prefers the bytes, such a shard is one whose reader may be answering from the older of two
timetables.

It has happened. The refresh of 28 October ran 22:54–00:15 while the migration ran 22:06–00:43:
the migration took its inventory before those writes, so the shards the refresh published
afterwards kept both forms, and the Leeds corridor for 29 October read eight of them as lines.

Two things make it visible and repairable:

- the publisher deletes the other form when it writes one (`removeOtherForm`, set for the trips
  family in `run-daily.ts`), so a refresh that carries this code leaves one form behind;
- re-running `[migrate-trips]` repairs the drift rather than skipping it: a text shard **newer**
  than its binary sibling is converted again, over the stale bytes, and then deleted.
  `supersedingStaleBytes` in the migration report counts exactly those.

Until the default branch carries this, treat a successful refresh as something that needs a
`[migrate-trips]` run after it, and read `shardsWithBothForms` in `[journey-profile]` as the check
that it worked.

A journey's diagnostics say which path answered: `shardsBinary`, `shardsBinaryFallback`,
`shardsGrouped`, `transfersFromArtifact`, `transferTilesRead`, `transferTilesMissing`.

## Rollback

One command each, and none of them needs a deploy. Run them in this order if you are rolling back
everything, because the trips are the only one that deletes anything a reader needs:

```
# 1. route grouping: the request goes back to grouping its own trips
npx tsx scripts/publish-journey-routes.ts --remove --apply

# 2. walking transfers: the request goes back to building its own grid
npx tsx scripts/publish-journey-transfers.ts --remove --apply

# 3. the trip shards: lines written back from the bytes, verified, then the bytes deleted
npx tsx scripts/migrate-trip-shards.ts --reverse --apply --minutes 30
```

### 4. The whole family, by version

The three commands above roll back the _representation_. Rolling back the **network** — the
version every one of these objects is addressed by — is a different act and needs none of them:
the index record names the version, so publishing an index that names the previous one moves every
family at once, atomically, and the new objects are simply never asked for again. That is only
available while the previous version's objects are still in the bucket, which is what
`KEEP_NETWORK_VERSIONS` in the prune job decides; `[prune]` without `[prune-apply]` reports which
versions are present and how many bytes each holds.

There is no capability flag to revert, by design: a reader that finds nothing computes it.

### Proving it without running it

`[rollback-check]` runs all three in report mode against the live bucket and prints what each would
restore or remove — the grouping objects it would delete, the transfer tiles it would delete, and
the first twenty shards it would write back as lines. It writes nothing. A rollback nobody has
asked the bucket about is a paragraph, not a rollback, so this is what makes the claim above
checkable on any commit.

Each removal takes only the live version's objects; other versions are untouched, because a
rollback is not a prune. Without `--apply` all three report what they would do and change nothing.

Only after step 3 is it safe to deploy a Worker older than `b0e7db6`, which cannot read the binary
trip form at all. The transfer and grouping families are invisible to an older Worker — it simply
never asks for them — so steps 1 and 2 are not needed before a rollback of the code, only before a
rollback of the data.

## What to check after publishing

- `/v1/journeys` answers in the five cities, with `transfersFromArtifact: true` and
  `shardsGrouped` equal to `shardsBinary` in the diagnostics.
- The journey corpus comparison reports the same best itinerary, fastest arrival and fewest
  changes as before the migration: `[corpus]`.
- Cloudflare's own CPU per invocation, from `[cpu-proof]`, rather than the absence of errors.
