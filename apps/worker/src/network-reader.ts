import type { Coordinate, Operator, RoutePattern, ServiceRoute, Stop } from "@busstops/contracts";
import {
  ArtifactStore,
  objectKeyFor,
  type ObjectStore,
  haversineMetres,
  tilesForBoundingBox,
} from "@busstops/pipeline-core";
import {
  DATASETS,
  SHARDED,
  type NetworkIndexRecord,
  type PatternTileLine,
  type PatternTileRecord,
  type RouteTileRecord,
  type SearchHit,
  type SearchIndexEntry,
  type StopLocatorRecord,
  assemblePatternTile,
  locatorBucketFor,
  nearbyStops,
  patternTileDataset,
  searchIndex as rankSearch,
  searchPrefixDataset,
  searchPrefixFor,
  searchTileDataset,
  stopLocatorDataset,
  stopTileDataset,
  tokenize,
} from "@busstops/pipeline-static-network";
import type { PatternGeometry } from "@busstops/matching";

/**
 * Bounded reads of the published network.
 *
 * This replaces a repository that loaded the national network into the isolate. Measured against
 * real data that was never going to work: journeys 292 MiB, stops 198 MiB, patterns 100 MiB and
 * the search index 87 MiB, against a Workers isolate of 128 MiB. Every endpoint that loaded the
 * snapshot answered 500; every endpoint that did not, worked.
 *
 * So nothing here reads a national dataset. A viewport reads the tiles it covers, a stop page
 * reads one locator bucket and one tile, a search reads the prefix buckets its words fall in.
 * The only whole datasets are operators and services, which are 22 and 1,043 records — and a test
 * asserts they stay small rather than trusting that they will.
 *
 * **Versioning.** The index record is read first and names the version; every shard is then read
 * at that exact version rather than through its own manifest pointer. A publish writes shards
 * first and the index last, so a version that is visible is complete, and a reader mid-publish
 * simply keeps serving the previous one. Without this a request could pair a stop tile from one
 * publish with a pattern tile from the next and see a route referencing stops that are not there.
 */

/**
 * Cached shards are capped by count and by size, not just by age.
 *
 * An unbounded cache would refill the isolate with the national network one tile at a time and
 * reintroduce exactly the failure this class exists to prevent — slowly enough that it would look
 * like an unrelated intermittent 500. A count on its own does not prevent that: twenty-four dense
 * city tiles are a different quantity of memory from twenty-four rural ones, so the cache also
 * carries a budget in characters of the source text it parsed.
 *
 * The budget is deliberately a small fraction of the isolate's 128 MiB, because the parsed objects
 * are several times the size of the text they came from and a request needs room to work on top of
 * whatever is resident.
 */
const MAX_CACHED_SHARDS = 24;
const MAX_CACHED_SHARD_CHARS = 12 * 1024 * 1024;

const INDEX_TTL_MS = 5 * 60 * 1000;

interface CachedShard {
  records: unknown[];
  /** Length of the text this shard was parsed from, which is what the budget is spent in. */
  chars: number;
  usedAt: number;
}

/** What a bounded area's worth of network looks like to code that does not read shards. */
export interface NetworkSlice {
  stopsById: ReadonlyMap<string, Stop>;
  patternsById: ReadonlyMap<string, RoutePattern>;
  services: ReadonlyMap<string, ServiceRoute>;
}

export interface StopsInViewport {
  stops: Stop[];
  truncated: boolean;
}

export class NetworkReader {
  private index: NetworkIndexRecord | null = null;
  private indexLoadedAt = 0;
  private indexInFlight: Promise<NetworkIndexRecord | null> | null = null;

  private readonly shards = new Map<string, CachedShard>();

  private operatorsCache: Map<string, Operator> | null = null;
  private servicesCache: Map<string, ServiceRoute> | null = null;
  private routeTilesCache: Map<string, string[]> | null = null;

  constructor(
    private readonly store: ObjectStore,
    private readonly ttlMs = 15 * 60 * 1000,
  ) {}

  /** The version pointer. Null when nothing has been published, so callers degrade visibly. */
  async networkIndex(now: number = Date.now()): Promise<NetworkIndexRecord | null> {
    if (this.index && now - this.indexLoadedAt < INDEX_TTL_MS) return this.index;
    if (this.indexInFlight) return this.indexInFlight;

    this.indexInFlight = (async () => {
      const artifacts = new ArtifactStore(this.store);
      const result = await artifacts.readCurrent<NetworkIndexRecord>(SHARDED.index);
      const record = result.records[0] ?? null;
      if (record) {
        // A new version invalidates every cached shard at once: mixing versions is the one thing
        // the pinning is there to prevent.
        if (this.index && this.index.version !== record.version) this.shards.clear();
        this.index = record;
        this.indexLoadedAt = now;
      }
      return record;
    })().finally(() => {
      this.indexInFlight = null;
    });

    return this.indexInFlight;
  }

