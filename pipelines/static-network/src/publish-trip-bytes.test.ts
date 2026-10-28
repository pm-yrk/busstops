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

async function publishTo(store: ObjectStore, count = 24) {
  const spill = new TileSpill(mkdtempSync(join(tmpdir(), "busstops-trip-bytes-")));
  const source = rows(count);
  for (const row of source) spill.append(DATASET, JSON.stringify(row));
  spill.flush();
  const published = await publishSpilledJourneyTiles(store, spill, {
    version: "v1",
    datasetFor: (dataset) => dataset,
    encodeBytes: (lines) =>
      encodePatternTripShard(lines.map((line) => JSON.parse(line) as PatternTripRow)).bytes,
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
