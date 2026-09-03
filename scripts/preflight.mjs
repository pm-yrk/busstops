#!/usr/bin/env node
/**
 * Pre-deployment preflight (docs/13_FREE_TIER_RULES.md "Verification").
 *
 * Fails when a required cap, TTL, rate limit, secret binding or budget value is missing.
 * Runs in CI on every push so a regression cannot reach deployment. Deployment-only checks
 * (verified provider allowances, live secret bindings) are reported but only fail the run
 * when PREFLIGHT_STAGE=deploy, so day-to-day CI stays green while the deploy gate stays hard.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = process.env.PREFLIGHT_STAGE ?? "ci";
const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}
function warn(message) {
  warnings.push(message);
}
function deployGate(message) {
  if (stage === "deploy") fail(message);
  else warn(`${message} (deploy-stage gate)`);
}

function read(relativePath) {
  const path = join(root, relativePath);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// --- 1. Required files exist -------------------------------------------------
for (const required of [
  ".env.example",
  ".gitignore",
  "packages/governor/src/budget-registry.ts",
  "packages/contracts/src/source-registry.ts",
  "docs/13_FREE_TIER_RULES.md",
]) {
  if (!read(required)) fail(`Missing required file: ${required}`);
}

// --- 2. No secret values committed ------------------------------------------
const envExample = read(".env.example") ?? "";
for (const line of envExample.split("\n")) {
  const match = line.match(/^([A-Z0-9_]+)=(.+)$/);
  if (match && !match[2].startsWith("$") && !["{}", "green"].includes(match[2].trim())) {
    const value = match[2].trim();
    // Non-secret defaults (bucket names, mode flags) are allowed; anything key-shaped is not.
    if (value.length > 24 || /[A-Za-z0-9]{24,}/.test(value)) {
      fail(`.env.example appears to contain a value for ${match[1]} — names only, never values`);
    }
  }
}

const gitignore = read(".gitignore") ?? "";
if (!gitignore.includes(".env")) fail(".gitignore must ignore .env files");

// --- 3. Budget registry completeness ----------------------------------------
const budgetSource = read("packages/governor/src/budget-registry.ts") ?? "";
// Every resource the deployed platform actually consumes. KV is deliberately absent: nothing
// binds or reads it, so tracking a budget for it would be tracking a fiction.
const requiredBudgetKeys = [
  "cloudflare.workers.requests",
  "cloudflare.r2.storage_bytes",
  "cloudflare.r2.class_a_operations",
  "cloudflare.r2.class_b_operations",
  "github.actions.minutes",
  "email.daily_sends",
  "upstream.bods.requests",
  "upstream.tfl.requests",
];
for (const key of requiredBudgetKeys) {
  if (!budgetSource.includes(`"${key}"`)) {
    fail(`Budget registry is missing required resource: ${key}`);
  }
}

// Only allowances explicitly marked requiredForDeploy are deployment gates. Optional features
// (for example Daily Brief email or weather enrichment) are allowed to remain unverified and
// disabled without preventing the core public site from being previewed or deployed.
const budgetResourceBlocks = [
  ...budgetSource.matchAll(/\{\n\s*key:\s*"([^"]+)"[\s\S]*?\n\s*\},/g),
].map((match) => ({ key: match[1], source: match[0] }));
const unverifiedRequired = budgetResourceBlocks.filter(
  ({ source }) =>
    /requiredForDeploy:\s*true/.test(source) && /verifiedAt:\s*null/.test(source),
);
if (unverifiedRequired.length > 0) {
  deployGate(
    `${unverifiedRequired.length} required budget allowance(s) are unverified against live ` +
      `provider terms (${unverifiedRequired.map(({ key }) => key).join(", ")}); confirm current ` +
      `free allowances and set verifiedAt before deploying`,
  );
}

// A verified allowance must say how it was verified. Without that, "verified" is just a date.
const verifiedWithoutNote = (
  budgetSource.match(/verifiedAt: "[^"]+",\s*\n\s*verifiedNote: null/g) ?? []
).length;
if (verifiedWithoutNote > 0) {
  fail(
    `${verifiedWithoutNote} budget allowance(s) claim verification without recording how it was ` +
      `verified; set verifiedNote alongside verifiedAt`,
  );
}

// An unmetered resource must state the condition that keeps it unmetered, because that condition
// can change — a repository going private turns free Actions minutes into a real budget.
const unmeteredCount = (budgetSource.match(/metered: false/g) ?? []).length;
const unmeteredReasons = (
  budgetSource.match(/metered: false,\s*\n\s*unmeteredBecause:\s*\n?\s*"/g) ?? []
).length;
if (unmeteredCount !== unmeteredReasons) {
  fail(
    `every resource marked metered: false must record unmeteredBecause ` +
      `(${unmeteredCount} unmetered, ${unmeteredReasons} with a stated reason)`,
  );
}

// --- 3b. Worker bindings are declared for every environment ------------------
// Wrangler does not inherit bindings into named environments; a binding missing from
// [env.preview] is simply absent at runtime and the deploy still succeeds.
const wrangler = read("apps/worker/wrangler.toml") ?? "";
const topBindings = [
  ...wrangler.matchAll(/^\[\[(r2_buckets|kv_namespaces|d1_databases)\]\]/gm),
].map((m) => m[1]);
for (const kind of new Set(topBindings)) {
  const previewCount = (
    wrangler.match(new RegExp(`^\\[\\[env\\.preview\\.${kind}\\]\\]`, "gm")) ?? []
  ).length;
  const topCount = topBindings.filter((k) => k === kind).length;
  if (previewCount !== topCount) {
    fail(
      `wrangler.toml declares ${topCount} top-level ${kind} binding(s) but ${previewCount} for ` +
        `env.preview; bindings do not inherit between environments`,
    );
  }
}
if (!/^\[env\.preview\]/m.test(wrangler)) {
  fail("wrangler.toml must declare a preview environment");
}

// --- 4. Governor thresholds match the specification --------------------------
const governorSource = read("packages/governor/src/governor.ts") ?? "";
for (const [name, value] of [
  ["amber", "0.7"],
  ["red", "0.85"],
  ["critical", "0.95"],
]) {
  if (!new RegExp(`${name}:\\s*${value.replace(".", "\\.")}`).test(governorSource)) {
    fail(`Governor threshold ${name} must be ${value} per docs/13_FREE_TIER_RULES.md`);
  }
}
for (const preserved of [
  "consent_deletion",
  "raw_retention_deletion",
  "unsubscribe",
  "security_controls",
]) {
  if (!governorSource.includes(preserved)) {
    fail(`Governor must preserve ${preserved} in critical mode`);
  }
}

// --- 5. API caps present -----------------------------------------------------
const apiSource = read("packages/contracts/src/api.ts") ?? "";
for (const cap of ["maxBboxAreaSquareDegrees", "minZoom", "maxStops", "maxVehicles", "timeoutMs"]) {
  if (!apiSource.includes(cap)) fail(`API contract is missing hard cap: ${cap}`);
}

// --- 6. Source registry: no live-verification claims without evidence --------
const registrySource = read("packages/contracts/src/source-registry.ts") ?? "";
const liveClaims = registrySource.match(/method: "live_response",\s*\n\s*at: null/g);
if (liveClaims) {
  fail("Source registry claims live verification without a recorded verification timestamp");
}

// --- 7. Retention policy -----------------------------------------------------
const retention = read("packages/pipeline-core/src/retention.ts");
if (retention) {
  const match = retention.match(/RAW_TRACE_MAX_AGE_HOURS\s*=\s*(\d+)/);
  if (!match || Number(match[1]) > 48) {
    fail("Raw trace retention must be capped at 48 hours or less (docs/06_DATA_MODEL.md)");
  }
  if (/replay/i.test(retention)) {
    fail("No Replay pipeline may exist (docs/01_PRODUCT_SPEC.md explicit exclusions)");
  }
} else {
  warn("packages/pipeline-core/src/retention.ts not present yet — raw-expiry policy unverified");
}

// --- Report ------------------------------------------------------------------
for (const w of warnings) console.warn(`  warn  ${w}`);
for (const f of failures) console.error(`  FAIL  ${f}`);

if (failures.length > 0) {
  console.error(`\nPreflight failed with ${failures.length} error(s) [stage=${stage}].`);
  process.exit(1);
}
console.log(
  `Preflight passed [stage=${stage}] with ${warnings.length} warning(s). ` +
    `Deployment additionally requires PREFLIGHT_STAGE=deploy to pass.`,
);
