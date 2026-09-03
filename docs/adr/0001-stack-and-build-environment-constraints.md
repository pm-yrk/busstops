# ADR 0001 — Stack selection and build-environment constraints

Status: accepted
Date: 2026-09-02

## Context

`docs/04_ARCHITECTURE.md` prefers React + TypeScript + Vite/PWA, Cloudflare Pages/Workers/R2,
MapLibre, and scheduled GitHub Actions. The repository began as specification documents only,
with no application code, lockfile or toolchain.

The build session runs inside a sandbox whose outbound network access is restricted by an
egress policy. Reachability was measured directly at the start of the build:

| Host                                  | Result                     |
| ------------------------------------- | -------------------------- |
| `registry.npmjs.org`                  | 200 — reachable            |
| `github.com`                          | reachable (git push works) |
| `api.cloudflare.com`                  | CONNECT denied             |
| `data.bus-data.dft.gov.uk` (BODS)     | CONNECT denied             |
| `api.tfl.gov.uk`                      | CONNECT denied             |
| `naptan.api.dft.gov.uk`               | CONNECT denied             |
| `environment.data.gov.uk` (EA floods) | CONNECT denied             |
| `api.open-meteo.com`                  | CONNECT denied             |
| `tile.openstreetmap.org`              | CONNECT denied             |

No upstream credentials (`BODS_API_KEY`, `TFL_APP_KEY`, National Highways, Street Manager) are
provisioned in this environment either.

## Decision

1. **Stack**: adopt the preferred stack as specified — npm workspaces monorepo, TypeScript
   throughout, Vite + React PWA for `apps/web`, a Cloudflare Worker for `apps/worker`, R2 for
   versioned artifacts, MapLibre GL with a licence-compliant no-cost style, GitHub Actions for
   bounded scheduled pipelines, Vitest for unit/contract/integration tests and Playwright for
   end-to-end and accessibility tests. No deviation from the specification is required.

2. **Adapters are written against published provider contracts, and say so.** Because no live
   upstream response can be inspected from this environment, every adapter is built to the
   provider's published schema, and the source registry records
   `contractVerification.method = "published_documentation"` rather than `"live_response"`.
   The `live_response` value may only ever be set when a real response was actually observed;
   `scripts/preflight.mjs` and a contract test both fail if that claim appears without a
   recorded verification timestamp.

3. **Fixtures are labelled by origin.** Contract-test fixtures constructed from published
   schemas are stored under `tests/fixtures/documented/` and carry an explicit
   `"origin": "constructed_from_published_schema"` marker. Fixtures captured from a real
   response would go under `tests/fixtures/captured/` with a capture timestamp. This keeps the
   difference between "our parser handles the documented shape" and "our parser handles the
   real feed" honest and machine-checkable, and it is why passing contract tests are never
   reported as live verification in `BUILD_STATE.md`.

4. **Production code paths never fall back to fixtures.** Per `CLAUDE.md`, fixtures are
   confined to tests and explicitly labelled demo snapshots. When a source is unavailable the
   product degrades visibly (stale age, scheduled-only, partial coverage) rather than
   substituting fake data.

## Consequences

- All credential-independent work — contracts, adapters, normalization, pipelines, analytics,
  journey planning, both applications, the governor, security controls, tests and CI — proceeds
  to completion in this environment.
- Three classes of acceptance criteria cannot be satisfied here and are recorded in
  `BUILD_STATE.md` as external blockers rather than as unfinished work:
  1. live verification of BODS/TfL/NaPTAN/National Highways/Street Manager/OSM/Open-Meteo/EA
     adapters against real responses;
  2. national static-network bootstrap, which requires downloading real NaPTAN and timetable
     data;
  3. cloud deployment and deployed smoke tests, which require `api.cloudflare.com` reachability
     and a deploy credential.
- Each blocked item names the exact command or check that will satisfy it once an environment
  with egress and credentials is available, so none of them requires re-derivation later.
