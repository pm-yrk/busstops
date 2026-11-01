import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ArtifactStore,
  InMemoryObjectStore,
  objectKeyFor,
  objectKeyForBytes,
} from "@busstops/pipeline-core";
import {
  PATTERN_INDEX_PREFIX,
  SHARDED,
  buildNetwork,
  encodePatternStops,
  journeyPatternStopsDataset,
  patternIndexTileDataset,
  publishNetworkShards,
  type NetworkIndexRecord,
  type PatternIndexRow,
  type PatternStopSequence,
} from "@busstops/pipeline-static-network";
import { NetworkReader } from "./network-reader.js";
import { ReadLedger } from "./read-ledger.js";

/**
 * The published pattern-stop projection, held to the text index it is a projection of.
 *
 * A journey finds its patterns by reading every line of every pattern index tile its corridor
 * crosses: 2,098,153 of a request's 2,316,100 decoded characters, 5,123 lines scanned to keep
 * 1,090. The projection is the same patterns in a keyed form, so the only thing that matters is
 * that a plan built on it is the same plan: the same ids, the same service routes, the same stop
 * sequences in the same order. A projection that disagreed with the index would route passengers
 * through stops the bus does not call at, and would do it without a single test failing anywhere
 * else — which is why the equivalence is asserted against the published text directly.
 *
 * The second thing asserted is that the text index is *not* read when the projection answers. A
 * form that is read alongside the one it replaces is not an optimisation, and the layover tests
 * on the trip shards were passing for exactly that reason until each store was made to carry one
 * form only. So the fixtures here are deliberately one-sided: projection without text where the
 * projection is meant to win, text without projection where the fallback is meant to.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../tests/fixtures/documented");
const naptanCsv = readFileSync(join(fixtures, "naptan-stops.csv"), "utf8");
const txcXml = readFileSync(join(fixtures, "transxchange-service.xml"), "utf8");

function network() {
  /* The same extra stop the isolate-memory fixtures add: without it the fixture's patterns have no
   * shape, and a pattern with no shape is not filed in a pattern index tile at all. */
  const armley =
    "450010003,,,,Armley Road,en,Armley Rd,en,,,Armley Road,en,,,,,W,E0035477,Leeds,,,Leeds,en,,,0,U,428500,433900,-1.5600,53.7996,BCT,MKD,PTP,,,,107,2019-01-01T00:00:00,2026-01-15T09:00:00,1,rev,active";
  return buildNetwork({
    naptanCsv: `${naptanCsv.trimEnd()}\n${armley}\n`,
    transXChangeDocuments: [txcXml],
    retrievedAt: "2026-09-02T06:00:00.000Z",
    serviceDate: "2026-09-02",
  });
}

/** A store that records what was read, by text key and by byte key separately. */
function recordingStore() {
  const inner = new InMemoryObjectStore();
  const textReads: string[] = [];
  const byteReads: string[] = [];
  return {
    textReads,
    byteReads,
    inner,
    store: {
      async get(key: string) {
        textReads.push(key);
        return inner.get(key);
      },
      async getBytes(key: string) {
        byteReads.push(key);
        return inner.getBytes(key);
      },
      put: inner.put.bind(inner),
      putBytes: inner.putBytes.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
      listDetailed: inner.listDetailed?.bind(inner),
    },
  };
}

interface Published {
  version: string;
  tiles: string[];
  /** Every pattern in the published text index, by tile, exactly as the publisher wrote it. */
  patternsByTile: Map<string, PatternStopSequence[]>;
}

/** Publish the fixture network's text artifacts and read back what its pattern index holds. */
async function publishText(store: InMemoryObjectStore): Promise<Published> {
  await publishNetworkShards(store, network(), { version: "v1" });
  const index = (await new ArtifactStore(store).readCurrent<NetworkIndexRecord>(SHARDED.index))
    .records[0];
  if (!index) throw new Error("the fixture published no index");
  const tiles = index.patternIndexTiles ?? [];
  const patternsByTile = new Map<string, PatternStopSequence[]>();
  for (const tile of tiles) {
    const body = await store.get(objectKeyFor(patternIndexTileDataset(tile), index.version));
    if (body === null) continue;
    const patterns: PatternStopSequence[] = [];
    for (const line of body.split("\n")) {
      if (line.length === 0 || !line.startsWith("[")) continue;
      const row = JSON.parse(line) as [string, PatternIndexRow];
      patterns.push({
        id: row[1].id,
        serviceRouteId: row[1].serviceRouteId,
        stopSequence: row[1].stopSequence,
      });
    }
    if (patterns.length > 0) patternsByTile.set(tile, patterns);
  }
  if (patternsByTile.size === 0) throw new Error("the fixture published no patterns");
  return { version: index.version, tiles, patternsByTile };
}

