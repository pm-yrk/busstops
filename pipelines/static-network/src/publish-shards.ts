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
  MAX_SHARD_BYTES,
  MAX_SHARD_RECORDS,
  SEARCH_BUCKET_SPLIT_AT,
  SEARCH_MAX_PREFIX_LENGTH,
  SEARCH_PREFIX_LENGTH,
  SHARDED,
  type NetworkIndexRecord,
  type PatternTileLine,
  type RouteTileRecord,
  type StopLocatorRecord,
  locatorBucketFor,
  patternTileDataset,
  searchPrefixDataset,
  currentArtifactLayout,
  searchPartKey,
  searchPrefixFor,
  searchTileDataset,
  stopLocatorDataset,
  stopTileDataset,
  tileForSearchEntry,
  tileForStop,
  tilesForPattern,
  ROUTE_PATTERN_BUCKETS,
  routePatternsBucketFor,
  routePatternsDataset,
  routePatternsShardLines,
  PATTERN_INDEX_BUCKETS,
  patternIndexBucketFor,
  patternIndexDataset,
  patternIndexTileDataset,
  patternIndexShardLines,
  stopRoutesDataset,
  type PatternIndexRow,
  type StopRoutesRow,
  type MapStopRow,
  mapStopsDataset,
  type StopDetailRow,
  stopDetailDataset,
  stopDetailBucketFor,
  type RoutePatternsRow,
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
  /** Shards that hit the byte budget, and how many records went unpublished as a result. */
  truncated: Array<{ dataset: string; dropped: number; kept: number }>;
  /**
   * The biggest shard in each family.
   *
   * Reported rather than merely bounded, because the useful question after a publish is not "did
   * anything overflow" but "how close is the largest one" — and the answer needs measuring on
   * real national data, not estimating from record counts.
   */
  largest: Array<{ dataset: string; bytes: number; records: number }>;
  /**
   * How long each family took, and how many objects it wrote.
   *
   * The report said how many objects a build published in total and nothing about where the time
   * went, so a bootstrap that ran an hour longer than the one before it could only be explained by
   * guessing which family had grown. These writes are the bulk of the build's wall clock, and the
   * free tier is counted in operations, so both numbers are worth keeping.
   */
  families: Array<{ name: string; objects: number; failed: number; bytes: number; ms: number }>;
  /** Total bytes this publish occupies, counted as it was written. */
  publishedBytes: number;
}

export interface ShardPublishOptions {
  version: string;
  now?: () => Date;
}

/**
 * A shard, already serialised.
 *
 * The lines are built before anything is measured because the byte budget has to apply to the
 * exact text that gets written; measuring an estimate and writing something else is how a shard
 * passes a cap and is still refused by object storage.
 */
interface Shard {
  dataset: string;
  lines: string[];
  records: number;
}

/**
 * UTF-8 byte length. Node's Buffer is the fast path and this only ever runs in the pipeline, but
 * the module is reachable from the Worker bundle, so it is read off the global rather than
 * imported — a bare `Buffer` reference would break there at module evaluation.
 */
const nodeBuffer = (
  globalThis as { Buffer?: { byteLength(value: string, encoding: string): number } }
).Buffer;
const encoder = nodeBuffer ? null : new TextEncoder();

function utf8Bytes(value: string): number {
  return nodeBuffer ? nodeBuffer.byteLength(value, "utf8") : encoder!.encode(value).length;
}

/**
 * R2's free storage allowance, and what one publish is allowed to occupy inside it.
 *
 * The bucket went over ten gigabytes in run 53 and retention could only claw back four objects a
 * second, so a publish that does not know its own size is how it happens again. Four versions of
 * headroom: retention keeps the live one and prunes behind it, and a run that cannot finish its
 * pruning must still leave room for the next publish.
 */
export const FREE_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
export const MAX_PUBLISH_BYTES = FREE_STORAGE_BYTES / 4;

export interface StoragePlan {
  families: Array<{ name: string; objects: number; bytes: number }>;
  objects: number;
  bytes: number;
  limitBytes: number;
  withinLimit: boolean;
}

/**
 * What this publish will occupy, measured before a byte of it is written.
 *
 * The lines are built to be measured rather than estimated from record counts: a `Stop` and a map
 * projection row differ by a factor of four, so a count says nothing useful about bytes. The
 * caller decides what to do about a plan that does not fit; this only reports it.
 */
