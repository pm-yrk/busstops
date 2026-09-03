import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The static site's deployment configuration.
 *
 * These files are the only thing standing between the app shell and being served with no
 * Content-Security-Policy at all: the Worker hardens API responses, but it never touches the
 * pages people actually load. A build that quietly dropped them would produce a site that passes
 * every other test and ships without a CSP.
 */

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../../public");

describe("static deployment configuration", () => {
  const headers = readFileSync(join(publicDir, "_headers"), "utf8");

  /*
   * This file is the fallback that ships in `public/`. The deploy workflow overwrites
   * `dist/_headers` with a generated copy naming the exact API origin the build was compiled
   * against, because that hostname contains an account-specific subdomain unknown until deploy.
   *
   * The fallback deliberately allows no cross-origin connection at all. If a deploy ever skipped
   * the generator, API calls would fail visibly rather than the page silently gaining permission
   * to talk to hosts nobody vetted.
   */
  it("falls back to allowing no cross-origin API calls", () => {
    expect(headers).toMatch(/connect-src 'self'(;|\s*$)/m);
  });

  it("sets a Content-Security-Policy on every page", () => {
    expect(headers).toMatch(/^\/\*$/m);
    expect(headers).toContain("Content-Security-Policy:");
    expect(headers).toContain("default-src 'self'");
    expect(headers).toContain("object-src 'none'");
    expect(headers).toContain("frame-ancestors 'none'");
  });

  it("does not permit inline or remote script", () => {
    const csp = headers.match(/Content-Security-Policy: (.+)/)![1]!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-eval/);
    expect(csp).not.toMatch(/script-src[^;]*\*/);
  });

  it("sets the other headers a static site still needs", () => {
    for (const header of [
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy: strict-origin-when-cross-origin",
      "X-Frame-Options: DENY",
      "Strict-Transport-Security:",
    ]) {
      expect(headers).toContain(header);
    }
  });

  it("asks for no permission it does not use, and keeps geolocation to first party", () => {
    const policy = headers.match(/Permissions-Policy: (.+)/)![1]!;
    expect(policy).toContain("geolocation=(self)");
    for (const denied of ["camera=()", "microphone=()", "payment=()"]) {
      expect(policy).toContain(denied);
    }
  });

  it("caches hashed assets hard and the shell not at all", () => {
    expect(headers).toMatch(/\/assets\/\*[\s\S]*?immutable/);
    // A cached shell would strand people on a previous deploy.
    expect(headers).toMatch(/\/index\.html[\s\S]*?must-revalidate/);
  });

  it("serves deep links as the shell with a 200, so URLs survive a refresh", () => {
    const redirects = readFileSync(join(publicDir, "_redirects"), "utf8");
    expect(redirects).toMatch(/^\/\*\s+\/index\.html\s+200$/m);
  });
});
