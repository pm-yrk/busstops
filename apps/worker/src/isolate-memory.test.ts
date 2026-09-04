import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryObjectStore } from "@busstops/pipeline-core";
import {
  DATASETS,
  SHARDED,
  buildNetwork,
  publishNetworkShards,
} from "@busstops/pipeline-static-network";
import { NetworkReader } from "./network-reader.js";

/**
 * Guards against the national network returning to the isolate.
 *
 * This is the defect these tests exist for, measured against real published data: journeys
 * 292 MiB, stops 198 MiB, patterns 100 MiB and the search index 87 MiB, against a Cloudflare
 * Workers isolate of 128 MiB. Every endpoint that loaded the snapshot answered 500 in production
 * while every server-side test passed, because the fixtures were small enough to fit.
 *
 * So size alone cannot be the test. What is asserted instead is the *shape* of the access: which
 * keys the edge reads, that a viewport reads only its own tiles, and that the read cache is
 * bounded. A change that reintroduced a national read would fail here on a tiny fixture.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../tests/fixtures/documented");
const naptanCsv = readFileSync(join(fixtures, "naptan-stops.csv"), "utf8");
const txcXml = readFileSync(join(fixtures, "transxchange-service.xml"), "utf8");

/** Datasets whose national object the edge must never open. */
const NATIONAL_ONLY = [DATASETS.stops, DATASETS.patterns, DATASETS.journeys, DATASETS.searchIndex];

/** Records a Worker isolate may legitimately hold nationally, and how many. */
const NATIONAL_ALLOWANCES: Array<{ dataset: string; maxRecords: number; why: string }> = [
  { dataset: DATASETS.operators, maxRecords: 5_000, why: "22 operators nationally" },
  { dataset: DATASETS.services, maxRecords: 50_000, why: "1,043 services nationally" },
  { dataset: SHARDED.routeTiles, maxRecords: 50_000, why: "one row per service" },
  { dataset: SHARDED.index, maxRecords: 10, why: "one version pointer" },
];

function network() {
  const armley =
    "450010003,,,,Armley Road,en,Armley Rd,en,,,Armley Road,en,,,,,W,E0035477,Leeds,,,Leeds,en,,,0,U,428500,433900,-1.5600,53.7996,BCT,MKD,PTP,,,,107,2019-01-01T00:00:00,2026-01-15T09:00:00,1,rev,active";
  return buildNetwork({
    naptanCsv: `${naptanCsv.trimEnd()}\n${armley}\n`,
    transXChangeDocuments: [txcXml],
    retrievedAt: "2026-09-02T06:00:00.000Z",
    serviceDate: "2026-09-02",
  });
}

/** An object store that remembers every key read, so a test can assert on access rather than size. */
function recordingStore() {
  const inner = new InMemoryObjectStore();
  const reads: string[] = [];
  return {
    reads,
    store: {
      async get(key: string) {
        reads.push(key);
        return inner.get(key);
      },
      put: inner.put.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
      listDetailed: inner.listDetailed?.bind(inner),
      inner,
    },
  };
}

async function publishedReader() {
  const recording = recordingStore();
  await publishNetworkShards(recording.store, network(), { version: "v1" });
  return { reader: new NetworkReader(recording.store), reads: recording.reads };
}

