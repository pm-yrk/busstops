import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryObjectStore, objectKeyFor } from "@busstops/pipeline-core";
import type { Coordinate } from "@busstops/contracts";
import { buildNetwork } from "./build-network.js";
import { publishNetworkShards } from "./publish-shards.js";
import {
  MAX_SEARCH_BUCKETS_PER_WORD,
  MAX_SHARD_BYTES,
  SEARCH_BUCKET_SPLIT_AT,
  assemblePatternTile,
  searchPrefixesForWord,
  patternTileDataset,
  searchPrefixDataset,
  type PatternTileLine,
} from "./shards.js";

/**
 * What a shard may weigh, and whose geometry a pattern gets.
 *
 * Both were learned from a national publish rather than reasoned about. Two shards failed: one
 * threw `Invalid string length` while being serialised, and object storage refused the other with
 * 413. Neither had passed the record cap — a record count is not a size, and the records in
 * question were enormous.
 *
 * They were enormous because a TransXChange journey pattern id is unique only inside its own
 * document. Keying shapes by it alone collapsed 48,448 national patterns onto 515 shapes, so most
 * patterns carried some other operator's geometry and every pattern sharing a key piled into the
 * same tiles. The two defects are one story, so they are tested together.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../tests/fixtures/documented");
const naptanCsv = readFileSync(join(fixtures, "naptan-stops.csv"), "utf8");
const txcXml = readFileSync(join(fixtures, "transxchange-service.xml"), "utf8");

/** The same document published by a different operator: same local ids, different service. */
function asService(code: string): string {
  return txcXml.replace(
    "<ServiceCode>PB0002032:72</ServiceCode>",
    `<ServiceCode>${code}</ServiceCode>`,
  );
}

/** The fixture timetable calls at one stop NaPTAN's sample does not carry; without it no pattern
 * survives the dangling-reference check and there is nothing to shard. */
const armley =
  "450010003,,,,Armley Road,en,Armley Rd,en,,,Armley Road,en,,,,,W,E0035477,Leeds,,,Leeds,en,,,0,U,428500,433900,-1.5600,53.7996,BCT,MKD,PTP,,,,107,2019-01-01T00:00:00,2026-01-15T09:00:00,1,rev,active";

function build(documents: string[]) {
  return buildNetwork({
    naptanCsv: `${naptanCsv.trimEnd()}\n${armley}\n`,
    transXChangeDocuments: documents,
    retrievedAt: "2026-09-02T06:00:00.000Z",
    serviceDate: "2026-09-02",
  });
}

async function publish(network: ReturnType<typeof build>) {
  const store = new InMemoryObjectStore();
  const result = await publishNetworkShards(store, network, { version: "v1" });
  return { store, result };
}

describe("shape identity", () => {
  it("gives two operators reusing the same journey pattern id their own geometry", () => {
    const network = build([asService("AAA:1"), asService("BBB:1")]);

    const withGeometry = network.patterns.filter((pattern) => network.shapes.has(pattern.shapeRef));
    expect(withGeometry.length).toBeGreaterThan(0);

    // The failure being guarded: one shape shared by patterns from unrelated services.
    const refsByService = new Map<string, Set<string>>();
    for (const pattern of withGeometry) {
      const refs = refsByService.get(pattern.serviceRouteId) ?? new Set<string>();
      refs.add(pattern.shapeRef);
      refsByService.set(pattern.serviceRouteId, refs);
    }
    expect(refsByService.size).toBe(2);

    const [first, second] = [...refsByService.values()];
    for (const ref of first!) expect(second!.has(ref)).toBe(false);
  });

  it("still shares one shape between patterns of the same route", () => {
    // The deduplication the old key was reaching for, kept. Patterns on a route differ in which
    // stops they call at, not in where the road goes, so two patterns pointing at R1 must resolve
    // to one shape rather than two copies of it.
    const twoPatterns = txcXml.replace(
      "        </JourneyPattern>\n",
      "        </JourneyPattern>\n" +
        '        <JourneyPattern id="JP2">\n' +
        "          <DirectionRef>inbound</DirectionRef>\n" +
        "          <RouteRef>R1</RouteRef>\n" +
        "          <JourneyPatternSectionRefs>JPS1</JourneyPatternSectionRefs>\n" +
        "        </JourneyPattern>\n",
    );
    const network = build([twoPatterns]);

    expect(network.patterns.length).toBe(2);
    expect(new Set(network.patterns.map((pattern) => pattern.shapeRef)).size).toBe(1);
    expect(network.shapes.size).toBe(1);
  });

  it("publishes geometry simplified and rounded rather than at survey precision", () => {
    const network = build([txcXml]);
    for (const points of network.shapes.values()) {
      for (const point of points) {
        // Five decimal places, which is a little over a metre.
        expect(Math.round(point.lat * 1e5) / 1e5).toBe(point.lat);
        expect(Math.round(point.lon * 1e5) / 1e5).toBe(point.lon);
      }
      // Rounding may not leave a repeated vertex behind: a zero-length segment is something every
      // consumer would otherwise have to guard against.
      for (let i = 1; i < points.length; i++) {
        expect(points[i]).not.toEqual(points[i - 1]);
      }
    }
  });
});

