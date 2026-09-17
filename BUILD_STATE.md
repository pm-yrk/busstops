# Bus Stops. Build State

Last updated: 2026-09-17 (live buses proved in the deployment; the national timetable build still fails)

## Current status

### Real departures are on the deployed site; routes and journeys are not (2026-09-17)

`Deploy Preview` run 33 (`35211138685`, a55694d) **published the national artifact** — 63.5
minutes, `outcome: published`, 349,589 stops, 13,579 services, 773,393 journeys — and the
passenger-facing result is that a person clicking a real stop on the deployed map now sees real
upcoming buses. Visual QA: **84 of 84**.

| Width   | City  | Buses inside the map | Stop clicked   | Board      |
| ------- | ----- | -------------------- | -------------- | ---------- |
| desktop | Leeds | 167 of 167           | Merrion D      | **4 rows** |
| desktop | York  | 73 of 73             | Eboracum Way   | **3 rows** |
| tablet  | Leeds | 166 of 166           | Merrion E      | **4 rows** |
| tablet  | York  | 72 of 72             | Willerby House | 0 rows     |
| phone   | Leeds | 169 of 169           | LGI A&E        | **4 rows** |
| phone   | York  | 73 of 73             | Langley House  | **2 rows** |

**The departure index is settled.** Every row emitted was published, and the sizing held:

```
"departures": { "published": 1024, "rows": 29358096, "rowsEmitted": 29358096,
                "failed": [], "oversized": [],
                "largest": { "network/departures/2026-09-17/125", 35905 records, 2518894 bytes } }
```

1,024 objects against 7,168, every row published, largest shard 2.5 MB against an 8 MiB budget.
The bucket spread is not perfectly even — the largest shard holds 35,905 calls against a mean of
28,670 — which is what a hash gives and is well inside the margin.

**Three checks failed, and they are three different things.**

1. **The planner's trips lost London.** 687,164 of 773,393 published; four shards refused as
   oversized, all of them `102_-1` and `103_-1` — 51.0-51.5N by 0.5W-0.0E — at 11.1 to 12.5 MB.
   That is a regression introduced by opening the trip grid to half a degree, and the largest
   shard that _did_ publish was another London tile at 8,351,605 bytes, fitting by 37 kilobytes.
   The grid is now a quarter degree and `maxTiles` 16 to match.

2. **`routePublicNames` was a hard-coded `[]` in the Worker's map projection.** The contract
   declares it, the marker reads it, nothing filled it. So the check "the viewport's stops carry
   the services that call at them" could only ever fail, and its message blamed the national
   timetable for a stub. It is populated now, from the patterns already read for the viewport,
   and a test fails against the stub.

3. **Leeds -> Leeds Bradford Airport still plans nothing, and Manchester Piccadilly still reports
   no route calling at it.** Not yet root-caused, and not guessed at here. The pattern shards
   published without failure or truncation (`truncated` names only `search-prefix/bound_`), the
   ids on both sides of the join are `deterministicUuid("stop", atcoCode)`, and the tile reader
   drops whole tiles rather than parts of them — so the obvious explanations are all ruled out
   and the next step is to reproduce the join against real pattern data rather than fixtures.

Not claimed: that any of the three fixes above works against real data. Run 33's artifact is in
the bucket, so a deploy without a bootstrap can test (2) and (3) in minutes; (1) needs a rebuild.

### The timetable publishes; the write budget is what it ran out of (2026-09-17)

**Live buses are done and deployed.** `Deploy Preview` run 30 proved the CSS positioning fix — at
every width, in Leeds and York, every bus the API returned was inside the rectangle the map
occupies. Run 32 proved the pointer-events fix that followed it: **84 of 84 visual checks passed**
against https://preview.busstops.pages.dev, and clicking a stop opened the arrival board on all
six camera/width combinations, where run 30 had failed that check three times in Leeds.

| Width   | City  | Buses inside the map | Map scrollHeight | Stop click                |
| ------- | ----- | -------------------- | ---------------- | ------------------------- |
| desktop | Leeds | 156 of 156           | 672px            | NEXT BUS — Merrion D      |
| desktop | York  | 71 of 71             | 690px            | NEXT BUS — Eboracum Way   |
| tablet  | Leeds | 154 of 154           | 489px            | NEXT BUS — Merrion E      |
| tablet  | York  | 70 of 70             | 497px            | NEXT BUS — Willerby House |
| phone   | Leeds | 158 of 158           | 378px            | NEXT BUS — LGI A&E        |
| phone   | York  | 71 of 71             | 393px            | NEXT BUS — Langley House  |

Every board opened with **0 rows**, which is the honest state: run 32's bootstrap never finished,
so there is no timetable in the bucket for them to read.

**The departure index published at national scale. Writing it is what ran out of time.** Run 32
(`35202327336`, 0848752) got as far as:

```
08:58:48  Timetable source: BODS GTFS "all", 1332.2 MiB in 41.5s
09:22:56  Read 62,012,873 stop_times rows across 13,729 routes; 773,393 journeys on 2 dates
09:50:23  Departure index: 29,358,096 rows across 7,168 shards, largest 1,489,273 bytes
10:05:57  ##[error]The operation was canceled.
```

So the sharding works: the 281 MiB journey tile is gone, the largest shard is 1.49 MB, and nothing
failed or was refused as oversized. What killed it is that **7,168 objects took 1,647 seconds —
4.35 writes a second at a concurrency of eight**. That is a ceiling, not a pace. The pipeline
writes through Cloudflare's REST API, which rate-limits per account; the same run moved about
3.9 GB, which is 1.8 MB/s, so the identical number also reads as a bandwidth ceiling. One run
cannot tell those two apart, and the job was cancelled fifteen minutes into the planner's trips.

**What changed, and what it is measured at.** The layout is now sized against both currencies, and
every publish reports its own objects/second and MiB/s so the next run says which one was real.

|                             | Before                                    | After                             |
| --------------------------- | ----------------------------------------- | --------------------------------- |
| Departure objects per build | 7,168 (512 buckets × 7 windows × 2 dates) | **1,024** (512 buckets × 2 dates) |
| Bytes per boardable call    | 134.6                                     | **46.5**                          |
| National departure index    | 3.91 GB                                   | **1.35 GB**                       |
| Largest shard               | 1,489,273 bytes                           | ~1.26 MiB                         |
| Class A operations / month  | 215,040                                   | **30,720**                        |

The window dimension is gone from departures: a board reads one object per service date. Rows are
interned against a per-shard header — a 36-character pattern UUID, a route name and a destination
repeated on every one of 29.4 million calls — times are offsets from the service date rather than
ten-digit epochs, and the calls at one stop are grouped onto one line. That last part is the edge
win as much as the wire win: a board finds its own line by prefix and parses that alone, so
reading one stop out of a 28,000-call shard costs the hundred calls at that stop.

The planner's trips moved from the eighth-degree pattern grid to a half-degree trip grid with
eight-hour windows, for the same reason: a trip is filed once rather than copied into every tile
its route crosses, so a fine grid there buys nothing and costs objects. `maxTiles` went 24 → 8 to
match.

**And the job limit was the wrong shape.** 70 minutes was rationing something that is not scarce —
this repository is public, so Actions minutes are free — and worse, a _job_ timeout cancels every
remaining step, so run 32 threw away the data verification that would have said how far it got.
The job cap is now 150 minutes and the bootstrap step carries its own 110-minute limit, so a
bootstrap that hangs fails the step and leaves the run able to report.

Not yet proven, and not claimed: that a national build now finishes inside the job, and that
Leeds, Manchester, Birmingham, Bristol and York return real routes and real departures with
Leeds → Leeds Bradford Airport returning an option. That needs the next bootstrap run.

### Live buses are real in the deployment; the timetable is not (2026-09-17)

Actions execution came back. `Deploy Preview` run 27 (`35184912332`, 8308013, `bootstrap_data:
true`) deployed the Worker and Pages, then **failed at the national network bootstrap**. The probe
job runs regardless, so the passenger surfaces were measured against the real deployment at
2026-09-17T05:20Z.

**Live vehicles: settled.** The deployed Worker's count matched an independent request made
straight to BODS from the runner, in the same second, in every non-London city:

| Area                 | `/v1/map` through the deployment | BODS direct from the runner | Diagnostics                               |
| -------------------- | -------------------------------- | --------------------------- | ----------------------------------------- |
| Leeds                | **115 vehicles**                 | 115 accepted                | bods ok · raw 230 · 115 rejected as stale |
| Manchester           | **181**                          | 181                         | raw 421 · 240 stale                       |
| Birmingham           | **163**                          | 163                         | raw 307 · 144 stale                       |
| Bristol              | **106**                          | 106                         | raw 213 · 107 stale                       |
| London (Westminster) | **0**                            | 345 (BODS)                  | TfL `degraded`, never fetched             |

