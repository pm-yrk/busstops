# Bus Stops. Build State

Last updated: 2026-09-03 (P6 analytics engine complete)

## Current status

- Phase: P0–P2 complete, P4 and P6 complete, P3 partially complete → P5 (national intelligence
  pipeline) and the remaining P3 surfaces next
- Overall: foundations, all eight source adapters, the national static-network pipeline, the
  Worker edge API, the core passenger surfaces, the journey planning engine and the analytics
  engine are complete. Remaining: the rest of the P3 pages, P5 intelligence pipeline, P7 Pro
  app, P8 accounts/Daily Brief, P9 hardening, P10 deployment.
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

**P3 — Bus Stops Live (partial)**

- [x] React 18 + Vite PWA shell, warm-white/black/red tokens, pixel-art SVG library, wordmark
- [x] Home, stop, search, live map, saved, methodology, legal and not-found pages
- [x] Arrival board with live/scheduled/stale distinction and visible source confidence
- [x] "Will I make it?" and "Bus Stopped?" logic with honest uncertainty
- [x] Local-first favourites (no account required), maps handoff, allowlisted ticket links
- [x] MapLibre in a lazy chunk; with no configured style the map renders nothing rather than
      silently falling back to a third-party tile provider, and the list stands alone
- [x] 61 web tests (35 lib, 26 component)

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

### In progress

- [ ] P3 — remaining surfaces: vehicle, route, disruption, operator, network and area pages,
      and the journey planner UI page

### Next

1. Finish the remaining P3 surfaces on top of the completed journey and analytics engines.
2. P5 national intelligence pipeline: bounded collectors, map matching at scale, aggregates,
   roll-ups, enrichment and atomic artifact publication.
3. P7 Pro app, P8 accounts/Daily Brief, P9 hardening, P10 deployment.

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

### Decisions and deviations

- **ADR 0001** — stack adopted as specified; no architectural deviation was required. Adapters are
  built from published provider contracts, and fixtures are labelled by origin
  (`constructed_from_published_schema` vs `captured`) so that "contract tests pass" is never
  reported as "live verified".
- **Preflight staging** — preflight distinguishes `ci` from `deploy` stages so unverified provider
  allowances warn during development but hard-fail before any deployment.
