import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `.env.example` is the contract between the code and whoever provisions it.
 *
 * Drift in either direction is a deployment defect that no other test catches. A variable the
 * code reads but the template omits is a capability that silently fails in production with no
 * clue why. A variable the template lists but nothing reads is a step someone follows during
 * provisioning for no reason, and it makes the whole file less trustworthy.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readAll(directory: string, extensions: string[], collected: string[] = []): string[] {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (
        ["node_modules", "dist", ".git", "test-results", "playwright-report"].includes(entry.name)
      ) {
        continue;
      }
      readAll(relative, extensions, collected);
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      if (entry.name.includes(".test.")) continue;
      collected.push(readFileSync(join(root, relative), "utf8"));
    }
  }
  return collected;
}

const envExample = readFileSync(join(root, ".env.example"), "utf8");

/** Names declared in the template, ignoring commented-out lines. */
const declared = new Set([...envExample.matchAll(/^([A-Z0-9_]+)=/gm)].map((match) => match[1]!));

const sources = [
  ...readAll("apps", [".ts", ".tsx"]),
  ...readAll("packages", [".ts"]),
  ...readAll("pipelines", [".ts"]),
  ...readAll("scripts", [".mjs"]),
].join("\n");

const workflows = readdirSync(join(root, ".github/workflows"))
  .map((name) => readFileSync(join(root, ".github/workflows", name), "utf8"))
  .join("\n");

/*
 * The Worker reads its non-secret configuration from bindings rather than from process.env, so
 * wrangler.toml is a third place a name can legitimately be used.
 */
const wrangler = readFileSync(join(root, "apps/worker/wrangler.toml"), "utf8");

/** Read from the process environment by shipped code. */
const readInCode = new Set(
  [...sources.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]!),
);

describe(".env.example matches what the platform actually uses", () => {
  it("documents every variable the code reads from the process environment", () => {
    // PREFLIGHT_STAGE is a CI switch rather than deployment configuration; the template explains
    // it in prose instead of offering it as a value to set.
    const exempt = new Set(["PREFLIGHT_STAGE"]);
    const undocumented = [...readInCode].filter((name) => !declared.has(name) && !exempt.has(name));
    expect(undocumented).toEqual([]);
  });

  it("declares no variable that nothing reads", () => {
    const unused = [...declared].filter(
      (name) => !readInCode.has(name) && !workflows.includes(name) && !wrangler.includes(name),
    );
    expect(unused).toEqual([]);
  });

  it("carries names only, never values, for anything secret-shaped", () => {
    for (const [, name, value] of envExample.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) {
      if (/KEY|SECRET|TOKEN|PASSWORD/.test(name!)) {
        expect(value, `${name} must have no value in the template`).toBe("");
      }
    }
  });

  it("every secret the workflows pass is documented", () => {
    const referenced = new Set(
      [...workflows.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]!),
    );
    // GITHUB_TOKEN is provided by Actions itself and is never something a person sets.
    referenced.delete("GITHUB_TOKEN");
    expect([...referenced].filter((name) => !declared.has(name))).toEqual([]);
  });

  it("every repository variable the workflows read is documented", () => {
    const referenced = new Set(
      [...workflows.matchAll(/vars\.([A-Z0-9_]+)/g)].map((match) => match[1]!),
    );
    expect([...referenced].filter((name) => !declared.has(name))).toEqual([]);
  });
});
