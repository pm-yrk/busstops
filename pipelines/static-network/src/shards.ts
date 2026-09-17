import type { Coordinate, RoutePattern, Stop } from "@busstops/contracts";
import type { BoundingBox } from "@busstops/contracts";
import { tileIdFor, tilesForBoundingBox, tilesForCoordinates } from "@busstops/pipeline-core";
import type { SearchIndexEntry } from "./search-index.js";
import { DEPARTURE_BUCKETS, TRIP_WINDOW_HOURS, TRIP_WINDOWS } from "./departures-index.js";

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
 * Where a two-character bucket is split into three-character ones.
 *
 * Two characters is right for most of the alphabet and hopeless for a few of it. Measured
 * nationally, "bo" held 69,659 entries and could publish 31,570 of them; "st", "ma", "nw" and
 * "s_" were the same story, while most buckets are a few hundred rows. A single length cannot
 * serve both, so the ones that overflow are split and the index records which were written —
 * making the depth a property of the published data rather than a constant both sides have to
 * agree on in advance.
 *
 * The threshold is in records rather than bytes because it decides the shape of the index, and
 * the shape should not change because a name got longer. It sits well below the byte budget so
 * splitting happens before truncation would.
 */
export const SEARCH_BUCKET_SPLIT_AT = 6_000;

/**
 * How a bucket that prefix-deepening cannot split is split anyway.
 *
 * Deepening works by taking more characters of the word, which assumes the words in a bucket
 * differ somewhere further along. "Northbound", "Southbound" and the rest tokenise to a word that
 * normalises to `bound`, padded to the six-character maximum as `bound_` — so every entry
 * produces the identical deeper key however far the split goes, the loop gives up, and the
 * publisher truncates to fit the byte budget. Measured on England's real archive: 65,573 entries
 * in that one bucket, 31,385 kept, **34,188 dropped** and reported as a statistic.
 *
 * So a bucket the prefix cannot divide is divided by something else: a hash of the entry's own
 * id, into as many parts as it takes to fit. The parts are named `bound_~0`, `bound_~1` and so
 * on, the index lists them like any other key, and a reader that wants the word reads its parts.
 *
 * `~` because it sorts after alphanumerics and cannot occur in a normalised prefix, so a part key
 * can never collide with a real deeper prefix.
 */
export const SEARCH_PART_SEPARATOR = "~";

/** The part keys a bucket becomes when it is split by hash rather than by prefix. */
export function searchPartKey(prefix: string, part: number): string {
  return `${prefix}${SEARCH_PART_SEPARATOR}${String(part)}`;
}

/** Whether a published key is one part of a hash-split bucket, and which prefix it belongs to. */
export function searchPartPrefixOf(key: string): string | null {
  const at = key.indexOf(SEARCH_PART_SEPARATOR);
  return at > 0 ? key.slice(0, at) : null;
}

/**
 * How deep a split may go.
 *
 * One extra character is not always enough. Every London ATCO code begins 490, so splitting "49"
 * produced "490" and moved the whole city one character sideways; the split has to keep going
 * until the bucket fits or the key runs out of word to grow into. Six characters is past the
 * point where any real query is still ambiguous, and it bounds the recursion.
 */
export const SEARCH_MAX_PREFIX_LENGTH = 6;

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
 *
 * Trips are the exception, and they are sized against a different constraint entirely. A pattern
 * is written to every tile it crosses, so a finer grid costs copies; a trip is written once, to
 * the tile its first call is in, so a finer grid costs only objects. The first national run made
 * that the expensive currency — the REST API the pipeline publishes through answers about four
 * writes a second — so the grid opened out to half a degree with eight-hour windows, a few
 * hundred objects rather than a few thousand.
 *
 * Half a degree was too far, and London said so. The run published 832 trip shards and refused
 * four: `102_-1` and `103_-1`, which is 51.0-51.5N by 0.5W-0.0E, at 11.1 to 12.5 MB against an
 * 8 MiB budget — 86,229 of 773,393 trips, the whole capital's morning, dropped from the planner.
 * The largest shard that did publish was another London tile at 8,351,605 bytes, which is to say
 * it fitted by 37 kilobytes.
 *
 * A quarter degree puts the worst of those at about three megabytes and roughly doubles the
 * object count to something still measured in hundreds. Density is why: the same grid that holds
 * a county's trips holds London's, and the answer is a grid fine enough for the densest place
 * rather than one chosen for the average.
 */
