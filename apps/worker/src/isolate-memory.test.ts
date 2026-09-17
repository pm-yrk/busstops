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
import { objectKeyFor } from "@busstops/pipeline-core";
import { patternTilesForBoundingBox } from "@busstops/pipeline-static-network";
import { NetworkReader } from "./network-reader.js";
import { ReadLedger } from "./read-ledger.js";
import {
  ROUTE_PATTERN_BUCKETS,
  routePatternsBucketFor,
  routePatternsDataset,
} from "@busstops/pipeline-static-network";

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
  return {
    reader: new NetworkReader(recording.store),
    reads: recording.reads,
    store: recording.store,
  };
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

  it("finds a stop whose letter had to be split into deeper buckets", async () => {
    /*
     * The publisher splits a two-character bucket that would overflow, and only the index says
     * which letters it did that to. If the edge computed the key itself instead of asking, every
     * stop under a split letter would simply stop being findable — no error, no empty bucket,
     * just nothing.
     */
    const crowded = network();
    const seed = crowded.stops[0]!;
    for (let i = 0; i < 6_200; i++) {
      crowded.stops.push({
        ...seed,
        id: `crowded-${i}`,
        atcoCode: `CRW${i}`,
        name: `Bolton Interchange ${i}`,
      });
    }

    const store = new InMemoryObjectStore();
    await publishNetworkShards(store, crowded, { version: "v1" });
    const reader = new NetworkReader(store);

    const index = await reader.networkIndex();
    expect(index!.searchPrefixes).not.toContain("bo");

    const found = await reader.search("Bolton", { limit: 10 });
    expect(found?.hits.length).toBeGreaterThan(0);
  });

  it("opens a bounded number of buckets however long the query is", async () => {
    // A query is capped at 120 characters, not at a word count, and each word is at least one
    // object. Without a bound on the reading, how much someone types decides how much the edge
    // holds — the same defect as a wide viewport, arrived at through the search box.
    const { reader, reads } = await publishedReader();
    reads.length = 0;

    const wordy = Array.from({ length: 40 }, (_, i) => `word${i}`)
      .join(" ")
      .slice(0, 120);
    await reader.search(wordy, { limit: 10 });
    expect(reads.filter((key) => key.includes(SHARDED.searchPrefix)).length).toBeLessThanOrEqual(
      12,
    );
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

    /*
     * Every reader in the Worker, not just the network one. The guard used to scan a single file,
     * which meant a new reader could add a whole-dataset read and never be asked about it — and
     * one promptly did.
     */
    const readerSource = ["network-reader.ts", "disruption-reader.ts"]
      .map((name) => readFileSync(join(here, name), "utf8"))
      .join("\n");
    /*
     * readCurrent reads a whole dataset. It may only ever be used on the allowed ones.
     *
     * The argument may itself be a call — `journeyTileDataset(tile)` — so one level of nesting is
     * matched. Stopping at the first bracket truncated it to `journeyTileDataset(tile`, which then
     * failed the check for a reason that had nothing to do with what was being read.
     */
    const wholeDatasetReads = [
      ...readerSource.matchAll(/readCurrent<[^>]+>\(\s*([A-Za-z_$][\w$.]*(?:\([^()]*\))?)/g),
    ].map((match) => match[1]!.trim());
    const allowedExpressions = new Set([
      "SHARDED.index",
      "DATASETS.operators",
      "DATASETS.services",
      /*
       * A journey tile is already one spatial shard — the same bounded read the journey planner
       * makes — so reading it whole is reading a shard, not a nation. It is on this list because
       * the guard matches on the call rather than on what the call resolves to, and a stop board
       * has to be able to load the timetable for its own tile.
       */
      "journeyTileDataset(tile)",
      /*
       * The disruption set is bounded at publish time — MAX_PUBLISHED_NOTICES, ordered
       * worst-first — so its size is a property of the pipeline rather than of how disrupted
       * England happens to be today. That is what makes reading it whole safe, and it is the
       * only reason: if the cap ever comes off, this entry must come off with it.
       */
      "DISRUPTIONS_DATASET",
    ]);
    for (const expression of wholeDatasetReads) {
      expect(allowedExpressions.has(expression), `${expression} is read whole`).toBe(true);
    }
  });
});

