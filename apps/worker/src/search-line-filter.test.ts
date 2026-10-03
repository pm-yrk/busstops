import { tokenize } from "@busstops/pipeline-static-network";
import { describe, expect, it } from "vitest";
import { searchLineFilter } from "./network-reader.js";

/**
 * The filter that decides which index lines become objects.
 *
 * A published prefix bucket reaches 5.1 MiB and "Leeds Station" opens several of them, turning
 * every line of every one into an object. The filter tests the raw text instead — and deliberately
 * does *not* lowercase the line, because lowercasing allocates a copy of it and twenty thousand
 * copies cost more than the parse being avoided. That is sound only because every entry's `tokens`
 * are built by `tokenize`, which lowercases. These fixtures are built with the real `tokenize`, so
 * if the pipeline ever stops lowercasing, this fails rather than search quietly losing results.
 *
 * The filter has to be *more* generous than the ranking it feeds: a filter stricter than the ranker
 * stops reducing work and starts deciding results.
 *
 * **Why this file is called with three arguments.** The filter is a `LineFilter` — `(body, start,
 * end)` — and the test used to call it with one. That was not a convenience: the filter genuinely
 * took one parameter, and the reader passed it where a three-parameter one was expected, which
 * TypeScript accepts. At run time it received the *whole object body* as its "line", so the stem
 * test was "does this stem occur anywhere in five mebibytes", which for any real query it does.
 * The filter kept every line and search parsed every bucket in full. The test passed throughout,
 * because it was the only caller passing a single line. So every case here is applied through a
 * body of several lines, with the ranges the reader actually uses.
 */

/** Join lines into a body and give each one's range, exactly as `readShardSized` walks it. */
function body(...lines: string[]): { text: string; ranges: Array<[number, number]> } {
  const text = lines.join("\n");
  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (const entry of lines) {
    ranges.push([start, start + entry.length]);
    start += entry.length + 1;
  }
  return { text, ranges };
}

/** Which of a body's lines the filter keeps, by index. */
function kept(
  filter: ReturnType<typeof searchLineFilter>,
  made: ReturnType<typeof body>,
): number[] {
  if (!filter) throw new Error("the filter declined, which this case does not expect");
  return made.ranges
    .map(([start, end], index) => (filter(made.text, start, end) ? index : -1))
    .filter((index) => index >= 0);
}
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
    const made = body(line("Leeds Station"), line("LEEDS CITY BUS STATION"), line("leeds station"));
    expect(kept(searchLineFilter(["leeds", "station"]), made)).toEqual([0, 1, 2]);
  });

  it("drops the rest of the bucket the prefix also holds", () => {
    const made = body(line("Leicester Square"), line("Lewisham Centre"), line("Leyland Cross"));
    expect(kept(searchLineFilter(["leeds"]), made)).toEqual([]);
  });

  /*
   * The case the broken signature could not fail. One line in the bucket matches and the others do
   * not; a filter handed the whole body sees the match and keeps all three.
   */
  it("keeps only the line that matches, not every line in the same object", () => {
    const made = body(line("Leicester Square"), line("Leeds Station"), line("Lewisham Centre"));
    expect(kept(searchLineFilter(["leeds"]), made)).toEqual([1]);
  });

  it("does not take a match from the line after it", () => {
    const made = body(line("Leicester Square"), line("Leeds Station"));
    const filter = searchLineFilter(["leeds"])!;
    const [start, end] = made.ranges[0]!;
    expect(filter(made.text, start, end)).toBe(false);
  });

  it("still keeps a match the ranker would have forgiven", () => {
    const made = body(line("Leeds Station"));
    expect(kept(searchLineFilter(["lees"]), made)).toEqual([0]);
    expect(kept(searchLineFilter(["leedss"]), made)).toEqual([0]);
    expect(kept(searchLineFilter(["LEEDS"]), made)).toEqual([0]);
  });

  it("keeps an entry that matches on a token rather than its title", () => {
    const made = body(line("Duncombe Place", ["York Minster"]));
    expect(kept(searchLineFilter(["minster"]), made)).toEqual([0]);
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
    const made = body(line("X1"), line("X9"));
    expect(kept(searchLineFilter(["x1"]), made)).toEqual([0]);
  });

  /*
   * The dependency this rests on, stated as a test rather than as a comment: the published tokens
   * are lowercase, so a lowercase stem matches the text as published.
   */
  it("rests on the pipeline publishing lowercase tokens", () => {
    expect(tokenize("Leeds Station")).toEqual(["leeds", "station"]);
  });
});