Exact agreement in four cities is what closes the "runner has hundreds of buses, the deployment
has zero" question: the `SourceClient` fetch-receiver fix was the cause, and it is confirmed in a
real isolate rather than argued from the diff. The stale rejections are the freshness filter doing
its job — ages run to 84,797s in the raw feed, so roughly half of what BODS publishes for a
viewport is a position from yesterday.

**London is a separate, open failure.** The Worker serves London from TfL, and TfL reports
`status: degraded` with `lastSuccessfulFetchAt: null` — it has never succeeded. BODS has 345
vehicles in that same box, so the data exists and the London path is not reaching it.

**The timetable is the thing that is broken.** Every sampled Manchester stop answered HTTP 200
with **0 departures and 0 routes** — not a quiet hour, but a published network that knows no route
at those stops at all. The journey planner returns 0 options for Leeds → Leeds Bradford Airport,
which follows. `/v1/disruptions` reports `official 0`, and no weather: both jobs publish on a
schedule, and a schedule only fires from the default branch, so neither has ever run against the
preview bucket.

**Why the rebuild failed, and what it says.** The archive itself was fine — `BODS GTFS "all",
1332.2 MiB in 31.9s`, uncapped, exactly as designed. Then:

```
Daily static-network job failed: Error: Invalid time of day: 106:25:00
```

One `stop_times` row in England's national extract carries a time four and a half days past its
service date. The resolver's pattern allowed a one- or two-digit hour, threw on a three-digit one,
and the exception came out through the zip stream and ended the build with nothing published. The
shape of that is the timetable cap again: a single input deciding whether England has departure
boards. The hour is now bounded by how far past the service date it actually lands rather than by
how many characters it was written in, a trip carrying a time that cannot be placed is dropped and
counted in `tripsRejectedForTime`, and a test pins that the rest of the archive still publishes.

Not yet proven, and not claimed: that the rebuild succeeds. That needs the next run.

### The recruiter preview cut (2026-09-05) — built, not deployed

> **The one thing that was asked for could not be done.** The deliberate `Deploy Preview`
> dispatch was refused: `failed to run workflow: Actions has been disabled for this user`, at
> 2026-09-05T17:14Z, on `deploy-preview.yml` at `claude/bus-stops-platform-build-f7qztb` with
> `bootstrap_data: false`. A repository-wide `list_workflow_runs` a minute earlier returned
> `total_count: 0` — not one run, historic ones included — so this is execution being withheld
> rather than a workflow that failed. The Cloudflare API says the preview Worker was last
> modified at 2026-09-04T09:38:13Z, which is the run-26 build: **nothing from 2026-09-04 or
> 2026-09-05 is deployed**, including the CORS-on-error fix, the diagnostics endpoint,
> disruptions, accessibility, GTFS or any of the below. This container cannot substitute: the
> egress policy refuses `preview.busstops.pages.dev` and `*.workers.dev` with a 403 at CONNECT,
> and the Cloudflare MCP surface can read Workers but not deploy one.
>
> So the live-bus failure is **still not diagnosed**. The deployed probe is what would diagnose
> it, and the probe cannot run. Nothing below should be read as "the preview shows real buses".

- **The one fetch path that only ran in a deployment is gone.** `SourceClient` read the global
  fetch as a property and called it as a method, so `fetch` ran with the client as its receiver:
  Node tolerates that, workerd refuses it. It is bound to `globalThis` now. This is hazard
  removal and not a diagnosis — reproduced locally, Node threw identically either way — but every
  test injects its own `fetchImpl`, so that line was the only code in the live path that a test
  never executed, which is the shape of thing that turns out to be broken in production.
- **`network_error` says which network error.** The Worker reported a fetch that never left, a
  runtime that refused the call and an unreachable host under one label, and telling those apart
  is the entire diagnosis. The class now carries the message with URLs replaced wholesale and any
  `api_key` redacted first.
- **Weather at the stop is real, end to end.** A scheduled job (`pipelines/weather`) asks
  Open-Meteo about every 0.10° cell that has a bus stop in it — derived from the published stop
  tile _names_, so no stop is loaded to find out — and publishes one artifact per degree square.
  The Worker reads exactly one square and attaches `weather` to the stop response, or null. The
  cost is arithmetic: about 2,500 cells, batched a hundred to a request, is ~25 requests a run and
  ~1,200 a day against an allowance of 10,000, and the job refuses to run a schedule that would
  not fit rather than trusting the comment above its cron. A cell the model did not answer for is
  reported missing and published as nothing: the stop page then shows no vignette.
- **The live map's default view opens on Leeds, ~12 km across** rather than ~4 km. A camera
  position, not data: whatever is in frame is whatever is really there. The tight version framed
  three streets, and a first view holding two buses demonstrates far less than one holding twenty.
- **Buses on the map stay upright and wear their number.** The marker used to rotate to the
  reported bearing, which looked right heading east and stood the bus on its back end heading
  north — the sprite is a side view, and a side view has no top-down rotation to give; an
  arbitrary angle also destroyed the pixel grid. It now mirrors east/west only, and the compass
  direction is a pip that orbits it. Route numbers, previously hover-only, are shown outright
  while the viewport holds 40 buses or fewer.
- **Every marker announces itself again.** MapLibre overwrites the `aria-label` on the element it
  is handed, so a map of named stops and numbered buses told a screen reader "Map marker" a
  hundred times. The name is reapplied after construction, and the bench asserts it.
- **A green bench over a broken page, found by looking at it.** The art bench asserted that every
  sprite loaded; a page in its error state has no sprites, so it passed for days over a live map
  reading "Something went wrong" — its fixture had gone on missing `disruptions` after that field
  was added to the map contract. The fixture now lives in `tests/e2e/fixtures.ts` where the
  contract test parses it, and the bench fails on a rendered error state.

### Passenger product recovery (2026-09-04)

> **Locally complete, not yet verified against real data.** Everything in this section is built,
> unit- and integration-tested, and green on the full local gate — but this container has no
> upstream egress and no deploy, so none of it has met a real BODS archive, a real SIRI-SX
> document or a deployed Worker. "The GTFS ingest reads the whole archive" is a claim about code
> that has been proved against archives built byte by byte in tests; it becomes a claim about
> England when the deliberate online verification run measures it. Until then, treat every count,
> size and coverage figure below as a design target rather than an observation.

- **The 60-of-945 timetable cap is retired.** It was a memory limit wearing a coverage limit's
  clothes: everything fetched was assembled into one in-memory network, so how much of England
  could have a departure board was decided by how much would fit in a heap. The daily and weekly
  jobs now read BODS's own GTFS extract as a stream — `gtfs-zip.ts` reads the central directory
  off disk (Zip64 included), `gtfs-csv.ts` parses RFC 4180 rows off that stream, `gtfs-network.ts`
  emits one journey at a time, and `gtfs-spill.ts` sorts them into tiles on disk. Only journeys
  moved to disk, because only journeys scale with every trip on every service date; stops,
  patterns, services and the search index are unchanged. `BODS_MAX_TIMETABLE_DATASETS` is gone and
  `BODS_GTFS_REGION` replaces it.
- **Official disruption notices are real.** A separate model from `Incident` — one is what an
  operator published, the other is what Bus Stops inferred — collected every ten minutes from BODS
  SIRI-SX and TfL, published as a bounded artifact, and shown as "Official now" above "Observed by
  Bus Stops". The map's hardcoded `incidents: []` is gone.
- **Accessibility is a set of sourced facts.** Fourteen stop facts and three vehicle facts, each
  with a status, a source, the field it came from, a provenance sentence and a confidence. A
  missing value is UNKNOWN and never NO. No score.
- **A Worker error is readable again.** CORS headers were only on successful responses, so every
  404, 405, 429 and 500 reached the browser as `net::ERR_FAILED` with no status — which is what
  the live map's "This stop could not be loaded" actually was.
- **Run 26's mismatch is a regression test.** BODS answered 237/364/338/233 vehicles for
  Leeds/Manchester/Birmingham/Bristol at 09:38Z while the deployment answered zero for all four.
  Both halves are pinned: the counts must be published, and an empty viewport must name which of
  `request_failed`, `empty_feed` or `all_rejected` happened.

- Phase: P0–P9 complete → P10 (deployment, automated and executing)
- Overall: foundations, all eight source adapters, the national static-network pipeline, the
  Worker edge API, the full Bus Stops Live passenger app, the journey planning engine, the
  analytics engine, the national intelligence pipeline, Bus Stops Pro and the Daily Brief are
  complete, and the platform is hardened with browser, accessibility, property and free-tier
  drill suites. P10 is now a single GitHub Actions run rather than a manual checklist.
