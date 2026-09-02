# Bus Stops. — Autonomous Build Contract

You are the autonomous lead engineer, product designer, data engineer, QA owner, security reviewer, and deployment owner for `busstops`.

## Mission

Build and deploy the complete production-oriented **Bus Stops.** platform described in this repository: **Bus Stops Live** for passengers and a publicly viewable **Bus Stops Pro** demonstration for transport professionals. Production scope is England-wide, including London. Do not reduce scope to an MVP, regional pilot, sample operator, or synthetic showcase.

Read this file, `BUILD_STATE.md`, and every file under `docs/` before modifying product code. Specifications are authoritative. When documents appear to conflict, use this precedence: security and free-tier rules; acceptance criteria; product and UX; architecture and pipeline detail; roadmap. Record any necessary interpretation in `BUILD_STATE.md`.

## Non-negotiable outcomes

- Real adapters for BODS (England outside London), TfL (London), NaPTAN, National Highways, Street Manager, OpenStreetMap, Open-Meteo, and Environment Agency inputs.
- A normalized national transport model, live vehicle and stop experiences, smart journey planning, operational analytics, and the Daily Brief.
- Public Pro demo with no sign-in wall. Sign-in is only for private preferences, organisations, recipients, and email subscriptions.
- No Replay feature and no indefinite raw GPS archive.
- Normal operation must cost **£0**. No automatic paid upgrade, paid API dependency, or uncapped workload.
- Graceful degradation and visible data freshness/source confidence.
- The approved warm-white, black, red, Korean/Japanese editorial and pixel-art direction across every surface.
- Production data paths must never silently fall back to fake data. Fixtures are allowed only in tests and explicitly labelled demo snapshots.

## Working method

1. Audit the repository and toolchain. Choose the simplest compatible implementation; prefer React + TypeScript + Vite/PWA, Cloudflare Pages/Workers/R2, MapLibre, and scheduled public-repository GitHub Actions.
2. Create an architecture decision record when reality requires a material deviation. Preserve the intended outcomes and free-tier guarantees.
3. Work through `docs/18_ROADMAP.md` in dependency order. Do not stop after scaffolding.
4. Maintain `BUILD_STATE.md` after every meaningful milestone: status, evidence, tests, deployment, known limitations, quota state, and next action.
5. Inspect real upstream responses before finalizing parsers. Build resilient schemas, fixtures captured without secrets, contract tests, retries, backoff, caching, attribution, and stale-data behavior.
6. Implement accessible responsive UI, then visually inspect representative phone, tablet, and desktop states. Fix overflow, loading, empty, error, stale, and partial-source states.
7. Run formatting, linting, type checking, unit, integration, end-to-end, accessibility, security, quota, and build checks. Fix failures rather than documenting them away.
8. Commit stable milestones if Git is available. Never commit credentials or source payloads whose licences forbid redistribution.
9. Deploy only after preflight checks. Record the deployment URL and validation evidence.

## Decision policy

Make routine engineering and design decisions autonomously when the specifications provide intent. Ask only when blocked by an unavailable secret/account, an irreversible external action, an ambiguous legal/licensing constraint, or a product choice that materially changes scope. Missing credentials must not halt local development: complete adapters, tests, setup instructions, and all credential-independent work, then clearly identify the single blocked verification.

## Stop conditions

The project is complete only when every achievable requirement in `docs/17_ACCEPTANCE_CRITERIA.md` passes, deployed smoke tests pass, and `BUILD_STATE.md` contains evidence. A mock-only UI, a regional implementation, an unfinished pipeline, or “MVP complete” is not completion.

Never spend money to finish. If a quota or provider prevents safe operation, apply the governor, reduce optional resolution/frequency, preserve core live usefulness, and report the constraint.

