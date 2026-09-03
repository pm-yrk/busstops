import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The generated Content-Security-Policy.
 *
 * This is the only thing standing between the deployed app and either (a) being unable to reach
 * its own API, or (b) being permitted to talk to any host on the internet. Both failures are
 * invisible in every other test, because the policy is produced at deploy time from a hostname
 * that does not exist until the Worker has been deployed.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "scripts/generate-headers.mjs");

function generate(apiUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "busstops-headers-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  execFileSync("node", [script, dir, apiUrl], { encoding: "utf8" });
  return readFileSync(join(dir, "_headers"), "utf8");
}

function cspOf(headers: string): string {
  return /Content-Security-Policy: (.+)/.exec(headers)![1]!;
}

describe("generated Pages headers", () => {
  const headers = generate("https://busstops-api-preview.acme.workers.dev");
  const csp = cspOf(headers);

  it("allows the exact API origin and nothing broader", () => {
    expect(csp).toContain("connect-src 'self' https://busstops-api-preview.acme.workers.dev");
    // A wildcard would defeat most of the point of having a policy at all.
    expect(csp).not.toMatch(/connect-src[^;]*\*/);
    expect(csp).not.toMatch(/connect-src[^;]*https:(\s|;|$)/);
  });

  it("strips any path, keeping the origin", () => {
    expect(cspOf(generate("https://api.example.workers.dev/v1/"))).toContain(
      "connect-src 'self' https://api.example.workers.dev;",
    );
  });

  it("still forbids inline and remote script", () => {
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-eval/);
  });

  it("keeps every other protection the static fallback has", () => {
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
    for (const header of [
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy: strict-origin-when-cross-origin",
      "X-Frame-Options: DENY",
      "Strict-Transport-Security:",
    ]) {
      expect(headers).toContain(header);
    }
  });

  it("caches hashed assets hard and the shell not at all", () => {
    expect(headers).toMatch(/\/assets\/\*[\s\S]*?immutable/);
    expect(headers).toMatch(/\/index\.html[\s\S]*?must-revalidate/);
  });

  it("refuses a non-https origin", () => {
    expect(() => generate("http://insecure.example.com")).toThrow();
  });

  it("refuses something that is not a URL", () => {
    expect(() => generate("not-a-url")).toThrow();
  });
});