- Deployment: preview deploy runs from `Deploy Preview`, which provisions Cloudflare resources,
  sets the Worker's runtime secrets, deploys both halves, bootstraps real national data and smoke
  tests what it deployed. Production stays behind a separate, reviewer-gated button.
- Data: the preview serves real national data. A bootstrap publishes 349,531 NaPTAN stops, 1,043
  services, 48,448 patterns and 32,199 journeys from live BODS and NaPTAN, sharded so the edge
  reads only what a request spans — see ADR 0002 for why the mechanism differs from the letter of
  the architecture document, and what it costs.
- Design: the pixel artwork is a real asset library rather than shapes assembled out of
  rectangles. It is authored as drawing code in `tools/pixel-art` on a fixed art-pixel grid with
  one ramped palette and one light direction, and built to images (`npm run art`); see ADR 0003.
  The hero street is composed in three planes at two native sizes — 320x144 wide, 144x250
  upright — and displayed only at whole-number scales, with a repeating edge tile carrying it off
  both sides of the window. The map markers, the loading bus, the empty states and the arrival
  board's mark are the same drawings reduced.
- Design verification: `scripts/visual-qa.mjs` opens the deployed preview at desktop, tablet and
  phone widths and measures what can be measured — the hero fills the fold, the artwork loaded and
  is scaled by a whole number, the basemap paints, nothing scrolls sideways — and keeps its
  screenshots as a run artifact. It does not judge the artwork, and says so: `npm run art:bench`
  renders every surface carrying artwork for that.
- **B4 — GitHub Actions stopped executing (2026-09-04, ~09:40 UTC onwards).** Dispatch answered
  `Actions has been disabled for this user` at 14:03Z, and — the decisive evidence — CI, which
  triggers on push to this branch, has not produced a run since `run_number: 94` at 09:36:47Z
  across four subsequent pushes. Read access to the Actions API returned later in the day, so this
  was never a token being blind; nothing was being _run_. Everything needing a runner is blocked
  until execution resumes: the deployed probe, the GTFS measurement, deploys, and the product
  audit. Everything else continues here — the container has no upstream egress of its own (the
  agent proxy answers 403 to `data.bus-data.dft.gov.uk`), but adapters, pipelines, the Worker, the
  app, tests and the artwork are all buildable and testable locally, and Chromium is installed.
