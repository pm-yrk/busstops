import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The inventory must read service dates from the key's date segment, not from anything date-shaped.
 *
 * A version is a timestamp, so `data/network/operators/2026-09-26T07:48:07.333Z.jsonl` contains a
 * date-shaped substring. Searching the whole key for one therefore reported the rollback artifact's
 * 2.03 GB and the live artifact's 2.29 GB as two expired *service dates* — four phantom dates and
 * 4.34 GB of phantom waste, in the report that is read to decide what is safe to delete. It was
 * caught while answering "did normal retention remove the obsolete dates?", one step before being
 * reported as a retention failure that had not happened.
 *
 * Only two families are date-keyed, and their shape is
 * `data/network/<departures|pattern-trips>/<date>/<shard>/<version>.jsonl` — the same shape
 * `prune-service-dates.ts` matches on, which is the point: an inventory that disagrees with the
 * pruner about what a service date is cannot be used to check the pruner.
 */

const SOURCE = readFileSync(
  join(new URL("../..", import.meta.url).pathname, "scripts/prove-production-dead.ts"),
  "utf8",
);

describe("the inventory's service dates", () => {
  it("matches on the dated families' key prefixes", () => {
    expect(SOURCE).toContain("data/network/departures/");
    expect(SOURCE).toContain("data/network/pattern-trips/");
  });

  it("reads the date from the segment after the prefix, anchored", () => {
    /* Anchored, so `2026-09-26T07:48:07.333Z` as a whole segment does not match either. */
    expect(SOURCE).toMatch(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
  });

  it("no longer scans the whole key for anything date-shaped", () => {
    expect(
      SOURCE,
      "an unanchored date search reads a version timestamp as a service date",
    ).not.toMatch(/\/\(\\d\{4\}-\\d\{2\}-\\d\{2\}\)\/\.exec\(object\.key\)/);
  });

  /*
   * And the shape itself, checked against the pruner rather than against this test's idea of it.
   */
  it("agrees with the pruner about which families are date-keyed", () => {
    const pruner = readFileSync(
      join(
        new URL("../..", import.meta.url).pathname,
        "pipelines/static-network/src/departures-index.ts",
      ),
      "utf8",
    );
    expect(pruner).toContain('DEPARTURES_PREFIX = "network/departures"');
    expect(pruner).toContain('PATTERN_TRIPS_PREFIX = "network/pattern-trips"');
  });
});