/** Write the projection for these tiles, and optionally drop the text index they came from. */
async function publishProjection(
  store: InMemoryObjectStore,
  published: Published,
  options: { tiles?: readonly string[]; withoutText?: boolean } = {},
): Promise<void> {
  const chosen = options.tiles ?? [...published.patternsByTile.keys()];
  for (const tile of chosen) {
    const patterns = published.patternsByTile.get(tile);
    if (!patterns) continue;
    await store.putBytes(
      objectKeyForBytes(journeyPatternStopsDataset(tile), published.version),
      encodePatternStops(patterns).bytes,
    );
  }
  if (options.withoutText !== true) return;
  for (const tile of chosen) {
    await store.delete(objectKeyFor(patternIndexTileDataset(tile), published.version));
  }
}

function everyPattern(published: Published): PatternStopSequence[] {
  return [...published.patternsByTile.values()].flat();
}

const sorted = (patterns: Iterable<{ id: string }>): string[] =>
  [...patterns].map((pattern) => pattern.id).sort();

describe("reading a corridor's patterns out of the published projection", () => {
  it("answers the ids a corridor named, with the same patterns the text index holds", async () => {
    const plain = new InMemoryObjectStore();
    const published = await publishText(plain);
    const wanted = everyPattern(published);

    /* The text answer, from a store that has no projection at all: the oracle. */
    const fromText = await new NetworkReader(plain).patternsInIndexTiles(
      published.tiles,
      Date.now(),
      undefined,
      undefined,
      wanted.map((pattern) => pattern.id),
    );

    /* The projection answer, from a store whose text index for those tiles is gone. */
    const recording = recordingStore();
    const projected = await publishText(recording.inner);
    await publishProjection(recording.inner, projected, { withoutText: true });
    recording.textReads.length = 0;
    const ledger = new ReadLedger(5_000_000);
    const fromBytes = await new NetworkReader(recording.store).patternsInIndexTiles(
      projected.tiles,
      Date.now(),
      ledger,
      undefined,
      wanted.map((pattern) => pattern.id),
    );

    expect(fromBytes.available).toBe(true);
    expect(fromBytes.complete).toBe(true);
    expect(sorted(fromBytes.patterns.values())).toEqual(sorted(fromText.patterns.values()));
    for (const [id, pattern] of fromText.patterns) {
      const mine = fromBytes.patterns.get(id);
      expect(mine).toBeDefined();
      expect(mine!.serviceRouteId).toBe(pattern.serviceRouteId);
      expect(mine!.stopSequence).toEqual(pattern.stopSequence);
    }
    expect(fromBytes.patterns.size).toBeGreaterThan(0);
    expect(ledger.toJSON().counts.patternsProjected).toBe(fromBytes.patterns.size);
  });

  it("does not read the text pattern index when the projection answered", async () => {
    const recording = recordingStore();
    const published = await publishText(recording.inner);
    await publishProjection(recording.inner, published);
    recording.textReads.length = 0;

    const ledger = new ReadLedger(5_000_000);
    const result = await new NetworkReader(recording.store).patternsInIndexTiles(
      published.tiles,
      Date.now(),
      ledger,
      undefined,
      everyPattern(published).map((pattern) => pattern.id),
    );

    expect(result.patterns.size).toBe(everyPattern(published).length);
    /* The point of the family: the tile is opened as bytes and its text is never touched. */
    const text = recording.textReads.filter((key) => key.includes(PATTERN_INDEX_PREFIX));
    expect(text).toEqual([]);
    expect(recording.byteReads.some((key) => key.includes(SHARDED.journeyPatternStops))).toBe(true);
    const counts = ledger.toJSON().counts;
    expect(counts.patternStopTiles).toBeGreaterThan(0);
    expect(counts.patternStopTilesMissing).toBe(0);
    expect(counts.patternStopBytes).toBeGreaterThan(0);
  });

  it("skips the text scan although a named pattern is in none of the tiles", async () => {
    /*
     * The rule that decides whether this family buys anything.
     *
     * A corridor's trips can name a pattern whose shape runs outside the corridor's own tiles —
     * the planner already reports those as trips without a pattern — so a reader that fell back
     * whenever an id was still missing would read the whole text index on most requests and save
     * nothing. A published tile holds every pattern its text tile holds, so having opened every
     * tile is having seen everything the scan could find, including nothing for that id.
     */
    const recording = recordingStore();
    const published = await publishText(recording.inner);
    await publishProjection(recording.inner, published);
    recording.textReads.length = 0;

    const named = [
      ...everyPattern(published).map((pattern) => pattern.id),
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ];
    const result = await new NetworkReader(recording.store).patternsInIndexTiles(
      published.tiles,
      Date.now(),
      new ReadLedger(5_000_000),
      undefined,
      named,
    );

    expect(result.complete).toBe(true);
    expect(result.patterns.has("ffffffff-ffff-4fff-8fff-ffffffffffff")).toBe(false);
    expect(sorted(result.patterns.values())).toEqual(sorted(everyPattern(published)));
    expect(recording.textReads.filter((key) => key.includes(PATTERN_INDEX_PREFIX))).toEqual([]);
  });

  it("falls back to the text index when the projection has not been published", async () => {
    const recording = recordingStore();
    const published = await publishText(recording.inner);
    const ledger = new ReadLedger(5_000_000);

    const result = await new NetworkReader(recording.store).patternsInIndexTiles(
      published.tiles,
      Date.now(),
      ledger,
      undefined,
      everyPattern(published).map((pattern) => pattern.id),
    );

    expect(result.available).toBe(true);
    expect(result.complete).toBe(true);
    expect(sorted(result.patterns.values())).toEqual(sorted(everyPattern(published)));
    expect(ledger.toJSON().counts.patternsProjected ?? 0).toBe(0);
    expect(recording.textReads.some((key) => key.includes(PATTERN_INDEX_PREFIX))).toBe(true);
  });

  it("answers from a half-published family by reading the text only for what is left", async () => {
    const recording = recordingStore();
    const published = await publishText(recording.inner);
    const tiles = [...published.patternsByTile.keys()];
    if (tiles.length < 2) {
      /* The fixture is one tile, so the half-published case is made by withholding its only one. */
      await publishProjection(recording.inner, published, { tiles: [] });
    } else {
      await publishProjection(recording.inner, published, { tiles: tiles.slice(1) });
    }

    const ledger = new ReadLedger(5_000_000);
    const result = await new NetworkReader(recording.store).patternsInIndexTiles(
      published.tiles,
      Date.now(),
      ledger,
      undefined,
      everyPattern(published).map((pattern) => pattern.id),
    );

    /* A missing tile must cost patterns nothing: the answer is whole either way. */
    expect(result.complete).toBe(true);
    expect(sorted(result.patterns.values())).toEqual(sorted(everyPattern(published)));
  });

  it("stops asking for a family that is not there, after three misses with no hit", async () => {
    const recording = recordingStore();
    const published = await publishText(recording.inner);
    const reader = new NetworkReader(recording.store);
    const ids = everyPattern(published).map((pattern) => pattern.id);

    for (let request = 0; request < 6; request += 1) {
      await reader.patternsInIndexTiles(published.tiles, Date.now(), undefined, undefined, ids);
    }

    /*
     * A 404 per corridor tile per request, forever, is what an unpublished family would otherwise
     * cost — on Workers Free an invocation gets fifty subrequests, so the probe has to give up.
     */
    const probes = recording.byteReads.filter((key) =>
      key.includes(SHARDED.journeyPatternStops),
    ).length;
    expect(probes).toBeGreaterThan(0);
    expect(probes).toBeLessThanOrEqual(3);
  });

  it("drops the tiles it holds when the published version moves", async () => {
    const recording = recordingStore();
    const published = await publishText(recording.inner);
    await publishProjection(recording.inner, published);
    const reader = new NetworkReader(recording.store);
    const ids = everyPattern(published).map((pattern) => pattern.id);

    const first = await reader.patternsInIndexTiles(
      published.tiles,
      Date.now(),
      undefined,
      undefined,
      ids,
    );
    expect(first.patterns.size).toBe(ids.length);

    /* The same network at a new version: nothing held for v1 may answer for v2. */
    await publishNetworkShards(recording.inner, network(), { version: "v2" });
    recording.byteReads.length = 0;
    const second = await reader.patternsInIndexTiles(
      published.tiles,
      Date.now() + 60 * 60 * 1000,
      undefined,
      undefined,
      ids,
    );
    expect(sorted(second.patterns.values())).toEqual(sorted(everyPattern(published)));
    expect(recording.byteReads.every((key) => !key.includes("/v1."))).toBe(true);
  });
});
