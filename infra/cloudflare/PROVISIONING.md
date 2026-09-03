# Provisioning

The authoritative list of everything that must exist before Bus Stops. can be deployed, and the
exact order to create it in. If this file and any other file disagree, this file is wrong and
should be fixed — `scripts/preflight.mjs` and the tests in `apps/worker/src/wrangler-config.test.ts`
and `tests/contract/environment.test.ts` enforce most of it mechanically.

Everything here is free-tier. Nothing enables usage-based billing. **Attach no payment method** —
that is the only guarantee that costs cannot appear.

---

## 1. What must exist

### Cloudflare resources

| Resource      | Name                         | Used by                                   |
| ------------- | ---------------------------- | ----------------------------------------- |
| R2 bucket     | `busstops-artifacts`         | Production Worker + scheduled jobs        |
| R2 bucket     | `busstops-artifacts-preview` | Preview Worker                            |
| Pages project | `busstops`                   | Both environments (preview uses a branch) |
| Worker        | `busstops-api`               | Created by the first production deploy    |
| Worker        | `busstops-api-preview`       | Created by the first preview deploy       |

There is **no KV namespace and no D1 database**. Earlier configuration declared a KV binding that
no code read; it has been removed rather than left for you to provision for nothing.

### Worker bindings

Declared in `apps/worker/wrangler.toml`. Wrangler does **not** inherit bindings into named
environments, so each is declared twice — once at the top level and once under `[env.preview]`.
Preflight fails if the two ever drift apart.

| Binding                    | Production           | Preview                      |
| -------------------------- | -------------------- | ---------------------------- |
| `ARTIFACTS` (R2)           | `busstops-artifacts` | `busstops-artifacts-preview` |
| `GOVERNOR_MODE` (var)      | `green`              | `green`                      |
| `FEATURE_FLAGS_JSON` (var) | `{}`                 | `{}`                         |

### GitHub repository secrets

Settings → Secrets and variables → Actions → **Secrets**.

| Secret                  | Required        | Used by                                         |
| ----------------------- | --------------- | ----------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Yes             | Deploy, and every scheduled job that reaches R2 |
| `CLOUDFLARE_API_TOKEN`  | Yes             | Deploy, and every scheduled job that reaches R2 |
| `BODS_API_KEY`          | Yes             | Static network, live collection                 |
| `TFL_APP_KEY`           | Yes             | Static network                                  |
| `VEHICLE_SALT_SECRET`   | Yes             | Live collection — it refuses to run without it  |
| `UNSUBSCRIBE_SECRET`    | Only with email | Daily Brief                                     |
| `EMAIL_API_KEY`         | Only with email | Daily Brief                                     |

`VEHICLE_SALT_SECRET` and `UNSUBSCRIBE_SECRET` should each be a long random string, for example
`openssl rand -hex 32`. The vehicle salt is what stops a published vehicle reference being
correlated across service days; a guessable value defeats the scheme entirely.

### GitHub Environments

Settings → Environments. Create two, named exactly **`preview`** and **`production`**.

The Deploy workflow takes the environment as its input and reads `PUBLIC_BASE_URL` and
`PUBLIC_API_URL` from it. Defining those only at repository scope would point a preview deploy's
smoke test at production and report a pass, so the workflow fails loudly if they are missing.

| Environment variable | `preview`                                              | `production`                                   |
| -------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| `PUBLIC_BASE_URL`    | Preview Pages URL                                      | Production Pages URL                           |
| `PUBLIC_API_URL`     | `https://busstops-api-preview.<subdomain>.workers.dev` | `https://busstops-api.<subdomain>.workers.dev` |

Adding a required reviewer to the `production` environment is worth considering: it makes the
production deploy button ask a person first.

### GitHub repository variables

Settings → Secrets and variables → Actions → **Variables**. These are public by definition and
must not be secrets.

| Variable                                                          | Required        | Value                 |
| ----------------------------------------------------------------- | --------------- | --------------------- |
| `R2_BUCKET_ARTIFACTS`                                             | Yes             | `busstops-artifacts`  |
| `BUDGET_UTILIZATION`                                              | Recommended     | `0` initially; see §6 |
| `R2_STORAGE_LIMIT_BYTES`                                          | Optional        | Defaults to 10 GiB    |
| `MAX_PARTITIONS_PER_RUN`                                          | Optional        | Defaults to 12        |
| `BODS_DAILY_REQUEST_BUDGET`                                       | Optional        | Defaults to 8,640     |
| `COLLECTION_PASSES`                                               | Optional        | Defaults to 3         |
| `COLLECTION_BUDGET_MS`                                            | Optional        | Defaults to 240,000   |
| `BATCH_BUDGET_MS`                                                 | Optional        | Defaults to 300,000   |
| `EMAIL_PROVIDER`, `EMAIL_PROVIDER_ENDPOINT`, `EMAIL_FROM_ADDRESS` | Only with email | Provider details      |

### Worker secrets

Set separately from repository secrets, because the Worker reads them at runtime rather than at
deploy time. **Each environment has its own set** — setting one does not set the other.

| Worker secret         | Needed by                    |
| --------------------- | ---------------------------- |
| `BODS_API_KEY`        | Live vehicles outside London |
| `TFL_APP_KEY`         | London arrivals              |
| `VEHICLE_SALT_SECRET` | Opaque vehicle references    |
| `UNSUBSCRIBE_SECRET`  | One-click unsubscribe        |