describe("shard size", () => {
  it("writes no object larger than the byte budget, whatever the record count", async () => {
    const network = build([txcXml]);

    // A route whose geometry alone is past the budget. The record cap would not notice it: this
    // is one record.
    const huge: Coordinate[] = [];
    for (let i = 0; i < 400_000; i++) {
      huge.push({ lat: 53.79 + (i % 1000) / 1e5, lon: -1.56 + (i % 997) / 1e5 });
    }
    const pattern = network.patterns[0];
    expect(pattern).toBeDefined();
    network.shapes.set(pattern!.shapeRef, huge);

    const { store, result } = await publish(network);
    expect(result.failed).toEqual([]);

    for (const key of await store.list("data/")) {
      const body = await store.get(key);
      expect(Buffer.byteLength(body ?? "", "utf8")).toBeLessThanOrEqual(MAX_SHARD_BYTES);
    }
  });

  it("reports what a full shard had to drop instead of losing it quietly", async () => {
    const network = build([txcXml]);
    const stop = network.stops[0];
    expect(stop).toBeDefined();

    // Enough stops in one tile to pass the budget. Nothing about the count says so; the bytes do.
    const padding = "x".repeat(4_000);
    for (let i = 0; i < 4_000; i++) {
      network.stops.push({ ...stop!, id: `pad-${i}`, atcoCode: `PAD${i}`, name: padding });
    }

    const { result } = await publish(network);
    expect(result.truncated.length).toBeGreaterThan(0);
    expect(result.truncated[0]!.dropped).toBeGreaterThan(0);
    // And the size of the largest shard in each family is reported, not just whether it fitted.
    expect(result.largest.some((entry) => entry.bytes > 0)).toBe(true);
  });
});

