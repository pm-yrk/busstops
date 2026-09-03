import {
  ArtifactStore,
  mapWithConcurrency,
  objectKeyFor,
  type ObjectStore,
} from "@busstops/pipeline-core";
import type { Coordinate } from "@busstops/contracts";
import type { BuiltNetwork } from "./build-network.js";
import { buildSearchIndex, type SearchIndexEntry } from "./search-index.js";
import { stopDistancesAlongShape } from "./stop-distances.js";
import { NETWORK_SCHEMA_VERSION, TILE_PUBLISH_CONCURRENCY } from "./publish.js";
import {
  MAX_SHARD_RECORDS,
  SHARDED,
  type NetworkIndexRecord,
  type PatternTileRecord,
  type RouteTileRecord,
  type StopLocatorRecord,
  locatorBucketFor,
  patternTileDataset,
  searchPrefixDataset,
  searchPrefixFor,
  searchTileDataset,
  stopLocatorDataset,
  stopTileDataset,
  tileForSearchEntry,
  tileForStop,
  tilesForPattern,
} from "./shards.js";

/**
 * Publishes the network as shards the edge can actually read.
 *
 * The national datasets are still published — the batch pipelines legitimately want the whole
 * country, and they run in Node with gigabytes available. What changes is that the edge no longer
 * has to touch them: everything a passenger query needs is also written per shard, and the index
 * record written last names the version they all belong to.
 *
 * Order matters. Shards go out first and the index last, so a reader that sees a version can rely
 * on every shard for it already existing. A reader that sees the previous index simply serves the
 * previous publish, which is the behaviour we want during a rebuild.
 */

export interface ShardPublishResult {
  index: NetworkIndexRecord | null;
  published: number;
  failed: Array<{ dataset: string; reason: string }>;
  /** Shards that hit the record cap, which would mean the sharding scheme needs a finer key. */
  oversized: string[];
}

export interface ShardPublishOptions {
  version: string;
  now?: () => Date;
}

interface Shard {
  dataset: string;
  records: readonly unknown[];
}

