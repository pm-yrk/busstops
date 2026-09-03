# Bus Stops.

Live bus arrivals, journey planning and network intelligence for England — for passengers as
**Bus Stops Live**, and for transport professionals as **Bus Stops Pro**.

The whole platform runs on free tiers, and is built so that it cannot quietly stop doing so.

## What it does

**Bus Stops Live** — a live map, stop arrival boards that separate live predictions from
timetable-only departures, vehicle tracking, a journey planner that answers with a range rather
than a false-precision time, "Will I make it?", "Bus Stopped?", and local-first favourites that
need no account.

**Bus Stops Pro** — a public, read-only operational view: Control Tower, Live Operations, Routes,
Operators, Congestion, Analytics, Disruptions, Reports, the Daily Brief and Settings. There is no
sign-in wall anywhere in it.

**The Daily Brief** — one frozen snapshot a day, rendered identically to the browser view and to a
responsive HTML and plain-text email.

## The principles the code actually enforces

These are not aspirations; they are asserted by tests, and most are enforced by the shape of the
types rather than by convention.

- **Never fabricate.** A production data path never falls back to invented data. Where something
  cannot be measured, the interface says so — "unmeasured" is a different statement from "fine",
  and the difference is preserved everywhere it matters.
- **Every figure carries its denominator**, comparison window, freshness, coverage and confidence.
  A punctuality percentage from eleven journeys looks identical to one from nine hundred unless
  the type refuses to let it.
- **Suppress rather than mislead.** A metric below its threshold publishes null and its reason,
  never a placeholder number and never a blank that reads as zero.
- **Overstating abnormality is the worse error.** Classification takes the *less* alarming of
  percentile and robust z-score, then applies materiality and persistence gates.
- **Corroboration is not causation.** Roadworks near a delay are context. The types carry no
  cause field, and the wording never claims one.
- **Only official sources get official wording.** Environment Agency notices are warnings;
  anything derived is "elevated risk".
- **£0, with margin.** Self-imposed ceilings sit below the real free-tier limits, and the governor
  degrades in a documented order before anything could be charged for.
- **Bounded retention, no Replay.** Raw positions expire automatically within 48 hours. There is
  no long-term raw archive and no replay feature, by design.
- **Privacy by construction.** Vehicle references are salted with a secret that rotates daily, so
  a trace cannot be joined to yesterday's. Passenger favourites and locations never leave the
  device.

## Layout

```
apps/web              Bus Stops Live and Bus Stops Pro (React, Vite, PWA)
apps/worker           Edge API (Cloudflare Worker): validation, caps, caching, degradation
packages/contracts    Typed and zod-validated model, shared by every layer
packages/adapters     BODS, TfL, NaPTAN, National Highways, Street Manager, OSM,
                      Open-Meteo, Environment Agency
packages/analytics    Robust statistics, metrics, baselines, events, congestion, confidence
packages/journey      RAPTOR-style journey planning, with a brute-force verification harness
packages/matching     Vehicle-to-journey matching and bounded Viterbi map matching
packages/governor     Budget registry, thresholds, projections, degradation ladder, safe mode
packages/daily-brief  Frozen snapshot, email rendering, consent and send guards
packages/pipeline-core  Retention, geo, time, resilient HTTP, atomic artifacts, tiling
pipelines/            Scheduled jobs: static network, live collection, analytics batch,
                      retention, Daily Brief
tests/                Contract, integration, property and end-to-end suites
docs/                 The specification, ADRs, threat model and runbooks
```

## Running it

```bash
npm install
npm run dev --workspace @busstops/web   # the app, against a local or deployed API
```

No credentials are needed to build, typecheck, lint or test. Adapters, pipelines and the whole
interface are exercised against contract fixtures.

```bash
npm run format:check
npm run lint
npm run typecheck
npm test           # unit, contract, integration and property suites
npm run test:e2e   # browser and accessibility suites, four viewports
npm run preflight  # free-tier and security gate
node scripts/secret-scan.mjs
```

For the end-to-end suite, `CHROMIUM_PATH` may point at an already-installed Chromium instead of
downloading one.

## Configuration

Copy `.env.example` to `.env`. Every value is optional for local development; each one that is
missing degrades one capability and nothing else. In particular the product works with **no email
provider configured at all** — the Daily Brief snapshot is still built and the browser view works
normally.

Never commit real values. Secrets belong in the platform secret store and in GitHub Actions
secrets, referenced by the names in `.env.example`.

## Where to read next

- `BUILD_STATE.md` — what is built, what is verified, what is blocked, with evidence
- `docs/` — the full specification, in dependency order
- `docs/runbooks/` — what to do when a source dies, a budget tightens or an artifact goes bad
- `docs/THREAT_MODEL.md` — the threats and the controls that answer them
- `docs/adr/` — decisions where reality required a deviation

## Attribution

Contains public sector information licensed under the Open Government Licence v3.0.
Bus location and timetable data from the Bus Open Data Service and Transport for London.
Stop data from NaPTAN. Map data © OpenStreetMap contributors, ODbL. Weather from Open-Meteo.
Flood data from the Environment Agency. Road data from National Highways and Street Manager.