export const STOP_TILE_DEGREES = 0.25;
export const PATTERN_TILE_DEGREES = 0.125;
export const TRIP_TILE_DEGREES = 0.25;

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

/**
 * The prefix buckets a query word could be in, given what was actually published.
 *
 * The publisher splits a bucket that would overflow, so the depth varies by letter and only the
 * index knows which. A word of three characters or more resolves to exactly one bucket at either
 * depth. A word of one or two characters against a split letter has no single bucket, so it reads
 * the sub-buckets — capped, because "bo" is a vague question and reading forty objects to answer
 * it would be a worse answer than reading eight.
 */
export const MAX_SEARCH_BUCKETS_PER_WORD = 8;

/**
 * Every published part of a hash-split bucket, in order.
 *
 * A word whose bucket was split this way has no single object, and the reader has to ask for all
 * of them — which is why the parts are named from the prefix rather than hashed into opaque keys.
 */
export function searchPartsOf(prefix: string, published: ReadonlySet<string>): string[] {
  const parts: string[] = [];
  for (let part = 0; ; part += 1) {
    const key = searchPartKey(prefix, part);
    if (!published.has(key)) break;
    parts.push(key);
  }
  return parts;
}

export function searchPrefixesForWord(word: string, published: ReadonlySet<string>): string[] {
  /*
   * Longest first. A bucket is split as many times as it takes to fit, so the depth varies by
   * letter and only the index knows it: "pi" may be one object while "4900" is one of several
   * hundred that "49" became. Asking for the longest key the word can name and walking down finds
   * whichever depth this publish settled on.
   */
  /*
   * Up to the maximum, not up to the word's own length.
   *
   * Short words are padded, not given a scheme of their own: "bound" is filed as `bound_`, six
   * characters. Starting at `word.length` meant a five-letter word never asked for its own
   * six-character key and fell through to the shallow scan — which mostly worked, and stopped
   * working the moment that bucket had to be split into parts.
   */
  const longest = SEARCH_MAX_PREFIX_LENGTH;
  for (let length = longest; length >= SEARCH_PREFIX_LENGTH; length--) {
    const candidate = searchPrefixFor(word, length);
    if (published.has(candidate)) return [candidate];
    // A bucket the prefix could not divide was divided by hash instead, and is published as
    // parts. There is no single object to find, so every part is read.
    const parts = searchPartsOf(candidate, published);
    if (parts.length > 0) return parts.slice(0, MAX_SEARCH_BUCKETS_PER_WORD);
  }

  // The letter was split below what this word can name, so read the parts it could be in.
  const shallow = searchPrefixFor(word, SEARCH_PREFIX_LENGTH);
  const parts: string[] = [];
  for (const candidate of published) {
    if (candidate.length > shallow.length && candidate.startsWith(shallow)) parts.push(candidate);
    if (parts.length >= MAX_SEARCH_BUCKETS_PER_WORD) break;
  }
  return parts;
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

/**
 * The route-pattern index: every pattern of one service, in one line of one object.
 *
 * Route detail is not a viewport. A route page needs the *whole* route — every stop in sequence
 * and the complete line on the map — and the geographic tiles cannot give it that cheaply. A
 * pattern is written into every tile its shape crosses, so asking for a cross-country service
 * meant opening dozens of tiles, parsing every other route in each of them, and throwing almost
 * all of it away. That is what took `/v1/routes/:id` over the isolate's limit, and a byte cap
 * only converts it from a crash into a route drawn half way.
 *
 * So services are hashed into buckets and each bucket holds one line per service, carrying that
 * service's shapes and patterns and nothing else. Reading a route is one object and one
 * `JSON.parse` of one line — the rest of the bucket is never parsed, which is the same trick the
 * departure shards use and the reason they are cheap.
 *
 * The lines are `PatternTileLine`s, reusing the tile format rather than inventing a second one, so
 * `assemblePatternTile` puts either back together and the two cannot drift apart.
 */
export const ROUTE_PATTERN_BUCKETS = 512;
export const ROUTE_PATTERNS_PREFIX = "network/route-patterns";
export const ROUTE_PATTERNS_FORMAT = 1;

/** FNV-1a, the same hash the departure buckets use, so one service always lands in one place. */
export function routePatternsBucketFor(
  serviceId: string,
  buckets: number = ROUTE_PATTERN_BUCKETS,
): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < serviceId.length; i += 1) {
    hash ^= serviceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % buckets;
}

