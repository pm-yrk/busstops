import type { Coordinate, RoutePattern, Stop } from "@busstops/contracts";
import type { BoundingBox } from "@busstops/contracts";
import { tileIdFor, tilesForBoundingBox, tilesForCoordinates } from "@busstops/pipeline-core";
import type { SearchIndexEntry } from "./search-index.js";

/**
 * Shard addressing for the published network.
 *
 * A Workers isolate has 128 MiB. Measured against real national data, the datasets a passenger
 * query touches are far past that on their own — journeys 292 MiB, stops 198 MiB, patterns
 * 100 MiB, the search index 87 MiB — so the edge cannot hold the national network at all, and
 * every request that tried answered 500.
 *
 * The fix is the one this pipeline already chose for journeys: publish per shard and read only
 * the shards a request spans. A viewport needs the stops inside it, not all 349,531; a stop page
 * needs one stop; a search needs the entries whose words could match.
 *
 * Two shard kinds, because queries arrive two ways:
 *
 * - **Spatial**, for anything with a location: stops, patterns, journeys and the nearby index.
 *   Keyed by the same half-degree tile the journey tiles already use.
 * - **By key**, for anything arriving as an identifier with no location: a stop id, an ATCO code,
 *   a search word. Keyed by a hash or prefix bucket, so a lookup reads exactly one small object.
 */

export const SHARDED = {
  /** One record naming the version every other shard in this publish belongs to. */
  index: "network/index",
  stopTile: "network/stops-tile",
  patternTile: "network/patterns-tile",
  searchTile: "network/search-tile",
  searchPrefix: "network/search-prefix",
  stopLocator: "network/stop-locator",
  routeTiles: "network/route-tiles",
} as const;

/**
 * Locator buckets. 349,531 stops indexed twice (by id and by ATCO code) is ~700,000 keys; at 256
 * buckets that is ~2,700 rows each, a few hundred kilobytes. Enough buckets that one is trivial
 * to parse, few enough that publishing them is not itself a cost.
 */
export const LOCATOR_BUCKETS = 256;

/**
 * Search words are bucketed by their first two characters. One character would put every word
 * beginning "a" in a single shard — around a sixth of a national index, which is exactly the
 * failure being fixed. Two gives roughly a thousand possible buckets and a few hundred rows each.
 */
export const SEARCH_PREFIX_LENGTH = 2;

/**
 * A shard that grew without bound would reintroduce the original defect quietly, so each is
 * capped. The cap is high enough that no real bucket approaches it and low enough that hitting it
 * cannot exhaust an isolate; publishing records when it bites, rather than silently truncating.
 */
export const MAX_SHARD_RECORDS = 20_000;

/**
 * The cap that actually matters, because a record count is not a size.
 *
 * A national publish stopped on two shards that were inside the record cap and still impossible:
 * one threw `Invalid string length` while being serialised, meaning the text had passed the
 * largest string the runtime can hold, and object storage refused the other with 413. Neither
 * limit knows anything about how many records went into the body — so the bound has to be on the
 * bytes, measured on the exact text that gets written.
 *
 * Eight mebibytes is comfortably under both what object storage accepts in one request and what
 * an isolate can afford to parse for a viewport that spans several tiles.
 */
export const MAX_SHARD_BYTES = 8 * 1024 * 1024;

/**
 * Tile sizes, per family, chosen from what a national publish actually weighed rather than from
 * one number reused everywhere.
 *
 * At the half-degree the journey tiles use, the first complete publish reported the cost: the
 * London stop tile came to 8 MiB and had to drop 230 real stops, and one West Yorkshire pattern
 * tile held 11,420 patterns and could publish 1,407 of them. Both are coverage holes in the
 * densest places, which is precisely where they are noticed.
 *
 * Stops divide cleanly by area, so a quarter degree takes the worst tile to about a quarter of
 * the budget. Patterns do not: a route is written to every tile it crosses, so a finer grid also
 * multiplies the copies. An eighth of a degree is the point where the densest tile fits with room
 * left, at the cost of geometry stored roughly four times over — which is cheap in object storage
 * and is the thing the edge never has to read all of.
 *
 * Journey tiles keep the half degree they were published with; nothing here changes them.
 */
export const STOP_TILE_DEGREES = 0.25;
export const PATTERN_TILE_DEGREES = 0.125;

export function stopTileDataset(tile: string): string {
  return `${SHARDED.stopTile}/${tile}`;
}

export function patternTileDataset(tile: string): string {
  return `${SHARDED.patternTile}/${tile}`;
}

export function searchTileDataset(tile: string): string {
  return `${SHARDED.searchTile}/${tile}`;
}

export function searchPrefixDataset(prefix: string): string {
  return `${SHARDED.searchPrefix}/${prefix}`;
}

export function stopLocatorDataset(bucket: number): string {
  return `${SHARDED.stopLocator}/${bucket}`;
}

/**
 * FNV-1a over the key, so a lookup computes its bucket without consulting anything. The hash only
 * has to spread evenly; it is not a checksum and nothing depends on its exact value beyond both
 * sides computing it identically, which is what the shared implementation is for.
 */
export function locatorBucketFor(key: string, buckets = LOCATOR_BUCKETS): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % buckets;
}

/**
 * The bucket a search word belongs to. Words shorter than the prefix are padded rather than given
 * their own scheme, so every word has exactly one bucket and lookup never has to special-case.
 */
export function searchPrefixFor(token: string, length = SEARCH_PREFIX_LENGTH): string {
  const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length === 0) return "_".repeat(length);
  return normalized.slice(0, length).padEnd(length, "_");
}

