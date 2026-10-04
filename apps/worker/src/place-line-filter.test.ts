import { describe, expect, it } from "vitest";
import { placeLineFilter, searchLineFilter } from "./network-reader.js";

/**
 * Which gazetteer lines become objects, and the five landmarks that decide it.
 *
 * Run 82 filtered the gazetteer with a lowercase stem and lost three of the five landmarks the
 * deployed check asks for — Manchester Arndale, Bullring and Bristol Temple Meads — so the filter
 * was removed and all 3,178 places were parsed on whichever request searched first. `places=3178`
 * was then resident in every isolate that answered error 1102 across runs 90 to 96.
 *
 * The diagnosis was wrong, and that is the thing worth keeping. A **stop**'s search entry is
 * published with `tokens` built by `tokenize`, which lowercases, so a lowercase stem matches that
 * text as it stands. A **place** is published as a `PlaceRecord`: its searchable words are `name`
 * and `subtitle`, in the case a cartographer wrote them. "man" does not occur in "Manchester
 * Arndale". So the filter tests each stem in both forms a Title Case name can present it.
 *
 * These five names are the deployed check's own list, kept here so the regression cannot come back
 * quietly — it would come back as a failure in this file instead of as three missing landmarks in
 * a run forty minutes long.
 */

/** A published place line, in the shape and the casing the pipeline actually writes. */
function place(name: string, subtitle: string): string {
  return JSON.stringify({
    // Not derived from the name: the pipeline files a place by its OSM identity, and an id that
    // happened to be a lowercased copy of the name would make the stop-style filter look fine.
    id: `place:node:${String(name.length * 7919)}`,
    name,
    kind: "station",
    coordinate: { lat: 53.8, lon: -1.5 },
    subtitle,
    prominence: 5,
    osmId: "node/1",
  });
}

const GAZETTEER = [
  place("York Minster", "Cathedral in York"),
  place("Leeds Station", "Railway station in Leeds"),
  place("Manchester Arndale", "Shopping centre in Manchester"),
  place("Bull Ring", "Shopping centre in Birmingham"),
  place("Bristol Temple Meads", "Railway station in Bristol"),
  place("Hyde Park Corner", "Junction in Leeds"),
];

/** The names the filter keeps for a query, as the reader applies it: one line at a time. */
function kept(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const filter = placeLineFilter(words);
  return GAZETTEER.filter((line) => !filter || filter(line, 0, line.length)).map(
    (line) => (JSON.parse(line) as { name: string }).name,
  );
}

describe("the five landmarks the deployed check asks for", () => {
  it("keeps each one for the words a passenger types", () => {
    expect(kept("York Minster")).toContain("York Minster");
    expect(kept("Leeds Station")).toContain("Leeds Station");
    expect(kept("Manchester Arndale")).toContain("Manchester Arndale");
    expect(kept("Bullring")).toContain("Bull Ring");
    expect(kept("Bristol Temple Meads")).toContain("Bristol Temple Meads");
  });

  it("keeps them typed in lower case, which is how they are typed", () => {
    expect(kept("york minster")).toContain("York Minster");
    expect(kept("manchester arndale")).toContain("Manchester Arndale");
    expect(kept("bristol temple meads")).toContain("Bristol Temple Meads");
  });

  /*
   * The exact case that broke run 82, asserted on its own so the reason is legible: a lowercase
   * stem against a capitalised name. The stop filter is the one that may assume lowercase text,
   * and here it is shown failing on the same line, which is why the two are separate functions.
   */
  it("is why the stop filter cannot be used on a place", () => {
    const arndale = GAZETTEER[2]!;
    const stopStyle = searchLineFilter(["manchester", "arndale"])!;
    expect(stopStyle(arndale, 0, arndale.length)).toBe(false);

    const placeStyle = placeLineFilter(["manchester", "arndale"])!;
    expect(placeStyle(arndale, 0, arndale.length)).toBe(true);
  });

  it("does narrow, which is the point of having it at all", () => {
    /*
     * Narrows, and is deliberately generous about it — the filter has to be looser than the
     * ranking it feeds, or it stops reducing work and starts deciding results. "minster" is
     * tested as its first three characters, and "min" also occurs in "Bir*min*gham", so the Bull
     * Ring's subtitle survives the filter and the ranker puts it nowhere. That is the design
     * working, not a leak: keeping one extra candidate costs a parse, dropping the right one
     * costs the answer.
     */
    expect(kept("minster")).toContain("York Minster");
    expect(kept("minster").length).toBeLessThan(GAZETTEER.length);

    // A stem that collides with nothing narrows all the way.
    expect(kept("arndale")).toEqual(["Manchester Arndale"]);
    expect(kept("temple meads")).toEqual(["Bristol Temple Meads"]);
  });

  it("matches a word the subtitle supplies rather than the name", () => {
    expect(kept("cathedral")).toContain("York Minster");
  });

  /*
   * Nothing to narrow by means every landmark is a candidate, not none. Narrowing on one letter
   * would drop the gazetteer for a query that had not yet said anything — the same rule the stop
   * index follows.
   */
  it("declines to filter when there is nothing to filter on", () => {
    expect(placeLineFilter(["y"])).toBeUndefined();
    expect(placeLineFilter([])).toBeUndefined();
    expect(kept("y")).toHaveLength(GAZETTEER.length);
  });
});
