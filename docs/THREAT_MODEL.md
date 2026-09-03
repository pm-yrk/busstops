# Threat model

Derived from `docs/14_SECURITY.md`. Each threat names the asset, the attack, the implemented
control and where that control is tested.

## Assets

| Asset                                                            | Sensitivity  | Store                                          |
| ---------------------------------------------------------------- | ------------ | ---------------------------------------------- |
| Provider API keys (BODS, TfL, National Highways, Street Manager) | High         | Platform secret store only                     |
| Deployment credentials (Cloudflare, GitHub)                      | High         | Platform secret store only                     |
| User accounts, organisation settings, recipient lists            | High         | Account database, access-controlled            |
| Precise user location / journey requests                         | High         | Client/session only; never logged or persisted |
| Pipeline artifacts and manifests                                 | Medium       | R2, versioned with checksums                   |
| Public transport data                                            | Low (public) | R2 / edge cache                                |

## Threats and controls

### T1 — Provider key exfiltration

_Attack:_ keys committed to the repo, leaked in logs, or exposed to the browser.
_Controls:_ keys live only in platform secret stores; `.env.example` holds names without values;
`scripts/secret-scan.mjs` runs in CI over all tracked files; the Worker holds credentials and the
browser never receives them; structured logs exclude headers, tokens and environment dumps.
_Tested by:_ `scripts/secret-scan.mjs` (CI job `secret-scan`), `scripts/preflight.mjs` env-example check.

### T2 — Oversized bbox / query denial of service

_Attack:_ a caller requests a national bounding box at high zoom repeatedly, forcing expensive
upstream fetches and burning the free tier.
_Controls:_ `MAP_QUERY_LIMITS` caps bbox area, zoom floor/ceiling, result counts and timeout;
requests are validated against the schema before any upstream call; identical in-flight requests
are coalesced; the governor raises cache TTLs as pressure rises.
_Tested by:_ `packages/contracts/src/contracts.test.ts`, Worker request-validation tests.

### T3 — API scraping and abuse

_Attack:_ automated bulk harvesting of the live API.
_Controls:_ per-client rate limiting at the edge, result caps, cache-first responses, no bulk
national endpoint, and no raw GPS export.
_Tested by:_ Worker rate-limit tests.

### T4 — Malicious or malformed upstream payloads

_Attack:_ an upstream feed returns unexpected types, absurd coordinates, or injected strings.
_Controls:_ every upstream payload is parsed through a zod schema at ingress; coordinates are
range-checked against England bounds; impossible jumps and stale timestamps are rejected; poison
records are quarantined rather than crashing the job; schema drift raises a health incident.
_Tested by:_ adapter contract tests including malformed, empty, rate-limited and drifted cases.

### T5 — SSRF via ticket URLs

_Attack:_ untrusted feed text is used to construct an outbound URL the server fetches.
_Controls:_ ticket links come only from a curated registry with a domain allowlist; URLs are
never constructed from feed text; the server never fetches a user- or feed-supplied URL; links
open with `rel="noopener noreferrer"` and an explicit external-seller label.
_Tested by:_ ticket registry allowlist tests.

### T6 — Stale or poisoned artifacts

_Attack:_ a partial or corrupted pipeline run publishes bad national data.
_Controls:_ artifacts are written to a versioned temporary key, validated for count/schema/checksum,
then published by an atomic manifest pointer swap; readers keep the previous good version when a
build fails; manifests carry content hashes.
_Tested by:_ artifact publish/rollback integration tests.

### T7 — Account takeover and privilege escalation

_Attack:_ an attacker accesses another organisation's Pro scope or edits recipients.
_Controls:_ the Pro demo is anonymous and read-only, so no shared demo password exists;
account endpoints require verified identity; organisation membership and role are enforced
server-side on every request rather than by hiding UI; preference and recipient edits require
ownership and write an audit record; rate limiting and anti-automation protect recovery flows.
_Tested by:_ authorization integration tests.

### T8 — Email abuse

_Attack:_ the Daily Brief is used to send unsolicited mail, or a retry storm burns the send quota.
_Controls:_ verified opt-in required before any send; verified-recipient allowlist; hard daily and
monthly caps below the provider free limit; idempotency key per snapshot+recipient; one-click
unsubscribe honoured immediately with a suppression list; no catch-up burst after an outage;
previews are suspended before real sends under quota pressure.
_Tested by:_ Daily Brief idempotency, cap and unsubscribe tests.

### T9 — Supply-chain compromise

_Attack:_ a malicious dependency or action version executes in CI with repository access.
_Controls:_ lockfile-only installs (`npm ci`), pinned action major versions, least-privilege
`permissions:` blocks, no secrets exposed to pull-request workflows, and dependency/licence audit.
_Tested by:_ CI configuration; audit job.

### T10 — Privacy regression

_Attack:_ precise user location or journey endpoints leak into logs, analytics or storage.
_Controls:_ geolocation is processed client-side wherever possible; the journey API accepts
coordinates only for the requested plan and never persists them; request fingerprints are hashed
without raw coordinates; logs exclude location; favourites are local-first; vehicle identifiers
are opaque and may be rotated; speed anomalies are never presented as evidence about an individual.
_Tested by:_ logging redaction tests, journey fingerprint tests.

## Residual risks

- Upstream feeds may misreport vehicle positions; the product mitigates presentation risk with
  confidence, freshness and cautious wording rather than eliminating the underlying error.
- A determined scraper can still collect public data slowly within rate limits; this is accepted
  because the data is public and the cost is bounded by the governor.
- No penetration test has been performed. Controls are verified by automated tests and review only.
