import { describe, expect, it } from "vitest";
import { searchIndex, tokenize, type SearchIndex, type SearchIndexEntry } from "./search-index.js";

/**
 * The Bullring, which was in the gazetteer the whole time.
 *
 * Run 54's places report lists Birmingham's twelve shopping centres in full and `Bull Ring
 * (shopping)` is among them. OSM writes the name open, passengers write it closed, and tokenised
 * those share no token — so the place scored zero and five runs went looking for it in the
 * extraction, the bounding box and the ranker in turn.
 */
describe("a compound name written open in one place and closed in the other", () => {
  function place(name: string): SearchIndexEntry {
    return {
      kind: "place",
      id: name,
      title: name,
      tokens: tokenize(name),
      codes: [],
      hasLiveCoverage: false,
      prominence: 7,
    };
  }

  const index: SearchIndex = {
    builtAt: "2026-01-01T00:00:00.000Z",
    entries: [place("Bull Ring"), place("Grand Central"), place("Selfridges")],
  };

  it("finds Bull Ring when the query is Bullring", () => {
    const [top] = searchIndex(index, "Bullring", { limit: 3 });
    expect(top?.entry.title).toBe("Bull Ring");
  });

  it("finds it the other way round too", () => {
    const closed: SearchIndex = {
      builtAt: index.builtAt,
      entries: [place("Bullring"), place("Selfridges")],
    };
    const [top] = searchIndex(closed, "Bull Ring", { limit: 3 });
    expect(top?.entry.title).toBe("Bullring");
  });

  it("still finds it spelled the way it is filed", () => {
    const [top] = searchIndex(index, "Bull Ring", { limit: 3 });
    expect(top?.entry.title).toBe("Bull Ring");
  });

  it("does not make everything match everything", () => {
    expect(searchIndex(index, "Arndale", { limit: 3 })).toEqual([]);
  });

  it("does not let a squashed query run past the name it belongs to", () => {
    /*
     * "Bull Ringway" does reach "Bull Ring", and always did: the two share the token "bull", and
     * partial token credit is long-standing behaviour rather than anything this change introduced.
     * What matters is that the squash branch stays out of it — 1 of 2 tokens is 12.5, plus 7 for
     * prominence, and nothing else. A squashed hit would add 15 at the very least.
     */
    const [top] = searchIndex(index, "Bull Ringway", { limit: 3 });
    expect(top?.entry.title).toBe("Bull Ring");
    expect(top?.score).toBeCloseTo(19.5, 5);
  });

  it("leaves an ordinary spaced match scoring exactly as it did", () => {
    const [top] = searchIndex(index, "Grand Central", { limit: 3 });
    expect(top?.entry.title).toBe("Grand Central");
    // 60 for the exact title, 25 for both tokens, 7 for prominence. The squash branch is only
    // reached when the spaced comparison found nothing, so it cannot have contributed here.
    expect(top?.score).toBe(92);
  });
});
