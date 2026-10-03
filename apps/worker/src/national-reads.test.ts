import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No request path may read a whole national dataset.
 *
 * This is the defect that cost most of 3 October, and it hid for a long time because the shape of
 * its failure looks like an unrelated intermittent fault. `NetworkReader.services()` is 13,626
 * records behind an FNV-1a hash of a 4.7 MiB object, and `operators()` the same over a smaller
 * one. Both are tens of milliseconds of pure computation against the ten a Workers Free invocation
 * gets, and both cache their result in the isolate — so the *first* request to reach the line dies
 * with Cloudflare's error 1102, and every request after it, reading the result out of the cache,
 * answers perfectly. `/v1/map` passed as check one and answered 503 as check nine in four
 * consecutive deployed runs, and the map's own diagnostics printed `services=13626` throughout.
 *
 * Three handlers and one reader method were calling them, each for a handful of records. The
 * replacements read by id — `servicesByIds`, `operatorsByIds`, `servicesForOperator` — scanning
 * the text and parsing only what was asked for.
 *
 * A comment on each method says nothing on a request path may call it. A comment did not stop the
 * last four callers, so this is the rule with teeth: the methods may exist, because the tests use
 * them as an oracle, and nothing that serves a request may name them.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Everything in the Worker that runs while a request is being served. */
function requestPathSources(): Array<{ file: string; text: string }> {
  return readdirSync(here)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ file: name, text: readFileSync(join(here, name), "utf8") }));
}

/**
 * Lines that call one of the whole-table methods, ignoring comments.
 *
 * Matched on the call rather than the name, because the names appear all over the prose that
 * explains why they are not called — including in this file's own reasoning.
 */
function nationalCalls(text: string): string[] {
  return text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"))
    .filter(({ line }) => /\.(services|operators)\(\s*\)/.test(line))
    .map(({ line, number }) => `${number}: ${line}`);
}

describe("the whole national tables", () => {
  it("are not read by anything that serves a request", () => {
    const offenders = requestPathSources()
      .map((source) => ({ ...source, calls: nationalCalls(source.text) }))
      .filter((source) => source.calls.length > 0);

    expect(
      offenders.map((source) => `${source.file} — ${source.calls.join("; ")}`),
      "a request path is reading a whole national table; ask by id instead " +
        "(servicesByIds / operatorsByIds / servicesForOperator)",
    ).toEqual([]);
  });

  /*
   * And the rule can actually fail, which a test of absence has to prove about itself. A rule that
   * matches nothing passes on an empty codebase just as happily as on a correct one.
   */
  it("would catch a caller that came back", () => {
    expect(nationalCalls("const all = await network.services();")).toEqual([
      "1: const all = await network.services();",
    ]);
    expect(nationalCalls("const all = await this.operators();")).toEqual([
      "1: const all = await this.operators();",
    ]);
    // Prose about them is not a call, which is what lets the warnings on the methods stay put.
    expect(nationalCalls(" * `services()` hashes the whole object before returning one.")).toEqual(
      [],
    );
    expect(nationalCalls("// never call operators() here")).toEqual([]);
    // Nor is the by-id form it is telling people to use.
    expect(nationalCalls("await network.servicesByIds(new Set([id]));")).toEqual([]);
  });
});