export function routePatternsDataset(bucket: number): string {
  return `${ROUTE_PATTERNS_PREFIX}/${bucket}`;
}

export interface RoutePatternsRow {
  serviceId: string;
  lines: PatternTileLine[];
}

/** Header first, then one line per service, so the reader's prefix scan is uniform. */
export function routePatternsShardLines(rows: readonly RoutePatternsRow[]): string[] {
  const out = [JSON.stringify({ v: ROUTE_PATTERNS_FORMAT, n: rows.length })];
  for (const row of rows) out.push(JSON.stringify([row.serviceId, row.lines]));
  return out;
}

/** The same shard as one string, which is what a reader is handed. */
export function encodeRoutePatternsShard(rows: readonly RoutePatternsRow[]): string {
  return routePatternsShardLines(rows).join("\n");
}

/**
 * One service's lines, without parsing the rest of the bucket.
 *
 * Null means the bucket was written and this service is not in it, which is an ordinary answer.
 * The search includes the leading newline and the closing quote and comma, so a service whose id
 * is a prefix of another's cannot match the wrong line.
 */
export function decodeRoutePatternsForService(
  text: string,
  serviceId: string,
): PatternTileLine[] | null {
  const needle = `\n[${JSON.stringify(serviceId)},`;
  const at = text.indexOf(needle);
  if (at === -1) return null;
  const start = at + 1;
  const end = text.indexOf("\n", start);
  const line = end === -1 ? text.slice(start) : text.slice(start, end);
  const parsed = JSON.parse(line) as [string, PatternTileLine[]];
  return parsed[1];
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
  /**
   * How this publish was stored, so a reader can check rather than assume. Optional because
   * artifacts written before this existed do not have it, and a reader must be able to say so.
   */
  layout?: ArtifactLayout;
  publishedAt: string;
  partialCoverage: boolean;
  /** Tiles that actually have stops, so the edge never requests an object that cannot exist. */
  stopTiles: string[];
  patternTiles: string[];
  searchTiles: string[];
  searchPrefixes: string[];
  /**
   * How many route-pattern buckets this publish wrote.
   *
   * Absent on an artifact written before the index existed. A reader must be able to tell that
   * apart from "zero buckets", because the answer decides whether route detail can be served at
   * all or has to say it cannot.
   */
  routePatternBuckets?: number;
  /**
   * Which of those buckets were actually written.
   *
   * Without it, an object that is absent because nothing was ever filed there is indistinguishable
   * from one that is absent because it could not be read — and those mean "this service has no
   * patterns" and "we cannot say", which a route page must never confuse.
   */
  routePatternShards?: number[];
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

/**
 * The trip tiles a corridor crosses. Coarser than the pattern grid, because a trip is filed once
 * rather than copied into every tile its route touches, so the cost of a fine grid here is object
 * count against a write budget rather than duplicated geometry.
 */
export function tripTilesForBoundingBox(bbox: BoundingBox): string[] {
  return centreOut(bbox, TRIP_TILE_DEGREES);
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

/**
 * The storage layout an artifact was written with.
 *
 * A Worker and a pipeline built from the same commit agree about grid sizes because they import
 * the same constants. They are deployed independently, so that agreement is an assumption rather
 * than a fact — and when it broke it broke silently.
 *
 * Measured: the trip grid moved from half a degree to a quarter. The Worker then asked for Leeds
 * at `215_-7` while the published artifact held it at `107_-4`, three shards came back absent,
 * and the planner reported "No timetable data is published for this area yet". Every word of that
 * is wrong. The data was published, it was complete, and it was a quarter of a mile from where
 * the reader was looking.
 *
 * So an artifact now says how it was written, and a reader that cannot interpret one says *that*
 * rather than describing the country as empty.
 */
export interface ArtifactLayout {
  /** Bumped when the shape of a shard changes, as opposed to the grid it is filed on. */
  formatVersion: number;
  stopTileDegrees: number;
  patternTileDegrees: number;
  tripTileDegrees: number;
  tripWindowHours: number;
  tripWindows: number;
  departureBuckets: number;
  searchPrefixLength: number;
  locatorBuckets: number;
}

/**
 * Two, not one. Version one is every artifact published before the layout was recorded at all —
 * there is no such declaration in the bucket, so a reader meeting one knows only that it cannot
 * check, which is a different and lesser statement than knowing the layout matches.
 */
export const ARTIFACT_FORMAT_VERSION = 2;

export function currentArtifactLayout(): ArtifactLayout {
  return {
    formatVersion: ARTIFACT_FORMAT_VERSION,
    stopTileDegrees: STOP_TILE_DEGREES,
    patternTileDegrees: PATTERN_TILE_DEGREES,
    tripTileDegrees: TRIP_TILE_DEGREES,
    tripWindowHours: TRIP_WINDOW_HOURS,
    tripWindows: TRIP_WINDOWS,
    departureBuckets: DEPARTURE_BUCKETS,
    searchPrefixLength: SEARCH_PREFIX_LENGTH,
    locatorBuckets: LOCATOR_BUCKETS,
  };
}

export type LayoutCheck =
  | { state: "compatible" }
  /** The artifact predates layout declarations. Serving continues; the gap is reported. */
  | { state: "undeclared" }
  | {
      state: "mismatch";
      differences: Array<{ field: string; artifact: unknown; reader: unknown }>;
    };

/**
 * Whether this reader can interpret that artifact.
 *
 * An undeclared layout is not called compatible. It is the honest third answer: nothing in the
 * bucket says how it was written, so nothing here can promise it matches — and saying so is what
 * lets a deployment tell "verified" apart from "assumed", which is the whole point.
 */
export function checkArtifactLayout(
  artifact: ArtifactLayout | null | undefined,
  reader: ArtifactLayout = currentArtifactLayout(),
): LayoutCheck {
  if (!artifact) return { state: "undeclared" };

  const differences: Array<{ field: string; artifact: unknown; reader: unknown }> = [];
  for (const field of Object.keys(reader) as Array<keyof ArtifactLayout>) {
    if (artifact[field] !== reader[field]) {
      differences.push({ field, artifact: artifact[field], reader: reader[field] });
    }
  }
  return differences.length === 0 ? { state: "compatible" } : { state: "mismatch", differences };
}

/** One line a human can act on, for a report or an error body. */
export function describeLayoutCheck(check: LayoutCheck): string {
  if (check.state === "compatible") return "artifact layout matches this reader";
  if (check.state === "undeclared") {
    return "artifact declares no storage layout, so it cannot be checked against this reader";
  }
  return check.differences
    .map((d) => `${d.field}: artifact ${String(d.artifact)}, reader ${String(d.reader)}`)
    .join("; ");
}
