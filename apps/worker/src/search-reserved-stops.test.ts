import { describe, expect, it } from "vitest";
import type { SearchHit, SearchIndexEntry } from "@busstops/contracts";
import { withReservedStops } from "./network-reader.js";

/**
 * The deployed preview answered "Leeds" with twenty results, every one of them a place, so the
 * most obvious query a visitor can type offered twenty ways to plan a journey and no departure
 * board. These hold the correction and its limits: a search that genuinely matched no stop is
 * left alone, a search already carrying stops is left alone, and the best matches are never given
 * up to make room.
 */
function entry(kind: SearchIndexEntry["kind"], id: string, title: string): SearchIndexEntry {
  return {
    kind,
    id,
    title,
    tokens: title.toLowerCase().split(/\s+/),
    codes: [],
    prominence: kind === "place" ? 40 : 0,
    hasLiveCoverage: true,
  } as unknown as SearchIndexEntry;
}

function hit(e: SearchIndexEntry, score: number): SearchHit {
  return { entry: e, score } as SearchHit;
}

const PLACES = Array.from({ length: 20 }, (_, i) => entry("place", `p${i}`, `Leeds Place ${i}`));
const STOPS = Array.from({ length: 6 }, (_, i) => entry("stop", `s${i}`, `Leeds Stop ${i}`));

describe("reserving room for stops in a search result", () => {
  it("puts stops into a result set that is otherwise all places", () => {
    const ranked = PLACES.map((place, i) => hit(place, 100 - i));
    const out = withReservedStops([...PLACES, ...STOPS], ranked, "Leeds", "now", { limit: 20 });

    expect(out).toHaveLength(20);
    const stops = out.filter((one) => one.entry.kind === "stop");
    expect(
      stops.length,
      "a town search must offer somewhere to catch a bus",
    ).toBeGreaterThanOrEqual(4);
  });

  /* The best matches are what the ranking is for; room comes from the bottom. */
  it("keeps the highest-scoring results and drops from the tail", () => {
    const ranked = PLACES.map((place, i) => hit(place, 100 - i));
    const out = withReservedStops([...PLACES, ...STOPS], ranked, "Leeds", "now", { limit: 20 });
    expect(out[0]!.entry.id).toBe("p0");
    // The places that went are the weakest ones, not the strongest.
    const ids = out.map((one) => one.entry.id);
    expect(ids).toContain("p0");
    expect(ids).not.toContain("p19");
  });

  it("leaves a result set that already has stops exactly as the ranking produced it", () => {
    const ranked = [hit(PLACES[0]!, 100), ...STOPS.slice(0, 4).map((stop, i) => hit(stop, 90 - i))];
    const out = withReservedStops([...PLACES, ...STOPS], ranked, "Leeds", "now", { limit: 20 });
    expect(out).toEqual(ranked);
  });

  /*
   * The case that must not be "corrected". A query matching no stop should return places only —
   * inventing a stop result would be worse than the problem being fixed.
   */
  it("leaves a search that matched no stop alone", () => {
    const ranked = PLACES.slice(0, 3).map((place, i) => hit(place, 100 - i));
    const out = withReservedStops(PLACES, ranked, "Leeds", "now", { limit: 20 });
    expect(out).toEqual(ranked);
  });

  it("never returns more than the limit asked for", () => {
    const ranked = PLACES.slice(0, 5).map((place, i) => hit(place, 100 - i));
    const out = withReservedStops([...PLACES, ...STOPS], ranked, "Leeds", "now", { limit: 5 });
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.filter((one) => one.entry.kind === "stop").length).toBeGreaterThan(0);
  });
});
