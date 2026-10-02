import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every call that has a schema passes it.
 *
 * This is the bug class the vehicle page crashed on: `disruptions` and `operator` in a vehicle
 * detail response both carry `.default([])`, meaning the server may omit them — but a default is
 * applied by *parsing*, and nothing parsed, so the page read `undefined.length` and the error
 * boundary swallowed it. Six of the ten calls were skipping validation at the time.
 *
 * "The API returned data and the UI dropped it" is the hardest failure to see from the outside: the
 * request is a 200, the Worker's log is clean, and the screen is blank. So this reads the client's
 * own source and insists that each `request<T>(…)` names a schema — a structural check, because the
 * alternative is a fixture per endpoint that goes stale the moment a contract gains a field.
 */

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../apps/web/src/lib/api.ts"),
  "utf8",
);

/**
 * Deliberately unvalidated, with the reason.
 *
 * `sourcesHealth` is read as `unknown` by a page that renders it defensively and has no contract of
 * its own; adding one would be inventing a shape rather than enforcing one.
 */
const UNVALIDATED = ["/v1/sources/health"];

/**
 * Each `this.request<…>(…)` call's arguments, found by balancing parentheses rather than by
 * matching a layout. The first version of this test used a regex ending in `\n    );`, which
 * silently skipped every single-line call — so removing a schema from one of them left the test
 * green. A guard whose failure is indistinguishable from its success is worse than no guard.
 */
function requestCalls(text: string): string[] {
  const calls: string[] = [];
  const marker = "this.request<";
  let at = text.indexOf(marker);
  while (at !== -1) {
    const open = text.indexOf("(", text.indexOf(">", at));
    let depth = 0;
    let end = open;
    for (; end < text.length; end += 1) {
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(text.slice(open + 1, end));
    at = text.indexOf(marker, end);
  }
  return calls;
}

describe("the web client validates what it is given", () => {
  it("passes a schema to every request that has one", () => {
    const calls = requestCalls(source);
    // A guard on the guard: a scan that found nothing would make this pass by vacuum.
    expect(calls.length).toBeGreaterThanOrEqual(10);

    const unvalidated = calls.filter((args) => {
      if (UNVALIDATED.some((exempt) => args.includes(exempt))) return false;
      return !/Schema\b/.test(args);
    });

    expect(unvalidated).toEqual([]);
  });
});
