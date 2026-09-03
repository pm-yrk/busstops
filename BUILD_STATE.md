# Bus Stops. Build State

Last updated: 2026-09-03 (P8 accounts and Daily Brief complete)

## Current status

- Phase: P0–P8 complete → P9 (hardening and free-tier proof)
- Overall: foundations, all eight source adapters, the national static-network pipeline, the
  Worker edge API, the full Bus Stops Live passenger app, the journey planning engine, the
  analytics engine, the national intelligence pipeline, Bus Stops Pro and the Daily Brief are
  complete. Remaining: P9 hardening, P10 deployment.
- Deployment: not deployed (external blocker — see Known limitations B3)
- Blockers: 3 external blockers recorded below (B1 upstream egress, B2 credentials, B3 deploy reachability)

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

No upstream credentials are provisioned in this environment. Per `CLAUDE.md`, this does not
halt development: all credential-independent work proceeds and the blocked verifications are
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

### In progress

- [ ] P9 — hardening, safe mode, lifecycle and pruning drills, runbooks, performance,
      end-to-end and accessibility testing, and the full acceptance audit

### Next

1. P9 hardening, safe mode, runbooks, end-to-end and accessibility testing.
2. P10 deployment and smoke tests (externally blocked — B3).

### Verification evidence

| Check                         | Command or method                               | Result                                                                 | Date       |
| ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- | ---------- |
| Install                       | `npm install`                                   | Clean install from lockfile                                            | 2026-09-02 |
| Unit + contract + integration | `npm test`                                      | 571 passed / 571 (510 root across 19 files, 61 web)                    | 2026-09-03 |
| Lint                          | `npx eslint . --max-warnings=0`                 | Clean                                                                  | 2026-09-02 |
| Format                        | `npx prettier --check .`                        | Clean                                                                  | 2026-09-02 |
| Type check                    | `npm run typecheck`                             | Passed for every workspace                                             | 2026-09-02 |
| Free-tier preflight           | `node scripts/preflight.mjs`                    | Passed, 1 deploy-stage warning                                         | 2026-09-02 |
| Secret scan                   | `node scripts/secret-scan.mjs`                  | Clean across 188 tracked files                                         | 2026-09-03 |
| Pipeline dry run              | `npx tsx pipelines/static-network/run-daily.ts` | Exits 0 reporting the missing credentials, publishes nothing           | 2026-09-02 |
| Journey planner verification  | `npx vitest run packages/journey`               | 26 passed, including brute-force equivalence against exhaustive search | 2026-09-03 |
| Analytics engine              | `npx vitest run packages/analytics`             | 93 passed / 93                                                         | 2026-09-03 |
| End-to-end                    | —                                               | Not run yet (scheduled for P9)                                         | —          |
| Accessibility                 | —                                               | Not run yet (scheduled for P9)                                         | —          |
| Deployed smoke test           | —                                               | Blocked (B3)                                                           | —          |

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

**B1 — Upstream egress blocked (external blocker).** The build sandbox's egress policy denies
CONNECT to every transport, weather, flood and map host, and to `api.cloudflare.com`. _User
impact:_ none in production; this only constrains what can be verified during this build.
_Affected criteria:_ "BODS/TfL adapters live-verified", "NaPTAN reconciles nationally",
"Live checks cover London and multiple non-London areas". _Mitigation:_ adapters are written to
published provider schemas, contract-tested against fixtures labelled by origin, and the source
registry refuses to claim live verification. _Resolution:_ run the contract suite with
`SOURCE_VERIFY=live` from an environment with egress and credentials.

**B2 — No upstream credentials (external blocker).** `BODS_API_KEY`, `TFL_APP_KEY`,
National Highways and Street Manager credentials are not provisioned. _User impact:_ live data
cannot be fetched until keys are configured. _Mitigation:_ `.env.example` names every variable
and the deployment checklist records where each is obtained. _Resolution:_ register for free keys
and set them as platform secrets.

**B3 — Deployment unreachable (external blocker).** `api.cloudflare.com` is denied and no
deploy credential is present, so the app cannot be deployed or smoke-tested from here.
_Affected criteria:_ "Cloud deployment succeeds at a free project URL", "mobile/desktop smoke
tests pass". _Mitigation:_ deployment configuration, preflight gate and runbooks are built and
committed so deployment is a single credentialed step. _Resolution:_ run the deploy workflow
with a Cloudflare API token from an environment with egress.

No limitation above excuses unfinished credential-independent work; the remaining phases are
tracked as work, not blockers.

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
