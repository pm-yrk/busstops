# 14 — Security, privacy and trust

## Threat model

Protect provider keys, deployment credentials, user accounts, organisation settings, recipient lists, precise locations, pipeline integrity and public availability. Consider API scraping/abuse, oversized bbox/query DoS, injection, malicious upstream fields, SSRF through ticket URLs, stale/poisoned artifacts, account takeover, privilege escalation, email abuse and supply-chain compromise.

## Secrets and environments

Secrets live only in local ignored files and platform secret stores; commit `.env.example` names without values. Separate preview/production credentials and least-privilege bindings. Never log headers, tokens or raw environment dumps. Rotate after suspected exposure. CI receives only the secrets needed by that job and untrusted pull requests receive none.

## Application controls

Validate all inputs and upstream payloads against schemas. Cap bbox, coordinates, arrays, strings and response sizes. Parameterize queries. Escape UI/email content. Use CSP, HSTS, Referrer-Policy, Permissions-Policy, MIME protection, safe CORS, CSRF protection where cookie auth is used, secure/httpOnly/sameSite cookies, dependency integrity and safe external-link attributes. Ticket domains come from an allowlist; never server-fetch arbitrary user URLs.

## Authentication/authorization

Pro demo is anonymous read-only. Account endpoints require verified identity. Enforce organisation membership and roles server-side; never trust UI hiding. Preferences/recipient edits require ownership and audit. Add rate limiting, anti-automation and secure recovery. No shared demo password.

## Privacy

Geolocation is requested with contextual consent and processed client-side where possible. Do not log/store exact user origin/destination, map taps, or device location by default. Analytics are privacy-minimized and aggregate; offer a no-analytics path where required. Favourites are local-first. Publish retention and deletion behavior; support access/deletion for account data.

Vehicle data is operational public-source data, not a basis to identify or score drivers. Hash/rotate public identifiers if persistent source IDs create tracking risk. Never present speed anomalies as evidence of an individual offence.

## Pipeline and supply chain

Pin actions/dependencies appropriately, use lockfiles, automated vulnerability/license checks, minimal permissions, artifact checksums/schema/version, previous-good rollback and provenance. Quarantine malformed source records. Protect publish manifests from partial jobs.

## Email and legal/trust pages

Verified opt-in, one-click unsubscribe, suppression list and idempotency. Configure SPF/DKIM/DMARC when a domain exists; until then use provider-verified compliant sending. Include Privacy, Terms, Methodology, source licences/attribution, contact and security-reporting guidance. Avoid unsupported claims about accuracy, safety or official endorsement.

## Incident response

Document detection, containment/kill switches, secret rotation, artifact rollback, user/provider notification assessment, evidence preservation without personal overcollection, and post-incident review. Security failures override feature availability but not mandatory deletion/unsubscribe paths.

