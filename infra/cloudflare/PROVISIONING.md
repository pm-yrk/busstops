# Provisioning

Everything below is free-tier. Nothing here enables usage-based billing, and the account should be
left with no payment method attached — that is the only guarantee that costs cannot appear.

## Once, before the first deploy

1. **R2 bucket** for artifacts. The name must match `wrangler.toml`:

   ```
   busstops-artifacts            # production
   busstops-artifacts-preview    # preview
   ```

2. **KV namespace** for the edge cache. Put its id into `wrangler.toml` under
   `[[kv_namespaces]]`. The id is not a secret and belongs in the file.

3. **Pages project** named `busstops`, connected to no repository — the deploy workflow uploads
   the build directly, so Pages never needs write access to the repository.

4. **API token**, scoped to exactly these permissions and nothing more:

   | Scope                        | Permission |
   | ---------------------------- | ---------- |
   | Account · Workers Scripts    | Edit       |
   | Account · Workers R2 Storage | Edit       |
   | Account · Workers KV Storage | Edit       |
   | Account · Cloudflare Pages   | Edit       |

   A token with account-wide edit is not acceptable here: it would let a compromised CI run
   change billing.

5. **Repository secrets**: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and the upstream
   credentials from `.env.example` that you hold. **Repository variables**: `PUBLIC_BASE_URL`,
   `PUBLIC_API_URL`, `R2_BUCKET_ARTIFACTS`.

## Worker secrets

Set separately from the repository secrets, because the Worker reads them at runtime:

```bash
npx wrangler secret put BODS_API_KEY --config apps/worker/wrangler.toml
npx wrangler secret put TFL_APP_KEY --config apps/worker/wrangler.toml
npx wrangler secret put VEHICLE_SALT_SECRET --config apps/worker/wrangler.toml
npx wrangler secret put UNSUBSCRIBE_SECRET --config apps/worker/wrangler.toml
```

`VEHICLE_SALT_SECRET` should be long and random. It is what stops a published vehicle reference
being correlated across service days; a guessable value would defeat the whole scheme.

## Before you deploy

Run the deploy-stage preflight, which is stricter than the CI one:

```bash
PREFLIGHT_STAGE=deploy npm run preflight
```

It fails while any free-tier allowance is unverified. Verifying one means reading the provider's
current terms page and setting `verifiedAt` in `packages/governor/src/budget-registry.ts`. This is
deliberately a human step: allowances change, and a stale figure in a registry is worse than no
figure because it is trusted.

## After you deploy

```bash
node scripts/smoke-test.mjs "$PUBLIC_BASE_URL" "$PUBLIC_API_URL"
```

If it fails, roll back rather than fixing forward:

```bash
npx wrangler rollback --config apps/worker/wrangler.toml
npx wrangler pages deployment list --project-name busstops
```

## Keeping it free

- Attach no payment method.
- Leave the Workers plan on free. `workers_dev = true` and the absence of any paid binding are
  what keep it there.
- The budget governor degrades before limits are reached, but it cannot see the Cloudflare
  dashboard. Set `BUDGET_UTILIZATION` as a repository variable so scheduled jobs know what the
  account actually looks like.
