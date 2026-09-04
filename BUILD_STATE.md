# Bus Stops. Build State

Last updated: 2026-09-04 (preview serving real national data; edge reads shards, not the country)

## Current status

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
- Design: the approved direction is applied and checked in a browser against the deployment, not
  only in the DOM. `scripts/visual-qa.mjs` opens the deployed preview at desktop, tablet and
  phone widths, measures the hero, the basemap and the page gutters, clicks a real stop, and
  keeps its screenshots as a run artifact.
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

- [ ] P10 — `Deploy Preview` executing in GitHub Actions; evidence recorded below as it lands

### Next

1. Watch the shard sizes each publish reports. The byte budget is a backstop, not a target: a
   family that starts truncating is telling you its key needs to be finer, and it says which.
2. The remaining TfL adapters (route sequence, stop point, disruptions) are still verified
   against published documentation rather than against a live response.
3. Production remains un-deployed pending explicit approval after the preview is reviewed.

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

| Check                         | Command or method                          | Result                                                                                                                                                                                 | Date       |
| ----------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Install                       | `npm ci`                                   | Clean install from lockfile                                                                                                                                                            | 2026-09-03 |
| Unit + contract + integration | `npm test`                                 | 941 passed / 941 (837 root across 37 files, 104 web)                                                                                                                                   | 2026-09-04 |
| Lint                          | `npm run lint`                             | Clean, `--max-warnings=0`                                                                                                                                                              | 2026-09-03 |
| Format                        | `npm run format:check`                     | Clean                                                                                                                                                                                  | 2026-09-03 |
| Type check                    | `npm run typecheck`                        | Passed for every workspace                                                                                                                                                             | 2026-09-03 |
| Free-tier preflight (ci)      | `npm run preflight`                        | Passed, 0 warnings                                                                                                                                                                     | 2026-09-03 |
| Free-tier preflight (deploy)  | `PREFLIGHT_STAGE=deploy npm run preflight` | Passed, 0 warnings                                                                                                                                                                     | 2026-09-03 |
| Secret scan                   | `node scripts/secret-scan.mjs`             | Clean across 313 tracked files                                                                                                                                                         | 2026-09-03 |
| End-to-end + accessibility    | `npm run test:e2e`                         | 140 passed / 140 across desktop, tablet and two phone sizes                                                                                                                            | 2026-09-04 |
| Journey planner verification  | `npx vitest run packages/journey`          | Brute-force equivalence against exhaustive search                                                                                                                                      | 2026-09-03 |
| Zip reader                    | `npx vitest run pipelines/static-network`  | 7 passed against a fixture written by Python's zipfile                                                                                                                                 | 2026-09-03 |
| Live sources                  | `Verify live sources` run 2                | BODS, BODS timetables, TfL and NaPTAN all answered and parsed                                                                                                                          | 2026-09-03 |
| Provisioning                  | `Deploy Preview` run 1                     | R2 buckets and Pages project ensured; nothing chargeable enabled                                                                                                                       | 2026-09-03 |
| Worker deploy                 | `Deploy Preview` run 1                     | Deployed, secrets set, `/v1/sources/health` answered 200                                                                                                                               | 2026-09-03 |
| Pages deploy                  | `Deploy Preview` run 1                     | Deployed to the `preview` branch alias                                                                                                                                                 | 2026-09-03 |
| Basemap terms and origins     | `Verify sources and artifacts` run 6       | OpenFreeMap Liberty: style loaded, a tile fetched with no key answered 200 image/png (154,821 bytes), attribution "OpenFreeMap © OpenMapTiles Data from OpenStreetMap", one CSP origin | 2026-09-03 |
| Data bootstrap                | `Deploy Preview` run 9                     | Outcome `published`; 349,531 stops, 1,043 services, 32,199 journeys                                                                                                                    | 2026-09-04 |
| Real data through the edge    | `Deploy Preview` run 9                     | 400 stops for a Manchester viewport (first: Piccadilly); stop board and search answered                                                                                                | 2026-09-04 |
| Deployed visual pass          | `node scripts/visual-qa.mjs <preview>`     | Desktop, tablet and phone in Chromium; screenshots kept as a run artifact                                                                                                              | 2026-09-04 |

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