describe("search buckets", () => {
  it("splits a letter that will not fit rather than truncating it", async () => {
    /*
     * Two characters suits most of the alphabet and not all of it. Nationally "bo" held 69,659
     * entries where most buckets hold a few hundred, and truncating it lost every stop whose only
     * distinctive word began that way — which is most of a city.
     */
    const network = build([txcXml]);
    const stop = network.stops[0];
    expect(stop).toBeDefined();

    // Enough entries under one two-character prefix to force the split, spread over three third
    // characters so the result is a real division rather than a rename.
    const thirds = ["l", "u", "w"];
    for (let i = 0; i < SEARCH_BUCKET_SPLIT_AT + 60; i++) {
      network.stops.push({
        ...stop!,
        id: `bo-${i}`,
        atcoCode: `BO${i}`,
        name: `Bo${thirds[i % thirds.length]}ton Interchange ${i}`,
      });
    }

    const { result } = await publish(network);
    expect(result.index).not.toBeNull();
    const prefixes = result.index!.searchPrefixes;

    expect(prefixes).not.toContain("bo");
    for (const third of thirds) expect(prefixes).toContain(`bo${third}`);

    // And nothing was dropped to make it fit.
    expect(result.truncated.filter((entry) => entry.dataset.includes("search-prefix"))).toEqual([]);
  });

  it("keeps a stop findable by every word that reached its letter", async () => {
    /*
     * A stop called "Bolton Bond Street" reaches "bo" by two different words. Filing it under the
     * first one alone means the other word finds nothing — an empty result, not an error, which
     * is how every defect in this sharding has presented so far.
     */
    const network = build([txcXml]);
    const stop = network.stops[0];
    expect(stop).toBeDefined();

    for (let i = 0; i < SEARCH_BUCKET_SPLIT_AT + 40; i++) {
      network.stops.push({
        ...stop!,
        id: `two-words-${i}`,
        atcoCode: `TW${i}`,
        name: `Bolton Bondgate ${i}`,
      });
    }

    const { store, result } = await publish(network);
    expect(result.index).not.toBeNull();
    const published = new Set(result.index!.searchPrefixes);
    expect(published.has("bo")).toBe(false);

    // Both words resolve to a bucket, and both buckets hold the stop.
    for (const word of ["bolton", "bondgate"]) {
      const buckets = searchPrefixesForWord(word, published);
      expect(buckets.length).toBe(1);
      const body = (await store.get(objectKeyFor(searchPrefixDataset(buckets[0]!), "v1"))) ?? "";
      expect(body).toContain("Bolton Bondgate");
    }
  });

  it("sends a word to the buckets it was actually published in", () => {
    // The edge asks this rather than computing a key, because only the index knows how deep a
    // letter went. A three-letter word resolves to one object at either depth.
    const split = new Set(["bol", "bou", "bow", "pi"]);
    expect(searchPrefixesForWord("bolton", split)).toEqual(["bol"]);
    expect(searchPrefixesForWord("piccadilly", split)).toEqual(["pi"]);

    // Two characters against a split letter has no single bucket, so it reads the parts — capped,
    // because "bo" is a vague question and forty reads would be a worse answer than eight.
    const parts = searchPrefixesForWord("bo", split);
    expect(parts.sort()).toEqual(["bol", "bou", "bow"]);
    expect(parts.length).toBeLessThanOrEqual(MAX_SEARCH_BUCKETS_PER_WORD);
  });
});

describe("pattern tiles", () => {
  it("stores each shape once and puts the patterns back together on read", async () => {
    const network = build([txcXml]);
    const { store, result } = await publish(network);
    expect(result.index).not.toBeNull();

    const tile = result.index!.patternTiles[0];
    expect(tile).toBeDefined();

    const body = (await store.get(objectKeyFor(patternTileDataset(tile!), "v1"))) ?? "";
    const lines = body
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as PatternTileLine);

    const shapeLines = lines.filter((line) => line.kind === "shape");
    const refs = new Set(shapeLines.map((line) => line.shapeRef));
    expect(shapeLines.length).toBe(refs.size);

    const records = assemblePatternTile(lines);
    expect(records.length).toBe(lines.length - shapeLines.length);
    for (const record of records) expect(record.shape.length).toBeGreaterThanOrEqual(2);
  });

  it("never separates a pattern from its geometry when a tile is cut short", () => {
    // The write order is what makes truncation safe, so it is asserted directly: every pattern
    // line is preceded somewhere earlier in the shard by the shape it names.
    const lines: PatternTileLine[] = [
      {
        kind: "shape",
        shapeRef: "a",
        points: [
          { lat: 1, lon: 1 },
          { lat: 2, lon: 2 },
        ],
      },
      {
        kind: "pattern",
        // Only the fields assembly reads matter here.
        pattern: { id: "p1", shapeRef: "a" } as never,
        shapeRef: "a",
        stopDistancesMetres: [0, 10],
      },
      {
        kind: "shape",
        shapeRef: "b",
        points: [
          { lat: 3, lon: 3 },
          { lat: 4, lon: 4 },
        ],
      },
    ];

    for (let cut = 0; cut <= lines.length; cut++) {
      for (const record of assemblePatternTile(lines.slice(0, cut))) {
        expect(record.shape.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