### API token scopes

Create the token with **exactly** these four permissions and no more. A token with account-wide
edit would let a compromised CI run change billing.

| Scope                        | Permission |
| ---------------------------- | ---------- |
| Account · Workers Scripts    | Edit       |
| Account · Workers R2 Storage | Edit       |
| Account · Cloudflare Pages   | Edit       |
| Account · Account Settings   | Read       |

---

## 2. Order of operations

Follow this exactly; each step depends on the one before.

1. **Create the two R2 buckets** with the names in the table above.
2. **Create the Pages project** named `busstops`, connected to **no repository** — the deploy
   workflow uploads the build directly, so Pages never needs write access to your code.
3. **Create the API token** with the four scopes above.
4. **Add the repository secrets**, then the repository variables.
5. **Create the `preview` and `production` GitHub Environments.** Their URL variables are not
   known yet — step 7 fills them in.
6. **Set the preview Worker secrets** (see §3).
7. **Run the Deploy workflow against `preview`** (see §4). The first run will stop at the smoke
   test, because the environment URLs are still empty; that is the guard working. The deploy
   steps before it will have printed the preview Worker and Pages URLs.
8. **Set `PUBLIC_BASE_URL` and `PUBLIC_API_URL`** on the `preview` environment to those URLs, and
   re-run the preview deploy. This time the smoke test runs and must pass.
9. **Verify the free-tier allowances** and set `verifiedAt` (see §5). Production deploys fail
   until this is done.
10. **Set the production Worker secrets**, then run the Deploy workflow against `production`.
11. **Bootstrap the data**: run _Static network — daily change check_ manually, then let the
    scheduled jobs take over.

---

## 3. Setting Worker secrets

Preview and production are separate. Run each command twice, once per environment:

```bash
# Preview
npx wrangler secret put BODS_API_KEY        --config apps/worker/wrangler.toml --env preview
npx wrangler secret put TFL_APP_KEY         --config apps/worker/wrangler.toml --env preview
npx wrangler secret put VEHICLE_SALT_SECRET --config apps/worker/wrangler.toml --env preview
npx wrangler secret put UNSUBSCRIBE_SECRET  --config apps/worker/wrangler.toml --env preview

# Production — note the empty --env, which targets the top-level environment
npx wrangler secret put BODS_API_KEY        --config apps/worker/wrangler.toml --env ""
npx wrangler secret put TFL_APP_KEY         --config apps/worker/wrangler.toml --env ""
npx wrangler secret put VEHICLE_SALT_SECRET --config apps/worker/wrangler.toml --env ""
npx wrangler secret put UNSUBSCRIBE_SECRET  --config apps/worker/wrangler.toml --env ""
```

These need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in your shell, or an interactive
`npx wrangler login`.

---

## 4. Deploying

GitHub → **Actions** → **Deploy** → **Run workflow** → choose `preview` or `production`.

Deployment is manual by design. A merge that passes CI is not the same event as a decision to put
something in front of the public, and a deploy-on-push would remove the one place a person can
say no.

The workflow re-runs the whole quality gate on the commit being deployed — that may not be the
commit CI tested — then runs the deploy-stage preflight, deploys the Worker and Pages, and smoke
tests what it deployed.

---

## 5. Verifying free-tier allowances

```bash
PREFLIGHT_STAGE=deploy npm run preflight
```

This fails while any required allowance in `packages/governor/src/budget-registry.ts` has
`verifiedAt: null`. Nine do. Verifying one means opening the provider's current terms page,
confirming the number, and setting both `verifiedAt` and `verifiedNote` on that entry.

This is deliberately a human step. Allowances change, and a stale figure in a registry is worse
than no figure because it is trusted. **Do not set `verifiedAt` merely to make preflight pass** —
the gate exists precisely to stop that.

Three entries are already verified and record how:

- **GitHub Actions minutes** — standard GitHub-hosted runners are free and unlimited for public
  repositories, so the entry is marked `metered: false`. It is kept rather than deleted because
  the condition matters: making this repository private turns minutes into a real budget.
- **BODS live data** — consumer guidance asks for no more than one central live-data request
  every five seconds, recorded as 12 requests per minute and enforced per request in the
  collector, not merely documented.
- **TfL Unified API** — the registered product is 500 requests per minute. The app key is what
  makes that figure apply; an unregistered caller gets far less.

---

## 6. Keeping it free

- Attach no payment method.
- Leave the Workers plan on free. `workers_dev = true` and the absence of any paid binding keep
  it there.
- The governor cannot see the Cloudflare dashboard. Set `BUDGET_UTILIZATION` (0..1) as a
  repository variable so the scheduled jobs know what the account actually looks like; leaving it
  at `0` means they assume there is headroom.
- The retention job runs separately from the analytics batch on purpose, so an analytics failure
  can never postpone raw-data expiry.

---

## 7. After deploying

```bash
node scripts/smoke-test.mjs "$PUBLIC_BASE_URL" "$PUBLIC_API_URL"
```

The Deploy workflow runs this itself; run it by hand to re-check later. If it fails, roll back
rather than fixing forward:

```bash
npx wrangler rollback --config apps/worker/wrangler.toml --env ""
npx wrangler pages deployment list --project-name busstops
```

`docs/runbooks/` covers what to do when a source dies, a budget tightens, an artifact goes bad, a
Daily Brief misfires, or someone asks what data you hold about them.