describe("one request stays bounded", () => {
  it("stops reading tiles once a viewport costs more than it may hold", async () => {
    /*
     * The other end of the same defect. Sharding stops an endpoint loading the national network
     * in one object; it does not stop a wide viewport loading it a tile at a time. The map caps a
     * box at 1.5 square degrees, which on the pattern grid is ninety-six tiles — and every check
     * that ever exercised this asked for a city centre, so a wide box was never tried.
     *
     * The fixture is tiny, so the budget is what is varied rather than the data: with a budget of
     * nothing, a box spanning many tiles must stop after the first batch and say that it did.
     */
    // Stops spread across the country, so a wide box really does span many tiles. The documented
    // fixture is one town, which is the reason a wide viewport was never exercised.
    const spread = network();
    const seed = spread.stops[0]!;
    for (let lat = 50.2; lat < 55; lat += 0.3) {
      for (let lon = -5.8; lon < 1; lon += 0.3) {
        spread.stops.push({
          ...seed,
          id: `spread-${lat.toFixed(1)}-${lon.toFixed(1)}`,
          atcoCode: `SPREAD${lat.toFixed(1)}${lon.toFixed(1)}`,
          locationCoordinate: { lat, lon },
        });
      }
    }

    const recording = recordingStore();
    await publishNetworkShards(recording.store, spread, { version: "v1" });
    const reads = recording.reads;
    const wide = { west: -6, south: 50, east: 1.4, north: 55.4 };

    reads.length = 0;
    const unbounded = await new NetworkReader(recording.store).stopsInBoundingBox(wide, 400);
    const unboundedReads = reads.filter((key) => key.includes(SHARDED.stopTile)).length;
    expect(unboundedReads).toBeGreaterThan(6);

    reads.length = 0;
    const bounded = new NetworkReader(recording.store, 15 * 60 * 1000, 0);
    const result = await bounded.stopsInBoundingBox(wide, 400);

    expect(result.truncated).toBe(true);
    const boundedReads = reads.filter((key) => key.includes(SHARDED.stopTile)).length;
    expect(boundedReads).toBeLessThan(unboundedReads);
    // And it still answers rather than failing: a partial viewport beats a 500.
    expect(unbounded.stops.length).toBeGreaterThanOrEqual(result.stops.length);
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

/*
 * A route's stops and geometry are a statement of fact — this is where the 36 goes.
 *
 * Pattern reads are capped, because `/v1/map` and `/v1/routes/:id` are the only two endpoints
 * that read pattern tiles in bulk and both answered Cloudflare's own HTML 503 on two consecutive
 * deployments. The cap is containment, and containment that silently shortens a route is worse
 * than the crash it prevents: a passenger would be shown part of a route as though it were all
 * of it. So the read reports whether it got everything, and the endpoint carries that through.
 */
describe("a route too large for one request", () => {
  /** A route whose patterns are spread over enough tiles that a small budget cannot hold them. */
  async function sprawlingRoute() {
    const sprawling = network();
    const seed = sprawling.stops[0]!;
    const pattern = sprawling.patterns[0]!;
    const stopIds = [...pattern.stopSequence];

    // Stops strung across England, so the route's patterns land in many different tiles.
    for (let i = 0; i < 400; i++) {
      const id = `sprawl-${i}`;
      sprawling.stops.push({
        ...seed,
        id,
        atcoCode: `SPR${String(i).padStart(5, "0")}`,
        name: `Sprawl ${i}`,
        locationCoordinate: { lat: 51 + (i % 50) / 20, lon: -4 + (i % 40) / 10 },
      });
      stopIds.push(id);
    }
    sprawling.patterns[0] = { ...pattern, stopSequence: stopIds };
    /*
     * And the shape, which is what decides the tiles.
     *
     * The route-tiles index is built from a pattern's geometry, not from its stop sequence, so a
     * fixture that stretched only the stops left the route in its original handful of tiles and
     * the budget never bit. Worth knowing generally: these two can disagree.
     */
    sprawling.shapes.set(
      pattern.shapeRef,
      Array.from({ length: 400 }, (_, i) => ({
        lat: 51 + (i % 50) / 20,
        lon: -4 + (i % 40) / 10,
      })),
    );

    const store = new InMemoryObjectStore();
    await publishNetworkShards(store, sprawling, { version: "v1" });
    return { store, serviceId: pattern.serviceRouteId };
  }

  /*
   * The dense route, which is the case that used to kill the isolate.
   *
   * It is read from the route-pattern index now: one object, one line. The byte budget that used
   * to decide how much of this route a passenger saw is irrelevant to it, which is the point —
   * starving the reader to two thousand characters no longer shortens the route, because the
   * route was never being assembled from a scan.
   */
  it("reads a route spanning the country completely, from one object", async () => {
    const { store, serviceId } = await sprawlingRoute();

    const starved = new NetworkReader(store, 15 * 60 * 1000, 2_000);
    const capped = await starved.patternsForService(serviceId);

    expect(capped.source).toBe("route_pattern_index");
    expect(capped.complete).toBe(true);
    expect(capped.geometries.length).toBeGreaterThan(0);
    // The whole route, not the part that fitted: the fixture's pattern calls at 400+ stops.
    expect(capped.geometries[0]!.pattern.stopSequence.length).toBeGreaterThan(400);
  });

  it("asks for one object to answer a route, however far the route goes", async () => {
    const { store, serviceId } = await sprawlingRoute();
    const reader = new NetworkReader(store);
    const ledger = new ReadLedger(60_000);

    await reader.patternsForService(serviceId, Date.now(), ledger);

    const report = ledger.toJSON();
    expect(report.families["route-patterns"]?.requested).toBe(1);
    expect(report.families.patterns).toBeUndefined();
  });

  /*
   * The half-a-route case, which must never be presentable as a whole one.
   *
   * With the index there is no such thing as a partly-read route: the bucket is there or it is
   * not. An object the index promises and the store cannot produce is `unavailable`, which is a
   * different answer from "this route has no patterns" and is what stops an empty route being
   * drawn as though the emptiness were a fact about the route.
   */
  it("cannot label an unreadable route complete", async () => {
    const { store, serviceId } = await sprawlingRoute();
    const reader = new NetworkReader(store);

    const bucket = routePatternsBucketFor(serviceId, ROUTE_PATTERN_BUCKETS);
    await store.delete(objectKeyFor(routePatternsDataset(bucket), "v1"));

    const answer = await reader.patternsForService(serviceId);
    expect(answer.source).toBe("unavailable");
    expect(answer.complete).toBe(false);
    expect(answer.geometries).toEqual([]);
  });

  it("tells an unreadable route apart from one with no patterns", async () => {
    const { store } = await sprawlingRoute();
    const reader = new NetworkReader(store);

    // A service the index has never heard of: its bucket exists, its line does not.
    const absent = await reader.patternsForService("00000000-0000-5000-8000-00000000beef");
    expect(absent.source).toBe("route_pattern_index");
    expect(absent.complete).toBe(true);
    expect(absent.geometries).toEqual([]);
  });

  /*
   * The other direction, on an ordinary route rather than the sprawling one.
   *
   * The sprawling fixture is genuinely too big for the cap even at the production budget — a
   * pattern is written into every tile its shape crosses, so a route spanning England carries its
   * geometry hundreds of times over. That is real duplication rather than a fixture artefact,
   * which is why "complete" has to be provable on a route of normal size instead.
   */
  it("reports an ordinary route as whole", async () => {
    const ordinary = network();
    const store = new InMemoryObjectStore();
    await publishNetworkShards(store, ordinary, { version: "v1" });

    const reader = new NetworkReader(store);
    const full = await reader.patternsForService(ordinary.patterns[0]!.serviceRouteId);
    expect(full.complete).toBe(true);
    expect(full.source).toBe("route_pattern_index");
    expect(full.geometries.length).toBeGreaterThan(0);
  });

  it("reports a viewport whose patterns did not all fit", async () => {
    const { store } = await sprawlingRoute();
    const starved = new NetworkReader(store, 15 * 60 * 1000, 2_000);

    const wide = { west: -4, east: 0, south: 51, north: 53.5 };
    const detailed = await starved.patternsInTilesDetailed(patternTilesForBoundingBox(wide));
    expect(detailed.complete).toBe(false);
  });

  /*
   * An empty answer is complete when the publish says the route touches no tiles. Conflating that
   * with a starved read would make every route without geometry look like a fault.
   */
  it("calls a route with no published patterns complete, not truncated", async () => {
    const { store } = await sprawlingRoute();
    const reader = new NetworkReader(store);
    const absent = await reader.patternsForService("00000000-0000-5000-8000-00000000dead");
    expect(absent.complete).toBe(true);
    expect(absent.geometries).toEqual([]);
  });
});

/*
 * The clock, rather than the byte cap.
 *
 * Error 1102 is the platform killing a Worker that ran out of *something* — its page does not say
 * what, and a budget counted in characters cannot stop a request that is slow rather than large.
 * So the reader watches a wall clock the request owns, declines to start optional work when it has
 * already gone, and books every object it touches so a request that survives can say what it cost.
 */
describe("a request that watches its own clock", () => {
  /** A clock the test drives, so "out of time" is a fact rather than a race. */
  function fakeClock(start = 1_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("declines to start pattern enrichment once the budget has gone", async () => {
    const ordinary = network();
    const store = new InMemoryObjectStore();
    await publishNetworkShards(store, ordinary, { version: "v1" });
    const reader = new NetworkReader(store);

    const clock = fakeClock();
    const ledger = new ReadLedger(500, clock.now);
    clock.advance(600);

    const detailed = await reader.patternsInTilesDetailed(
      patternTilesForBoundingBox({ west: -2, east: 0, south: 53, north: 54 }),
      Date.now(),
      ledger,
    );

    expect(detailed.geometries).toEqual([]);
    expect(detailed.complete).toBe(false);
    expect(ledger.stopped).toBe(true);
    expect(ledger.reason).toBe("pattern_enrichment_budget");
  });

  it("does the work when there is time for it, and says what it cost", async () => {
    const ordinary = network();
    const store = new InMemoryObjectStore();
    await publishNetworkShards(store, ordinary, { version: "v1" });
    const reader = new NetworkReader(store);

    const ledger = new ReadLedger(60_000);
    const detailed = await reader.patternsInTilesDetailed(
      patternTilesForBoundingBox({ west: -2, east: 0, south: 53, north: 54 }),
      Date.now(),
      ledger,
    );

    expect(detailed.complete).toBe(true);
    expect(ledger.stopped).toBe(false);

    const report = ledger.toJSON();
    expect(report.objectsRequested).toBeGreaterThan(0);
    expect(report.families.patterns?.requested).toBeGreaterThan(0);
    expect(report.chars).toBeGreaterThan(0);
    expect(report.counts.patterns).toBe(detailed.geometries.length);
    expect(report.degradationReason).toBeNull();
  });

  it("counts a cache hit apart from a read, because a cache hit decodes nothing", async () => {
    const ordinary = network();
    const store = new InMemoryObjectStore();
    await publishNetworkShards(store, ordinary, { version: "v1" });
    const reader = new NetworkReader(store);
    const tiles = patternTilesForBoundingBox({ west: -2, east: 0, south: 53, north: 54 });

    const first = new ReadLedger(60_000);
    await reader.patternsInTilesDetailed(tiles, Date.now(), first);
    const second = new ReadLedger(60_000);
    await reader.patternsInTilesDetailed(tiles, Date.now(), second);

    expect(first.toJSON().families.patterns?.read).toBeGreaterThan(0);
    expect(second.toJSON().families.patterns?.read).toBe(0);
    expect(second.toJSON().families.patterns?.cached).toBeGreaterThan(0);
  });

  it("books a missing shard as missing rather than as a failure", async () => {
    const ordinary = network();
    const store = new InMemoryObjectStore();
    await publishNetworkShards(store, ordinary, { version: "v1" });
    const reader = new NetworkReader(store);

    const ledger = new ReadLedger(60_000);
    await reader.stopsInTiles(["999_999"], Date.now(), ledger);
    const report = ledger.toJSON();
    expect(report.objectsFailed).toBe(0);
  });

  it("never puts a key or a URL in what it reports", async () => {
    const ordinary = network();
    const store = new InMemoryObjectStore();
    await publishNetworkShards(store, ordinary, { version: "v1" });
    const reader = new NetworkReader(store);

    const ledger = new ReadLedger(60_000);
    await reader.patternsInTilesDetailed(
      patternTilesForBoundingBox({ west: -2, east: 0, south: 53, north: 54 }),
      Date.now(),
      ledger,
    );

    const serialised = JSON.stringify(ledger.toJSON()) + ledger.serverTiming();
    expect(serialised).not.toMatch(/data\/network/);
    expect(serialised).not.toMatch(/https?:/);
    expect(serialised).not.toMatch(/\.jsonl/);
  });
});