describe("the edge never reads a national dataset", () => {
  it("serves a viewport without opening the national stop, pattern or search objects", async () => {
    const { reader, reads } = await publishedReader();
    reads.length = 0;

    await reader.stopsInBoundingBox({ west: -1.7, south: 53.7, east: -1.4, north: 53.9 }, 400);

    expect(reads.length).toBeGreaterThan(0);
    for (const dataset of NATIONAL_ONLY) {
      expect(reads.filter((key) => key.includes(`/${dataset}/`))).toEqual([]);
    }
  });

  it("resolves a stop by id without opening the national stop object", async () => {
    const { reader, reads } = await publishedReader();
    const inViewport = await reader.stopsInBoundingBox(
      { west: -2, south: 53.5, east: -1.2, north: 54 },
      400,
    );
    const target = inViewport.stops[0];
    expect(target).toBeDefined();

    reads.length = 0;
    const found = await reader.stopByKey(target!.id);
    expect(found?.id).toBe(target!.id);
    for (const dataset of NATIONAL_ONLY) {
      expect(reads.filter((key) => key.includes(`/${dataset}/`))).toEqual([]);
    }
  });

  it("searches without opening the national search index", async () => {
    const { reader, reads } = await publishedReader();
    reads.length = 0;

    const found = await reader.search("Armley", { limit: 10 });
    expect(found).not.toBeNull();
    expect(reads.filter((key) => key.includes(`/${DATASETS.searchIndex}/`))).toEqual([]);
    // It read prefix buckets, not everything: a search that opened every bucket would be the
    // national index wearing a different filename.
    expect(reads.filter((key) => key.includes(SHARDED.searchPrefix)).length).toBeLessThan(5);
  });

  it("finds a stop and its routes at their own coordinates", async () => {
    /*
     * The grids are per family now — stops on a quarter degree, patterns on an eighth, journeys
     * still on the half degree they were published with — because a national publish had to drop
     * 230 London stops and 10,013 West Yorkshire patterns to fit one size to all of them. Two
     * grids means two chances to disagree, and a publisher and a reader that disagree produce
     * empty results rather than an error. So this asks for a stop at the coordinate it is
     * actually at, and the patterns that call there.
     */
    const { reader } = await publishedReader();
    const built = network();
    const stop = built.stops.find((candidate) =>
      built.patterns.some((pattern) => pattern.stopSequence.includes(candidate.id)),
    );
    expect(stop).toBeDefined();

    const { lat, lon } = stop!.locationCoordinate;
    const box = { west: lon - 0.01, east: lon + 0.01, south: lat - 0.01, north: lat + 0.01 };

    const viewport = await reader.stopsInBoundingBox(box, 400);
    expect(viewport.stops.map((s) => s.id)).toContain(stop!.id);

    const serving = await reader.patternsServingStop(stop!);
    expect(serving.length).toBeGreaterThan(0);
  });

  it("reads only the tiles a viewport covers, not every published tile", async () => {
    const { reader, reads } = await publishedReader();
    const index = await reader.networkIndex();
    expect(index).not.toBeNull();

    reads.length = 0;
    // A viewport over one tile must not pull its neighbours in with it.
    await reader.stopsInBoundingBox({ west: -1.55, south: 53.79, east: -1.54, north: 53.8 }, 400);
    const stopTileReads = reads.filter((key) => key.includes(SHARDED.stopTile));
    expect(stopTileReads.length).toBeLessThanOrEqual(4);
  });
});

describe("national datasets the edge does still hold", () => {
  it("are the only ones allowed, and each is small enough to be safe", async () => {
    /*
     * Operators and services are small enough to hold whole — 22 and 1,043 records — and holding
     * them saves a lookup on every route and stop page. The allowances are generous multiples of
     * the real figures, so they catch a dataset that has changed character rather than one that
     * has merely grown a little.
     */
    const store = new InMemoryObjectStore();
    await publishNetworkShards(store, network(), { version: "v1" });

    for (const allowance of NATIONAL_ALLOWANCES) {
      expect(allowance.maxRecords, allowance.why).toBeGreaterThan(0);
    }

    const readerSource = readFileSync(join(here, "network-reader.ts"), "utf8");
    // readCurrent reads a whole dataset. It may only ever be used on the allowed ones.
    const wholeDatasetReads = [...readerSource.matchAll(/readCurrent<[^>]+>\(\s*([^,\n)]+)/g)].map(
      (match) => match[1]!.trim(),
    );
    const allowedExpressions = new Set([
      "SHARDED.index",
      "DATASETS.operators",
      "DATASETS.services",
    ]);
    for (const expression of wholeDatasetReads) {
      expect(allowedExpressions.has(expression), `${expression} is read whole`).toBe(true);
    }
  });
});

describe("the shard cache stays bounded", () => {
  it("does not accumulate the network one tile at a time", async () => {
    /*
     * An unbounded cache would refill the isolate with the national network gradually, and the
     * symptom would be an intermittent 500 that looks unrelated to the cache. The working set is
     * capped, so reading many distinct tiles cannot grow past it.
     */
    const { reader } = await publishedReader();
    for (let lat = 50; lat < 56; lat += 0.25) {
      for (let lon = -6; lon < 1; lon += 0.25) {
        await reader.stopsInBoundingBox(
          { west: lon, south: lat, east: lon + 0.1, north: lat + 0.1 },
          10,
        );
      }
    }
    expect(reader.cachedShardCount).toBeLessThanOrEqual(24);
  });
});

describe("worker source", () => {
  it("has no code path that loads a national snapshot", () => {
    // The class that did this is deleted; this fails if it comes back under any name.
    const sources = readdirSync(here)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(join(here, name), "utf8"))
      .join("\n");
    expect(sources).not.toMatch(/NetworkSnapshot/);
    expect(sources).not.toMatch(/network-repository/);
  });
});
