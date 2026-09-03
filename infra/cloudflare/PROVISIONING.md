# Provisioning

Everything Bus Stops. needs before it can be deployed, and how much of it is now done for you.

Most of this file used to be a checklist. It is not any more: `.github/workflows/deploy-preview.yml`
creates the Cloudflare resources, sets the Worker's runtime secrets, works out the deployed URLs
and wires them into the frontend, the CORS allow-list and the Content-Security-Policy. What
remains for a person is the part a workflow genuinely cannot do — hold an account, mint a token,
and read a provider's terms.

If this file and any other file disagree, this file is wrong and should be fixed.
`scripts/preflight.mjs`, `apps/worker/src/wrangler-config.test.ts` and the contract tests in
`tests/contract/` enforce most of it mechanically.

Everything here is free-tier. Nothing enables usage-based billing. **Attach no payment method** —
that is the only guarantee that costs cannot appear.

---

## 1. The short version

1. Add six repository secrets (§2).
2. GitHub → **Actions** → **Deploy Preview** → **Run workflow**.

That is the whole preview path. The run provisions what is missing, deploys, bootstraps real
national data, smoke tests the result and prints the URL. It is safe to re-run.

Production is deliberately not part of that button: see §6.

---

## 2. What a person must set

### GitHub repository secrets

Settings → Secrets and variables → Actions → **Secrets**.

| Secret                  | Required        | Used by                                                |
| ----------------------- | --------------- | ------------------------------------------------------ |
| `CLOUDFLARE_ACCOUNT_ID` | Yes             | Deploy, provisioning, and every job that reaches R2    |
| `CLOUDFLARE_API_TOKEN`  | Yes             | Deploy, provisioning, and every job that reaches R2    |
| `BODS_API_KEY`          | Yes             | Live vehicles outside London; static network           |
| `TFL_APP_KEY`           | Yes             | London arrivals; static network                        |
| `VEHICLE_SALT_SECRET`   | Yes             | Live collection — it refuses to run without it         |
| `UNSUBSCRIBE_SECRET`    | Yes             | One-click unsubscribe tokens                           |
| `EMAIL_API_KEY`         | Only with email | Daily Brief delivery; everything else works without it |

`VEHICLE_SALT_SECRET` and `UNSUBSCRIBE_SECRET` should each be a long random string, for example
`openssl rand -hex 32`. The vehicle salt is what stops a published vehicle reference being
correlated across service days; a guessable value defeats the scheme entirely.

The deploy workflows copy the four runtime secrets into the Worker themselves, piping each value
on stdin so it never appears as a command-line argument. You do not run `wrangler secret put` by
hand for a deploy — §7 is only there for a local Worker.

### API token scopes

Create the token with **exactly** these four permissions and no more. A token with account-wide
edit would let a compromised CI run change billing.

| Scope                        | Permission | Needed for                    |
| ---------------------------- | ---------- | ----------------------------- |
| Account · Workers Scripts    | Edit       | Deploying the Worker          |
| Account · Workers R2 Storage | Edit       | Creating and using the bucket |
| Account · Cloudflare Pages   | Edit       | Creating and deploying Pages  |
| Account · Account Settings   | Read       | Resolving the account         |

### Nothing else

No GitHub repository variables are required, and the preview path uses no GitHub Environment.
Everything else the platform needs is either deterministic or read back from what was deployed:

| Value                | Where it comes from now                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| R2 bucket            | Fixed: `busstops-artifacts`, `busstops-artifacts-preview`                   |
| Pages project        | Fixed: `busstops`                                                           |
| Pages URL            | Deterministic: `busstops.pages.dev`, `preview.busstops.pages.dev`           |
| Worker URL           | Read back from `wrangler deploy` — the workers.dev subdomain is per-account |
| `VITE_API_URL`       | The Worker URL, baked into the bundle at build time                         |
| `PUBLIC_BASE_URL`    | Declared per environment in `wrangler.toml` `[vars]`; it is the CORS origin |
| `BUDGET_UTILIZATION` | Defaults to `0`                                                             |

The optional repository variables in the table in §8 still work if you set them. They are
overrides, not requirements — every one has a default in the job that reads it.

---

## 3. What the workflow creates

`scripts/provision-cloudflare.mjs` runs first on every deploy. It asks whether each resource
exists before creating it, treats an "already exists" answer from a concurrent run as success, and
can enable nothing chargeable.

| Resource      | Name                         | Created by                  |
| ------------- | ---------------------------- | --------------------------- |
| R2 bucket     | `busstops-artifacts`         | The provisioning script     |
| R2 bucket     | `busstops-artifacts-preview` | The provisioning script     |
| Pages project | `busstops`                   | The provisioning script     |
| Worker        | `busstops-api`               | The first production deploy |
| Worker        | `busstops-api-preview`       | The first preview deploy    |

