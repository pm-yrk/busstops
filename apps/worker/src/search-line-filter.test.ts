import { tokenize } from "@busstops/pipeline-static-network";
import { describe, expect, it } from "vitest";
import { searchLineFilter } from "./network-reader.js";

/**
 * The filter that decides which index lines become objects.
 *
 * A published prefix bucket reaches 1,644,719 bytes and "Leeds Station" opened several of them,
 * turning every line of every one into an object. The filter tests the raw text instead — and
 * deliberately does *not* lowercase the line, because lowercasing allocates a copy of it and six
 * thousand copies cost more than the parse being avoided. That is sound only because every entry's
 * `tokens` are built by `tokenize`, which lowercases. These fixtures are built with the real
 * `tokenize`, so if the pipeline ever stops lowercasing, this fails rather than search quietly
 * losing results.
 *
 * The filter has to be *more* generous than the ranking it feeds: a filter stricter than the ranker
 * stops reducing work and starts deciding results.
 */
function line(title: string, extra: string[] = []): string {
  return JSON.stringify({
    kind: "stop",
    id: "1",
    title,
    tokens: [...new Set([...tokenize(title), ...extra.flatMap(tokenize)])],
  });
}

describe("which index lines are worth building", () => {
  it("keeps the entry the query names, whatever case its title is in", () => {
    const keep = searchLineFilter(["leeds", "station"])!;
    expect(keep(line("Leeds Station"))).toBe(true);
    expect(keep(line("LEEDS CITY BUS STATION"))).toBe(true);
    expect(keep(line("leeds station"))).toBe(true);
  });

  it("drops the rest of the bucket the prefix also holds", () => {
    const keep = searchLineFilter(["leeds"])!;
    expect(keep(line("Leicester Square"))).toBe(false);
    expect(keep(line("Lewisham Centre"))).toBe(false);
    expect(keep(line("Leyland Cross"))).toBe(false);
  });

  it("still keeps a match the ranker would have forgiven", () => {
    expect(searchLineFilter(["lees"])!(line("Leeds Station"))).toBe(true);
    expect(searchLineFilter(["leedss"])!(line("Leeds Station"))).toBe(true);
    expect(searchLineFilter(["LEEDS"])!(line("Leeds Station"))).toBe(true);
  });

  it("keeps an entry that matches on a token rather than its title", () => {
    const keep = searchLineFilter(["minster"])!;
    expect(keep(line("Duncombe Place", ["York Minster"]))).toBe(true);
  });

  /*
   * Nothing to narrow by means no filter, not an empty bucket. Narrowing on one letter would drop
   * the bucket's contents for a query that had not yet said anything.
   */
  it("declines to filter when there is nothing to filter on", () => {
    expect(searchLineFilter(["y"])).toBeUndefined();
    expect(searchLineFilter([])).toBeUndefined();
  });

  it("keeps a short route code whole", () => {
    const keep = searchLineFilter(["x1"])!;
    expect(keep(line("X1"))).toBe(true);
    expect(keep(line("X9"))).toBe(false);
  });

  /*
   * The dependency this rests on, stated as a test rather than as a comment: the published tokens
   * are lowercase, so a lowercase stem matches the text as published.
   */
  it("rests on the pipeline publishing lowercase tokens", () => {
    expect(tokenize("Leeds Station")).toEqual(["leeds", "station"]);
  });
});
