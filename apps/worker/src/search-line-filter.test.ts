import { describe, expect, it } from "vitest";
import { searchLineFilter } from "./network-reader.js";

/**
 * The filter that made search survive two words.
 *
 * A published prefix bucket reaches 1,644,719 bytes, and "Leeds Station" opened several of them and
 * turned every line of every one into an object. Run 79 measured the result: Cloudflare error 1102,
 * which a browser reports as a CORS failure, so a visitor searching for a landmark got nothing.
 *
 * The filter has to be *more* generous than the ranking it feeds. A filter stricter than the ranker
 * stops reducing work and starts deciding results.
 */
describe("which index lines are worth building", () => {
  const line = (title: string, tokens: string[] = []) =>
    JSON.stringify({ kind: "stop", id: "1", title, tokens });

  it("keeps the entry the query names", () => {
    const keep = searchLineFilter(["leeds", "station"])!;
    expect(keep(line("Leeds Station"))).toBe(true);
    expect(keep(line("Leeds City Bus Station"))).toBe(true);
  });

  it("drops the rest of the bucket the prefix also holds", () => {
    const keep = searchLineFilter(["leeds"])!;
    expect(keep(line("Leicester Square"))).toBe(false);
    expect(keep(line("Lewisham Centre"))).toBe(false);
    expect(keep(line("Leyland Cross"))).toBe(false);
  });

  /*
   * Three characters, not the whole word: the ranker tolerates a misspelling and so must this, or
   * the filter would quietly overrule it.
   */
  it("still keeps a match the ranker would have forgiven", () => {
    expect(searchLineFilter(["lees"])!(line("Leeds Station"))).toBe(true);
    expect(searchLineFilter(["leedss"])!(line("Leeds Station"))).toBe(true);
  });

  it("keeps an entry that matches on a token rather than its title", () => {
    const keep = searchLineFilter(["minster"])!;
    expect(keep(line("Duncombe Place", ["york", "minster"]))).toBe(true);
  });

  it("is case-insensitive in both directions", () => {
    expect(searchLineFilter(["LEEDS"])!(line("leeds station"))).toBe(true);
    expect(searchLineFilter(["leeds"])!(line("LEEDS STATION"))).toBe(true);
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
    expect(keep(line("X1", ["x1"]))).toBe(true);
    expect(keep(line("X9", ["x9"]))).toBe(false);
  });
});
