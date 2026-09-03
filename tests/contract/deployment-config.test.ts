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

  it("refuses to smoke test against an unset URL", () => {
    // Falling back to a repository-scoped URL would smoke test production after a preview deploy
    // and report a pass.
    expect(deploy).toMatch(/if \[ -z "\$SITE_URL" \] \|\| \[ -z "\$API_URL" \]/);
    expect(deploy).toMatch(/exit 1/);
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
