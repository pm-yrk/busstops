import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryObjectStore, objectKeyForBytes, type ObjectStore } from "@busstops/pipeline-core";
import { groupRouteIndices } from "@busstops/journey";
import { TileSpill } from "./gtfs-spill.js";
import { publishSpilledJourneyTiles } from "./publish-spilled-journeys.js";
import { PatternTripShard, encodePatternTripShard } from "./binary-trips.js";
import { RouteGrouping, encodeRouteGrouping, journeyRoutesDataset } from "./journey-routes.js";
import { patternTripsDatasetParts, type PatternTripRow } from "./departures-index.js";

/**
 * A shard and its route grouping, written by one publish.
 *
 * A journey groups a corridor's trips into routes before it can search them, and the published
 * grouping exists so a request does not: 27.65 ms of a ten-millisecond budget, measured on a real
 * Manchester corridor. The grouping names each trip by its index in the shard it was built from
 * and carries that shard's fingerprint, so it means nothing for any other shard — and the shards
 * are keyed by service date and republished on a rolling horizon three times a day.
 *
 * That is the defect these tests exist for, and it was found in production: a read of 400 shards
 * of the newest service date found 400 with no grouping at all, while every deployed journey
 * reported `shardsGrouped: 0` and grouped the long way with 5,574 grouping objects sitting in the
 * bucket describing dates that had rolled off. A grouping published by a separate pass is a
 * grouping that falls behind the data it describes.
 *
 * So the assertions are about the pair, not about the grouping: that writing a shard writes its
 * grouping, that the grouping describes the shard that was written and not the one before it, and
 * that a republished shard does not keep the old grouping beside it.
 */

const MIDNIGHT = Date.parse("2026-11-04T00:00:00.000Z") / 1000;
const DATASET = "network/pattern-trips/2026-11-04/1/215_-7";
const PARTS = patternTripsDatasetParts(DATASET)!;
const GROUPING = journeyRoutesDataset(PARTS.serviceDate, PARTS.tile, PARTS.window);

/** Trips on three patterns, some cut short, some overtaking: the shapes grouping has to split. */
function rows(count: number, shift = 0): PatternTripRow[] {
  return Array.from({ length: count }, (_, index) => {
    const depart = MIDNIGHT + 32_400 + index * 300 + shift;
    const express = index % 5 === 0;
    const hop = express ? 120 : 600;
    const calls = index % 6 === 0 ? 2 : 3;
    return {
      p: `0191bd0a-000${String(index % 3)}-7c1e-9a2b-4f6c8d1e2a3b`,
      j: `vj-${String(index)}`,
      t: Array.from({ length: calls }, (_, at) => depart + at * hop),
    };
  });
}

async function publish(store: ObjectStore, source: PatternTripRow[]) {
  const spill = new TileSpill(mkdtempSync(join(tmpdir(), "busstops-grouping-")));
  for (const row of source) spill.append(DATASET, JSON.stringify(row));
  spill.flush();
  const published = await publishSpilledJourneyTiles(store, spill, {
    version: "v1",
    datasetFor: (dataset) => dataset,
    encodeBytes: (lines) =>
      encodePatternTripShard(lines.map((line) => JSON.parse(line) as PatternTripRow)).bytes,
    removeOtherForm: true,
    derive: (asBytes, dataset) => {
      const parts = patternTripsDatasetParts(dataset);
      if (parts === null) return null;
      const shard = new PatternTripShard(asBytes);
      return {
        dataset: journeyRoutesDataset(parts.serviceDate, parts.tile, parts.window),
        bytes: encodeRouteGrouping({
          fingerprint: shard.fingerprint(),
          routes: groupRouteIndices({
            tripCount: shard.tripCount,
            patternKeyOf: (trip) => shard.patternOf(trip),
            callCountOf: (trip) => shard.callsIn(trip),
            departureOf: (trip, call) => shard.departure(trip, call),
            tripIdOf: (trip) => shard.tripId(trip),
          }),
        }).bytes,
      };
    },
    verify: (stored, asBytes) => {
      try {
        return new RouteGrouping(stored).describes(new PatternTripShard(asBytes).fingerprint());
      } catch {
        return false;
      }
    },
  });
  spill.dispose();
  return published;
}

async function readPair(store: ObjectStore) {
  const shardBytes = await store.getBytes!(objectKeyForBytes(DATASET, "v1"));
  const groupingBytes = await store.getBytes!(objectKeyForBytes(GROUPING, "v1"));
  return { shardBytes, groupingBytes };
}