The Pages project is created connected to **no repository**: the workflow uploads the build
directly, so Cloudflare never needs access to your code.

There is **no KV namespace and no D1 database**. Earlier configuration declared a KV binding that
no code read; it has been removed rather than left for you to provision for nothing.

### Worker bindings

Declared in `apps/worker/wrangler.toml`. Wrangler does **not** inherit bindings into named
environments, so each is declared twice — once at the top level and once under `[env.preview]`.
Preflight fails if the two ever drift apart.

| Binding                    | Production                   | Preview                              |
| -------------------------- | ---------------------------- | ------------------------------------ |
| `ARTIFACTS` (R2)           | `busstops-artifacts`         | `busstops-artifacts-preview`         |
| `PUBLIC_BASE_URL` (var)    | `https://busstops.pages.dev` | `https://preview.busstops.pages.dev` |
| `GOVERNOR_MODE` (var)      | `green`                      | `green`                              |
| `FEATURE_FLAGS_JSON` (var) | `{}`                         | `{}`                                 |

---

## 4. How the frontend reaches the API

The app is served by Pages and the API by a Worker. They are different origins, so a relative
`/api` would resolve to the Pages host and 404. Three things are wired together at deploy time:

1. **The client.** `VITE_API_URL` is set to the Worker URL the deploy just read back, and Vite
   bakes it into the bundle. There is no runtime lookup and no configuration endpoint to get
   wrong. With it unset the client falls back to a relative `/api`, which is what the Vite dev
   server proxies to a local `wrangler dev`.
2. **CORS.** The Worker allows exactly the Pages origin for its environment, from
   `PUBLIC_BASE_URL` in `wrangler.toml`. Pages hostnames are deterministic, so this needs no
   chicken-and-egg resolution — the origin is known before either side is deployed.
3. **The Content-Security-Policy.** `scripts/generate-headers.mjs` writes `dist/_headers` with
   `connect-src 'self' <the exact Worker origin>`. It is generated rather than checked in because
   the workers.dev subdomain is account-specific, and named exactly rather than wildcarded.

`apps/web/public/_headers` is the pre-generation fallback and deliberately allows no cross-origin
API call at all. If the generator is ever skipped the app fails visibly in the browser console
rather than silently shipping a wider policy than intended.

A Pages Functions proxy at `/api` was considered and rejected: Pages Functions are themselves
Workers, so every API request would invoke two of them against the same free-tier request budget.

---

## 5. Deploying the preview

GitHub → **Actions** → **Deploy Preview** → **Run workflow**.

The single input, `bootstrap_data`, defaults to on and publishes the national network artifact to
the preview bucket. Turn it off for a code-only redeploy.

In order, the run:

1. Re-runs the full quality gate on the commit being deployed — that may not be the commit CI
   tested — then the deploy-stage preflight, which is stricter.
2. Provisions any missing Cloudflare resource.
3. Deploys the preview Worker and reads its URL back from wrangler's output.
4. Sets the Worker's four runtime secrets.
5. Waits for the Worker to answer `/v1/sources/health` before compiling anything against it.
6. Builds the frontend with `VITE_API_URL` and generates the matching CSP.
7. Deploys Pages to the `preview` branch, whose alias `preview.busstops.pages.dev` is stable
   across deploys — unlike the per-deployment hash URL, which is not what CORS allows.
8. Bootstraps the national artifact and **fails if it published nothing**. The daily job exits 0
   when storage is unconfigured, so a schedule keeps running and the gap stays visible; a
   bootstrap needs the opposite.
9. Waits for Pages to serve, then runs two different checks and prints the preview link in the
   job summary.

The two checks answer different questions, which is why they are separate:

- `scripts/smoke-test.mjs` asks whether the **deployment** is sound — the edge serves, the
  security headers are present, the query caps are enforced by the running Worker, Pro needs no
  credential. It deliberately asserts nothing about live bus data, because whether a feed is
  healthy this minute is not a property of a deployment and failing a deploy over it would be the
  wrong signal.
- `scripts/verify-deployment.mjs` asks whether there is **real data** behind it and whether a
  passenger can reach it: real stops in a real viewport, a stop that can be selected and returns a
  renderable departure board, a search that finds a stop the API itself named. It also checks the
  three things that make the cross-origin setup work — that the bundle really was compiled against
  the Worker origin, that the served CSP names it exactly, and that the Worker allows the Pages
  origin. It only runs after a bootstrap, where "no data" is a meaningful answer.

## 5a. Verifying the adapters against real upstreams

GitHub → **Actions** → **Verify live sources** → **Run workflow**.

Fetches one bounding box from BODS, one stop from TfL and a cancelled prefix of the NaPTAN CSV,
runs each through the parser the platform uses, and reports structure only — counts, field names,
parser outcomes. Payloads are licensed data that is not redistributed, and credentials are
redacted from every message. Requests are deliberately tiny, so verification cannot become a load
source.

