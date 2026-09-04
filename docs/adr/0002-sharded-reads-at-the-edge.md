# ADR 0002 — Sharded reads at the edge

Status: accepted
Date: 2026-09-04

## Context

`docs/04_ARCHITECTURE.md` says to partition artifacts "by dataset/date/area/geohash or tile and
time bucket", to "write to a versioned temporary key, validate counts/schema/checksum, then
atomically publish a small manifest pointer", and that "readers keep the previous good version
when a build fails". The implementation followed the letter of that for whole national datasets
and did not partition the ones a passenger query reads.

The cost was measured against the first real national publish, with
`scripts/inspect-artifacts.mjs` reading the preview bucket:

| Dataset                | Records | Size      |
| ---------------------- | ------- | --------- |
| `network/journeys`     | 32,199  | 292.2 MiB |
| `network/stops`        | 349,531 | 197.6 MiB |
| `network/patterns`     | 48,448  | 100.1 MiB |
| `network/search-index` | 350,596 | 87.5 MiB  |

A Cloudflare Workers isolate has 128 MiB. The reader loaded stops, operators, services, patterns,
shapes and the search index together — around 390 MiB of text before parsing, and parsed JSON is
larger than its source. Every endpoint that touched it returned 500 in production while every
server-side test passed, because the fixtures fit.

## Decision

Everything a passenger query reads is published per shard, and the edge reads only the shards a
request spans. Four deviations from the letter of the architecture document were required; the
outcomes it asks for — atomicity, a reader that keeps the previous good version, bounded
responses — are unchanged.

### 1. A shard is one object, not a published artifact

A full publish costs three round trips: read the manifest, write the object, swap the pointer. A
national build writes thousands of shards, and the first attempt lost 962 of them to HTTP 429
from the Cloudflare API. Two of the three were never needed. The edge reads a shard at the
version the index names and addresses the object directly, so a per-shard manifest is written and
never read; and the shrink check a publish performs is meaningless per shard, because a rural tile
legitimately empties when a school route stops for the summer.

Atomicity is unchanged and now comes from one place: a single `network/index` record, published
as a real artifact, written last. A reader reads it first and pins every subsequent read to the
version it names. A version that is visible is therefore complete, and a reader arriving mid-build
serves the previous one. Object storage retries a 429 honouring `Retry-After`.

### 2. Tile size is per family, not one constant

The journey tiles' half degree does not suit everything. Measured on the first complete publish:
the London stop tile reached the 8 MiB shard budget and had to drop 230 real stops, and one West
Yorkshire pattern tile held 11,420 patterns and could publish 1,407.

Stops divide cleanly by area, so a quarter degree takes the worst tile to about a quarter of the
budget. Patterns do not — a route is written to every tile it crosses, so a finer grid also
multiplies the copies — and an eighth of a degree is where the densest tile fits with room left,
at the cost of storing geometry roughly four times over. Journey tiles keep their half degree.

Publisher and reader call the same exported helpers, and a test asks for a stop at the coordinate
it is actually at, because two grids means two chances to disagree and a disagreement returns
nothing rather than failing.

### 3. Shard budgets are in bytes, and they are reported

Two shards failed while inside a 20,000-record cap: one threw `Invalid string length` while being
serialised, and object storage refused the other with 413. A record count is not a size. The cap
is 8 MiB measured on the exact text written, a shard that still overflows is truncated at a line
boundary in priority order rather than failing the run, and the build report carries both what was
dropped and the size of the largest shard in each family — because after a publish the useful
question is how close the largest one came.

### 4. A request has a read budget as well

Sharding stops an endpoint loading the national network in one object; it does not stop a wide
viewport loading it a tile at a time. The map allows 1.5 square degrees, which on the pattern grid
is ninety-six tiles. A request reads tiles outwards from the middle of the box until a budget of
text is spent, and reports truncation through the flag the map response already carried.

## Consequences

- The edge opens no national object except operators (22 records), services (1,043) and the
  one-record index. `apps/worker/src/isolate-memory.test.ts` asserts that as the shape of the
  access rather than as a size, because a fixture small enough for a test is small enough to hide
  the defect; it fails if `NetworkSnapshot` or a whole-dataset read reappears.
- Stored geometry is larger than the source, deliberately: shapes are shared per route rather than
  per pattern and simplified to ten metres at five decimal places, then duplicated into each tile
  a route crosses. Object storage is the cheap resource here and the isolate is the scarce one.
- Coverage can be bounded rather than complete in the densest tiles and the largest viewports.
  Every such case is reported — in the build report when publishing, and in the response when
  serving — rather than being presented as the whole answer.
- The national datasets are still published unchanged. The batch pipelines legitimately want the
  whole country and run in Node with gigabytes available.