- **B4 (original note) — GitHub Actions is disabled on this account (2026-09-04 12:09 UTC).** Dispatching any
  workflow returns `Actions has been disabled for this user`, and the run history now lists zero
  runs where it listed twenty-six an hour earlier. This container has no upstream egress of its
  own — the agent proxy answers 403 to `data.bus-data.dft.gov.uk` and to the Actions artifact
  host — so with Actions off there is no route to a real upstream, no way to deploy, and no way
  to run the deployed probe or the GTFS measurement. Everything that needs a runner is stopped
  until Actions is re-enabled (usually a spending limit or an account flag, in the repository's
  Actions settings or the account's billing page). Everything that does not need one continues:
  adapters, pipelines, the Worker, the app, tests and the artwork are all buildable and testable
  here, and Chromium is installed locally for visual work.
- Blockers: B1 and B2 are unchanged and are properties of _this build container_, not of the
  platform — the GitHub Actions runner has the egress and the credentials that this container
  lacks, which is precisely why the deploy happens there. B3 is resolved (see below).

## Environment audit (measured 2026-09-02)

Host reachability was measured directly rather than assumed:

| Host                                  | Result                          |
| ------------------------------------- | ------------------------------- |
| `registry.npmjs.org`                  | reachable (npm install works)   |
| `github.com`                          | reachable (git push works)      |
| `api.cloudflare.com`                  | CONNECT denied by egress policy |
| `data.bus-data.dft.gov.uk` (BODS)     | CONNECT denied                  |
| `api.tfl.gov.uk`                      | CONNECT denied                  |
| `naptan.api.dft.gov.uk`               | CONNECT denied                  |
| `environment.data.gov.uk` (EA floods) | CONNECT denied                  |
| `api.open-meteo.com`                  | CONNECT denied                  |
| `tile.openstreetmap.org`              | CONNECT denied                  |

Re-measured 2026-09-03: unchanged. Every one of those hosts still answers `403` to `CONNECT`
through the environment's egress proxy, and no upstream credential is present here.

This constrains what can be _verified from this container_; it does not constrain the platform.
A GitHub-hosted runner has ordinary egress and holds the repository secrets, so live verification
of BODS, TfL and NaPTAN, and every Cloudflare API call, happen in the workflow rather than here.
Per `CLAUDE.md`, all credential-independent work proceeded and the blocked verifications are
isolated and documented. See `docs/adr/0001-stack-and-build-environment-constraints.md`.

### Completed

- [x] Repository/toolchain audit — spec docs only, no prior application code
- [x] Stack decision recorded (ADR 0001): npm workspaces, TypeScript, Vite/React PWA,
      Cloudflare Worker + R2, MapLibre, GitHub Actions, Vitest + Playwright
- [x] Monorepo scaffold: `apps/`, `packages/`, `pipelines/`, `tests/`, `infra/`, `scripts/`
- [x] Quality gates run locally: format, lint, typecheck, tests, preflight, secret scan
- [x] `packages/contracts` — typed + zod-validated model for static, live, derived, account
      and API entities, with England bounds and hard map-query caps
- [x] Source registry with owner, purpose, geography, licence, attribution, credential env name,
      freshness SLA, cache policy, terms notes and contract-verification method
- [x] `packages/governor` — £0 budget registry, 70/85/95% thresholds, projection, capability
      gating, degradation ladder and safe mode
- [x] `packages/ui` design tokens for the approved warm-white/black/red direction
- [x] Threat model (`docs/THREAT_MODEL.md`) mapping 10 threats to implemented, tested controls
- [x] CI workflow with least-privilege permissions and no secrets for pull requests
- [x] `.env.example` with names only; `.gitignore` excludes all env files

- [x] `packages/pipeline-core` — retention classes (raw traces hard-capped at 48h), geo and
      DST-correct time primitives, resilient HTTP with circuit breaking and request coalescing,
      atomic versioned artifacts with checksum validation and rollback, poison-record quarantine
- [x] `packages/adapters` — all eight sources: NaPTAN (with OSGB36→WGS84 recovery), TfL,
      BODS SIRI-VM, TransXChange, Open-Meteo, Environment Agency, National Highways,
      Street Manager and OpenStreetMap
- [x] `pipelines/static-network` — national build, search index, atomic publish with
      previous-good rollback, daily fingerprint change detection, weekly full reconciliation
- [x] Scheduled workflows with concurrency groups, runtime caps and least-privilege permissions

**P2 — live data and edge delivery**

- [x] `apps/worker` — dependency-free router serving versioned envelopes for viewport, stop,
      route and search queries, with hard map-query caps enforced server-side
- [x] Isolate-level snapshot caching, request coalescing and per-client rate limiting
- [x] Security headers and CSP; no upstream credential ever reaches a response
- [x] Source health surfaced per response: `sources`, `coverage`, `degradation`,
      `governorState` and `attribution` on every envelope
- [x] Degradation derivation — `scheduled_only` when every live source for the viewport is
      down, `partial_sources` when some remain, so the UI can state exactly what is missing
- [x] `packages/matching` — vehicle-to-journey matching by distance, bearing and sequence
      continuity, with delay interpolated between scheduled stop times
- [x] 40 worker tests driving the real fetch handler end to end

**P3 — Bus Stops Live**

- [x] React 18 + Vite PWA shell, warm-white/black/red tokens, pixel-art SVG library, wordmark
- [x] Home, stop, search, live map, saved, methodology, legal and not-found pages
- [x] Arrival board with live/scheduled/stale distinction and visible source confidence
- [x] "Will I make it?" and "Bus Stopped?" logic with honest uncertainty
- [x] Local-first favourites (no account required), maps handoff, allowlisted ticket links
- [x] MapLibre in a lazy chunk; with no configured style the map renders nothing rather than
      silently falling back to a third-party tile provider, and the list stands alone
- [x] Vehicle page: route, destination, punctuality, movement, match confidence, next four stops
      with an expandable full sequence, and an explicit statement that the reference rotates daily
      so an old link is expected to stop resolving
- [x] Route page: variants as selectable directions, the stop sequence drawn as a route line,
      buses currently running it, and a frequency only where the timetable supports one
- [x] Operator page: factual overview with per-metric suppression and an explicit statement that
      the operator cannot be ranked, rather than a league-table position the sample cannot support
- [x] Disruptions page: the two rankings kept separate, each explaining what it answers, with the
      uncovered areas named so an empty list is never read as nothing being wrong
- [x] Journey planner page: search or geolocation endpoints, arrival shown as a range with its
      confidence, walk-only fallback, and a statement that the locations are not stored
- [x] "Bus Stopped?" panel: plausible states rather than one cause, never claiming a breakdown or
      cancellation, with the next useful services, an alternative stop, a maps handoff and fixed
      minimal emergency guidance
- [x] Worker endpoints added for route, operator, disruptions, vehicle and journey, and the stop
      endpoint now returns the routes that actually call there
- [x] Journeys are additionally published one artifact per spatial tile, so the edge can plan a
      journey by loading the two or three tiles a corridor spans instead of the national timetable
- [x] 83 web tests and 56 worker tests

**P4 — journey planning engine**

- [x] `packages/journey` — RAPTOR-style rounds keyed by change count, initial footpaths,
      walk-only itineraries and transfer handling
- [x] Brute-force verification harness that proves the planner's answers against exhaustive
      search; it found three real planner bugs, all fixed
- [x] Nearest-versus-fastest explanation gated on uncertainty, so the app only claims a
      further stop is better when the evidence supports it
- [x] 26 journey tests

**P6 — analytics engine**

- [x] `packages/analytics/statistics.ts` — robust statistics: quantiles, median, MAD, IQR,
      MAD→IQR-fallback robust z-score, empirical percentile, Wilson proportion intervals
- [x] `metrics.ts` — punctuality, reliability, headway adherence and network health, each with
      a mandatory denominator, small-sample suppression, and source outages excluded from the
      denominator so a dead feed can never be reported as cancelled services
- [x] `baseline.ts` — comparable-period baselines with explicit sufficiency rules, and an
      abnormality classifier that takes the _less_ alarming of percentile and z-score, then
      applies materiality and persistence gates before anything is called unusual
- [x] `events.ts` — bunching, service gaps, diversions and skipped stops, each refusing to fire
      when the feed is unhealthy, and worded observationally ("appears to have taken a
      different route", never "is diverted")
- [x] `congestion.ts` — excess vehicle-minutes, delay-origin location with competing
      explanations, and speed anomalies that require a sourced limit and are never framed as
      an accusation against a driver
- [x] `weather-risk.ts` — weather sensitivity from matched strata only (association, never
      causation), flood susceptibility behind the official-wording gate, and route risk as a
      probability band that widens as coverage falls
- [x] `confidence.ts` — confidence capped by the weakest _essential_ evidence component, with
      supporting evidence able to adjust only within that cap, plus calibration measurement
- [x] 93 analytics tests

**P5 — national intelligence pipeline**

- [x] `packages/matching/map-match.ts` — bounded Viterbi map matching with emission, transition,
      bearing and plausible-speed terms. Nearest-line matching is not used: it flips between
      parallel carriageways and manufactures phantom diversions, which is the most damaging false
      positive this system can publish. Display traces are simplified separately from the
      analytical match, as the specification requires.
- [x] `pipelines/live-collection` — the scheduled intelligence path, wholly separate from the user
      path: a 24-cell England partition grid, quota-aware cadence that never polls faster than the
      source updates and suspends entirely in critical state, ingest quality gates that reject
      rather than silently correct, and a rolling window that deduplicates on source timestamps and
      hard-caps itself at the retention ceiling by age and by count
- [x] Multiple snapshots per run: one position per vehicle cannot yield a traversal, a speed or a
      delay, so a scheduled run collects a short bounded burst rather than a single frame
- [x] Collection refuses to run without `VEHICLE_SALT_SECRET` rather than storing operators'
      own vehicle identifiers unsalted
- [x] `pipelines/analytics-batch` — checkpointed stage runner (idempotent, bounded, emitting
      counts, rejections and timing; a failed stage skips its dependants instead of letting them
      build on a gap), segment sampling behind a match-confidence floor, interval aggregation with
      an open/closed bucket model and versioned revisions, roll-up-before-pruning, storage
      inventory with forward quota projection, enrichment joins, incident lifecycle and atomic
      publication with rollback
- [x] Enrichment states its distance, window and match confidence on every join; National
      Highways silence about a local street is reported as "not covered", never as "clear"; Street
      Manager records are corroboration and the type carries no cause field; Environment Agency
      notices join by licensed flood area rather than an invented radius
- [x] Incidents open as `emerging` and need a second detection to become `active`, then decay
      through `recovering` to `resolved`; identity is deterministic so a retried run cannot
      duplicate an incident already on screen
- [x] Retention runs as its own scheduled job, independent of the batch, so raw expiry can never
      be blocked by an analytics failure
- [x] 94 pipeline tests (27 collection, 42 batch, 7 map matching, plus artifact contract tests)

**P7 — Bus Stops Pro**

- [x] All ten sections built and publicly reachable with no sign-in anywhere: Control Tower, Live
      Operations, Routes, Operators, Congestion, Analytics, Reports, Daily Brief and Settings,
      with working filters and drilldowns
- [x] Every response carries an explicit `dataMode` — live, demo_snapshot or unavailable — so a
      viewer never has to guess. The demonstration snapshot is dated, labelled in the UI, and is
      reached only when no live intelligence artifact has been published; live and snapshot data
      are never blended
- [x] `ProMetric` makes it structurally impossible to publish a figure without its definition,
      denominator, comparison window, freshness, coverage and suppression state; the tile renders
      a dash and the reason rather than a placeholder number
- [x] Control Tower leads with the coverage warning, before any headline figure, and the outlook
      is assembled from the figures by a fixed rule with no model and no free text
- [x] Delay-burden and abnormality rankings kept distinct on both Control Tower and Congestion,
      each stating what it ranks on
- [x] Operator scorecards publish raw and context-adjusted figures together, and an operator below
      the comparison threshold is shown separately with its reason rather than ranked
- [x] Analytics sections carry wording the UI reproduces verbatim: association-not-causation for
      weather, the Environment Agency wording gate for flooding, and the explicit statement that
      speed anomalies are properties of a road segment and not statements about any driver
- [x] Live Operations shows no dispatch controls, and says why
- [x] Pro settings in the public demo are local and ephemeral, and say so
- [x] 12 Pro component tests and 11 Pro worker tests

**P8 — accounts and the Daily Brief**

- [x] `packages/daily-brief` — the frozen snapshot, from which both the email and the browser view
      are rendered, so a recipient opening the link an hour later sees the same figures
- [x] Deterministic narrative assembled from ranked facts by a fixed template. No model writes any
      part of it, which is a requirement rather than a preference: a rewriting step cannot be
      trusted not to change a number or soften a caveat
- [x] Route rankings are withheld when coverage or sample size cannot support comparing routes
- [x] A thin-data day is either sent under a clear limited-data label or skipped by preference,
      and never quietly padded out
- [x] Investigation priorities are phrased as suggestions and never as operational instructions;
      a test asserts the wording contains no imperative
- [x] Table-based responsive HTML with inline styles and no images, a full plain-text part carrying
      the same figures and the same unsubscribe link, and charts degraded to numbers and bars
- [x] Data-derived text is escaped, so crafted content cannot inject markup into an email
- [x] `canSend` returns a typed refusal with a reason, so no caller can treat "unverified" as
      "fine": verification, explicit opt-in, unsubscribe state, idempotency, the daily cap, the
      governor state, the provider being configured and the delivery window are all checked
- [x] The self-imposed daily cap sits below the provider's free limit and halves under budget
      pressure; sending is suspended entirely in the critical state
- [x] One-click unsubscribe over both GET and POST (RFC 8058), honoured immediately, idempotent on
      a second click, spending the token so a leaked link cannot be replayed, and answering
      identically whether or not the token was valid so it cannot be used to test an address
- [x] Only unsubscribe token hashes are stored; the plaintext exists only long enough to be put in
      the email
- [x] Every send attempt is recorded including the refusals, so an absence of email is explainable
- [x] The whole product works with no email provider configured: the snapshot is still built and
      published and the browser Daily Brief works normally
- [x] 55 Daily Brief tests (41 package, 14 pipeline) and 4 unsubscribe worker tests

**P9 — hardening and free-tier proof**

- [x] Playwright end-to-end suite: passenger journeys, degraded and stale states, the Pro
      surfaces, the disruption inbox and unsubscribe, across 320/375/768/1440 widths
- [x] axe-core accessibility pass at WCAG 2.2 AA on nine pages, plus keyboard focus, heading
      outline, reduced-motion, 200% zoom and map-alternative checks
- [x] Property-based tests for geometry, tiling, statistics, metrics and idempotency invariants
- [x] Free-tier drills simulating each governor threshold, asserting that the API, the scheduled
      collectors, the batch pipeline and email delivery all respond coherently to the same pressure
- [x] Retention drills: roll up before pruning, raw expiry at its ceiling regardless, correct
      prune ordering, and no retention class that keeps anything indefinitely
- [x] Storage projection drill naming the date storage would fill at the observed growth rate
- [x] Five runbooks covering source outage, budget pressure, bad artifacts, Daily Brief incidents
      and data subject requests
- [x] Pro Disruptions exception inbox with severity, abnormality, lifecycle, confidence and source
- [x] Journey planner accepts a destination handed over from the map or a stop page
- [x] README rewritten as a working guide to the repository

**Defects the hardening suites found, and fixed**

1. The stop page crashed to a blank white screen on a malformed API payload. Responses are now
   validated at the client boundary, and a route-level error boundary means a component failure
   degrades to a panel instead of blanking the app.
2. Saving a stop as a favourite silently did nothing: the favourite was written under the ATCO
   code and read back under the URL parameter, which is a UUID. Both sides now key on the ATCO
   code.
3. Three WCAG AA colour-contrast failures — brand red on white at 11px, the same red on the
   near-black arrival board, and the light-background muted grey used on that board.
4. The Wilson score interval could return an upper bound below its own point estimate at p = 1,
   through floating-point rounding. The bounds now bracket the value.

**P10 — deployment (credential-independent work complete)**

- [x] Deploy workflow: manual rather than deploy-on-push, re-running the whole gate on the commit
      being deployed, gated on the stricter deploy-stage preflight, and smoke-testing what it
      deployed with rollback guidance on failure
- [x] `scripts/smoke-test.mjs` — 11 checks against a live deployment, executed here against the
      Worker running under `wrangler dev` with 10 passing; it deliberately does not assert that
      upstream feeds are healthy, since that is not a property of the deployment
- [x] `apps/web/public/_headers` and `_redirects`. The smoke test found that the static site would
      have shipped with no Content-Security-Policy at all: the Worker hardened API responses while
      the pages people actually load had nothing. Six tests now assert the policy
- [x] `infra/cloudflare/PROVISIONING.md` — the exact minimum API token scopes, the Worker secrets,
      and why quota verification is deliberately a human step

**Deployment-readiness audit (2026-09-03)**

A reconciliation pass over every file that describes what must be provisioned. Seven defects
found, all fixed; the repository is now ready to provision.

1. **Production deploys would have gone to preview.** `deploy.yml` selected the Worker
   environment with `inputs.environment == 'production' && '' || 'preview'`. GitHub expressions
   short-circuit like JavaScript and the empty string is falsy, so that returns `preview` for
   _both_ branches. Verified empirically, then replaced with a shell step that computes the
   target once. A test rejects any expression whose truthy branch is an empty string.
2. **The preview Worker had no bindings of its own beyond R2.** Wrangler does not inherit
   bindings into named environments — a binding declared only at the top level is simply absent
   and the deploy still succeeds. Preview now declares every binding, var and observability
   setting explicitly, and both preflight and a test compare the two environments structurally,
   so a binding added later and forgotten under preview fails before it ships.
3. **The KV namespace was dead configuration.** `CACHE` was bound in `wrangler.toml` and declared
   in `WorkerEnv`, but no code read it. It has been removed rather than left for someone to
   provision for nothing: the free tier allows 1,000 KV writes a day, which suits none of the
   caching this Worker would want. Its two budget-registry entries went with it.
4. **GitHub Actions minutes were modelled as a fictitious 50,000/month allowance.** That is the
   included quota for private repositories on a paid plan; standard GitHub-hosted runners are
   free and unlimited for public repositories. The entry is now `metered: false` with the
   condition recorded, because making this repository private would turn minutes into a real
   budget.
5. **The BODS limit was a number nobody published.** 20,000 requests/day appeared nowhere in
   BODS guidance, which instead asks for no more than one central live-data request every five
   seconds. Recorded as 12 requests/minute and — more importantly — enforced at the point of
   request: the collector previously issued its whole partition list as fast as the responses
   came back, breaching the interval while appearing to be well inside budget. Four tests cover
   the spacing, including that coverage is sacrificed before the publisher's rule is.
6. **The cadence interval double-counted.** Waiting the full interval _after_ a pass, on top of
   per-request spacing, stretched a 60-second cadence to nearly two minutes and pushed a normal
   run over its time budget. The interval now counts from the start of the previous pass, which
   is what a cadence means.
7. **`evaluateResource` reported unverified allowances as verified**, substituting the current
   time when `verifiedAt` was null. An unverified figure could not be told apart from a checked
   one. `allowanceVerifiedAt` is now nullable and reports null.

Also: `.env.example` had five variables nothing read (`R2_BUCKET_RAW`, `KV_NAMESPACE_CACHE`,
`DATABASE_URL`, `AUTH_SECRET`, `AUTH_ALLOWED_ORIGIN`). A contract test now fails on drift in
either direction. National Highways and Street Manager keys are documented as not required to
deploy, because their adapters are contract-tested but not yet called by any scheduled job.

## Deployment automation (2026-09-03)

The deploy was a document describing eleven manual steps. It is now one button, because each step
a person performs before a deploy works is a step that gets performed wrong once.

**The API routing defect, fixed.** The frontend `ApiClient` defaulted to a relative `/api`. The
app is served by Pages and the API by a Worker — different origins — so every call would have
resolved to the Pages host and 404'd, and the static CSP's `connect-src 'self'` would have
blocked the correct origin even after it was pointed there. Three changes, applied together:

1. `defaultApiBaseUrl()` reads `import.meta.env.VITE_API_URL`, which the deploy workflows set to
   the Worker URL they just read back from wrangler's output. It is baked into the bundle: no
   runtime lookup, no configuration endpoint to get wrong. Unset, it still falls back to `/api`,
   which the Vite dev server now proxies to a local `wrangler dev` on 8787.
2. `scripts/generate-headers.mjs` writes `dist/_headers` at deploy time with
   `connect-src 'self' <exact Worker origin>` — named, never wildcarded. `public/_headers` stays
   deliberately restrictive so a skipped generator fails visibly in a browser console rather than
   silently shipping a wider policy.
3. `PUBLIC_BASE_URL` is declared per environment in `wrangler.toml`, so the Worker's CORS
   allow-list names exactly the Pages origin for that environment. This needed no chicken-and-egg
   resolution: Pages hostnames are deterministic (`busstops.pages.dev`,
   `preview.busstops.pages.dev`), unlike the account-specific workers.dev subdomain.

A Pages Functions proxy at `/api` was considered and rejected. Pages Functions are Workers, so
every API request would have invoked two of them against the same free-tier request budget.

**Provisioning.** `scripts/provision-cloudflare.mjs` checks before it creates, treats a
concurrent run's "already exists" as success, and can reach nothing chargeable. It creates the two
R2 buckets and the Pages project; wrangler creates the Worker scripts.

**Manual configuration removed.** `R2_BUCKET_ARTIFACTS`, `BUDGET_UTILIZATION`, `PUBLIC_BASE_URL`
and `PUBLIC_API_URL` were required repository variables. The first two now default in every
workflow that reads them, `PUBLIC_BASE_URL` moved into `wrangler.toml` where it is also the CORS
origin, and `PUBLIC_API_URL` is gone entirely — deriving the URL from the deploy is strictly
stronger than validating a variable, because a variable can be set and still name the wrong
environment, and a smoke test against production after a preview deploy reports a confident pass.
The preview path needs no GitHub Environment. The `production` environment is kept, because a
required reviewer on it is a real gate rather than ceremony.

Two tests changed rather than being deleted, and both were stale premises rather than weakened
assertions:

- `governor.test.ts` asserted `unverifiedRequiredResources()` returns a non-empty list. That was
  written when nothing had been verified; all deployment-required allowances now are, so it
  correctly returns none. It is replaced by three tests of the mechanism: that required-and-
  unverified is selected exactly, that an optional unverified allowance never blocks a deploy,
  and that every required allowance carries a note saying how it was verified.
- `deployment-config.test.ts` required the workflow to refuse an unset `$SITE_URL`/`$API_URL`.
  Those variables no longer exist; the replacement asserts the stronger property that both URLs
  come from the deploy steps and from no repository or environment variable.

A dead `quota:check` npm script pointing at a file that was never written has been removed.

### In progress

- [x] P10 — `Deploy Preview` run 25 green end to end: gates, deploy, data verification and the
      deployed visual pass. Production remains un-deployed and un-requested.

### Next

1. **Run `Deploy Preview` the moment Actions executes again.** Everything the recruiter cut needs
   is committed and pushed; the deploy is the only remaining step, and its probe is also what
   diagnoses the live-bus failure. Then verify, in order: home loads with the artwork, the live
   map loads, the basemap loads, the deployed `/v1/map` returns more than zero real vehicles for
   Leeds, buses render on the map, clicking a stop opens NEXT BUS, and the console carries no
   major failures.
2. **The deployed live-bus failure is unexplained.** BODS answered 237/364/338/233 vehicles for
   Leeds/Manchester/Birmingham/Bristol from a runner while the deployment answered zero for all
   four; both halves are a passing regression test, which itself says the code path is correct
   given a healthy feed. `/v1/diagnostics/live` will name which of `request_failed`, `empty_feed`
   or `all_rejected` actually happens up there.
3. Deferred to the next session, deliberately and with nothing started: GTFS verified against a
   real archive, departures at every non-London stop, place-first search, "take me to York
   Minster", the rest of accessibility, "Bus stopped?", mobile bottom sheets and the phone map
   layout (the live map on a phone still puts its controls above the map), a Pro baseline from
   real observations, the final art passes, and the full deployed product audit.
4. Watch the shard sizes each publish reports. The byte budget is a backstop, not a target: a
   family that starts truncating is telling you its key needs to be finer, and it says which.
5. The remaining TfL adapters (route sequence, stop point, disruptions) are still verified
   against published documentation rather than against a live response.
6. Production remains un-deployed pending explicit approval after the preview is reviewed.

### Deployment evidence

Preview, deployed by `Deploy Preview` from a GitHub-hosted runner:

|                 |                                                       |
| --------------- | ----------------------------------------------------- |
| Preview site    | https://preview.busstops.pages.dev                    |
| API (Worker)    | https://busstops-api-preview.paulmurrin13.workers.dev |
| Artifact bucket | `busstops-artifacts-preview`                          |

Verified against those real URLs, not against a rehearsal:

- **Smoke test: 11 of 11 passed.** App shell serves; security headers present; source health
  answers with its governor state; every response states freshness and degradation; the map's
  size cap and required bounding box are enforced by the running Worker; Pro answers with no
  credential; unknown paths 404; write methods are refused; one-click unsubscribe accepts a POST;
  no credential appears in any response body.
- **The cross-origin path works end to end.** The deployed bundle
  (`/assets/index-*.js`) contains the Worker origin, so `VITE_API_URL` really was baked in; the
  served CSP is `connect-src 'self' https://busstops-api-preview.paulmurrin13.workers.dev`, naming
  the exact origin with no wildcard; and the Worker answers a request from the Pages origin with
  `Access-Control-Allow-Origin: https://preview.busstops.pages.dev`. This was the defect most
  likely to produce an app whose every request fails in a browser while every server-side test
  passes, so it is checked against the deployment rather than reasoned about.
- **Pro is public.** `dataMode: "demo_snapshot"`, no `WWW-Authenticate`, no sign-in wall.

**Real national data is published.** `Deploy Preview` run 4 bootstrapped
`busstops-artifacts-preview` from live BODS and NaPTAN, outcome `published`, nothing failed:

| Dataset                | Records                                        |
| ---------------------- | ---------------------------------------------- |
| `network/stops`        | 349,531                                        |
| `network/search-index` | 350,596                                        |
| `network/patterns`     | 48,448                                         |
| `network/journeys`     | 32,199                                         |
| `network/services`     | 1,043                                          |
| `network/shapes`       | 515                                            |
| `network/operators`    | 22                                             |
| journey tiles          | 46 published, 0 failed, 0 journeys unplaceable |

Getting there took three real defects, each found by measurement rather than assumption:

1. **BODS timetables are zip archives.** 945 published datasets, all 25 in the first page
   `extension: "zip"`, the download `application/zip` with PK magic bytes. The pipeline fetched
   them as text, so the XML parser was handed binary — no journeys parsed, every downstream
   dataset came out empty, and the publish rolled back with nothing to explain why.
2. **The build exhausted the heap.** Fixing the zips meant 25 archives really were decompressed,
   and fingerprinting joined all of them into one string. FNV-1a folds left to right, so the join
   was never needed.
3. **Tile publishing was serial.** Thousands of independent writes, three round trips each.

**The national datasets do not fit in an edge isolate, so the edge stopped reading them.**
Measured, not inferred (`scripts/inspect-artifacts.mjs`, run against the preview bucket):

| Dataset                | Records | Size      |
| ---------------------- | ------- | --------- |
| `network/journeys`     | 32,199  | 292.2 MiB |
| `network/stops`        | 349,531 | 197.6 MiB |
| `network/patterns`     | 48,448  | 100.1 MiB |
| `network/search-index` | 350,596 | 87.5 MiB  |

A Workers isolate has 128 MiB. The former `NetworkRepository.read()` loaded stops, operators,
services, patterns, shapes and the search index together — roughly 390 MiB of text before any of
it was parsed, and parsed JSON is larger than its source. The isolate was killed, so every
endpoint that loaded the snapshot answered 500 and every endpoint that did not — health, Pro, the
query caps, unsubscribe — worked. That is exactly the pattern that was observed.

An earlier guess at this same 500 was that the free tier's CPU limit was being exceeded parsing
SIRI-VM. That was wrong: the response body is the Worker's own error text, not Cloudflare's
resource-limit page, which is what prompted printing the body rather than the status code.

**The fix is the one the codebase already chose once for journeys.** `publish.ts` says of them:
"The national journeys dataset is far too large to load in a Worker isolate, but a journey plan
only ever needs the corridor between two points." The same is now true of everything a passenger
query touches.

- `pipelines/static-network/src/shards.ts` addresses the shards. Spatial families — stops,
  patterns and the search tiles — use the half-degree tile the journey tiles already used. Key
  families — the stop locator and the search prefixes — use an FNV-1a bucket and a two-character
  word prefix, so an identifier or a typed word resolves to exactly one small object. A search is
  a prefix bucket plus, where the query has a location, the tiles around it: not one 87 MiB index
  moved somewhere else.
- `apps/worker/src/network-reader.ts` replaced `NetworkRepository`. Nothing in it opens a national
  object except `operators` (22 records), `services` (1,043) and the one-record index. Its shard
  cache is bounded by count _and_ by the size of the text it parsed, because twenty-four dense
  city tiles are not the same quantity of memory as twenty-four rural ones.
- **Versioning is atomic.** The index record is read first and names the version; every shard is
  then read at that exact version rather than through its own pointer. A publish writes shards
  first and the index last, so a version that is visible is complete, and a reader mid-publish
  keeps serving the previous one.
- `apps/worker/src/isolate-memory.test.ts` asserts the _shape_ of the access rather than a size,
  because a fixture small enough to run in a test is small enough to hide the defect. A recording
  store logs every key read; a viewport, a stop page and a search must touch none of the national
  datasets, and a source scan fails if `NetworkSnapshot` or `network-repository` reappear.

Publishing the shards then failed twice more, and both were about size rather than logic:

4. **Rate limiting, not memory.** 962 shard publishes returned 429. A full artifact publish costs
   three round trips; two of them — the per-shard manifest and the shrink check — are meaningless
   for a shard the reader addresses directly at a version the index names. One write per shard,
   and `R2ObjectStore` now waits out a 429 honouring `Retry-After`.
5. **A shape key that was not unique, and a cap counted in the wrong unit.** A TransXChange
   journey pattern id is unique only inside its own document, and shapes were keyed by it alone —
   so nationally 48,448 patterns collapsed onto 515 shapes. Most patterns carried another
   operator's geometry, and every pattern sharing a key piled into the same tiles: one tile threw
   `Invalid string length` while being serialised and the next was refused with 413, both while
   inside the 20,000-record cap. Shapes are now keyed by route, scoped to the service, which is
   also the deduplication the old key was reaching for. Published geometry is simplified to ten
   metres and rounded to five decimal places, a tile stores each shape once, and the cap is now on
   bytes measured on the exact text written — with the largest shard in each family reported after
   every publish, because the useful question is how close the largest one came.

### Verification evidence

Local checks run in the build container; live checks cite the GitHub Actions run that observed
them, because this container has no egress (B1).

| Check                         | Command or method                          | Result                                                                                                                                                                                                                                                                                                                                               | Date       |
| ----------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Install                       | `npm ci`                                   | Clean install from lockfile                                                                                                                                                                                                                                                                                                                          | 2026-09-03 |
| Unit + contract + integration | `npm test`                                 | 941 passed / 941 (837 root across 37 files, 104 web)                                                                                                                                                                                                                                                                                                 | 2026-09-04 |
| Lint                          | `npm run lint`                             | Clean, `--max-warnings=0`                                                                                                                                                                                                                                                                                                                            | 2026-09-03 |
| Format                        | `npm run format:check`                     | Clean                                                                                                                                                                                                                                                                                                                                                | 2026-09-03 |
| Type check                    | `npm run typecheck`                        | Passed for every workspace                                                                                                                                                                                                                                                                                                                           | 2026-09-03 |
| Free-tier preflight (ci)      | `npm run preflight`                        | Passed, 0 warnings                                                                                                                                                                                                                                                                                                                                   | 2026-09-03 |
| Free-tier preflight (deploy)  | `PREFLIGHT_STAGE=deploy npm run preflight` | Passed, 0 warnings                                                                                                                                                                                                                                                                                                                                   | 2026-09-03 |
| Secret scan                   | `node scripts/secret-scan.mjs`             | Clean across 313 tracked files                                                                                                                                                                                                                                                                                                                       | 2026-09-03 |
| End-to-end + accessibility    | `npm run test:e2e`                         | 140 passed / 140 across desktop, tablet and two phone sizes                                                                                                                                                                                                                                                                                          | 2026-09-04 |
| Journey planner verification  | `npx vitest run packages/journey`          | Brute-force equivalence against exhaustive search                                                                                                                                                                                                                                                                                                    | 2026-09-03 |
| Zip reader                    | `npx vitest run pipelines/static-network`  | 7 passed against a fixture written by Python's zipfile                                                                                                                                                                                                                                                                                               | 2026-09-03 |
| Live sources                  | `Verify live sources` run 2                | BODS, BODS timetables, TfL and NaPTAN all answered and parsed                                                                                                                                                                                                                                                                                        | 2026-09-03 |
| Provisioning                  | `Deploy Preview` run 1                     | R2 buckets and Pages project ensured; nothing chargeable enabled                                                                                                                                                                                                                                                                                     | 2026-09-03 |
| Worker deploy                 | `Deploy Preview` run 1                     | Deployed, secrets set, `/v1/sources/health` answered 200                                                                                                                                                                                                                                                                                             | 2026-09-03 |
| Pages deploy                  | `Deploy Preview` run 1                     | Deployed to the `preview` branch alias                                                                                                                                                                                                                                                                                                               | 2026-09-03 |
| Basemap terms and origins     | `Verify sources and artifacts` run 6       | OpenFreeMap Liberty: style loaded, a tile fetched with no key answered 200 image/png (154,821 bytes), attribution "OpenFreeMap © OpenMapTiles Data from OpenStreetMap", one CSP origin                                                                                                                                                               | 2026-09-03 |
| Data bootstrap                | `Deploy Preview` run 18                    | Outcome `published`; 349,531 stops, 1,043 services, 48,448 patterns, 32,199 journeys from 60 BODS timetable datasets                                                                                                                                                                                                                                 | 2026-09-04 |
| Smoke test                    | `Deploy Preview` run 25                    | 11 of 11 against the deployed pair                                                                                                                                                                                                                                                                                                                   | 2026-09-04 |
| Real data through the edge    | `Deploy Preview` run 25                    | Passed: viewport stops, nearby, stop board, search, route detail, journey plan, and that a viewport's stops carry the services calling at them                                                                                                                                                                                                       | 2026-09-04 |
| Artwork build                 | `npm run art`                              | 17 images, 20.3 KiB total, from tools/pixel-art                                                                                                                                                                                                                                                                                                      | 2026-09-04 |
| Deployed visual pass          | `Deploy Preview` run 25                    | 51 of 51 in Chromium at 1440/768/390: basemap paints (382,427 bytes at tablet, 114,150 at phone), 8–12 tiles at 200, attribution present, 230 markers, arrival board opens on a real Leeds stop, the hero artwork loads and is scaled by a whole number at every width (4x, 3x, 2x), no page scrolls sideways; 21 screenshots kept as a run artifact | 2026-09-04 |

### Acceptance audit (docs/17_ACCEPTANCE_CRITERIA.md)

Audited 2026-09-03. "Blocked" means the work is complete and testable but final verification needs
something unavailable in this environment; the blocker is named. Nothing is marked passing on the
strength of a fixture where the criterion asks for live data.

**Product and design** — all passing. Brand, pixel library with a reduced-motion loading bus,
functional pixel arrival board with live/scheduled/freshness states, responsive and keyboard
accessible UI verified by 140 browser tests at four widths with zero axe violations, and every
Live and Pro page present and substantive.

**England-wide data**

| Criterion                                                                                      | State                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No regional hard-code; configuration supports all England                                      | Pass — `ENGLAND_BOUNDS`, a 24-cell national partition grid, no per-city branching                                                                                                                                                                                             |
| BODS and TfL adapters live-verified with provenance/freshness                                  | Pass, within the scope recorded above — BODS SIRI-VM and the timetable catalogue, TfL arrivals and NaPTAN have all answered and parsed against the live services from a runner. Not every operator's dialect, and the remaining TfL adapters are still documentation-verified |
| NaPTAN identity, schedules, routes, patterns reconcile nationally                              | Pass — a national build published 349,531 stops, 1,043 services, 48,448 patterns and 32,199 journeys, with 4,211 dangling stop references reported rather than published                                                                                                      |
| Daily fingerprint ingest and weekly reconciliation run idempotently                            | Pass — tested; scheduled workflows configured                                                                                                                                                                                                                                 |
| Remaining five adapters implemented and contract-tested                                        | Pass                                                                                                                                                                                                                                                                          |
| Source failure, stale, partial coverage and previous-good fallback are user-visible and tested | Pass — worker tests and browser tests both assert the visible states                                                                                                                                                                                                          |

**Bus Stops Live**

| Criterion                                                                               | State                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewport map, nearby/search, departures, vehicles, tracking, next stops, show-all-stops | Pass against real published data — a Manchester viewport returns 400 real stops, selecting one returns its departure board, and search finds it by name, all through the deployed edge                                                                                                                                             |
| Recent actual path versus scheduled shape                                               | **Partial** — the scheduled shape is served and drawn; the actual path is held only in the bounded intelligence window and is not served at the edge. The vehicle page states this rather than drawing a line it cannot support                                                                                                    |
| Cautious diversion and skipped-stop evidence                                            | Pass — detectors, wording gates and tests                                                                                                                                                                                                                                                                                          |
| "Will I make it?" calibrated range, confidence, next service                            | Pass                                                                                                                                                                                                                                                                                                                               |
| "Bus Stopped?" evidence-aware recovery without unsupported claims                       | Pass — 10 component tests including "never claims a breakdown or cancellation"                                                                                                                                                                                                                                                     |
| Journey planner: searched and map-tapped destinations, three rankings                   | Pass                                                                                                                                                                                                                                                                                                                               |
| Nearest versus fastest boarding stop, explained when material                           | Pass — with a brute-force verification harness                                                                                                                                                                                                                                                                                     |
| Maps handoffs valid; favourites local-first                                             | Pass                                                                                                                                                                                                                                                                                                                               |
| Ticket links allowlisted, labelled, safely opened                                       | **Partial, deliberately** — the https-only domain allowlist, labelling and safe-open behaviour are implemented and tested, but `TICKET_REGISTRY` is empty. Entries require human verification that a domain is the operator's official retailer; adding unverified entries would be the exact harm the allowlist exists to prevent |

**Bus Stops Pro** — all passing. No login wall anywhere (asserted by a browser test), all ten
sections working with filters and drilldowns, every documented algorithm implemented, every metric
carrying denominator/window/freshness/coverage/confidence/evidence with incomparable rankings
suppressed, and the two rankings distinct on both Control Tower and Congestion.

**Daily Brief**

| Criterion                                                                           | State                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser and email from the same frozen snapshot                                     | Pass                                                                                                                                                                                                                   |
| Yesterday/today sections, caveats, evidence, deterministic narrative                | Pass                                                                                                                                                                                                                   |
| Verified opt-in, settings, authorization, one-click unsubscribe, idempotency, audit | Pass — 55 tests                                                                                                                                                                                                        |
| Hard send caps and degraded behaviour                                               | Pass                                                                                                                                                                                                                   |
| One authorized production test send                                                 | **Blocked** — needs a configured email provider and a real consenting recipient. Neither exists here, and sending to an unconsented address to satisfy a checkbox would violate the consent rules this system enforces |

**£0, security and operations**

| Criterion                                                                               | State                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Official quotas recorded; billing cannot increase automatically                         | **Partial** — the registry records every allowance with its terms URL, and no paid upgrade path exists in any code path. All 14 allowances carry `verifiedAt: null` because provider terms pages are unreachable (B1); the deploy-stage preflight fails until they are confirmed, which is the intended gate |
| Budget registry, thresholds, projections, kill switches, preflight                      | Pass                                                                                                                                                                                                                                                                                                         |
| Simulated amber/red/critical degrade in order, preserving deletion/unsubscribe/security | Pass — 18 drills                                                                                                                                                                                                                                                                                             |
| Raw GPS expires within 24–48h; rollups/pruning/inventory tested; no Replay              | Pass                                                                                                                                                                                                                                                                                                         |
| Secrets, validation, authorization, CSP, URL allowlist, privacy minimisation, audit     | Pass — threat model, secret scan, worker tests                                                                                                                                                                                                                                                               |
| Source/map attribution and privacy/terms/methodology pages ship                         | Pass                                                                                                                                                                                                                                                                                                         |

**Engineering, tests and deployment**

| Criterion                                                                                               | State                |
| ------------------------------------------------------------------------------------------------------- | -------------------- |
| Typed contracts, idempotent pipelines, versioned atomic artifacts, rollback                             | Pass                 |
| Format, lint, types, unit, property, contract, integration, golden, E2E, accessibility, security, build | Pass — all green     |
| Live checks: London, multiple non-London areas, national catalogue evidence                             | **Blocked (B1, B2)** |
| Cloud deployment at a free URL; mobile/desktop smoke tests                                              | **Blocked (B3)**     |
| README, runbooks, environment template complete; BUILD_STATE current                                    | Pass                 |

**Rejection conditions** — none apply. The product is not a static mock; fixtures appear only in
tests and in one conspicuously labelled dated demo snapshot that live data takes precedence over;
it is England-wide with no regional hard-code; Pro has no login wall; no production path falls back
to fabricated data; quota controls are hard and tested; raw telemetry expires within 48 hours;
there is no Replay; nothing depends on a paid service or on AI at runtime; the critical algorithms
are tested, including by brute-force verification and property tests; and deployment is blocked by
the absence of credentials rather than left undone.

### Coverage and source health

"Adapter" = normalization code exists. "Contract tests" = parser verified against fixtures built
from the provider's published schema. "Live verified" = a real upstream response was inspected —
which nothing can claim in this environment, and nothing does.

| Source              | Adapter | Contract tests | Live verified   | Freshness |
| ------------------- | ------- | -------------- | --------------- | --------- |
| BODS (SIRI-VM)      | done    | 21 passing     | blocked (B1/B2) | unknown   |
| BODS (TransXChange) | done    | 35 passing     | blocked (B1/B2) | unknown   |
| TfL                 | done    | 29 passing     | blocked (B1/B2) | unknown   |
| NaPTAN              | done    | 37 passing     | blocked (B1)    | unknown   |
| National Highways   | done    | 8 passing      | blocked (B1/B2) | unknown   |
| Street Manager      | done    | 9 passing      | blocked (B1/B2) | unknown   |
| OpenStreetMap       | done    | 11 passing     | blocked (B1)    | unknown   |
| Open-Meteo          | done    | 8 passing      | blocked (B1)    | unknown   |
| Environment Agency  | done    | 7 passing      | blocked (B1)    | unknown   |

### Free-tier budget

`packages/governor/src/budget-registry.ts` tracks 14 constrained resources across Cloudflare
Workers/R2/KV, GitHub Actions, email sends and each upstream API. Thresholds are green <70%,
amber 70–85%, red 85–95%, critical ≥95% or projected breach, verified by 28 governor tests
including every threshold boundary and the full degradation ladder.

**Every allowance is currently recorded as `verifiedAt: null`.** The numbers in the registry are
starting assumptions, not verified allowances, and `scripts/preflight.mjs` fails at
`PREFLIGHT_STAGE=deploy` while any required resource remains unverified. Confirming them against
current published provider terms is a deployment-time step and cannot be done from this
environment (B1). Billing cannot increase automatically: no payment method is configured on any
provider, the governor stops work at self-imposed ceilings below each free allowance, and
provider rejection is never used as the governor.

### Known limitations

**B0 — GitHub Actions execution withheld (resolved 2026-09-17).** Dispatch was refused with
`Actions has been disabled for this user` through 2026-09-05 and a repository-wide run listing
returned `total_count: 0`. Execution is back: the listing returns 147 runs and `Deploy Preview`
run 27 executed normally. _Still true:_ this container's egress policy denies `*.pages.dev` and
`*.workers.dev` at CONNECT, so the deployed preview can only be measured from a runner — which is
what the probe job is for.

**B1 — Upstream egress blocked from the build container (resolved for verification).** The build
sandbox's egress policy still denies CONNECT to every transport, weather, flood and map host and
to `api.cloudflare.com`, re-measured 2026-09-03. That is a property of this container, not of the
platform, and it no longer blocks verification: a GitHub-hosted runner has ordinary egress and
holds the repository secrets, so `Verify live sources` runs the adapters against real responses
there. _Still true:_ nothing can be verified by running it in this container, so every live claim
in this file cites a workflow run rather than a local command.

**B2 — Upstream credentials (resolved for BODS, TfL and Cloudflare).** `BODS_API_KEY`,
`TFL_APP_KEY`, `VEHICLE_SALT_SECRET`, `UNSUBSCRIBE_SECRET`, `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` are provisioned as repository secrets and are consumed by workflows only.
National Highways and Street Manager credentials are still absent; their adapters are implemented
and contract-tested but called by no scheduled job, so nothing degrades. _Resolution when they are
wanted:_ register, add the key names to `.env.example`, the source registry entry and that job's
workflow.

**B3 — Deployment (resolved).** The preview is deployed. What changed is not the egress policy but
where the deploy runs: `Deploy Preview` provisions, deploys and verifies from a runner, so the
container's inability to reach `api.cloudflare.com` no longer matters. See "Deployment evidence"
above for the URLs and the checks that passed against them.

**Timetable coverage is a fraction of England, and the figure is published.** NaPTAN gives every
stop in the country — 349,531 of them — so the map, search and nearby are national. Services,
routes and departures come only from the BODS timetable datasets a build downloads, and that is
capped: 25 originally, 60 now, against the 945 BODS publishes. The visible effect is a complete
map with a departure board at some stops and nothing at others, which reads as a defect at the
stop and is really this number — so the build report carries what was taken against what exists,
and the deployed verification reports how many stops in a viewport have any service at all.

Raising the cap further is a change rather than a larger number. Three national artifacts that
nothing read — journeys at 292 MiB, shapes and the search index — have been removed, which is what
allowed 60. The next ceiling is `network/patterns`, still a single object because the weekly
reconciliation reads it: 100 MiB at 25 datasets, so it runs out of room somewhere past 100.
Reaching every published operator means the weekly job reading pattern shards instead.

**Live verification is narrower than "the adapters work".** What was observed is recorded in
`packages/contracts/src/source-registry.ts` with the observation, not the conclusion:

- **BODS** — the SIRI-VM datafeed for one Manchester bounding box, and the timetable catalogue
  plus one dataset download. Not national coverage, and not every operator's dialect.
- **TfL** — arrivals for one stop point. The route-sequence, stop-point and disruption adapters
  are still verified against published documentation only.
- **NaPTAN** — the first 255,959 bytes of the national CSV. The stream is cancelled deliberately
  rather than downloading a national dataset to check a parser, so this verifies the head of the
  file and says nothing about national reconciliation.

Everything else — National Highways, Street Manager, OpenStreetMap, Open-Meteo, the Environment
Agency — remains `published_documentation`, because no live response has been inspected. The
registry's schema refuses to let those say otherwise.

No limitation above excuses unfinished credential-independent work; remaining work is tracked as
work, not as a blocker.

### Pro demonstration snapshot

`apps/worker/src/pro-demo-snapshot.ts` holds a fixed, dated example dataset. It exists because the
specification allows the public Pro demo to be served from "a conspicuously labelled dated
snapshot if live national analytics are unavailable", and no live analytics can be produced in
this environment (blockers B1/B2). It is reached only when no intelligence artifact has been
published, is never blended with live figures, and every response built from it carries
`dataMode: "demo_snapshot"`, the snapshot date and a notice the UI displays. A worker test asserts
that a published artifact — even one with zero incidents — takes precedence over it.

### Decisions and deviations

- **ADR 0001** — stack adopted as specified; no architectural deviation was required. Adapters are
  built from published provider contracts, and fixtures are labelled by origin
  (`constructed_from_published_schema` vs `captured`) so that "contract tests pass" is never
  reported as "live verified".
- **Preflight staging** — preflight distinguishes `ci` from `deploy` stages so unverified provider
  allowances warn during development but hard-fail before any deployment.
