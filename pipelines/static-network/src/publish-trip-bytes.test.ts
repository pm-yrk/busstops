import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryObjectStore,
  objectKeyFor,
  objectKeyForBytes,
  type ObjectStore,
} from "@busstops/pipeline-core";
import { TileSpill } from "./gtfs-spill.js";
import { publishSpilledJourneyTiles } from "./publish-spilled-journeys.js";
import { PatternTripShard, encodePatternTripShard } from "./binary-trips.js";
import type { PatternTripRow } from "./departures-index.js";

/**
 * Publishing the planner's trip shards as bytes rather than as lines.
 *
 * The journey endpoint does not fail in its search — that measured 3.24 ms. It fails in
 * `JSON.parse`, which measured 24.26 ms of a ten-millisecond budget on a Manchester corridor. So
 * the publisher writes the form the reader can open without a parse, and what has to be asserted
 * is that it wrote *that* key with *that* content, and that a store which cannot hold bytes still
 * gets a shard it can read.
 */

const MIDNIGHT = Date.parse("2026-10-28T00:00:00.000Z") / 1000;
const DATASET = "network/pattern-trips/2026-10-28/1/215_-7";

function rows(count: number): PatternTripRow[] {
  return Array.from({ length: count }, (_, index) => ({
    p: `0191bd0a-000${String(index % 3)}-7c1e-9a2b-4f6c8d1e2a3b`,
    j: `vj-${String(index)}`,
    t: [MIDNIGHT + 32_400 + index * 60, MIDNIGHT + 33_000 + index * 60],
    ...(index % 4 === 0
      ? { a: [MIDNIGHT + 32_400 + index * 60, MIDNIGHT + 32_880 + index * 60] }
      : {}),
  }));
}

async function publishTo(store: ObjectStore, count = 24, removeOtherForm = false) {
  const spill = new TileSpill(mkdtempSync(join(tmpdir(), "busstops-trip-bytes-")));
  const source = rows(count);
  for (const row of source) spill.append(DATASET, JSON.stringify(row));
  spill.flush();
  const published = await publishSpilledJourneyTiles(store, spill, {
    version: "v1",
    datasetFor: (dataset) => dataset,
    encodeBytes: (lines) =>
      encodePatternTripShard(lines.map((line) => JSON.parse(line) as PatternTripRow)).bytes,
    removeOtherForm,
  });
  spill.dispose();
  return { published, source };
}

describe("the planner's trip shards, published as bytes", () => {
  it("writes the binary object a journey request reads, and not the text one", async () => {
    const store = new InMemoryObjectStore();
    const { published, source } = await publishTo(store);

    expect(published.failed).toEqual([]);
    expect(published.records).toBe(source.length);

    /* The text key is absent: this family is published in one form, not two. */
    const asText = await store.get(objectKeyFor(DATASET, "v1"));
    expect(asText).toBeNull();

    const bytes = await store.getBytes(objectKeyForBytes(DATASET, "v1"));
    expect(bytes).not.toBeNull();
    const shard = new PatternTripShard(bytes!);
    expect(shard.tripCount).toBe(source.length);
    for (let trip = 0; trip < source.length; trip += 1) {
      expect(shard.rowAt(trip)).toEqual(source[trip]);
    }
  });

  it("reports the bytes it wrote, so the publish guard measures the right number", async () => {
    const store = new InMemoryObjectStore();
    const { published } = await publishTo(store);
    const bytes = await store.getBytes(objectKeyForBytes(DATASET, "v1"));
    expect(published.largest?.bytes).toBe(bytes!.byteLength);
  });

  /*
   * A store that cannot hold bytes still gets a readable shard.
   *
   * Not a hypothetical: half the test doubles in this repository are text-only, and a publisher
   * that threw at them would have made every one of those tests a test of nothing.
   */
  it("falls back to lines when the store cannot hold bytes", async () => {
    const memory = new InMemoryObjectStore();
    const textOnly: ObjectStore = {
      get: (key) => memory.get(key),
      put: (key, value) => memory.put(key, value),
      delete: (key) => memory.delete(key),
      list: (prefix) => memory.list(prefix),
    };
    const { source } = await publishTo(textOnly);

    const body = await memory.get(objectKeyFor(DATASET, "v1"));
    expect(body).not.toBeNull();
    const parsed = body!.split("\n").map((line) => JSON.parse(line) as PatternTripRow);
    expect(parsed).toEqual(source);
  });
});

/**
 * The shard that exists twice.
 *
 * Both forms live under one dataset path with different suffixes, and every reader prefers the
 * bytes — so a key holding both is a key whose reader may be answering from the older of two
 * timetables. It happened: the daily refresh republished the live horizon as lines while the
 * migration was converting those same keys, and eight Leeds shards came out holding both forms of
 * 29 October. These are the assertions that say a publish leaves one form behind.
 */
describe("one form per shard", () => {
  it("deletes the text sibling when it publishes the bytes", async () => {
    const store = new InMemoryObjectStore();
    /* As the bucket was: a text shard published before the format changed. */
    await store.put(objectKeyFor(DATASET, "v1"), '{"p":"stale","j":"stale","t":[1,2]}');

    await publishTo(store, 12, true);

    expect(await store.getBytes!(objectKeyForBytes(DATASET, "v1"))).not.toBeNull();
    expect(await store.get(objectKeyFor(DATASET, "v1"))).toBeNull();
  });

  it("deletes the binary sibling when a store that cannot hold bytes publishes the lines", async () => {
    const store = new InMemoryObjectStore();
    await store.putBytes!(objectKeyForBytes(DATASET, "v1"), new Uint8Array([1, 2, 3]));

    /* A store without `putBytes` is what a test double and an older deployment look like. */
    const textOnly: ObjectStore = {
      get: (key) => store.get(key),
      put: (key, body) => store.put(key, body),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
    };

    await publishTo(textOnly, 12, true);

    expect(await store.get(objectKeyFor(DATASET, "v1"))).not.toBeNull();
    expect(await store.getBytes!(objectKeyForBytes(DATASET, "v1"))).toBeNull();
  });

  it("leaves the other form alone when it was not asked to remove it", async () => {
    const store = new InMemoryObjectStore();
    await store.put(objectKeyFor(DATASET, "v1"), '{"p":"stale","j":"stale","t":[1,2]}');

    await publishTo(store, 12);

    /*
     * The default, because only one family has ever had two forms and a delete per shard per
     * publish is an operation spent on nothing for all the others.
     */
    expect(await store.get(objectKeyFor(DATASET, "v1"))).not.toBeNull();
  });
});
