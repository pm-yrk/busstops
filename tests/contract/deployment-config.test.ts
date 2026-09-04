import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The deployment path itself.
 *
 * Nothing else tests these files: a workflow only runs on GitHub, and a provisioning document is
 * prose until someone follows it at three in the morning. These assertions cover the mistakes
 * that would otherwise be discovered by deploying the wrong thing to the wrong place.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const deploy = read(".github/workflows/deploy.yml");
const provisioning = read("infra/cloudflare/PROVISIONING.md");
const wrangler = read("apps/worker/wrangler.toml");
const preview = read(".github/workflows/deploy-preview.yml");
const provisionScript = read("scripts/provision-cloudflare.mjs");

describe("deploy workflow", () => {
  it("resolves the target environment in a shell, not a GitHub ternary", () => {
    /*
     * `cond && '' || 'preview'` returns 'preview' for BOTH branches, because the empty string is
     * falsy and falls through to the ||. Production deployed to preview, silently. Any expression
     * whose truthy branch is an empty string has the same defect.
     */
    // Comment lines are excluded: the fix is explained in a comment that quotes the bad pattern.
    const executable = deploy
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(executable).not.toMatch(/&&\s*''\s*\|\|/);
    expect(executable).not.toMatch(/&&\s*""\s*\|\|/);
    expect(deploy).toMatch(/steps\.target\.outputs\.worker_env/);
  });

  it("targets a different Worker environment and Pages branch per input", () => {
    expect(deploy).toMatch(/worker_env=preview/);
    // Production targets the top-level environment, which wrangler expresses as an empty --env.
    expect(deploy).toMatch(/echo "worker_env=" >>/);
    expect(deploy).toMatch(/pages_branch=main/);
    expect(deploy).toMatch(/pages_branch=preview/);
  });

  it("smoke tests the URLs it just deployed, not configured ones", () => {
    /*
     * This assertion used to require the workflow to refuse an unset $SITE_URL/$API_URL, back
     * when both came from GitHub Environment variables. Deriving them is strictly stronger than
     * validating them: a variable can be set and still name the wrong environment, and a smoke
     * test against production after a preview deploy reports a confident pass. So the property
     * under test changed rather than relaxed — the URLs must now come from the deploy steps.
     */
    expect(deploy).toMatch(/steps\.worker\.outputs\.url/);
    expect(deploy).toMatch(/node scripts\/smoke-test\.mjs/);
    // Neither URL may be read from repository or environment variables any more.
    expect(deploy).not.toMatch(/vars\.PUBLIC_BASE_URL/);
    expect(deploy).not.toMatch(/vars\.PUBLIC_API_URL/);
  });

  it("fails rather than guessing when the Worker URL cannot be read back", () => {
    // The workers.dev subdomain is account-specific. A workflow that assembled the URL from a
    // guess would deploy a frontend compiled against a host that does not exist.
    expect(deploy).toMatch(/Could not determine the deployed Worker URL/);
  });

  it("compiles the frontend against the Worker it deployed", () => {
    // The app is served from Pages and the API from a Worker: different origins, so a relative
    // /api resolves to the Pages host and 404s. The origin has to be baked in at build time.
    expect(deploy).toMatch(/VITE_API_URL: \$\{\{ steps\.worker\.outputs\.url \}\}/);
    expect(deploy).toMatch(/generate-headers\.mjs/);
  });

  it("sets the Worker's runtime secrets without ever passing them as arguments", () => {
    // Command-line arguments appear in process listings; stdin does not.
    expect(deploy).toMatch(
      /printf '%s' "\$\{!NAME\}" \| npx (?:--no-install )?wrangler secret put/,
    );
  });

  it("runs the deploy-stage preflight, which is stricter than the CI one", () => {
    expect(deploy).toMatch(/PREFLIGHT_STAGE: deploy/);
  });

  it("re-runs the full gate rather than trusting an earlier green run", () => {
    for (const gate of ["format:check", "run lint", "run typecheck", "npm test"]) {
      expect(deploy, gate).toContain(gate);
    }
  });

  it("is manual, so a merge is never itself a decision to deploy", () => {
    expect(deploy).toMatch(/workflow_dispatch:/);
    expect(deploy).not.toMatch(/^\s+push:/m);
  });

  it("scopes itself to a GitHub Environment so variables resolve per target", () => {
    expect(deploy).toMatch(/environment: \$\{\{ inputs\.environment \}\}/);
  });
});