describe("publishing a trip shard's route grouping with the shard", () => {
  it("writes a grouping beside the shard, and reports it verified", async () => {
    const store = new InMemoryObjectStore();
    const published = await publish(store, rows(30));

    expect(published.failed).toEqual([]);
    expect(published.derived.published).toBe(1);
    expect(published.derived.verified).toBe(1);
    expect(published.derived.failed).toEqual([]);

    const { shardBytes, groupingBytes } = await readPair(store);
    expect(shardBytes).not.toBeNull();
    expect(groupingBytes).not.toBeNull();
  });

  it("writes a grouping that describes the shard beside it", async () => {
    const store = new InMemoryObjectStore();
    await publish(store, rows(30));
    const { shardBytes, groupingBytes } = await readPair(store);

    const shard = new PatternTripShard(shardBytes!);
    const grouping = new RouteGrouping(groupingBytes!);
    expect(grouping.describes(shard.fingerprint())).toBe(true);
  });

  it("names every trip in the shard exactly once, by its index there", async () => {
    /* The artifact's whole premise: a trip index is only meaningful against one shard. A grouping
     * that lost or duplicated an index would hand the search a bus that is not the one it asked
     * for, which is a wrong arrival rather than a slow one. */
    const store = new InMemoryObjectStore();
    const source = rows(30);
    await publish(store, source);
    const { shardBytes, groupingBytes } = await readPair(store);
    const shard = new PatternTripShard(shardBytes!);
    const grouping = new RouteGrouping(groupingBytes!);

    const seen: number[] = [];
    for (let route = 0; route < grouping.routeCount; route += 1) {
      for (let at = grouping.firstTrip(route); at < grouping.tripEnd(route); at += 1) {
        seen.push(grouping.tripAt(at));
      }
    }
    expect(seen.slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: shard.tripCount }, (_, trip) => trip),
    );
    expect(new Set(seen).size).toBe(source.length);
  });

  it("replaces the grouping when the shard is republished, rather than leaving the old one", async () => {
    /*
     * The production defect, as a test.
     *
     * The refresh rewrites a service date's shards three times a day, so the grouping already at
     * that key describes the shard that has just been replaced. A publisher that skipped on the
     * key being present would leave it there for ever and every journey through the tile would
     * ignore it — which is exactly the state this was found in.
     */
    const store = new InMemoryObjectStore();
    await publish(store, rows(30));
    const first = await readPair(store);
    const firstFingerprint = new PatternTripShard(first.shardBytes!).fingerprint();

    /* A refresh of the same date and tile with a different timetable: more trips, shifted. */
    const republished = await publish(store, rows(44, 180));
    expect(republished.derived.verified).toBe(1);

    const second = await readPair(store);
    const shard = new PatternTripShard(second.shardBytes!);
    const grouping = new RouteGrouping(second.groupingBytes!);

    expect(shard.fingerprint()).not.toEqual(firstFingerprint);
    /* The grouping now there describes the shard now there, and would be refused for the old one. */
    expect(grouping.describes(shard.fingerprint())).toBe(true);
    expect(grouping.describes(firstFingerprint)).toBe(false);
  });

  it("reports a grouping that does not describe its shard rather than trusting it", async () => {
    /* Teeth for the verification: a derive that keys the grouping off a different timetable must
     * come back as a failure, not as a published object. */
    const store = new InMemoryObjectStore();
    const spill = new TileSpill(mkdtempSync(join(tmpdir(), "busstops-grouping-bad-")));
    for (const row of rows(30)) spill.append(DATASET, JSON.stringify(row));
    spill.flush();
    const published = await publishSpilledJourneyTiles(store, spill, {
      version: "v1",
      datasetFor: (dataset) => dataset,
      encodeBytes: (lines) =>
        encodePatternTripShard(lines.map((line) => JSON.parse(line) as PatternTripRow)).bytes,
      derive: (_asBytes, dataset) => {
        const parts = patternTripsDatasetParts(dataset)!;
        /* Built from a shard that is not the one being written. */
        const other = new PatternTripShard(encodePatternTripShard(rows(12, 900)).bytes);
        return {
          dataset: journeyRoutesDataset(parts.serviceDate, parts.tile, parts.window),
          bytes: encodeRouteGrouping({
            fingerprint: other.fingerprint(),
            routes: groupRouteIndices({
              tripCount: other.tripCount,
              patternKeyOf: (trip) => other.patternOf(trip),
              callCountOf: (trip) => other.callsIn(trip),
              departureOf: (trip, call) => other.departure(trip, call),
              tripIdOf: (trip) => other.tripId(trip),
            }),
          }).bytes,
        };
      },
      verify: (stored, asBytes) => {
        try {
          return new RouteGrouping(stored).describes(new PatternTripShard(asBytes).fingerprint());
        } catch {
          return false;
        }
      },
    });
    spill.dispose();

    expect(published.derived.published).toBe(1);
    expect(published.derived.verified).toBe(0);
    expect(published.derived.failed).toHaveLength(1);
    expect(published.derived.failed[0]!.reason).toContain("does not describe this shard");
  });

  it("writes no grouping for a dataset that is not a trip shard", async () => {
    /* `derive` returning null must write nothing rather than write somewhere unintended. */
    const store = new InMemoryObjectStore();
    const spill = new TileSpill(mkdtempSync(join(tmpdir(), "busstops-grouping-other-")));
    spill.append("network/departures/2026-11-04/3", JSON.stringify(rows(2)[0]));
    spill.flush();
    const published = await publishSpilledJourneyTiles(store, spill, {
      version: "v1",
      datasetFor: (dataset) => dataset,
      encodeBytes: (lines) =>
        encodePatternTripShard(lines.map((line) => JSON.parse(line) as PatternTripRow)).bytes,
      derive: (asBytes, dataset) => {
        const parts = patternTripsDatasetParts(dataset);
        if (parts === null) return null;
        const shard = new PatternTripShard(asBytes);
        return {
          dataset: journeyRoutesDataset(parts.serviceDate, parts.tile, parts.window),
          bytes: encodeRouteGrouping({ fingerprint: shard.fingerprint(), routes: [] }).bytes,
        };
      },
    });
    spill.dispose();

    expect(published.derived.published).toBe(0);
    expect(published.derived.failed).toEqual([]);
    expect(await store.list(`data/${"network/journey-routes"}/`)).toEqual([]);
  });
});