/** What the edge needs to resolve an identifier to the shard holding it. */
export interface StopLocatorRecord {
  /** A stop id or an ATCO code; both resolve to the same tile. */
  key: string;
  tile: string;
}

/**
 * A pattern travels with its shape and its along-path stop distances.
 *
 * The distances are computed here rather than at the edge because they are a property of static
 * data that cannot change between publishes, and computing them at request time would mean
 * looking up every stop in the sequence — stops that may live in neighbouring tiles, turning one
 * bounded read into an unbounded fan-out.
 */
export interface PatternTileRecord {
  pattern: RoutePattern;
  shape: Coordinate[];
  stopDistancesMetres: number[];
}

/**
 * How a pattern tile is stored: each shape once, followed by the patterns that follow it.
 *
 * A route's geometry is shared by every pattern on it — the patterns differ in which stops they
 * call at, not in where the road goes — so writing the polyline into each of them multiplied a
 * dense tile by the number of patterns per route. The reader puts the two back together, so the
 * saving costs nothing anywhere else.
 *
 * A shape line always precedes the patterns that name it. That ordering is what makes truncating
 * a shard at any line boundary safe: the tail can lose patterns, and at worst leave behind a
 * shape nothing references, but it can never leave a pattern whose geometry has gone.
 */
export type PatternTileLine =
  | { kind: "shape"; shapeRef: string; points: Coordinate[] }
  | {
      kind: "pattern";
      pattern: RoutePattern;
      shapeRef: string;
      stopDistancesMetres: number[];
    };

/**
 * Rebuilds the tile's patterns from its lines.
 *
 * Lives beside the writer rather than in the reader so the two cannot drift: a change to the
 * stored form has to pass through this function, which both sides use.
 */
export function assemblePatternTile(lines: readonly PatternTileLine[]): PatternTileRecord[] {
  const shapes = new Map<string, Coordinate[]>();
  const records: PatternTileRecord[] = [];
  for (const line of lines) {
    if (line.kind === "shape") {
      shapes.set(line.shapeRef, line.points);
      continue;
    }
    const shape = shapes.get(line.shapeRef);
    // Only reachable if a shard were truncated between a shape and its patterns, which the write
    // order prevents. Dropping the pattern is right either way: a route line with no geometry has
    // nothing to draw and nothing to match a vehicle against.
    if (!shape) continue;
    records.push({
      pattern: line.pattern,
      shape,
      stopDistancesMetres: line.stopDistancesMetres,
    });
  }
  return records;
}

/** Which tiles a service's patterns touch, so route detail reads those and no others. */
export interface RouteTileRecord {
  serviceId: string;
  tiles: string[];
}

/**
 * The version pointer every other shard is read against.
 *
 * Without it a request could read a stop tile from one publish and a pattern tile from the next,
 * and see a pattern referencing a stop that the tile it holds does not contain. One small record,
 * read first, pins every subsequent read to a single consistent publish.
 */
export interface NetworkIndexRecord {
  version: string;
  publishedAt: string;
  partialCoverage: boolean;
  /** Tiles that actually have stops, so the edge never requests an object that cannot exist. */
  stopTiles: string[];
  patternTiles: string[];
  searchTiles: string[];
  searchPrefixes: string[];
  counts: { stops: number; patterns: number; services: number; searchEntries: number };
}

export function tileForStop(stop: Stop): string {
  return tileIdFor(stop.locationCoordinate, STOP_TILE_DEGREES);
}

/**
 * Tiles ordered outwards from the middle of the box.
 *
 * The edge reads until a byte budget runs out, so the order decides what a request keeps when a
 * viewport is larger than it can afford. The middle of the screen is what someone is looking at,
 * so that is what is read first and the far corners are what go.
 */
function centreOut(bbox: BoundingBox, sizeDegrees: number): string[] {
  const centreLat = (bbox.south + bbox.north) / 2 / sizeDegrees;
  const centreLon = (bbox.west + bbox.east) / 2 / sizeDegrees;
  return tilesForBoundingBox(bbox, sizeDegrees)
    .map((tile) => {
      const [lat, lon] = tile.split("_").map(Number) as [number, number];
      // Tile indices, so the distance is in tiles and the grid size cancels out.
      const dLat = lat + 0.5 - centreLat;
      const dLon = lon + 0.5 - centreLon;
      return { tile, distance: dLat * dLat + dLon * dLon };
    })
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => entry.tile);
}

/** The stop tiles a viewport covers. Used by the edge, so the sizes cannot drift between sides. */
export function stopTilesForBoundingBox(bbox: BoundingBox): string[] {
  return centreOut(bbox, STOP_TILE_DEGREES);
}

export function patternTilesForBoundingBox(bbox: BoundingBox): string[] {
  return centreOut(bbox, PATTERN_TILE_DEGREES);
}

/** Search entries are placed on the stop grid, because they are mostly stops. */
export const searchTilesForBoundingBox = stopTilesForBoundingBox;

/** Every tile a pattern passes through, so a viewport finds it from any point along the route. */
export function tilesForPattern(shape: readonly Coordinate[]): string[] {
  return tilesForCoordinates(shape, PATTERN_TILE_DEGREES);
}

/** Entries with a location are also placed spatially, which is what "stops near me" reads. */
export function tileForSearchEntry(entry: SearchIndexEntry): string | null {
  return entry.coordinate ? tileIdFor(entry.coordinate, STOP_TILE_DEGREES) : null;
}
