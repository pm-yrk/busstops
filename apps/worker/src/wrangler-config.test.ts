import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Worker's deployment configuration.
 *
 * Wrangler bindings are NOT inheritable between environments. A binding declared only at the top
 * level is silently absent from `--env preview`, and the deploy still succeeds — so the failure
 * shows up at runtime, in the environment nobody watches, as a binding that is undefined.
 *
 * These tests compare the two environments structurally rather than checking for one binding by
 * name, so a binding added later to the top level and forgotten under preview fails here instead
 * of in production.
 */

const config = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../wrangler.toml"),
  "utf8",
);

/** Binding names declared in `[[[env.<name>.]r2_buckets]]`-style blocks. */
function bindingsFor(scope: "top" | "preview"): string[] {
  const pattern =
    scope === "top"
      ? /^\[\[(r2_buckets|kv_namespaces|d1_databases|queues|durable_objects|services|analytics_engine_datasets)\]\]([\s\S]*?)(?=^\[|(?![\s\S]))/gm
      : /^\[\[env\.preview\.(r2_buckets|kv_namespaces|d1_databases|queues|durable_objects|services|analytics_engine_datasets)\]\]([\s\S]*?)(?=^\[|(?![\s\S]))/gm;

  const found: string[] = [];
  for (const match of config.matchAll(pattern)) {
    const binding = /binding\s*=\s*"([^"]+)"/.exec(match[2] ?? "");
    if (binding) found.push(`${match[1]}:${binding[1]}`);
  }
  return found.sort();
}

function varsFor(scope: "top" | "preview"): string[] {
  const header = scope === "top" ? "[vars]" : "[env.preview.vars]";
  const start = config.indexOf(`\n${header}`);
  if (start === -1) return [];
  const rest = config.slice(start + header.length + 1);
  const end = rest.search(/^\[/m);
  const block = end === -1 ? rest : rest.slice(0, end);
  return [...block.matchAll(/^([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]!).sort();
}

describe("wrangler environments", () => {
  it("declares a preview environment at all", () => {
    expect(config).toMatch(/^\[env\.preview\]/m);
    expect(config).toMatch(/name\s*=\s*"busstops-api-preview"/);
  });

  it("gives preview every binding the top level declares", () => {
    const top = bindingsFor("top");
    expect(top.length).toBeGreaterThan(0);
    // Not a subset check: the two must match exactly, because an extra preview binding that
    // production lacks is the same class of mistake in the other direction.
    expect(bindingsFor("preview")).toEqual(top);
  });

  it("gives preview every variable the top level declares", () => {
    const top = varsFor("top");
    expect(top.length).toBeGreaterThan(0);
    expect(varsFor("preview")).toEqual(top);
  });

  it("points preview at its own storage, never production's", () => {
    const buckets = [...config.matchAll(/bucket_name\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(buckets).toContain("busstops-artifacts");
    expect(buckets).toContain("busstops-artifacts-preview");
    // A preview deploy must not be able to publish over the production dataset.
    expect(new Set(buckets).size).toBe(buckets.length);
  });

  it("enables observability in both environments", () => {
    expect(config).toMatch(/^\[observability\]\nenabled = true/m);
    expect(config).toMatch(/^\[env\.preview\.observability\]\nenabled = true/m);
  });

  it("declares no binding the Worker does not read", () => {
    // A binding nothing reads is configuration someone has to provision for no reason, and it
    // hides the fact that the capability is not actually wired up.
    const env = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "env.ts"), "utf8");
    for (const declared of bindingsFor("top")) {
      const name = declared.split(":")[1]!;
      expect(env, `${name} is bound in wrangler.toml but absent from WorkerEnv`).toContain(name);
    }
  });

  it("commits no secret value", () => {
    for (const secret of [
      "BODS_API_KEY",
      "TFL_APP_KEY",
      "VEHICLE_SALT_SECRET",
      "UNSUBSCRIBE_SECRET",
    ]) {
      expect(config).not.toMatch(new RegExp(`${secret}\\s*=`));
    }
  });
});
