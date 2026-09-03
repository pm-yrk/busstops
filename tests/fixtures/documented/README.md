# Contract-test fixtures

Fixtures are labelled by origin so that "our parser handles the documented shape" is never
mistaken for "our parser handles the real feed".

- `documented/` — payloads constructed from each provider's **published schema and
  documentation**. They exercise field names, types, nesting and value vocabularies exactly as
  the provider documents them, but no real upstream response was observed. Every file carries
  `"origin": "constructed_from_published_schema"` where the format allows a comment or field.
- `captured/` — payloads **recorded from a real upstream response**, with a capture timestamp
  and any credential, personal or licence-restricted content removed. This directory is empty
  in environments without upstream egress.

`packages/contracts/src/source-registry.ts` may only record
`contractVerification.method = "live_response"` for a source once a fixture in `captured/`
exists for it. `scripts/preflight.mjs` and the source-registry contract test both fail if that
claim appears without evidence.

Fixtures are small by design: they must never redistribute bulk upstream data whose licence
does not permit it.
