#!/usr/bin/env node
/**
 * Idempotent Cloudflare provisioning.
 *
 * Creates only what the deployed platform reads: two R2 buckets and one Pages project. Re-running
 * is a no-op — every step checks first and reports "exists" rather than failing on a conflict, so
 * the deploy workflow can call it on every run without a human deciding whether it is the first.
 *
 * It deliberately cannot enable anything chargeable. There is no plan change, no usage-based
 * pricing toggle, no D1, no KV, no Durable Object, no queue. If a future resource is needed it
 * has to be added here explicitly, which is the point.
 *
 * The API token is read from the environment and never logged. Failures print the Cloudflare
 * error code and message, which name the missing permission without echoing the credential.
 */

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if (!accountId || !apiToken) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must both be set.");
  process.exit(2);
}

const API = "https://api.cloudflare.com/client/v4";

/** Resources this platform actually uses. Adding to this list is a deliberate act. */
const R2_BUCKETS = ["busstops-artifacts", "busstops-artifacts-preview"];
const PAGES_PROJECT = "busstops";
/** Pages needs a production branch name at creation; deploys target branches explicitly. */
const PAGES_PRODUCTION_BRANCH = "main";

let failed = false;

async function call(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  let body = {};
  try {
    body = await response.json();
  } catch {
    // A non-JSON body is still meaningful via its status.
  }
  return { ok: response.ok, status: response.status, body };
}

/** Cloudflare returns errors as a list of {code, message}; surface both, never the token. */
function describeErrors(body) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  if (errors.length === 0) return "no error detail returned";
  return errors.map((error) => `${error.code}: ${error.message}`).join("; ");
}

/** True when the failure means "it already exists", which is success for our purposes. */
function isAlreadyExists(body) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  return errors.some(
    (error) =>
      error.code === 10004 || // R2: bucket already exists
      error.code === 8000007 || // Pages: project name already taken
      /already exists|duplicate/i.test(String(error.message ?? "")),
  );
}

async function ensureR2Bucket(name) {
  const existing = await call(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(name)}`);
  if (existing.ok) {
    console.log(`  R2 bucket ${name}: exists`);
    return;
  }

  const created = await call(`/accounts/${accountId}/r2/buckets`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });

  if (created.ok) {
    console.log(`  R2 bucket ${name}: created`);
    return;
  }
  if (isAlreadyExists(created.body)) {
    // Another run created it between our check and our create.
    console.log(`  R2 bucket ${name}: exists`);
    return;
  }

  failed = true;
  console.error(`  R2 bucket ${name}: FAILED (${created.status}) ${describeErrors(created.body)}`);
}

async function ensurePagesProject(name) {
  const existing = await call(`/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}`);
  if (existing.ok) {
    console.log(`  Pages project ${name}: exists`);
    return;
  }

  const created = await call(`/accounts/${accountId}/pages/projects`, {
    method: "POST",
    // No build configuration and no repository connection: the workflow uploads a built
    // directory, so Pages never needs access to the source or a build of its own.
    body: JSON.stringify({ name, production_branch: PAGES_PRODUCTION_BRANCH }),
  });

  if (created.ok) {
    console.log(`  Pages project ${name}: created`);
    return;
  }
  if (isAlreadyExists(created.body)) {
    console.log(`  Pages project ${name}: exists`);
    return;
  }

  failed = true;
  console.error(
    `  Pages project ${name}: FAILED (${created.status}) ${describeErrors(created.body)}`,
  );
}

console.log("Provisioning Cloudflare resources (idempotent):");

for (const bucket of R2_BUCKETS) {
  await ensureR2Bucket(bucket);
}
await ensurePagesProject(PAGES_PROJECT);

if (failed) {
  console.error(
    "\nProvisioning did not complete. If the message above names a permission, the API token " +
      "needs that scope; nothing here can be worked around by retrying.",
  );
  process.exit(1);
}

console.log("\nAll Cloudflare resources present. Nothing chargeable was enabled.");