  /** Reads one shard at the pinned version. Missing shards are empty, not an error. */
  private async readShard<T>(dataset: string, version: string, now: number): Promise<T[]> {
    const key = `${version}:${dataset}`;
    const cached = this.shards.get(key);
    if (cached && now - cached.usedAt < this.ttlMs) {
      cached.usedAt = now;
      return cached.records as T[];
    }

    const raw = await this.store.get(objectKeyFor(dataset, version));
    const records: T[] =
      raw === null
        ? []
        : raw
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as T);

    this.shards.set(key, { records, chars: raw?.length ?? 0, usedAt: now });
    this.evictShards();
    return records;
  }

  /**
   * Least-recently-used eviction, so the cache is a working set rather than an accumulation.
   *
   * Both bounds are enforced from the same pass: oldest first until the count fits, then oldest
   * first again until the size does. The most recently used shard is never evicted, because it is
   * the one the request in flight is reading.
   */
  private evictShards(): void {
    if (this.shards.size <= MAX_CACHED_SHARDS && this.cachedShardChars <= MAX_CACHED_SHARD_CHARS) {
      return;
    }
    const byAge = [...this.shards].sort((a, b) => a[1].usedAt - b[1].usedAt);
    let chars = this.cachedShardChars;
    for (const [key, shard] of byAge.slice(0, -1)) {
      if (this.shards.size <= MAX_CACHED_SHARDS && chars <= MAX_CACHED_SHARD_CHARS) break;
      this.shards.delete(key);
      chars -= shard.chars;
    }
  }

  /** How many shards are resident. Exposed so a test can prove the cache stays bounded. */
  get cachedShardCount(): number {
    return this.shards.size;
  }

  /** How much source text the resident shards were parsed from, in characters. */
  get cachedShardChars(): number {
    let total = 0;
    for (const shard of this.shards.values()) total += shard.chars;
    return total;
  }

  private async readTiles<T>(
    dataset: (tile: string) => string,
    tiles: readonly string[],
    available: readonly string[],
    version: string,
    now: number,
  ): Promise<T[]> {
    // Only tiles the publish actually wrote are requested: asking for the rest would be a read
    // operation per empty tile, metered, for a guaranteed miss.
    const present = new Set(available);
    const wanted = tiles.filter((tile) => present.has(tile));
    const results = await Promise.all(
      wanted.map((tile) => this.readShard<T>(dataset(tile), version, now)),
    );
    return results.flat();
  }

  /**
   * Every stop in the given tiles.
   *
   * Uncapped, because the bound is the tile list: callers pass tiles they have already limited
   * (a viewport, or a journey corridor the planner caps at a handful of tiles), and truncating
   * inside a corridor would silently remove places a journey could legitimately board at.
   */
  async stopsInTiles(tiles: readonly string[], now: number = Date.now()): Promise<Stop[]> {
    const index = await this.networkIndex(now);
    if (!index) return [];
    return this.readTiles<Stop>(stopTileDataset, tiles, index.stopTiles, index.version, now);
  }

  async patternsInTiles(
    tiles: readonly string[],
    now: number = Date.now(),
  ): Promise<PatternGeometry[]> {
    const index = await this.networkIndex(now);
    if (!index) return [];
    const lines = await this.readTiles<PatternTileLine>(
      patternTileDataset,
      tiles,
      index.patternTiles,
      index.version,
      now,
    );
    return toGeometries(assemblePatternTile(lines));
  }

  /**
   * The slice of network a bounded area needs: its stops, its patterns, and the national service
   * list, which is small enough to hold whole.
   *
   * Journey planning wants all three keyed by id, and assembling them here keeps the planner from
   * needing to know anything about shards.
   */
  async sliceForBoundingBox(
    bbox: { west: number; south: number; east: number; north: number },
    now: number = Date.now(),
  ): Promise<NetworkSlice> {
    const tiles = tilesForBoundingBox(bbox);
    const [stops, patterns, services] = await Promise.all([
      this.stopsInTiles(tiles, now),
      this.patternsInTiles(tiles, now),
      this.services(now),
    ]);
    return {
      stopsById: new Map(stops.map((stop) => [stop.id, stop])),
      patternsById: new Map(patterns.map((geometry) => [geometry.pattern.id, geometry.pattern])),
      services,
    };
  }

  async stopsInBoundingBox(
    bbox: { west: number; south: number; east: number; north: number },
    limit: number,
    now: number = Date.now(),
  ): Promise<StopsInViewport> {
    const stops = await this.stopsInTiles(tilesForBoundingBox(bbox), now);

    const inside = stops.filter((stop) => {
      const { lat, lon } = stop.locationCoordinate;
      return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
    });

    if (inside.length <= limit) return { stops: inside, truncated: false };

    // When capped, keep the stops nearest the viewport centre: they are what the user is looking
    // at, and an arbitrary slice would drop the middle of the screen.
    const centre = { lat: (bbox.north + bbox.south) / 2, lon: (bbox.east + bbox.west) / 2 };
    const ranked = inside
      .map((stop) => ({ stop, distance: haversineMetres(centre, stop.locationCoordinate) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit)
      .map((entry) => entry.stop);

    return { stops: ranked, truncated: true };
  }

  /** Resolves a stop id or ATCO code through one locator bucket and one stop tile. */
  async stopByKey(key: string, now: number = Date.now()): Promise<Stop | null> {
    const found = await this.stopsByKeys([key], now);
    return found.get(key) ?? null;
  }

  /**
   * Several identifiers at once, reading each locator bucket and stop tile only once.
   *
   * A departure board names its stop, a journey names every stop on the leg; resolving them one
   * at a time would be a read per stop for data that mostly shares a handful of tiles.
   */
  async stopsByKeys(keys: readonly string[], now: number = Date.now()): Promise<Map<string, Stop>> {
    const resolved = new Map<string, Stop>();
    const index = await this.networkIndex(now);
    if (!index || keys.length === 0) return resolved;

    const buckets = new Set(keys.map((key) => locatorBucketFor(key)));
    const locatorRows = await Promise.all(
      [...buckets].map((bucket) =>
        this.readShard<StopLocatorRecord>(stopLocatorDataset(bucket), index.version, now),
      ),
    );

    const wanted = new Set(keys);
    const tileByKey = new Map<string, string>();
    for (const row of locatorRows.flat()) {
      if (wanted.has(row.key)) tileByKey.set(row.key, row.tile);
    }
    if (tileByKey.size === 0) return resolved;

    const tiles = [...new Set(tileByKey.values())];
    const stops = await this.readTiles<Stop>(
      stopTileDataset,
      tiles,
      index.stopTiles,
      index.version,
      now,
    );

    const byId = new Map<string, Stop>();
    const byAtco = new Map<string, Stop>();
    for (const stop of stops) {
      byId.set(stop.id, stop);
      byAtco.set(stop.atcoCode, stop);
    }
    for (const key of keys) {
      const stop = byId.get(key) ?? byAtco.get(key);
      if (stop) resolved.set(key, stop);
    }
    return resolved;
  }

  /** Pattern geometries covering a viewport, for matching live vehicles to routes. */
  async patternsInBoundingBox(
    bbox: { west: number; south: number; east: number; north: number },
    now: number = Date.now(),
  ): Promise<PatternGeometry[]> {
    return this.patternsInTiles(tilesForBoundingBox(bbox), now);
  }

  /** Every pattern of one service, read from the tiles that service is known to touch. */
  async patternsForService(
    serviceId: string,
    now: number = Date.now(),
  ): Promise<PatternGeometry[]> {
    const index = await this.networkIndex(now);
    if (!index) return [];
    const routeTiles = await this.routeTiles(now);
    const tiles = routeTiles.get(serviceId) ?? [];
    if (tiles.length === 0) return [];

    const lines = await this.readTiles<PatternTileLine>(
      patternTileDataset,
      tiles,
      index.patternTiles,
      index.version,
      now,
    );
    const records = assemblePatternTile(lines);
    return toGeometries(records.filter((r) => r.pattern.serviceRouteId === serviceId));
  }

  /** Patterns calling at a stop, found from the tiles around it rather than nationally. */
  async patternsServingStop(stop: Stop, now: number = Date.now()): Promise<PatternGeometry[]> {
    const geometries = await this.patternsInBoundingBox(boxAround(stop.locationCoordinate), now);
    return geometries.filter((geometry) => geometry.pattern.stopSequence.includes(stop.id));
  }

  async operators(now: number = Date.now()): Promise<Map<string, Operator>> {
    if (this.operatorsCache) return this.operatorsCache;
    const artifacts = new ArtifactStore(this.store);
    const result = await artifacts.readCurrent<Operator>(DATASETS.operators);
    void now;
    this.operatorsCache = new Map(result.records.map((o) => [o.id, o]));
    return this.operatorsCache;
  }

  async services(now: number = Date.now()): Promise<Map<string, ServiceRoute>> {
    if (this.servicesCache) return this.servicesCache;
    const artifacts = new ArtifactStore(this.store);
    const result = await artifacts.readCurrent<ServiceRoute>(DATASETS.services);
    void now;
    this.servicesCache = new Map(result.records.map((s) => [s.id, s]));
    return this.servicesCache;
  }

  private async routeTiles(now: number): Promise<Map<string, string[]>> {
    if (this.routeTilesCache) return this.routeTilesCache;
    const index = await this.networkIndex(now);
    if (!index) return new Map();
    const records = await this.readShard<RouteTileRecord>(SHARDED.routeTiles, index.version, now);
    this.routeTilesCache = new Map(records.map((r) => [r.serviceId, r.tiles]));
    return this.routeTilesCache;
  }

  /**
   * Search over the prefix buckets the query's words fall in.
   *
   * The ranking is the same code the national index used; only the candidate set is bounded. A
   * word is indexed under its own first two characters, so "armley" finds "Leeds Armley Road"
   * without the searcher having to start at the beginning of the name.
   */
  async search(
    query: string,
    options: { limit: number; near?: Coordinate },
    now: number = Date.now(),
  ): Promise<{ hits: SearchHit[]; builtAt: string } | null> {
    const index = await this.networkIndex(now);
    if (!index) return null;

    const words = tokenize(query);
    const prefixes = new Set(words.map((word) => searchPrefixFor(word)));
    // A query of only stop-words still deserves an answer rather than an error; its raw form is
    // the best available key.
    if (prefixes.size === 0) prefixes.add(searchPrefixFor(query));

    const available = new Set(index.searchPrefixes);
    const wanted = [...prefixes].filter((prefix) => available.has(prefix));
    const buckets = await Promise.all(
      wanted.map((prefix) =>
        this.readShard<SearchIndexEntry>(searchPrefixDataset(prefix), index.version, now),
      ),
    );

    // One entry can sit in several buckets when its words start differently; dedupe before
    // ranking so a multi-word match is not counted twice.
    const unique = new Map<string, SearchIndexEntry>();
    for (const entry of buckets.flat()) unique.set(`${entry.kind}:${entry.id}`, entry);

    const hits = rankSearch(
      { entries: [...unique.values()], builtAt: index.publishedAt },
      query,
      options.near === undefined
        ? { limit: options.limit }
        : { limit: options.limit, near: options.near },
    );
    return { hits, builtAt: index.publishedAt };
  }

  /** Stops near a point, from the tiles around it. */
  async nearby(
    coordinate: Coordinate,
    options: { radiusMetres: number; limit: number },
    now: number = Date.now(),
  ): Promise<{ hits: SearchHit[]; builtAt: string } | null> {
    const index = await this.networkIndex(now);
    if (!index) return null;

    const entries = await this.readTiles<SearchIndexEntry>(
      searchTileDataset,
      tilesForBoundingBox(boxAround(coordinate, options.radiusMetres)),
      index.searchTiles,
      index.version,
      now,
    );

    const hits = nearbyStops({ entries, builtAt: index.publishedAt }, coordinate, options);
    return { hits, builtAt: index.publishedAt };
  }
}

function toGeometries(records: readonly PatternTileRecord[]): PatternGeometry[] {
  const seen = new Set<string>();
  const geometries: PatternGeometry[] = [];
  for (const record of records) {
    // A pattern spanning tiles is written to each of them, so the same one arrives more than once
    // when a viewport covers several.
    if (seen.has(record.pattern.id)) continue;
    seen.add(record.pattern.id);
    geometries.push({
      pattern: record.pattern,
      shape: record.shape,
      stopDistancesMetres: record.stopDistancesMetres,
    });
  }
  return geometries;
}

/** A small box around a point, wide enough to catch a route passing just outside it. */
function boxAround(coordinate: Coordinate, marginMetres = 1_500) {
  const latMargin = marginMetres / 111_320;
  const lonMargin =
    marginMetres / (111_320 * Math.max(0.1, Math.cos((coordinate.lat * Math.PI) / 180)));
  return {
    south: coordinate.lat - latMargin,
    north: coordinate.lat + latMargin,
    west: coordinate.lon - lonMargin,
    east: coordinate.lon + lonMargin,
  };
}