Read the summary, then set `contractVerification` in
`packages/contracts/src/source-registry.ts` from what it **observed**, not from what it was
expected to observe. `method: "live_response"` is only honest when a real response was inspected,
and the note should say what was and was not covered — "arrivals for one stop point" rather than
"TfL works".

---

## 6. Deploying production

GitHub → **Actions** → **Deploy** → **Run workflow** → `production`.

This is a separate, manual, gated button on purpose. A merge that passes CI is not the same event
as a decision to put something in front of the public, and a deploy-on-push would remove the one
place a person can say no.

`Deploy` is scoped to a GitHub Environment named after its input, so **creating a `production`
environment with a required reviewer is the one piece of GitHub configuration still worth doing**.
It is the only remaining setting whose absence loses something real: without it, the production
button deploys immediately rather than asking a person first. Create `preview` too if you use
`Deploy` for preview rather than `Deploy Preview`; it needs no variables.

Production deploys also require every free-tier allowance marked `requiredForDeploy` to be
verified (§8).

---

## 7. Setting Worker secrets by hand

The deploy workflows do this for you. You only need these commands for a locally run Worker, or to
rotate a value outside a deploy:

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

## 8. Free-tier allowances and optional overrides

```bash
PREFLIGHT_STAGE=deploy npm run preflight
```

This fails while any allowance in `packages/governor/src/budget-registry.ts` that is marked
`requiredForDeploy` has `verifiedAt: null`. Verifying one means opening the provider's current
terms page, confirming the number, and setting both `verifiedAt` and `verifiedNote` on that entry.

This is deliberately a human step. Allowances change, and a stale figure in a registry is worse
than no figure because it is trusted. **Do not set `verifiedAt` merely to make preflight pass** —
the gate exists precisely to stop that.

Allowances for capabilities that are switched off — email delivery, Open-Meteo, the Environment
Agency feed — are not `requiredForDeploy`, so they cannot block a deploy of a platform that does
not yet call them. They become required when the capability is enabled.

Verified, with how:

- **GitHub Actions minutes** — standard GitHub-hosted runners are free and unlimited for public
  repositories, so the entry is marked `metered: false`. It is kept rather than deleted because
  the condition matters: making this repository private turns minutes into a real budget.
- **BODS live data** — consumer guidance asks for no more than one central live-data request
  every five seconds, recorded as 12 requests per minute and enforced per request in the
  collector, not merely documented.
- **TfL Unified API** — the registered product is 500 requests per minute. The app key is what
  makes that figure apply; an unregistered caller gets far less.
- **Cloudflare Workers, Pages and R2** — the free-tier request, build and storage allowances the
  deploy depends on.

### Optional repository variables

Settings → Secrets and variables → Actions → **Variables**. Every one has a working default; set
one only to override it. These are public by definition and must not be secrets.

| Variable                                                          | Default                       |
| ----------------------------------------------------------------- | ----------------------------- |
| `BUDGET_UTILIZATION`                                              | `0` — assume headroom         |
| `R2_BUCKET_ARTIFACTS`                                             | `busstops-artifacts`          |
| `PUBLIC_BASE_URL`                                                 | Used for Daily Brief links    |
| `R2_STORAGE_LIMIT_BYTES`                                          | 10 GiB                        |
| `MAX_PARTITIONS_PER_RUN`                                          | 12                            |
| `BODS_DAILY_REQUEST_BUDGET`                                       | 8,640                         |
| `COLLECTION_PASSES`                                               | 3                             |
| `COLLECTION_BUDGET_MS`                                            | 240,000                       |
| `BATCH_BUDGET_MS`                                                 | 300,000                       |
| `EMAIL_PROVIDER`, `EMAIL_PROVIDER_ENDPOINT`, `EMAIL_FROM_ADDRESS` | Unset; email delivery skipped |

---

## 9. Keeping it free

- Attach no payment method.
- Leave the Workers plan on free. `workers_dev = true` and the absence of any paid binding keep
  it there.
- The governor cannot see the Cloudflare dashboard. Set `BUDGET_UTILIZATION` (0..1) if you want
  the scheduled jobs to widen their cadence before a limit is reached; `0` means they assume
  there is headroom.
- The retention job runs separately from the analytics batch on purpose, so an analytics failure
  can never postpone raw-data expiry.

---

## 10. After deploying

The deploy workflows smoke test what they deployed. To re-check later, against the URLs the run
printed:

```bash
node scripts/smoke-test.mjs https://preview.busstops.pages.dev https://busstops-api-preview.<subdomain>.workers.dev
```

If it fails, roll back rather than fixing forward:

```bash
npx wrangler rollback --config apps/worker/wrangler.toml --env ""
npx wrangler pages deployment list --project-name busstops
```

`docs/runbooks/` covers what to do when a source dies, a budget tightens, an artifact goes bad, a
Daily Brief misfires, or someone asks what data you hold about them.