export function planStorage(families: Array<{ name: string; lines: string[][] }>): StoragePlan {
  const measured = families.map((family) => ({
    name: family.name,
    objects: family.lines.filter((lines) => lines.length > 0).length,
    bytes: family.lines.reduce(
      (total, lines) => total + lines.reduce((n, line) => n + utf8Bytes(line) + 1, 0),
      0,
    ),
  }));
  const bytes = measured.reduce((total, family) => total + family.bytes, 0);
  return {
    families: measured,
    objects: measured.reduce((total, family) => total + family.objects, 0),
    bytes,
    limitBytes: MAX_PUBLISH_BYTES,
    withinLimit: bytes <= MAX_PUBLISH_BYTES,
  };
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
  const truncated: ShardPublishResult["truncated"] = [];
  const largest: ShardPublishResult["largest"] = [];

  /*
   * Families are built, published and released one at a time rather than all assembled up front.
   * Holding every grouping at once means the stops, the patterns with their shapes, the search
   * entries and all six maps over them are live together at peak — on a national build that is
   * gigabytes, and an earlier version of this function died there.
   */
  let published = 0;
  /*
   * How long each family took and how many objects it wrote.
   *
   * The report said how many objects a build published in total and nothing about where the time
   * went, so a bootstrap that ran an hour longer than the one before it could only be explained
   * by guessing which family had grown. These writes are the bulk of the build's wall clock and
   * the free tier is counted in operations, so both numbers are worth keeping.
   */
  const families: ShardPublishResult["families"] = [];
  /*
   * What this publish is occupying, counted as it goes.
   *
   * Exact rather than estimated: a `Stop` and a map-projection row differ by a factor of four, so
   * a record count says nothing useful about bytes. The index is written last and atomically, so a
   * build that runs past the ceiling is abandoned before it becomes live and the previous artifact
   * keeps serving — which is the only safe way to fail, given the bucket went over ten gigabytes
   * in run 53 and retention could only remove four objects a second.
   */
  let publishedBytes = 0;
  const publishFamily = async (name: string, shards: Shard[]): Promise<void> => {
    const began = Date.now();
    let biggest: ShardPublishResult["largest"][number] | null = null;
    let familyBytes = 0;

    const outcomes = await mapWithConcurrency(shards, TILE_PUBLISH_CONCURRENCY, async (shard) => {
      if (shard.lines.length === 0) return { dataset: shard.dataset, error: null };
      if (shard.records > MAX_SHARD_RECORDS) oversized.push(shard.dataset);

      /*
       * Fitting to the budget, one line at a time.
       *
       * A shard that overflows is truncated at a line boundary rather than failing the publish,
       * because the alternative is a national build losing everything over one dense tile. What
       * it must not be is silent: the drop is reported, and the families that can be ordered by
       * importance are, so what survives is what people are most likely to be looking at.
       */
      const kept: string[] = [];
      let bytes = 0;
      for (const line of shard.lines) {
        const size = utf8Bytes(line) + (kept.length === 0 ? 0 : 1);
        if (bytes + size > MAX_SHARD_BYTES) break;
        bytes += size;
        kept.push(line);
      }
      if (kept.length < shard.lines.length) {
        truncated.push({
          dataset: shard.dataset,
          dropped: shard.lines.length - kept.length,
          kept: kept.length,
        });
      }
      if (!biggest || bytes > biggest.bytes) {
        biggest = { dataset: shard.dataset, bytes, records: kept.length };
      }
      familyBytes += bytes;

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
        await store.put(objectKeyFor(shard.dataset, options.version), kept.join("\n"));
        return { dataset: shard.dataset, error: null };
      } catch (error) {
        return {
          dataset: shard.dataset,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    let familyFailed = 0;
    for (const outcome of outcomes) {
      if (outcome.error === null) published += 1;
      else {
        familyFailed += 1;
        failed.push({ dataset: outcome.dataset, reason: outcome.error });
      }
    }
    if (biggest) largest.push(biggest);
    families.push({
      name,
      objects: shards.length,
      failed: familyFailed,
      bytes: familyBytes,
      ms: Date.now() - began,
    });
    publishedBytes += familyBytes;
  };

  const stopShards = groupStopsByTile(network);
  const stopTiles = [...stopShards.keys()].sort();
  await publishFamily(
    "stops",
    [...stopShards].map(([tile, records]) => shardOf(stopTileDataset(tile), records)),
  );
  stopShards.clear();

  const locatorShards = groupLocators(network);
  await publishFamily(
    "locators",
    [...locatorShards].map(([bucket, records]) => shardOf(stopLocatorDataset(bucket), records)),
  );
  locatorShards.clear();

  const stopDetailShards = groupStopDetail(network);
  const stopDetailBuckets = [...stopDetailShards.keys()].sort((a, b) => a - b);
  await publishFamily(
    "stop-detail",
    [...stopDetailShards].map(([bucket, rows]) => shardOf(stopDetailDataset(bucket), rows)),
  );
  stopDetailShards.clear();

  const patternShards = groupPatternsByTile(network);
  const patternTiles = [...patternShards.keys()].sort();
  await publishFamily(
    "patterns",
    [...patternShards].map(([tile, lines]) => shardOf(patternTileDataset(tile), lines)),
  );
  patternShards.clear();

  await publishFamily("route-tiles", [shardOf(SHARDED.routeTiles, routeTileRecords(network))]);

  /*
   * The route-pattern index: one line per service, carrying that service's whole route.
   *
   * Route detail asked the geographic tiles for this, which meant opening every tile a service
   * crossed and parsing every other route in each of them. A cross-country service took the
   * isolate over its limit doing it. Here the whole route is one line of one object.
   */
  const routePatternShards = groupPatternsByService(network);
  const routePatternBuckets = ROUTE_PATTERN_BUCKETS;
  const routePatternShardList = [...routePatternShards.keys()].sort((a, b) => a - b);
  await publishFamily(
    "route-patterns",
    [...routePatternShards].map(([bucket, rows]) => ({
      dataset: routePatternsDataset(bucket),
      lines: routePatternsShardLines(rows),
      records: rows.length,
    })),
  );
  routePatternShards.clear();

  /*
   * The route names each stop has on it, filed on the stop grid.
   *
   * The map was answering "what routes call here" by reading pattern tiles, which carry geometry:
   * a dense one is 3,935,975 bytes against a three-mebibyte cap, so in Leeds the read truncated on
   * its first tile every time and every stop came back with no services on it. This is the answer
   * published as the answer — a list of names is tens of bytes where a polyline is megabytes — so
   * the map reads the tiles it was already reading and never opens a pattern tile at all.
   */
  const namesByStop = routeNamesByStop(network);

  const mapStopShards = groupMapStopsByTile(network, namesByStop);
  const mapStopTiles = [...mapStopShards.keys()].sort();
  await publishFamily(
    "map-stops",
    [...mapStopShards].map(([tile, rows]) => shardOf(mapStopsDataset(tile), rows)),
  );
  mapStopShards.clear();

  const stopRouteShards = groupStopRoutesByTile(network, namesByStop);
  const stopRouteTiles = [...stopRouteShards.keys()].sort();
  await publishFamily(
    "stop-routes",
    [...stopRouteShards].map(([tile, records]) => shardOf(stopRoutesDataset(tile), records)),
  );
  stopRouteShards.clear();

  /*
   * And every pattern by its own id, without its geometry.
   *
   * The planner reads `pattern.stopSequence` and never touches a shape, and it was getting that
   * from the corridor's pattern tiles against the same cap — so a Leeds corridor came back
   * incomplete and the planner refused to plan rather than plan on half of one. Trips name their
   * pattern, so the planner can ask for exactly the patterns its trips referenced.
   */
  const patternIndexShardMap = groupPatternIndexByBucket(network);
  const patternIndexShards = [...patternIndexShardMap.keys()].sort((a, b) => a - b);
  await publishFamily(
    "pattern-index-hashed",
    [...patternIndexShardMap].map(([bucket, rows]) => ({
      dataset: patternIndexDataset(bucket),
      lines: patternIndexShardLines(rows),
      records: rows.length,
    })),
  );
  patternIndexShardMap.clear();

  const patternIndexTileMap = groupPatternIndexByTile(network);
  const patternIndexTiles = [...patternIndexTileMap.keys()].sort();
  await publishFamily(
    "pattern-index-tiles",
    [...patternIndexTileMap].map(([tile, rows]) => ({
      dataset: patternIndexTileDataset(tile),
      lines: patternIndexShardLines(rows),
      records: rows.length,
    })),
  );
  patternIndexTileMap.clear();

  const searchEntries = buildSearchIndex(network, { builtAt: now().toISOString() }).entries;

  const searchTileShards = groupSearchByTile(searchEntries);
  const searchTiles = [...searchTileShards.keys()].sort();
  await publishFamily(
    "search-tiles",
    [...searchTileShards].map(([tile, records]) => shardOf(searchTileDataset(tile), records)),
  );
  searchTileShards.clear();

  const searchPrefixShards = groupSearchByPrefix(searchEntries);
  const searchPrefixes = [...searchPrefixShards.keys()].sort();
  await publishFamily(
    "search-prefixes",
    [...searchPrefixShards].map(([prefix, records]) =>
      shardOf(searchPrefixDataset(prefix), records),
    ),
  );
  searchPrefixShards.clear();

  const partial = { published, failed, oversized, truncated, largest, families, publishedBytes };

  if (publishedBytes > MAX_PUBLISH_BYTES) {
    /*
     * Abandoned before the index, so nothing published here is ever served. Raising the ceiling is
     * not the remedy: a publish this size means a family has grown and the question is which.
     */
    return {
      index: null,
      ...partial,
      failed: [
        ...failed,
        {
          dataset: SHARDED.index,
          reason:
            `this publish would occupy ${(publishedBytes / 1024 / 1024).toFixed(0)} MiB, past the ` +
            `${(MAX_PUBLISH_BYTES / 1024 / 1024).toFixed(0)} MiB one version may hold. The index ` +
            `was not written, so the previous artifact is still live.`,
        },
      ],
    };
  }

  if (failed.length > 0) {
    // The index is the pointer that makes a publish live. Withholding it when a shard failed
    // leaves the previous complete publish serving, rather than a version with holes in it.
    return { index: null, ...partial };
  }

  const index: NetworkIndexRecord = {
    version: options.version,
    // What this publish was stored with, so a reader checks rather than assumes. The grids are
    // compiled-in constants on both sides and they were trusted to agree because they came from
    // one codebase; the two are deployed independently, and when the trip grid halved the planner
    // reported England as having no timetable rather than reporting that it could not read one.
    layout: currentArtifactLayout(),
    publishedAt: now().toISOString(),
    partialCoverage: network.counts.danglingStopReferences > 0 || network.counts.parseErrors > 0,
    stopTiles,
    patternTiles,
    searchTiles,
    searchPrefixes,
    stopRouteTiles,
    mapStopTiles,
    stopDetailBuckets,
    patternIndexBuckets: PATTERN_INDEX_BUCKETS,
    patternIndexShards,
    patternIndexTiles,
    routePatternBuckets,
    routePatternShards: routePatternShardList,
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
    return { index: null, ...partial, failed };
  }

  return { index, ...partial, published: published + 1 };
}

function shardOf(dataset: string, records: readonly unknown[]): Shard {
  return {
    dataset,
    lines: records.map((record) => JSON.stringify(record)),
    records: records.length,
  };
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

/**
 * Pattern tiles, written as each shape once followed by the patterns that follow it.
 *
 * Patterns are grouped by the route they run along, and the groups are ordered by their longest
 * pattern. A tile that overflows therefore loses its most minor routes rather than an arbitrary
 * tail, and because a group's shape line precedes its patterns, a cut at any line boundary can
 * never separate a pattern from its geometry.
 */
function groupPatternsByTile(network: BuiltNetwork): Map<string, PatternTileLine[]> {
  const stopsById = new Map(network.stops.map((stop) => [stop.id, stop]));

  interface Group {
    shapeRef: string;
    shape: Coordinate[];
    patterns: PatternTileLine[];
    longest: number;
  }

  // Grouped nationally first, so a route's along-path distances are computed once rather than
  // once per tile it crosses.
  const groups = new Map<string, Group>();
  const tilesByGroup = new Map<string, string[]>();

  for (const pattern of network.patterns) {
    const shape = network.shapes.get(pattern.shapeRef);
    // A pattern with no geometry cannot be placed, and the map has nothing to draw for it. It
    // stays in the national dataset for the batch pipelines; it simply has no tile.
    if (!shape || shape.length < 2) continue;

    let group = groups.get(pattern.shapeRef);
    if (!group) {
      group = {
        shapeRef: pattern.shapeRef,
        shape: shape as Coordinate[],
        patterns: [],
        longest: 0,
      };
      groups.set(pattern.shapeRef, group);
      tilesByGroup.set(pattern.shapeRef, tilesForPattern(shape));
    }
    group.patterns.push({
      kind: "pattern",
      pattern,
      shapeRef: pattern.shapeRef,
      stopDistancesMetres: stopDistancesAlongShape(pattern, shape as Coordinate[], stopsById),
    });
    group.longest = Math.max(group.longest, pattern.stopSequence.length);
  }

  const byTile = new Map<string, Group[]>();
  for (const group of groups.values()) {
    for (const tile of tilesByGroup.get(group.shapeRef) ?? []) {
      const existing = byTile.get(tile);
      if (existing) existing.push(group);
      else byTile.set(tile, [group]);
    }
  }

  const lines = new Map<string, PatternTileLine[]>();
  for (const [tile, tileGroups] of byTile) {
    tileGroups.sort((a, b) => b.longest - a.longest);
    const out: PatternTileLine[] = [];
    for (const group of tileGroups) {
      out.push({ kind: "shape", shapeRef: group.shapeRef, points: group.shape });
      out.push(...group.patterns);
    }
    lines.set(tile, out);
  }
  return lines;
}

/**
 * The same patterns, filed by the service that runs them rather than by where they go.
 *
 * Each service's shapes are written once, before the patterns that name them, exactly as a tile
 * does — so `assemblePatternTile` reads either and the two forms cannot drift. A service appears
 * in exactly one bucket, so a route is always one object.
 */
function groupPatternsByService(network: BuiltNetwork): Map<number, RoutePatternsRow[]> {
  const stopsById = new Map(network.stops.map((stop) => [stop.id, stop]));

  const byService = new Map<string, { shapes: Set<string>; lines: PatternTileLine[] }>();
  for (const pattern of network.patterns) {
    const shape = network.shapes.get(pattern.shapeRef);
    if (!shape || shape.length < 2) continue;

    let entry = byService.get(pattern.serviceRouteId);
    if (!entry) {
      entry = { shapes: new Set<string>(), lines: [] };
      byService.set(pattern.serviceRouteId, entry);
    }
    if (!entry.shapes.has(pattern.shapeRef)) {
      entry.shapes.add(pattern.shapeRef);
      entry.lines.push({
        kind: "shape",
        shapeRef: pattern.shapeRef,
        points: shape as Coordinate[],
      });
    }
    entry.lines.push({
      kind: "pattern",
      pattern,
      shapeRef: pattern.shapeRef,
      stopDistancesMetres: stopDistancesAlongShape(pattern, shape as Coordinate[], stopsById),
    });
  }

  const buckets = new Map<number, RoutePatternsRow[]>();
  for (const [serviceId, entry] of byService) {
    const bucket = routePatternsBucketFor(serviceId);
    const rows = buckets.get(bucket);
    const row = { serviceId, lines: entry.lines };
    if (rows) rows.push(row);
    else buckets.set(bucket, [row]);
  }
  // Deterministic order, so the same network publishes byte-identical shards.
  for (const rows of buckets.values()) rows.sort((a, b) => (a.serviceId < b.serviceId ? -1 : 1));
  return buckets;
}

/**
 * Which route names call at each stop, on the stop grid.
 *
 * Walked once over the patterns rather than once per stop: a network holds tens of thousands of
 * patterns and hundreds of thousands of stops, and the per-stop version is the product of the two.
 * Names are deduplicated and sorted, so a marker's label is the same between requests rather than
 * reshuffling as the map refreshes.
 */
/**
 * The map projection: every stop a viewport can draw, with its route names beside it.
 *
 * Built from the same per-stop name index `groupStopRoutesByTile` uses, so the two families agree
 * by construction rather than by coincidence. Unlike that one, a stop with nothing calling at it
 * is still published — the map draws it, and an absent row would take it off the screen.
 */
function groupMapStopsByTile(
  network: BuiltNetwork,
  namesByStop: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, MapStopRow[]> {
  const byTile = new Map<string, MapStopRow[]>();
  for (const stop of network.stops) {
    const names = namesByStop.get(stop.id);
    const row: MapStopRow = {
      i: stop.id,
      a: stop.atcoCode,
      n: stop.name,
      y: stop.locationCoordinate.lat,
      x: stop.locationCoordinate.lon,
      ...(stop.indicator === undefined ? {} : { d: stop.indicator }),
      ...(names && names.size > 0 ? { r: [...names].sort() } : {}),
    };
    const tile = tileForStop(stop);
    const rows = byTile.get(tile);
    if (rows) rows.push(row);
    else byTile.set(tile, [row]);
  }
  // Deterministic order, so the same network publishes byte-identical shards.
  for (const rows of byTile.values()) rows.sort((a, b) => (a.i < b.i ? -1 : 1));
  return byTile;
}

/** The per-stop route names both the stop-routes family and the map projection are built from. */
function routeNamesByStop(network: BuiltNetwork): Map<string, Set<string>> {
  const serviceNames = new Map(network.services.map((service) => [service.id, service.publicName]));
  const namesByStop = new Map<string, Set<string>>();
  for (const pattern of network.patterns) {
    const name = serviceNames.get(pattern.serviceRouteId);
    // A pattern whose service is not in this build has no name to publish. Filing the id instead
    // would put a UUID on a bus stop.
    if (!name) continue;
    for (const stopId of pattern.stopSequence) {
      const names = namesByStop.get(stopId);
      if (names) names.add(name);
      else namesByStop.set(stopId, new Set([name]));
    }
  }
  return namesByStop;
}

function groupStopRoutesByTile(
  network: BuiltNetwork,
  namesByStop: ReadonlyMap<string, ReadonlySet<string>> = routeNamesByStop(network),
): Map<string, StopRoutesRow[]> {
  const byTile = new Map<string, StopRoutesRow[]>();
  for (const stop of network.stops) {
    const names = namesByStop.get(stop.id);
    // A stop nothing calls at publishes no row rather than an empty one: the map reads an absent
    // row as "no services here", which is the same answer for a fraction of the bytes.
    if (!names || names.size === 0) continue;
    const tile = tileForStop(stop);
    const row: StopRoutesRow = { s: stop.id, r: [...names].sort() };
    const rows = byTile.get(tile);
    if (rows) rows.push(row);
    else byTile.set(tile, [row]);
  }

  // Deterministic order, so the same network publishes byte-identical shards.
  for (const rows of byTile.values()) rows.sort((a, b) => (a.s < b.s ? -1 : 1));
  return byTile;
}

/**
 * Every pattern by its id, carrying what a planner needs and nothing else.
 *
 * No shape. `buildGraphFor` reads the stop sequence and never looks at geometry, and the geometry
 * is the whole reason the tiles are too big to read a corridor's worth of.
 */
/**
 * The same rows as `groupPatternIndexByBucket`, filed by the tiles the pattern runs through.
 *
 * A journey corridor wants the patterns along one strip of the country, and a hash scatters those
 * across every bucket — so the planner read one bucket per pattern and threw away almost all of
 * each. Filed geographically, a corridor reads the two or three tiles it crosses and wants most
 * of what is in them.
 *
 * A pattern crossing four tiles is written into all four, exactly as its geometry is: a corridor
 * must find it from whichever tile it enters on, and these rows are small enough that the
 * duplication is cheaper than the read it prevents.
 */
function groupPatternIndexByTile(network: BuiltNetwork): Map<string, PatternIndexRow[]> {
  const byTile = new Map<string, PatternIndexRow[]>();
  for (const pattern of network.patterns) {
    const shape = network.shapes.get(pattern.shapeRef);
    // No geometry means no tile to file it under; the hashed layout still carries it.
    if (!shape || shape.length < 2) continue;
    const row: PatternIndexRow = {
      id: pattern.id,
      serviceRouteId: pattern.serviceRouteId,
      direction: pattern.direction,
      stopSequence: [...pattern.stopSequence],
      distanceMetres: pattern.distanceMetres,
    };
    for (const tile of tilesForPattern(shape)) {
      const rows = byTile.get(tile);
      if (rows) rows.push(row);
      else byTile.set(tile, [row]);
    }
  }
  for (const rows of byTile.values()) rows.sort((a, b) => (a.id < b.id ? -1 : 1));
  return byTile;
}

function groupPatternIndexByBucket(network: BuiltNetwork): Map<number, PatternIndexRow[]> {
  const buckets = new Map<number, PatternIndexRow[]>();
  for (const pattern of network.patterns) {
    const row: PatternIndexRow = {
      id: pattern.id,
      serviceRouteId: pattern.serviceRouteId,
      direction: pattern.direction,
      stopSequence: [...pattern.stopSequence],
      distanceMetres: pattern.distanceMetres,
    };
    const bucket = patternIndexBucketFor(pattern.id);
    const rows = buckets.get(bucket);
    if (rows) rows.push(row);
    else buckets.set(bucket, [row]);
  }
  for (const rows of buckets.values()) rows.sort((a, b) => (a.id < b.id ? -1 : 1));
  return buckets;
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
  // Ordered so a tile that has to be truncated keeps the places people are most likely to mean.
  for (const bucket of byTile.values()) bucket.sort((a, b) => b.prominence - a.prominence);
  return byTile;
}

/**
 * Words that say where a stop is not.
 *
 * A national publish measured what happens without this: the "ro" bucket held 79,298 entries and
 * could publish 32,168 of them, and "st" was the same story. Both are one word — nearly every
 * stop in England is on a Road or a Street, so those words place a stop in the country rather
 * than on a map, and indexing by them costs more than every distinctive word put together.
 *
 * They are removed from the *index*, not from the entry: the tokens stay, so "Armley Road" still
 * scores higher for the full phrase than "Armley Lane" does. And an entry with nothing else to
 * index by — a stop actually called "The Green" — keeps them, because being findable by a poor
 * word beats not being findable at all.
 */
const GENERIC_NAME_WORDS = new Set([
  "road",
  "street",
  "lane",
  "avenue",
  "close",
  "drive",
  "way",
  "court",
  "place",
  "terrace",
  "gardens",
  "crescent",
  "grove",
  "walk",
  "row",
  "rise",
  "view",
  "the",
  "of",
  "and",
  "at",
  "on",
  "opposite",
  "adjacent",
  "near",
  "outside",
  "corner",
  "junction",
  "stop",
  "bus",
  "stand",
  "bay",
]);

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
    for (const word of indexWordsFor(entry)) keys.add(searchPrefixFor(word));
    for (const key of keys) {
      const existing = byPrefix.get(key);
      if (existing) existing.push(entry);
      else byPrefix.set(key, [entry]);
    }
  }

  /*
   * A letter that will not fit is split rather than truncated, as many times as it takes.
   *
   * Two characters suits most of the alphabet and not all of it: "bo" held 69,659 entries where
   * most buckets hold a few hundred. One extra character is not always enough either — every
   * London ATCO code begins 490, so splitting "49" produced "490" and moved the whole city one
   * character sideways. So the split repeats until each bucket fits or its keys stop growing,
   * and the index records the depth each letter reached so the edge does not have to guess.
   */
  let split = byPrefix;
  for (let length = SEARCH_PREFIX_LENGTH + 1; length <= SEARCH_MAX_PREFIX_LENGTH; length++) {
    let anyOversized = false;
    const deepened = new Map<string, SearchIndexEntry[]>();
    for (const [key, bucket] of split) {
      if (bucket.length <= SEARCH_BUCKET_SPLIT_AT || key.length !== length - 1) {
        deepened.set(key, bucket);
        continue;
      }
      for (const entry of bucket) {
        for (const deeper of deeperPrefixesFor(entry, key, length)) {
          const existing = deepened.get(deeper);
          if (existing) existing.push(entry);
          else deepened.set(deeper, [entry]);
        }
      }
      anyOversized = true;
    }
    split = deepened;
    // Nothing at this depth needed splitting, so nothing deeper will either.
    if (!anyOversized) break;
  }

  /*
   * A bucket the prefix could not divide is divided by hash instead.
   *
   * Deepening takes more characters of the word, which assumes the words differ somewhere further
   * along. They do not always: "Northbound", "Southbound" and their kind tokenise to a word that
   * normalises to `bound`, padded to the six-character maximum as `bound_`, so every entry
   * produces the identical deeper key however far the loop goes. The loop then gave up and the
   * publisher truncated to fit the byte budget — 65,573 entries in that one bucket, 31,385 kept,
   * 34,188 dropped, and the drop reported as a statistic rather than as a fault.
   *
   * Splitting by a hash of the entry's own id has none of the prefix's assumptions: it divides
   * any bucket, into as many parts as it takes, deterministically, and a reader finds the parts
   * because they are named from the prefix they came from.
   */
  const partitioned = new Map<string, SearchIndexEntry[]>();
  for (const [key, bucket] of split) {
    if (bucket.length <= SEARCH_BUCKET_SPLIT_AT) {
      partitioned.set(key, bucket);
      continue;
    }
    const parts = Math.ceil(bucket.length / SEARCH_BUCKET_SPLIT_AT);
    for (const entry of bucket) {
      const partKey = searchPartKey(key, locatorBucketFor(entry.id, parts));
      const existing = partitioned.get(partKey);
      if (existing) existing.push(entry);
      else partitioned.set(partKey, [entry]);
    }
  }

  // Sorted rather than truncated arbitrarily: what survives a full bucket should be what people
  // mean by the word they typed.
  for (const bucket of partitioned.values()) bucket.sort((a, b) => b.prominence - a.prominence);
  return partitioned;
}

/**
 * The words an entry is reachable by. One definition, used both when filing an entry and when a
 * full bucket is split, because a split that used a different set would file an entry under a
 * word the edge will never look it up by.
 */
function indexWordsFor(entry: SearchIndexEntry): string[] {
  /*
   * A single letter is not a search term either, and removing the generic words made it the only
   * indexable word for a great many stops: NaPTAN is full of "Stop S" and "Stand K", and with
   * "stop" and "stand" gone what remained was "s". A national publish put 31,407 entries in one
   * bucket that way, and no amount of splitting helps when every entry shares the same one-letter
   * word. Such a stop stays findable by its code, by the tile it is in and by "stops near me" —
   * which is how anyone would actually look for it.
   */
  const distinctive = entry.tokens.filter(
    (token) => token.length > 1 && !GENERIC_NAME_WORDS.has(token.toLowerCase()),
  );
  return [...(distinctive.length > 0 ? distinctive : entry.tokens), ...entry.codes];
}

/**
 * Every deeper bucket an entry belongs in once its shallow one has been split.
 *
 * All of them, not the first: a stop called "Bolton Bond Street" reaches "bo" by two different
 * words, and filing it under only one means the other word finds nothing. That failure is silent
 * — an empty result, not an error — which is the kind this sharding keeps producing.
 */
function deeperPrefixesFor(entry: SearchIndexEntry, shallowKey: string, length: number): string[] {
  const deeper = new Set<string>();
  for (const word of indexWordsFor(entry)) {
    if (searchPrefixFor(word, shallowKey.length) === shallowKey) {
      deeper.add(searchPrefixFor(word, length));
    }
  }
  // Only reachable if the bucket key came from somewhere other than this entry's own words.
  if (deeper.size === 0) deeper.add(searchPrefixFor(shallowKey, length));
  return [...deeper];
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

/**
 * The stop page's lookup. See `STOP_DETAIL_BUCKETS` for why it is hashed rather than geographic.
 *
 * The stop is filed once under its id; its ATCO code gets an alias row rather than a second copy.
 */
function groupStopDetail(network: BuiltNetwork): Map<number, StopDetailRow[]> {
  const byBucket = new Map<number, StopDetailRow[]>();
  const add = (bucket: number, row: StopDetailRow) => {
    const rows = byBucket.get(bucket);
    if (rows) rows.push(row);
    else byBucket.set(bucket, [row]);
  };

  for (const stop of network.stops) {
    add(stopDetailBucketFor(stop.id), { k: stop.id, s: stop });
    if (stop.atcoCode !== stop.id) {
      add(stopDetailBucketFor(stop.atcoCode), { k: stop.atcoCode, a: stop.id });
    }
  }
  // Deterministic order, so the same network publishes byte-identical shards.
  for (const rows of byBucket.values()) rows.sort((a, b) => (a.k < b.k ? -1 : 1));
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