describe("provisioning document", () => {
  it("names every Cloudflare resource the Worker configuration expects", () => {
    for (const bucket of [...wrangler.matchAll(/bucket_name\s*=\s*"([^"]+)"/g)].map((m) => m[1]!)) {
      expect(provisioning, `${bucket} is bound but not in PROVISIONING.md`).toContain(bucket);
    }
  });

  it("names both Worker environments", () => {
    expect(provisioning).toContain("busstops-api-preview");
    expect(provisioning).toContain("busstops-api");
  });

  it("lists every secret and variable the workflows actually consume", () => {
    const workflows = readdirSync(join(root, ".github/workflows"))
      .map((name) => read(`.github/workflows/${name}`))
      .join("\n");

    const referenced = new Set([
      ...[...workflows.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]!),
      ...[...workflows.matchAll(/vars\.([A-Z0-9_]+)/g)].map((m) => m[1]!),
    ]);
    referenced.delete("GITHUB_TOKEN");

    const missing = [...referenced].filter((name) => !provisioning.includes(name));
    expect(missing).toEqual([]);
  });

  it("tells the reader to provision nothing the platform does not use", () => {
    // KV was declared but never read; both the binding and the instruction are gone.
    expect(provisioning).not.toMatch(/kv_namespace_create|Create a KV namespace/i);
    expect(wrangler).not.toContain("kv_namespaces");
  });

  it("keeps the API token to the least privilege the deploy needs", () => {
    for (const scope of ["Workers Scripts", "Workers R2 Storage", "Cloudflare Pages"]) {
      // Table cells are padded by the formatter, so match the row rather than an exact string.
      expect(provisioning, scope).toMatch(new RegExp(`${scope}\\s*\\|\\s*Edit`));
    }
    // An account-wide edit token could change billing from a compromised CI run. The warning
    // wraps across lines in the prose, so normalise whitespace before matching.
    expect(provisioning.replace(/\s+/g, " ")).toMatch(
      /account-wide edit would let a compromised CI run change billing/i,
    );
  });

  it("states that verification is a human step and must not be faked", () => {
    expect(provisioning).toMatch(/Do not set `verifiedAt` merely to make preflight pass/);
  });
});