export async function publishNetworkShards(
  store: ObjectStore,
  network: BuiltNetwork,
  options: ShardPublishOptions,
): Promise<ShardPublishResult> {
  const artifacts = new ArtifactStore(store);
  const now = options.now ?? (() => new Date());
  const failed: ShardPublishResult["failed"] = [];
  const oversized: string[] = [];

  /*
   * Families are built, published and released one at a time rather than all assembled up front.
   * Holding every grouping at once means the stops, the patterns with their shapes, the search
   * entries and all six maps over them are live together at peak — on a national build that is
   * gigabytes, and the previous version of this function died there.
   */
  let published = 0;
  const publishFamily = async (shards: Shard[]): Promise<string[]> => {
    for (const shard of shards) {
      if (shard.records.length > MAX_SHARD_RECORDS) oversized.push(shard.dataset);
    }

    const outcomes = await mapWithConcurrency(shards, TILE_PUBLISH_CONCURRENCY, async (shard) => {
      if (shard.records.length === 0) return { dataset: shard.dataset, error: null };
      try {
        /*
         * One write per shard, not a full artifact publish.
         *
         * A publish costs three round trips — read the manifest, write the object, swap the
         * pointer — and a national build writes over a thousand shards. That was four thousand
         * requests against a rate-limited API, and the first attempt lost 962 of them to 429s.
         *
         * Two of the three were never needed. The edge reads shards at the version the index
         * names, addressing the object directly, so a per-shard manifest is written and never
         * read. And the shrink check a publish performs is meaningless per shard: a rural tile
         * legitimately empties when a school route stops for the summer.
         *
         * Atomicity still comes from the index, which is a real publish, written last.
         */
        const body = shard.records.map((record) => JSON.stringify(record)).join("\n");
        await store.put(objectKeyFor(shard.dataset, options.version), body);
        return { dataset: shard.dataset, error: null };
      } catch (error) {
        return {
          dataset: shard.dataset,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    for (const outcome of outcomes) {
      if (outcome.error === null) published += 1;
      else failed.push({ dataset: outcome.dataset, reason: outcome.error });
    }
    return shards.map((shard) => shard.dataset);
  };

  const stopShards = groupStopsByTile(network);
  const stopTiles = [...stopShards.keys()].sort();
  await publishFamily(
    [...stopShards].map(([tile, records]) => ({ dataset: stopTileDataset(tile), records })),
  );
  stopShards.clear();

  const locatorShards = groupLocators(network);
  await publishFamily(
    [...locatorShards].map(([bucket, records]) => ({
      dataset: stopLocatorDataset(bucket),
      records,
    })),
  );
  locatorShards.clear();

  const patternShards = groupPatternsByTile(network);
  const patternTiles = [...patternShards.keys()].sort();
  await publishFamily(
    [...patternShards].map(([tile, records]) => ({ dataset: patternTileDataset(tile), records })),
  );
  patternShards.clear();

  await publishFamily([{ dataset: SHARDED.routeTiles, records: routeTileRecords(network) }]);

  const searchEntries = buildSearchIndex(network, { builtAt: now().toISOString() }).entries;

  const searchTileShards = groupSearchByTile(searchEntries);
  const searchTiles = [...searchTileShards.keys()].sort();
  await publishFamily(
    [...searchTileShards].map(([tile, records]) => ({ dataset: searchTileDataset(tile), records })),
  );
  searchTileShards.clear();

  const searchPrefixShards = groupSearchByPrefix(searchEntries);
  const searchPrefixes = [...searchPrefixShards.keys()].sort();
  await publishFamily(
    [...searchPrefixShards].map(([prefix, records]) => ({
      dataset: searchPrefixDataset(prefix),
      records,
    })),
  );
  searchPrefixShards.clear();

  if (failed.length > 0) {
    // The index is the pointer that makes a publish live. Withholding it when a shard failed
    // leaves the previous complete publish serving, rather than a version with holes in it.
    return { index: null, published, failed, oversized };
  }

  const index: NetworkIndexRecord = {
    version: options.version,
    publishedAt: now().toISOString(),
    partialCoverage: network.counts.danglingStopReferences > 0 || network.counts.parseErrors > 0,
    stopTiles,
    patternTiles,
    searchTiles,
    searchPrefixes,
    counts: {
      stops: network.stops.length,
      patterns: network.patterns.length,
      services: network.services.length,
      searchEntries: searchEntries.length,
    },
  };

  try {
    await artifacts.publish({
      dataset: SHARDED.index,
      version: options.version,
      records: [index],
      schemaVersion: NETWORK_SCHEMA_VERSION,
      sources: ["naptan", "bods"],
      minimumRecordCount: 1,
      now,
    });
  } catch (error) {
    failed.push({
      dataset: SHARDED.index,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { index: null, published, failed, oversized };
  }

  return { index, published: published + 1, failed, oversized };
}

function groupStopsByTile(network: BuiltNetwork): Map<string, BuiltNetwork["stops"]> {
  const byTile = new Map<string, BuiltNetwork["stops"]>();
  for (const stop of network.stops) {
    const tile = tileForStop(stop);
    const existing = byTile.get(tile);
    if (existing) existing.push(stop);
    else byTile.set(tile, [stop]);
  }
  return byTile;
}

function groupPatternsByTile(network: BuiltNetwork): Map<string, PatternTileRecord[]> {
  const byTile = new Map<string, PatternTileRecord[]>();
  const stopsById = new Map(network.stops.map((stop) => [stop.id, stop]));
  for (const pattern of network.patterns) {
    const shape = network.shapes.get(pattern.shapeRef);
    // A pattern with no geometry cannot be placed, and the map has nothing to draw for it. It
    // stays in the national dataset for the batch pipelines; it simply has no tile.
    if (!shape || shape.length < 2) continue;
    const record: PatternTileRecord = {
      pattern,
      shape: shape as Coordinate[],
      stopDistancesMetres: stopDistancesAlongShape(pattern, shape as Coordinate[], stopsById),
    };
    for (const tile of tilesForPattern(shape)) {
      const existing = byTile.get(tile);
      if (existing) existing.push(record);
      else byTile.set(tile, [record]);
    }
  }
  /*
   * A pattern is written to every tile its shape crosses, so a dense tile can collect far more
   * than the area itself has routes — one measured at over 20,000, which is tens of megabytes and
   * the isolate problem again one shard further down. The longest patterns are kept, because a
   * trunk route is what someone is most likely to be looking at; the rest lose their route name
   * on the map in that tile and nothing else.
   */
  for (const [tile, records] of byTile) {
    if (records.length > MAX_SHARD_RECORDS) {
      records.sort((a, b) => b.pattern.stopSequence.length - a.pattern.stopSequence.length);
      byTile.set(tile, records.slice(0, MAX_SHARD_RECORDS));
    }
  }
  return byTile;
}

function groupSearchByTile(entries: readonly SearchIndexEntry[]): Map<string, SearchIndexEntry[]> {
  const byTile = new Map<string, SearchIndexEntry[]>();
  for (const entry of entries) {
    const tile = tileForSearchEntry(entry);
    if (tile === null) continue;
    const existing = byTile.get(tile);
    if (existing) existing.push(entry);
    else byTile.set(tile, [entry]);
  }
  return byTile;
}

/**
 * An entry is reachable from every word in it, so someone searching "Armley" finds "Leeds Armley
 * Road" without having to type the first word. That means one entry appears in several prefix
 * shards; the duplication is the index, and it is bounded by the number of words in a name.
 */
function groupSearchByPrefix(
  entries: readonly SearchIndexEntry[],
): Map<string, SearchIndexEntry[]> {
  const byPrefix = new Map<string, SearchIndexEntry[]>();
  for (const entry of entries) {
    const keys = new Set<string>();
    for (const token of entry.tokens) keys.add(searchPrefixFor(token));
    for (const code of entry.codes) keys.add(searchPrefixFor(code));
    for (const key of keys) {
      const existing = byPrefix.get(key);
      if (existing) existing.push(entry);
      else byPrefix.set(key, [entry]);
    }
  }

  // Keep the most prominent when a bucket is unusually full, so a shard cannot grow without
  // bound. Sorted rather than truncated arbitrarily: what survives should be what people mean.
  for (const [key, bucket] of byPrefix) {
    if (bucket.length > MAX_SHARD_RECORDS) {
      bucket.sort((a, b) => b.prominence - a.prominence);
      byPrefix.set(key, bucket.slice(0, MAX_SHARD_RECORDS));
    }
  }
  return byPrefix;
}

function groupLocators(network: BuiltNetwork): Map<number, StopLocatorRecord[]> {
  const byBucket = new Map<number, StopLocatorRecord[]>();
  const add = (key: string, tile: string) => {
    const bucket = locatorBucketFor(key);
    const existing = byBucket.get(bucket);
    if (existing) existing.push({ key, tile });
    else byBucket.set(bucket, [{ key, tile }]);
  };

  for (const stop of network.stops) {
    const tile = tileForStop(stop);
    // Both identities resolve to the same tile: the API accepts either, and live departures
    // arrive keyed by ATCO code while the app links by id.
    add(stop.id, tile);
    if (stop.atcoCode !== stop.id) add(stop.atcoCode, tile);
  }
  return byBucket;
}

function routeTileRecords(network: BuiltNetwork): RouteTileRecord[] {
  const byService = new Map<string, Set<string>>();
  for (const pattern of network.patterns) {
    const shape = network.shapes.get(pattern.shapeRef);
    if (!shape || shape.length < 2) continue;
    const tiles = byService.get(pattern.serviceRouteId) ?? new Set<string>();
    for (const tile of tilesForPattern(shape)) tiles.add(tile);
    byService.set(pattern.serviceRouteId, tiles);
  }
  return [...byService].map(([serviceId, tiles]) => ({ serviceId, tiles: [...tiles].sort() }));
}