describe("preview deploy workflow", () => {
  /*
   * The preview path is one button. Everything it needs is either a repository secret that
   * already exists or a deterministic constant, because every value a person has to set by hand
   * before a deploy works is a value that will be set wrong once.
   */

  it("needs no repository variables and no GitHub Environment", () => {
    expect(preview).not.toMatch(/vars\./);
    expect(preview).not.toMatch(/^\s+environment:/m);
  });

  it("pins the deterministic names rather than asking for them", () => {
    expect(preview).toMatch(/PAGES_PROJECT: busstops/);
    expect(preview).toMatch(/R2_BUCKET_ARTIFACTS: busstops-artifacts-preview/);
    expect(preview).toMatch(/WORKER_ENV: preview/);
  });

  it("provisions before it deploys", () => {
    const provisionAt = preview.indexOf("provision-cloudflare.mjs");
    const deployAt = preview.search(/npx (?:--no-install )?wrangler deploy/);
    expect(provisionAt).toBeGreaterThan(-1);
    expect(deployAt).toBeGreaterThan(provisionAt);
  });

  it("runs the same gate as CI before touching Cloudflare", () => {
    for (const gate of ["format:check", "run lint", "run typecheck", "npm test"]) {
      expect(preview, gate).toContain(gate);
    }
    expect(preview).toMatch(/PREFLIGHT_STAGE: deploy/);
    expect(preview.indexOf("npm test")).toBeLessThan(
      preview.search(/npx (?:--no-install )?wrangler deploy/),
    );
  });

  it("proves the Worker answers before compiling a frontend against it", () => {
    const healthAt = preview.indexOf("/v1/sources/health");
    const buildAt = preview.indexOf("VITE_API_URL");
    expect(healthAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(healthAt);
  });

  it("targets the stable branch alias, not the per-deployment hash URL", () => {
    // Every Pages deploy also gets a <hash>.<project>.pages.dev address. It changes each time,
    // so it can never be the origin the Worker's CORS allow-list names.
    expect(preview).toMatch(/https:\/\/\$\{PAGES_BRANCH\}\.\$\{PAGES_PROJECT\}\.pages\.dev/);
  });

  it("fails when the data bootstrap quietly publishes nothing", () => {
    // run-daily exits 0 when storage is unconfigured, so the daily schedule keeps running and the
    // gap stays visible. A bootstrap needs the opposite: not publishing is the failure.
    expect(preview).toMatch(/OUTCOME.*!=.*"published"|"\$OUTCOME" != "published"/s);
  });

  it("never passes a secret as a command-line argument", () => {
    expect(preview).toMatch(
      /printf '%s' "\$\{!NAME\}" \| npx (?:--no-install )?wrangler secret put/,
    );
    for (const name of [
      "BODS_API_KEY",
      "TFL_APP_KEY",
      "VEHICLE_SALT_SECRET",
      "UNSUBSCRIBE_SECRET",
    ]) {
      expect(preview, name).not.toMatch(new RegExp(`secret put ${name}`));
    }
  });

  /*
   * A deploy that fetches its own tooling is a deploy whose tooling nobody reviewed. wrangler is
   * a pinned devDependency `npm ci` installs, so every call passes `--no-install`: a missing copy
   * must fail rather than reach for the registry, in the middle of talking to the account.
   */
  it("never installs the deploy tool while deploying", () => {
    // Command lines only. The step comments name `npx wrangler` to explain why the flag is there,
    // and a prose mention of the mistake is not the mistake.
    const calls = preview
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .filter((line) => /npx [^\n]*wrangler/.test(line));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.trim(), call.trim()).toContain("--no-install");
  });

  it("ends by printing the URL a person is meant to open", () => {
    expect(preview).toMatch(/GITHUB_STEP_SUMMARY/);
    expect(preview).toMatch(/Preview URL:/);
  });
});

describe("provisioning script", () => {
  it("checks for each resource before creating it", () => {
    expect(provisionScript).toMatch(/ensureR2Bucket/);
    expect(provisionScript).toMatch(/ensurePagesProject/);
    // An "already exists" answer from a concurrent run is success, not failure.
    expect(provisionScript).toMatch(/isAlreadyExists/);
  });

  it("creates only the resources the platform actually binds", () => {
    for (const bucket of [...wrangler.matchAll(/bucket_name\s*=\s*"([^"]+)"/g)].map((m) => m[1]!)) {
      expect(provisionScript, `${bucket} is bound but never provisioned`).toContain(bucket);
    }
    // Nothing here may reach for a paid product or a service the Worker does not use.
    expect(provisionScript).not.toMatch(/kv_namespaces|\/d1\/|hyperdrive|workers_for_platforms/i);
  });

  it("never echoes the credential it authenticates with", () => {
    // The token's *name* appears in a "you must set this" message, which is the point of that
    // message. Its *value* may only ever reach the Authorization header, so every line that
    // mentions the variable holding it is checked rather than every line mentioning the name.
    const usesValue = provisionScript
      .split("\n")
      .filter((line) => /\bapiToken\b/.test(line))
      .filter((line) => !/^const apiToken =/.test(line.trim()))
      // A truthiness check reveals only whether it was set, which the run has to know.
      .filter((line) => !/!apiToken/.test(line))
      .filter((line) => !/Authorization/.test(line));
    expect(usesValue).toEqual([]);
  });
});
