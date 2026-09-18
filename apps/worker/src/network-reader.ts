import type {
  Coordinate,
  Operator,
  RoutePattern,
  ScheduledJourney,
  ServiceRoute,
  Stop,
} from "@busstops/contracts";
import {
  ArtifactStore,
  objectKeyFor,
  type ObjectStore,
  haversineMetres,
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
  patternTilesForBoundingBox,
  nearbyStops,
  patternTileDataset,
  searchIndex as rankSearch,
  searchPrefixDataset,
  searchPrefixesForWord,
  searchTileDataset,
  searchTilesForBoundingBox,
  stopLocatorDataset,
  stopTileDataset,
  stopTilesForBoundingBox,
  stopTilesForShape,
  tokenize,
  decodeRoutePatternsForService,
  decodePatternIndexFor,
  passengerName,
  patternIndexBucketFor,
  patternIndexDataset,
  patternIndexTileDataset,
  stopRoutesDataset,
  type PatternIndexRow,
  type StopRoutesRow,
  routeBadgeName,
  routePatternsBucketFor,
  routePatternsDataset,
} from "@busstops/pipeline-static-network";
import { PLACES_DATASET, placeAsSearchEntry, type PlaceRecord } from "@busstops/pipeline-places";
import type { PatternGeometry } from "@busstops/matching";
import type { ArtifactFamily, ReadLedger } from "./read-ledger.js";

/** Where a read should be booked, and what to call it if the clock stops it. */
export interface ReadTrack {
  ledger: ReadLedger;
  family: ArtifactFamily;
  budgetReason: string;
}

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

/**
 * How much shard text one request will open.
 *
 * The map caps a viewport at 1.5 square degrees, which on the pattern grid is ninety-six tiles.
 * Reading all of them at once would put the national network back in the isolate a viewport at a
 * time — the exact failure the sharding exists to prevent, arrived at from the other end, and
 * invisible to a check that only ever asks for a city centre.
 *
 * So a request reads tiles outwards from the middle of the box until this budget is spent. What
 * it buys adapts to where you are: rural tiles are small so many are read, a dense city is
 * expensive so fewer are — which is right, because in a city a screen holds less ground anyway.
 * The same figure as the cache budget, for the same reason: parsed objects are several times the
 * size of the text they came from, and a request needs room to work on top of what it holds.
 */
const MAX_REQUEST_SHARD_CHARS = 12 * 1024 * 1024;

/**
 * A tighter budget for pattern geometry, which is the heaviest thing a request can read.
 *
 * Isolated from two deployments rather than reasoned about: `/v1/map` and `/v1/routes/:id` both
 * answered Cloudflare's own HTML 503 — in run 35 on desktop, in run 36 on tablet, the same pair of
 * endpoints both times. Every endpoint that kept working reads stops, departures or the search
 * index; the two that failed are the only ones that read pattern tiles in bulk. A published
 * pattern tile reaches 3,935,975 bytes and a city viewport spans several, so at the shared budget
 * a single map request could parse twelve mebibytes of JSON. A Worker past its limit is answered
 * by the platform, and the platform's error page carries no CORS header — which is why the browser
 * reported it as "No 'Access-Control-Allow-Origin' header" rather than as a server error.
 *
 * Three mebibytes covers an ordinary viewport's patterns. Beyond that the read is truncated and
 * says so, which costs some route names on a very dense screen and is a far better answer than a
 * page that fails to load at all.
 */
const MAX_PATTERN_REQUEST_CHARS = 3 * 1024 * 1024;

/**
 * How many search buckets one query may open. A hundred and twenty characters of query is a lot
 * of words, and each word is at least one object; the bound is on the reading, not on the typing.
 */
const MAX_SEARCH_BUCKETS_PER_QUERY = 12;

/**
 * How much search-tile text a "stops near me" answers from.
 *
 * Search entries are filed on the stop grid, so a quarter-degree tile in a city holds tens of
 * thousands of them — all decoded to answer a question about eight hundred metres, which is what
 * put `nearby` over the limit in run 44. Five mebibytes is the same cap the map's stops get,
 * because it is the same shape of question asked of the same grid.
 */
const NEARBY_READ_CHARS = 5 * 1024 * 1024;

/** The most tiles read at once, once their size is known. */
const TILE_READ_BATCH = 6;

/**
 * How many are read before anything is known about how big they are.
 *
 * Two rather than six, because the first round trip is the one no budget can undo. A dense city
 * tile is four megabytes; six of those arrive together and the isolate is over its limit before
 * the first check runs.
 */
const FIRST_TILE_BATCH = 2;

/**
 * The pattern index reads wider, because its objects are a different size of thing.
 *
 * A tile is megabytes and the first round trip is the one no budget can undo. A pattern-index
 * bucket carries stop sequences and no geometry, and a corridor's ninety patterns hash across
 * ninety buckets. Reading those two at a time is forty-five round trips of pure latency: run 44
 * planned Leeds to Leeds Bradford Airport correctly and spent 5,411ms of a 6,000ms budget doing
 * exactly that. The byte budget still decides when to stop; this decides how many small things
 * are asked for at once.
 *
 * "Small" was a guess and it was wrong. Run 46 read 92 of these buckets and spent the request's
 * whole twelve-mebibyte budget doing it, then cut the read short — so a bucket is well over a
 * hundred kilobytes, not tens of them. A bucket holds every pattern whose id hashes to it, from
 * anywhere in England, and only a handful of those are ever wanted. That is the shape of the
 * cost, and the answer to it is to ask for fewer buckets rather than to raise the budget: the
 * journey planner now asks only for the patterns its corridor slice did not already read.
 */
const FIRST_PATTERN_INDEX_BATCH = 12;
/*
 * Widened a second time, from a measurement rather than from hope.
 *
 * Run 44 planned Leeds to Leeds Bradford Airport over 164 trips and spent 5,411ms resolving their
 * patterns. Run 45's corridor carried 455 trips — nearly three times the patterns — resolved 108
 * of them in 4,184ms, ran past the six-second budget and refused the journey with
 * `incomplete_read`. The refusal is right: a pattern that could not be read is a bus the plan
 * cannot see, and a partial plan presented as complete is the one thing this endpoint must not do.
 *
 * What is wrong is the number of round trips. Pattern ids hash uniformly across 512 buckets, so
 * three hundred patterns are three hundred separate small objects, and twenty-four at a time is
 * thirteen rounds of pure latency. These rows carry stop sequences and no geometry, so ninety-six
 * of them together is a few megabytes against a twelve-mebibyte request budget — and that budget,
 * not this cap, is what should decide when to stop. A test holds that relationship.
 */
const PATTERN_INDEX_BATCH = 96;

const INDEX_TTL_MS = 5 * 60 * 1000;

/**
 * Whether one record in a shard is wanted, decided without building the line it sits on.
 *
 * Deliberately takes the whole body and a window into it rather than a string. Splitting a
 * four-megabyte tile on newlines allocates forty thousand substrings and copies the entire body
 * to do it — before a single one has been looked at — so a filter handed finished lines has
 * already paid most of the cost it exists to avoid. This reads inside the original string and
 * slices only the short values it compares.
 *
 * Testing every wanted id against every line would be the other mistake: a hundred substring
 * searches per line over forty thousand lines is more work than the parse it replaces. So the
 * record's own keys are pulled out by position and tested against a set — two bounded scans and
 * two lookups, whatever the size of the request.
 */
type LineFilter = (body: string, start: number, end: number) => boolean;

function valueAt(body: string, start: number, end: number, field: string): string | null {
  const needle = `"${field}":"`;
  const at = body.indexOf(needle, start);
  // Bounded to this record: without the check, a field absent here is found in the next one.
  if (at < 0 || at >= end) return null;
  const from = at + needle.length;
  const to = body.indexOf('"', from);
  return to < 0 || to > end ? null : body.slice(from, to);
}

/**
 * A JSON number read in place, for fields that are not strings.
 *
 * `valueAt` looks for `"field":"` and stops at the closing quote, which finds nothing when the
 * value is a number. A coordinate is two numbers, and filtering a viewport's stops before they
 * are built is the whole point of reading them positionally.
 */
function numberAt(body: string, start: number, end: number, field: string): number | null {
  const needle = `"${field}":`;
  const at = body.indexOf(needle, start);
  if (at < 0 || at >= end) return null;
  let from = at + needle.length;
  // A number, not a quoted one: if this field is a string here, it is not the field we mean.
  if (body.charCodeAt(from) === 34) return null;
  let to = from;
  while (to < end) {
    const code = body.charCodeAt(to);
    // digits, '-', '+', '.', 'e', 'E' — everything a JSON number may contain
    const numeric =
      (code >= 48 && code <= 57) ||
      code === 45 ||
      code === 43 ||
      code === 46 ||
      code === 101 ||
      code === 69;
    if (!numeric) break;
    to += 1;
  }
  if (to === from) return null;
  const value = Number(body.slice(from, to));
  return Number.isFinite(value) ? value : null;
}

/**
 * Stops inside a viewport, decided before the record is built.
 *
 * Run 54 measured one `/v1/map` request parsing 7.00 MiB into 23,806 stop records and returning
 * 400 of them: the box filter ran over the finished objects, so ninety-eight per cent of the
 * parse was allocated and thrown away. The tiles are a quarter of a degree and a dense city fills
 * one, so the ratio is a property of the grid rather than of that viewport.
 *
 * A `Stop` carries exactly one coordinate, so `"lat":` occurs once per record and can be read
 * where it lies. A record whose coordinate cannot be read is kept: the filter exists to save
 * allocations, not to decide what is a stop, and the schema is what rejects a malformed one.
 */
function withinBoundingBox(bbox: {
  west: number;
  south: number;
  east: number;
  north: number;
}): LineFilter {
  return (body, start, end) => {
    const lat = numberAt(body, start, end, "lat");
    const lon = numberAt(body, start, end, "lon");
    if (lat === null || lon === null) return true;
    return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
  };
}

/** Matching on `"id":"` rather than on `id` is what keeps `"stopAreaId":"…"` out of it. */
function hasWantedKey(
  body: string,
  start: number,
  end: number,
  wanted: ReadonlySet<string>,
): boolean {
  const id = valueAt(body, start, end, "id");
  if (id !== null && wanted.has(id)) return true;
  const atco = valueAt(body, start, end, "atcoCode");
  return atco !== null && wanted.has(atco);
}

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
  private placesCache: SearchIndexEntry[] | null = null;
  private routeTilesCache: Map<string, string[]> | null = null;

  constructor(
    private readonly store: ObjectStore,
    private readonly ttlMs = 15 * 60 * 1000,
    /** Overridable so a test can make the budget bite on a fixture too small to reach it. */
    private readonly requestChars = MAX_REQUEST_SHARD_CHARS,
  ) {}

  /**
   * The pattern budget, never above the request's own.
   *
   * Taking the smaller of the two keeps production at the three-mebibyte pattern cap while
   * letting a test shrink both together — otherwise the pattern path would be the one thing a
   * test could not make bite, which is exactly the path that needs proving.
   */
  private get patternChars(): number {
    return Math.min(MAX_PATTERN_REQUEST_CHARS, this.requestChars);
  }

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
  private async readShard<T>(
    dataset: string,
    version: string,
    now: number,
    track?: ReadTrack,
  ): Promise<T[]> {
    return (await this.readShardSized<T>(dataset, version, now, track)).records;
  }

  /**
   * As readShard, and also says how much text the shard cost, which is what bounds a request.
   *
   * Every outcome is reported to the caller's ledger when it has one: a cache hit, a body, an
   * absent object, a throw. The isolate is shared between requests, so the ledger is the caller's
   * rather than this reader's — a counter living here would blend concurrent requests into a
   * number that describes neither of them.
   */
  private async readShardSized<T>(
    dataset: string,
    version: string,
    now: number,
    track?: ReadTrack,
    /**
     * Which records to build, tested against the raw line before it is parsed.
     *
     * A route's stops are a hundred specific ids, and resolving them read three four-megabyte
     * tiles and turned every record in them into an object — some tens of thousands of
     * allocations to keep a hundred. The bytes arrive either way; what this saves is the parse,
     * which is the part that runs on the isolate's CPU.
     *
     * A filtered read deliberately does not populate the shard cache. The cache is shared by every
     * request in the isolate and an entry holding one request's hundred stops would answer the
     * next request's question with a tile that is missing almost all of it — a wrong answer, not a
     * slow one. It will still *use* a full entry that is already there.
     */
    keep?: LineFilter,
  ): Promise<{ records: T[]; chars: number }> {
    const key = `${version}:${dataset}`;
    const cached = this.shards.get(key);
    if (cached && now - cached.usedAt < this.ttlMs) {
      cached.usedAt = now;
      track?.ledger.record(track.family, {
        outcome: "cached",
        chars: cached.chars,
        records: cached.records.length,
      });
      return { records: cached.records as T[], chars: cached.chars };
    }

    const began = Date.now();
    let raw: string | null;
    try {
      raw = await this.store.get(objectKeyFor(dataset, version));
    } catch (error) {
      track?.ledger.record(track.family, { outcome: "failed", ms: Date.now() - began });
      throw error;
    }

    const records: T[] = [];
    if (raw !== null && keep) {
      /*
       * Walked rather than split. `split` would copy the whole body into forty thousand
       * substrings before the filter saw any of them, which is the allocation this path exists to
       * avoid; only the records that survive the test are ever built.
       */
      for (let start = 0; start < raw.length;) {
        const newline = raw.indexOf("\n", start);
        const end = newline < 0 ? raw.length : newline;
        if (end > start && keep(raw, start, end)) {
          records.push(JSON.parse(raw.slice(start, end)) as T);
        }
        if (newline < 0) break;
        start = newline + 1;
      }
    } else if (raw !== null) {
      // No filter: every record is wanted, so the split costs nothing that is not needed anyway.
      for (const line of raw.split("\n")) {
        if (line.length > 0) records.push(JSON.parse(line) as T);
      }
    }

    const chars = raw?.length ?? 0;
    track?.ledger.record(track.family, {
      outcome: raw === null ? "missing" : "read",
      chars,
      records: records.length,
      ms: Date.now() - began,
    });
    // See `keep`: a partial parse must never be cached as though it were the whole tile.
    if (!keep) this.shards.set(key, { records, chars, usedAt: now });
    this.evictShards();
    return { records, chars };
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

  /**
   * What this isolate is still holding from the requests before this one.
   *
   * Run 45's route detail answered six requests in 300–900ms each, reading two or three
   * mebibytes apiece, and the seventh was killed by the platform. Every figure the diagnostics
   * carried described *one* request, so there was no way to tell an expensive request from a full
   * isolate — and the numbers said the requests were cheap. This is the missing measurement: what
   * is resident before a request starts, reported alongside what the request itself cost.
   *
   * `records` is the honest one. `chars` counts the text a shard was parsed from and the parsed
   * objects are several times that, so a budget spent in characters is an estimate of memory
   * while a record count is a count of the objects actually being retained.
   */
  residency(): {
    shards: number;
    chars: number;
    records: number;
    operators: number;
    services: number;
    places: number;
    routeTiles: number;
  } {
    let records = 0;
    for (const shard of this.shards.values()) records += shard.records.length;
    return {
      shards: this.shards.size,
      chars: this.cachedShardChars,
      records,
      operators: this.operatorsCache?.size ?? 0,
      services: this.servicesCache?.size ?? 0,
      places: this.placesCache?.length ?? 0,
      routeTiles: this.routeTilesCache?.size ?? 0,
    };
  }

  /**
   * Make room before a request starts, rather than after it has failed.
   *
   * The LRU bound is enforced *after* a read, so a request can begin against a cache sitting at
   * its ceiling and then parse three more mebibytes on top of it. Trimming to a floor first costs
   * nothing — the evicted shards are re-read if they are wanted, and R2 reads are the cheap part
   * — and it means the peak is the floor plus one request instead of the ceiling plus one.
   *
   * Returns how many shards it let go, so the ledger can say whether it did anything.
   */
  trimTo(chars: number): number {
    if (this.cachedShardChars <= chars) return 0;
    const byAge = [...this.shards].sort((a, b) => a[1].usedAt - b[1].usedAt);
    let resident = this.cachedShardChars;
    let evicted = 0;
    for (const [key, shard] of byAge) {
      if (resident <= chars) break;
      this.shards.delete(key);
      resident -= shard.chars;
      evicted += 1;
    }
    return evicted;
  }

  /**
   * Reads tiles in the order given, stopping when the request budget is spent.
   *
   * The caller orders them, and for a viewport that order is outwards from the middle, so a box
   * too large to afford loses its far corners rather than an arbitrary set of tiles.
   */
  private async readTiles<T>(
    dataset: (tile: string) => string,
    tiles: readonly string[],
    available: readonly string[],
    version: string,
    now: number,
    budgetChars = this.requestChars,
    track?: ReadTrack,
    /** Passed through to the parse; see `readShardSized`. */
    keep?: LineFilter,
  ): Promise<{ records: T[]; truncated: boolean }> {
    // Only tiles the publish actually wrote are requested: asking for the rest would be a read
    // operation per empty tile, metered, for a guaranteed miss.
    const present = new Set(available);
    const wanted = tiles.filter((tile) => present.has(tile));

    const records: T[] = [];
    let chars = 0;
    let read = 0;
    let start = 0;
    /*
     * The first batch is small, and the rest are sized from what tiles here actually cost.
     *
     * Six tiles were read at once, in parallel, before anything was checked. A budget cannot stop
     * what has already been fetched: `stops-tile/206_-1` is 3,959,355 bytes, and a Manchester
     * viewport spans several, so a map request decoded twenty-odd megabytes in its very first
     * round trip and error 1102 arrived before the second. The budget was being enforced after the
     * only moment at which it mattered.
     *
     * A city tile and a rural tile differ by two orders of magnitude, and nothing here knows which
     * it is holding until it has one. So it takes two, measures them, and lets the measurement
     * decide how many to ask for next — wide where tiles are cheap, one at a time where they are
     * not.
     */
    let batchSize = FIRST_TILE_BATCH;

    while (start < wanted.length) {
      const batch = wanted.slice(start, start + batchSize);
      const results = await Promise.all(
        batch.map((tile) => this.readShardSized<T>(dataset(tile), version, now, track, keep)),
      );
      for (const result of results) {
        records.push(...result.records);
        chars += result.chars;
        read += 1;
      }
      start += batch.length;

      /*
       * Two ways to run out, and a request can hit either first.
       *
       * The byte budget is what stops one viewport holding the national network. The clock is what
       * stops a request being stopped for it: a reader that only counts bytes will happily spend
       * two seconds doing so, and error 1102 does not care which resource ran out.
       */
      if (chars >= budgetChars || track?.ledger.withinBudget === false) {
        const ranOut = start < wanted.length;
        if (ranOut && track && !track.ledger.withinBudget) track.ledger.stop(track.budgetReason);
        return { records, truncated: ranOut };
      }

      const averageChars = Math.max(1, Math.ceil(chars / Math.max(1, read)));
      const affordable = Math.floor((budgetChars - chars) / averageChars);
      batchSize = Math.max(1, Math.min(TILE_READ_BATCH, affordable));
    }
    return { records, truncated: false };
  }

  /**
   * Every stop in the given tiles.
   *
   * Bounded by what the request can afford to hold rather than by a stop count, and the caller
   * orders the tiles so that what a large box loses is its far corners. `truncated` says whether
   * anything was left unread, so the answer is never quietly partial.
   */
  /**
   * Stop tiles, with the names cleaned on the way out.
   *
   * Feeds publish stop names with their own separators in them — `White_Rose_Shopping_Centre`,
   * `Gledhow_Lidgett_Lane`, `Easterly_Road_Hollin_Park_Mount` — and those were reaching the map,
   * the board, the route page and the itinerary exactly as filed. `passengerName` is deliberately
   * conservative: it replaces underscores and colons and collapses runs of spaces, and touches
   * nothing else, so `King's Cross`, `Stratford-upon-Avon` and `Park & Ride` come through as
   * written.
   *
   * Done here, at the read boundary, rather than at each of the four places that render a stop
   * name — that is how three of them come to disagree — and rather than in the published artifact,
   * which would mean a national rebuild to fix a display bug. The canonical identifiers are not
   * touched: `id` and `atcoCode` are what links are built from and they are left exactly as filed.
   */
  private async readStopTiles(
    tiles: readonly string[],
    available: readonly string[],
    version: string,
    now: number,
    budgetChars?: number,
    track?: ReadTrack,
    keep?: LineFilter,
  ): Promise<{ records: Stop[]; truncated: boolean }> {
    const result = await this.readTiles<Stop>(
      stopTileDataset,
      tiles,
      available,
      version,
      now,
      budgetChars ?? this.requestChars,
      track,
      keep,
    );
    return {
      records: result.records.map((stop) => ({ ...stop, name: passengerName(stop.name) })),
      truncated: result.truncated,
    };
  }

  async stopsInTiles(
    tiles: readonly string[],
    now: number = Date.now(),
    ledger?: ReadLedger,
    budgetChars?: number,
    keep?: LineFilter,
  ): Promise<{ stops: Stop[]; truncated: boolean }> {
    const index = await this.networkIndex(now);
    if (!index) return { stops: [], truncated: false };
    const result = await this.readStopTiles(
      tiles,
      index.stopTiles,
      index.version,
      now,
      Math.min(budgetChars ?? this.requestChars, this.requestChars),
      ledger ? { ledger, family: "stops", budgetReason: "stop_read_budget" } : undefined,
      keep,
    );
    return { stops: result.records, truncated: result.truncated };
  }

  async patternsInTiles(
    tiles: readonly string[],
    now: number = Date.now(),
    ledger?: ReadLedger,
  ): Promise<PatternGeometry[]> {
    return (await this.patternsInTilesDetailed(tiles, now, ledger)).geometries;
  }

  /**
   * The same read, with whether it got everything.
   *
   * A viewport that could not afford all its patterns shows fewer route names, which is a
   * tolerable degradation as long as it is declared. The bare version above is kept for callers
   * that genuinely do not care — matching a vehicle to a route is best-effort either way.
   */
  async patternsInTilesDetailed(
    tiles: readonly string[],
    now: number = Date.now(),
    ledger?: ReadLedger,
    /**
     * How many characters of pattern text this read may open. Defaults to the map's own cap.
     *
     * The default exists for a viewport, which on the pattern grid can span ninety-six tiles —
     * that is what three mebibytes is protecting against. A journey corridor is a different shape
     * of question: run 48's spanned four tiles, and the cap cut it off after two and 4.21 MiB, so
     * the slice came back incomplete and the planner refused before the trips were read. Stops and
     * trips already take their budget from the caller for exactly this reason; patterns were the
     * last read still using a number calibrated for somebody else's question.
     */
    budgetChars?: number,
  ): Promise<{ geometries: PatternGeometry[]; complete: boolean }> {
    const index = await this.networkIndex(now);
    if (!index) return { geometries: [], complete: false };

    /*
     * Enrichment is optional, so it is not started at all when the clock has already gone.
     *
     * A request that is nearly out of time and opens a four-megabyte pattern tile anyway is the
     * request error 1102 kills — and a killed request answers with Cloudflare's own page, which
     * carries no CORS header, so the browser reports a map that failed to load as a CORS failure.
     * Declining to start is what turns that into a map with fewer route names on it.
     */
    if (ledger && !ledger.withinBudget) {
      ledger.stop("pattern_enrichment_budget");
      return { geometries: [], complete: false };
    }

    const lines = await this.readTiles<PatternTileLine>(
      patternTileDataset,
      tiles,
      index.patternTiles,
      index.version,
      now,
      // Never above the request's own budget, whatever the caller asks for.
      Math.min(budgetChars ?? this.patternChars, this.requestChars),
      ledger
        ? { ledger, family: "patterns", budgetReason: "pattern_enrichment_budget" }
        : undefined,
    );
    const geometries = toGeometries(assemblePatternTile(lines.records));
    ledger?.count({ patterns: geometries.length });
    return { geometries, complete: !lines.truncated };
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
    ledger?: ReadLedger,
    stopBudgetChars?: number,
    /**
     * Skip the pattern tiles entirely.
     *
     * The planner is the only caller that wanted them, and it wanted stop sequences rather than
     * geometry — which is exactly what the pattern index answers, by id, for the patterns the
     * corridor's trips actually name. Reading the tiles as well would be paying the four-megabyte
     * cost to discard it. Passed as a flag rather than assumed, because an artifact published
     * before the index existed still needs the old path.
     */
    options: { patterns?: "tiles" | "skip"; patternBudgetChars?: number } = {},
  ): Promise<NetworkSlice & { complete: boolean }> {
    /*
     * Stops and patterns are on different grids — a pattern is written to every tile it crosses,
     * so its grid is finer — and asking each for its own is what keeps the two from drifting.
     *
     * Read one after the other rather than together. They were in a `Promise.all`, so a corridor
     * opened its stop tiles and its pattern tiles in the same round trip and the two budgets were
     * spent simultaneously: the journey planner's slice could be fifteen mebibytes of text before
     * anything had looked at it, and the trip shards were still to come. Sequential, the pattern
     * read can see what the stop read has already cost and decline to start.
     */
    const stops = await this.stopsInTiles(
      stopTilesForBoundingBox(bbox),
      now,
      ledger,
      stopBudgetChars,
    );
    const patterns =
      options.patterns === "skip"
        ? { geometries: [] as PatternGeometry[], complete: true }
        : await this.patternsInTilesDetailed(
            patternTilesForBoundingBox(bbox),
            now,
            ledger,
            options.patternBudgetChars,
          );
    const services = await this.services(now);
    return {
      stopsById: new Map(stops.stops.map((stop) => [stop.id, stop])),
      patternsById: new Map(
        patterns.geometries.map((geometry) => [geometry.pattern.id, geometry.pattern]),
      ),
      services,
      complete: !stops.truncated && patterns.complete,
    };
  }

  async stopsInBoundingBox(
    bbox: { west: number; south: number; east: number; north: number },
    limit: number,
    now: number = Date.now(),
    ledger?: ReadLedger,
    budgetChars?: number,
  ): Promise<StopsInViewport> {
    /*
     * The box is applied twice, and only the first one costs anything.
     *
     * `withinBoundingBox` decides before the record is built, which is what stops a viewport
     * allocating a whole quarter-degree tile to keep the part of it on screen. The filter below
     * is the exact one — it reads the parsed coordinate rather than the text — and it is kept
     * because the parse-time pass is deliberately forgiving: a record whose coordinate it cannot
     * read positionally is let through rather than silently dropped.
     */
    const read = await this.stopsInTiles(
      stopTilesForBoundingBox(bbox),
      now,
      ledger,
      budgetChars,
      withinBoundingBox(bbox),
    );

    const inside = read.stops.filter((stop) => {
      const { lat, lon } = stop.locationCoordinate;
      return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
    });

    // Truncated either because the box held more stops than the response may carry, or because
    // it covered more tiles than the request may open. Both mean the same thing to a reader:
    // what you are seeing is the middle of what you asked for.
    if (inside.length <= limit) return { stops: inside, truncated: read.truncated };

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
    const stops = (await this.readStopTiles(tiles, index.stopTiles, index.version, now)).records;

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

  /**
   * The stops of one route, read from where the route goes rather than from the hash index.
   *
   * This is the stage that was taking `/v1/routes/:id` over the isolate's limit, and it was not
   * the obvious one. `stopsByKeys` resolves a key by reading its locator bucket, which is right
   * for a departure board asking about one stop. A route asks about every stop on it: the keys
   * are hashed across `LOCATOR_BUCKETS` buckets, so a route with a few hundred stops asks for
   * very nearly all of them, and they were read in a single `Promise.all` — hundreds of objects
   * in one round trip, before any budget could see a byte of it, purely to learn the names of
   * about three tiles.
   *
   * The route's shape already says which tiles those are. So this reads the tiles directly, in
   * the same measured batches the map uses, and the locator is not touched at all. The saving is
   * not a smaller limit but a smaller question.
   *
   * `truncated` is load-bearing: a route's stops are a statement of fact about where it goes, and
   * a caller must be able to refuse to publish a partial one as the whole route.
   */
  async stopsForGeometries(
    geometries: readonly PatternGeometry[],
    now: number = Date.now(),
    ledger?: ReadLedger,
    budgetChars?: number,
  ): Promise<{
    stopsById: Map<string, Stop>;
    truncated: boolean;
    tilesRequested: number;
    requested: number;
    resolved: number;
  }> {
    const keys = [...new Set(geometries.flatMap((geometry) => geometry.pattern.stopSequence))];
    const empty = {
      stopsById: new Map<string, Stop>(),
      truncated: false,
      tilesRequested: 0,
      requested: keys.length,
      resolved: 0,
    };

    const index = await this.networkIndex(now);
    if (!index || keys.length === 0) return empty;

    const tiles = stopTilesForShape(geometries.flatMap((geometry) => geometry.shape));
    /*
     * A pattern published without a shape cannot say where its stops are, so the locator path
     * still answers for it. That is the slow question, and it is asked only when the cheap one
     * has no answer at all rather than as a routine fallback.
     */
    if (tiles.length === 0) {
      const resolved = await this.stopsByKeys(keys, now);
      return {
        stopsById: resolved,
        truncated: false,
        tilesRequested: 0,
        requested: keys.length,
        resolved: resolved.size,
      };
    }

    /*
     * Only the stops this route calls at are built into objects.
     *
     * The tile arrives whole either way — R2 serves an object, not a query — but turning every
     * record in three four-megabyte tiles into a Stop to keep a hundred of them is tens of
     * thousands of allocations and parses on a shared isolate's CPU, per request. Run 46 ruled out
     * memory as the cause of the 1102s on this endpoint: residency was flat and the request that
     * died began against the lowest figure in the trail. What is left is the work, and this is the
     * largest piece of it that buys nothing.
     *
     * The test is on the raw line, before `JSON.parse` sees it. A stop is matched by its id or its
     * ATCO code, the same two keys the lookup below uses, so a line that would have been discarded
     * is never built.
     */
    const wanted = new Set(keys);
    const keep: LineFilter = (body, start, end) => hasWantedKey(body, start, end, wanted);

    const result = await this.readStopTiles(
      tiles,
      index.stopTiles,
      index.version,
      now,
      budgetChars ?? this.requestChars,
      ledger ? { ledger, family: "stops", budgetReason: "route_stop_read_budget" } : undefined,
      keep,
    );

    const byId = new Map<string, Stop>();
    const byAtco = new Map<string, Stop>();
    for (const stop of result.records) {
      byId.set(stop.id, stop);
      byAtco.set(stop.atcoCode, stop);
    }

    const stopsById = new Map<string, Stop>();
    for (const key of keys) {
      const stop = byId.get(key) ?? byAtco.get(key);
      if (stop) stopsById.set(key, stop);
    }
    ledger?.count({ stops: stopsById.size });

    return {
      stopsById,
      truncated: result.truncated,
      tilesRequested: tiles.length,
      requested: keys.length,
      resolved: stopsById.size,
    };
  }

  /**
   * Which route names call at each stop in these tiles.
   *
   * The map used to answer this by reading pattern tiles, which carry geometry: a dense one is
   * 3,935,975 bytes against a three-mebibyte cap, so in Leeds the read truncated on its first tile
   * every single time and every stop on the map came back with no services on it. The answer is
   * published as the answer now, on the same grid as the stops, so this reads the tiles the map
   * was already reading and opens no pattern tile at all.
   *
   * `complete` is what the map reports as `degraded`. An absent row means no service calls at that
   * stop, which is a real answer; an unread tile means we do not know, which is a different one.
   */
  async routeNamesForStopTiles(
    tiles: readonly string[],
    now: number = Date.now(),
    ledger?: ReadLedger,
    budgetChars?: number,
    /*
     * The stops the answer is actually for.
     *
     * One row per stop in the tile, and the map wants names for the four hundred it is returning
     * rather than for every stop in a quarter of a degree — the same ratio the stop read itself
     * had. Given the ids, the rows are filtered where they lie and the rest are never built.
     * Omitted, every row is kept, which is what a caller wanting the whole tile means.
     */
    wantedStopIds?: ReadonlySet<string>,
  ): Promise<{ byStopId: Map<string, string[]>; complete: boolean; available: boolean }> {
    const index = await this.networkIndex(now);
    // An artifact published before this family existed has no such tiles. Saying so lets the
    // caller fall back to the pattern tiles rather than report a network with no services on it.
    if (!index?.stopRouteTiles || index.stopRouteTiles.length === 0) {
      return { byStopId: new Map(), complete: false, available: false };
    }

    const result = await this.readTiles<StopRoutesRow>(
      stopRoutesDataset,
      tiles,
      index.stopRouteTiles,
      index.version,
      now,
      budgetChars ?? this.requestChars,
      ledger ? { ledger, family: "route-patterns", budgetReason: "stop_routes_budget" } : undefined,
      wantedStopIds && wantedStopIds.size > 0
        ? (body, start, end) => {
            const id = valueAt(body, start, end, "s");
            return id === null || wantedStopIds.has(id);
          }
        : undefined,
    );

    const byStopId = new Map<string, string[]>();
    for (const row of result.records) byStopId.set(row.s, row.r);
    return { byStopId, complete: !result.truncated, available: true };
  }

  /**
   * Patterns by id, read from the index rather than found by where they go.
   *
   * This is the journey planner's version of what the route-pattern index did for route detail.
   * The planner needs a pattern's stop sequence and never its geometry, and it was reading the
   * corridor's pattern tiles — geometry and all — to get it, which put a Leeds corridor past the
   * pattern budget and made the planner refuse to plan at all. The trips name their patterns, so
   * this asks for exactly those.
   *
   * Each bucket is one object and one prefix scan per pattern in it; the rest of the bucket is
   * never parsed.
   */
  async patternsByIds(
    patternIds: readonly string[],
    now: number = Date.now(),
    ledger?: ReadLedger,
  ): Promise<{ patterns: Map<string, RoutePattern>; complete: boolean; available: boolean }> {
    const index = await this.networkIndex(now);
    const buckets = index?.patternIndexBuckets ?? 0;
    if (!index || buckets === 0) {
      return { patterns: new Map(), complete: false, available: false };
    }

    const wanted = new Map<number, string[]>();
    for (const id of new Set(patternIds)) {
      const bucket = patternIndexBucketFor(id, buckets);
      // Only buckets the publish wrote are requested: the rest are a guaranteed miss, metered.
      if (index.patternIndexShards && !index.patternIndexShards.includes(bucket)) continue;
      const ids = wanted.get(bucket);
      if (ids) ids.push(id);
      else wanted.set(bucket, [id]);
    }

    const patterns = new Map<string, RoutePattern>();
    let complete = true;
    const entries = [...wanted];

    /*
     * The same measured batching the tiles use, for the same reason: the first round trip is the
     * one no budget can undo. A bucket is small — these rows carry no geometry — but a corridor
     * can touch a lot of them, and "small times many" is how the last two limits were reached.
     */
    let start = 0;
    let batchSize = FIRST_PATTERN_INDEX_BATCH;
    let chars = 0;
    let read = 0;

    while (start < entries.length) {
      const batch = entries.slice(start, start + batchSize);
      const bodies = await Promise.all(
        batch.map(async ([bucket, ids]) => {
          const began = Date.now();
          try {
            const raw = await this.store.get(
              objectKeyFor(patternIndexDataset(bucket), index.version),
            );
            ledger?.record("patterns", {
              outcome: raw === null ? "missing" : "read",
              chars: raw?.length ?? 0,
              records: ids.length,
              ms: Date.now() - began,
            });
            return { raw, ids };
          } catch {
            ledger?.record("patterns", { outcome: "failed", ms: Date.now() - began });
            return { raw: null, ids, failed: true as const };
          }
        }),
      );
      start += batch.length;

      for (const body of bodies) {
        if (body.raw === null) {
          // A bucket the index promised and the store could not produce is a gap, not an absence.
          if ("failed" in body) complete = false;
          continue;
        }
        chars += body.raw.length;
        read += 1;
        for (const id of body.ids) {
          const row = decodePatternIndexFor(body.raw, id);
          if (row) patterns.set(row.id, toRoutePattern(row));
        }
      }

      if (ledger && !ledger.withinBudget && start < entries.length) {
        ledger.stop("pattern_index_budget");
        complete = false;
        break;
      }

      const averageChars = Math.max(1, Math.ceil(chars / Math.max(1, read)));
      const affordable = Math.floor((this.requestChars - chars) / averageChars);
      if (affordable <= 0 && start < entries.length) {
        complete = false;
        break;
      }
      batchSize = Math.max(1, Math.min(PATTERN_INDEX_BATCH, affordable));
    }

    ledger?.count({ patterns: patterns.size });
    return { patterns, complete, available: true };
  }

  /**
   * The corridor's patterns, read from the tiles it crosses rather than a bucket per pattern.
   *
   * `patternsByIds` asks the hashed layout, which files a pattern by a hash of its id — so a
   * corridor's two hundred patterns are two hundred small objects scattered across the country's
   * worth of buckets, and run 47 measured what that costs: 91 buckets, 12.23 MiB, the request's
   * whole byte budget, 112 of 197 resolved, journey refused. These rows are the same rows filed
   * by where the pattern actually runs, so a corridor reads the handful of tiles it crosses and
   * wants most of what is in each.
   *
   * Parsed whole rather than by targeted decode, which is the opposite of the hashed layout's
   * trick and right for the same reason: there almost every row was unwanted, here almost every
   * row is wanted.
   */
  async patternsInIndexTiles(
    tiles: readonly string[],
    now: number = Date.now(),
    ledger?: ReadLedger,
    budgetChars?: number,
  ): Promise<{ patterns: Map<string, RoutePattern>; complete: boolean; available: boolean }> {
    const index = await this.networkIndex(now);
    const published = index?.patternIndexTiles;
    if (!index || !published || published.length === 0) {
      return { patterns: new Map(), complete: false, available: false };
    }

    const result = await this.readTiles<[string, PatternIndexRow]>(
      patternIndexTileDataset,
      tiles,
      published,
      index.version,
      now,
      Math.min(budgetChars ?? this.requestChars, this.requestChars),
      ledger ? { ledger, family: "patterns", budgetReason: "pattern_index_budget" } : undefined,
    );

    const patterns = new Map<string, RoutePattern>();
    for (const line of result.records) {
      // The header line parses as an object rather than a pair; a row is always `[id, row]`.
      if (!Array.isArray(line) || line.length !== 2) continue;
      const row = line[1];
      if (row && typeof row === "object" && "stopSequence" in row) {
        patterns.set(row.id, toRoutePattern(row));
      }
    }
    ledger?.count({ patterns: patterns.size });
    return { patterns, complete: !result.truncated, available: true };
  }

  /** Pattern geometries covering a viewport, for matching live vehicles to routes. */
  async patternsInBoundingBox(
    bbox: { west: number; south: number; east: number; north: number },
    now: number = Date.now(),
    ledger?: ReadLedger,
  ): Promise<PatternGeometry[]> {
    return (await this.patternsInTilesDetailed(patternTilesForBoundingBox(bbox), now, ledger))
      .geometries;
  }

  /**
   * Every pattern of one service, read from the tiles that service is known to touch.
   *
   * `complete` is the part that matters. A route's stops and geometry are a statement of fact —
   * "this is where the 36 goes" — and a byte budget quietly removing half of it would publish a
   * shorter route as though it were the route. The flag was being discarded here; the caller has
   * to be able to say "we cannot show all of this" instead.
   */
  /**
   * Every pattern of one service, read from the route-pattern index.
   *
   * A route page needs the whole route: every stop in sequence and the complete line on the map.
   * That is a different question from the one the geographic tiles answer well. A pattern is
   * written into every tile its shape crosses, so this used to open dozens of tiles, parse every
   * other route in each of them, and discard almost all of it — which is what took this endpoint
   * over the isolate's limit. Capping the bytes only turned the crash into a route drawn half way,
   * and half a route presented as a whole one is worse than an error.
   *
   * The index files each service into one bucket and gives it one line, so this is one object and
   * one `JSON.parse` of that line. `source` says which path answered, because an artifact
   * published before the index exists cannot be read this way and the caller must be able to tell.
   */
  async patternsForService(
    serviceId: string,
    now: number = Date.now(),
    ledger?: ReadLedger,
  ): Promise<{
    geometries: PatternGeometry[];
    complete: boolean;
    source: "route_pattern_index" | "pattern_tiles" | "unavailable";
  }> {
    const index = await this.networkIndex(now);
    if (!index) return { geometries: [], complete: false, source: "unavailable" };

    if (index.routePatternBuckets && index.routePatternBuckets > 0) {
      const bucket = routePatternsBucketFor(serviceId, index.routePatternBuckets);
      const began = Date.now();
      let raw: string | null;
      try {
        raw = await this.store.get(objectKeyFor(routePatternsDataset(bucket), index.version));
      } catch {
        ledger?.record("route-patterns", { outcome: "failed", ms: Date.now() - began });
        // The object exists as far as the index is concerned and could not be read. That is not
        // "this route has no patterns"; it is "we cannot say", and the caller must not round it
        // down to an empty route drawn as though it were complete.
        return { geometries: [], complete: false, source: "unavailable" };
      }

      if (raw === null) {
        ledger?.record("route-patterns", { outcome: "missing", ms: Date.now() - began });
        /*
         * Absent for two quite different reasons, and only the index can tell them apart.
         *
         * Nothing was ever filed in this bucket — no service that hashes here has a pattern with
         * geometry — which makes an empty answer a complete one. Or the publish says the bucket is
         * there and the store cannot produce it, which is a fault, and rounding that down to "this
         * route has no stops" would draw the fault as a fact about the route.
         */
        const written = index.routePatternShards;
        if (written && !written.includes(bucket)) {
          return { geometries: [], complete: true, source: "route_pattern_index" };
        }
        return { geometries: [], complete: false, source: "unavailable" };
      }

      const lines = decodeRoutePatternsForService(raw, serviceId);
      ledger?.record("route-patterns", {
        outcome: "read",
        chars: raw.length,
        records: lines?.length ?? 0,
        ms: Date.now() - began,
      });
      // The bucket was written and this service is not in it: the publish says it has no patterns
      // with geometry. A complete answer, and an empty one.
      if (lines === null) {
        return { geometries: [], complete: true, source: "route_pattern_index" };
      }
      const geometries = toGeometries(assemblePatternTile(lines));
      ledger?.count({ patterns: geometries.length });
      return { geometries, complete: true, source: "route_pattern_index" };
    }

    /*
     * An artifact published before the index existed.
     *
     * Kept so the endpoint still answers between a deploy and the next national rebuild, and
     * labelled so nobody mistakes it for the targeted path. It is still honest about completeness:
     * a read that ran out of budget reports `complete: false` and the endpoint refuses to present
     * what it got as the whole route.
     */
    const routeTiles = await this.routeTiles(now);
    const tiles = routeTiles.get(serviceId) ?? [];
    if (tiles.length === 0) return { geometries: [], complete: true, source: "pattern_tiles" };

    const lines = await this.readTiles<PatternTileLine>(
      patternTileDataset,
      tiles,
      index.patternTiles,
      index.version,
      now,
      this.patternChars,
      ledger ? { ledger, family: "patterns", budgetReason: "route_read_budget" } : undefined,
    );
    const records = assemblePatternTile(lines.records);
    return {
      geometries: toGeometries(records.filter((r) => r.pattern.serviceRouteId === serviceId)),
      complete: !lines.truncated,
      source: "pattern_tiles",
    };
  }

  /**
   * The names of the last stop of each journey, so a board can say where the bus is going.
   *
   * Only the terminus of each journey is looked up, and they are read through the existing
   * locator path in one batch, so a board with twenty rows costs a handful of shard reads rather
   * than twenty.
   */
  async stopsByIdsForJourneys(
    journeys: readonly ScheduledJourney[],
    now: number = Date.now(),
  ): Promise<Map<string, string>> {
    const terminals = new Set<string>();
    for (const journey of journeys) {
      const last = journey.stopTimes[journey.stopTimes.length - 1];
      if (last) terminals.add(last.stopId);
    }
    if (terminals.size === 0) return new Map();
    const stops = await this.stopsByKeys([...terminals], now);
    return new Map([...stops].map(([key, stop]) => [key, stop.name]));
  }

  /** Patterns calling at a stop, found from the tiles around it rather than nationally. */
  async patternsServingStop(stop: Stop, now: number = Date.now()): Promise<PatternGeometry[]> {
    const geometries = await this.patternsInBoundingBox(boxAround(stop.locationCoordinate), now);
    return geometries.filter((geometry) => geometry.pattern.stopSequence.includes(stop.id));
  }

  /**
   * The places gazetteer, held whole and cached like operators and services.
   *
   * One object rather than a second prefix-sharding scheme, because this is not a national
   * dataset in the way stops are: the landmarks people search by name across the extracted areas
   * are in the thousands, the same order as the 1,043 services already held here. The publish
   * enforces a ceiling, and the isolate test counts what this holds — so outgrowing it is a
   * failure that shows up rather than a slow return of the national index.
   *
   * Absent is a normal answer: a bucket the places job has not run against has no gazetteer, and
   * search then finds stops, routes and operators exactly as it did before.
   */
  private async placeEntries(): Promise<SearchIndexEntry[]> {
    if (this.placesCache) return this.placesCache;
    const artifacts = new ArtifactStore(this.store);
    try {
      const result = await artifacts.readCurrent<PlaceRecord>(PLACES_DATASET);
      this.placesCache = result.records.map(placeAsSearchEntry);
    } catch {
      // A gazetteer that cannot be read costs a search its landmarks, not its answer.
      this.placesCache = [];
    }
    return this.placesCache;
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

  /**
   * The national services text, held without being parsed.
   *
   * `readCurrent` does two expensive things before a caller sees a record: it runs an FNV-1a hash
   * over the whole multi-megabyte object, and it `JSON.parse`s all 13,593 services. Both are pure
   * computation, which is the one resource a Workers Free invocation is short of — ten
   * milliseconds of it — and a departure board wants about ten of those services.
   *
   * So the bytes are fetched once per isolate and kept as text. Text is nearly free to hold and
   * free to keep: the cost being avoided is the parse, not the transfer.
   */
  private servicesTextCache: string | null = null;

  private async servicesText(): Promise<string | null> {
    if (this.servicesTextCache !== null) return this.servicesTextCache;
    const artifacts = new ArtifactStore(this.store);
    const manifest = await artifacts.readManifest(DATASETS.services);
    if (!manifest) return null;
    const raw = await this.store.get(manifest.objectKey);
    if (raw === null) return null;
    this.servicesTextCache = raw;
    return raw;
  }

  /**
   * Only the services asked for, built by one pass over the text.
   *
   * No offset index is kept: building a map of 13,593 keys is itself several milliseconds of
   * allocation, and one bounded scan per request costs less than that once. A line is parsed only
   * when its id is wanted.
   */
  async servicesByIds(ids: ReadonlySet<string>): Promise<Map<string, ServiceRoute>> {
    const found = new Map<string, ServiceRoute>();
    if (ids.size === 0) return found;

    // A warm isolate that has already read them all for some other reason should use that.
    if (this.servicesCache) {
      for (const id of ids) {
        const service = this.servicesCache.get(id);
        if (service) found.set(id, service);
      }
      return found;
    }

    const text = await this.servicesText();
    if (text === null) return found;

    let start = 0;
    while (start < text.length && found.size < ids.size) {
      let end = text.indexOf("\n", start);
      if (end < 0) end = text.length;
      if (end > start) {
        const id = valueAt(text, start, end, "id");
        if (id !== null && ids.has(id)) {
          try {
            found.set(id, JSON.parse(text.slice(start, end)) as ServiceRoute);
          } catch {
            // A line that will not parse is a line this reader has no service for; the caller
            // already copes with a service it cannot name.
          }
        }
      }
      start = end + 1;
    }
    return found;
  }

  /** Every service an operator runs, by the same single pass. */
  async servicesForOperator(operatorId: string): Promise<Map<string, ServiceRoute>> {
    const found = new Map<string, ServiceRoute>();
    if (this.servicesCache) {
      for (const [id, service] of this.servicesCache) {
        if (service.operatorId === operatorId) found.set(id, service);
      }
      return found;
    }

    const text = await this.servicesText();
    if (text === null) return found;

    let start = 0;
    while (start < text.length) {
      let end = text.indexOf("\n", start);
      if (end < 0) end = text.length;
      if (end > start && valueAt(text, start, end, "operatorId") === operatorId) {
        try {
          const service = JSON.parse(text.slice(start, end)) as ServiceRoute;
          found.set(service.id, service);
        } catch {
          // As above: an unparseable line is not a service.
        }
      }
      start = end + 1;
    }
    return found;
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
    // A query of only stop-words still deserves an answer rather than an error; its raw form is
    // the best available key.
    const lookups = words.length > 0 ? words : [query];

    /*
     * How deep a letter's buckets go is a property of the published data, not a constant: the
     * publisher splits the few letters that would overflow and the index says which. Asking the
     * shared resolver rather than computing a key here is what keeps the two sides from
     * disagreeing about where an entry was filed.
     */
    const available = new Set(index.searchPrefixes);
    /*
     * Bounded like every other read. A long query tokenises into many words, each resolving to at
     * least one bucket, and a query is capped at 120 characters rather than at a word count — so
     * without this the number of objects one search opens is set by how much someone typed.
     * Words are taken in the order they were written, which is the order they were meant in.
     */
    const wanted = [
      ...new Set(lookups.flatMap((word) => searchPrefixesForWord(word, available))),
    ].slice(0, MAX_SEARCH_BUCKETS_PER_QUERY);
    const buckets = await Promise.all(
      wanted.map((prefix) =>
        this.readShard<SearchIndexEntry>(searchPrefixDataset(prefix), index.version, now),
      ),
    );

    // One entry can sit in several buckets when its words start differently; dedupe before
    // ranking so a multi-word match is not counted twice.
    const unique = new Map<string, SearchIndexEntry>();
    for (const entry of buckets.flat()) unique.set(`${entry.kind}:${entry.id}`, entry);

    /*
     * Places are ranked with everything else, not stapled on afterwards.
     *
     * A query is one question — "Leeds" could be the station, the stops or the routes — and
     * scoring them together is what lets the station come first when it deserves to. Two lists
     * concatenated would put whichever happened to be first ahead of a better match.
     */
    for (const entry of await this.placeEntries()) {
      unique.set(`${entry.kind}:${entry.id}`, entry);
    }

    const hits = rankSearch(
      { entries: [...unique.values()], builtAt: index.publishedAt },
      query,
      options.near === undefined
        ? { limit: options.limit }
        : { limit: options.limit, near: options.near },
    );
    return { hits: hits.map(presentHit), builtAt: index.publishedAt };
  }

  /** Stops near a point, from the tiles around it. */
  async nearby(
    coordinate: Coordinate,
    options: { radiusMetres: number; limit: number },
    now: number = Date.now(),
    ledger?: ReadLedger,
  ): Promise<{ hits: SearchHit[]; builtAt: string } | null> {
    const index = await this.networkIndex(now);
    if (!index) return null;

    /*
     * Bounded, like every other read on this class.
     *
     * This was the last one that was not, and it is on the stop grid: a quarter-degree tile in a
     * city holds tens of thousands of entries, all of which had to be decoded to answer a question
     * about eight hundred metres. Run 44 answered error 1102 on `nearby` for a real point. The cap
     * is the same one the map's stops get, because it is the same shape of question.
     */
    /*
     * The box was already being computed, and only used to pick the tiles.
     *
     * The comment above is right that a quarter-degree tile holds tens of thousands of entries —
     * and they were still all being built, because a byte cap bounds what is *read* and not what
     * is parsed out of it. Handing the same box to the parse means eight hundred metres costs the
     * entries inside eight hundred metres. `nearbyStops` still does the real distance test; this
     * only stops the far corners of the tile becoming objects first.
     */
    const box = boxAround(coordinate, options.radiusMetres);
    const entries = await this.readTiles<SearchIndexEntry>(
      searchTileDataset,
      searchTilesForBoundingBox(box),
      index.searchTiles,
      index.version,
      now,
      NEARBY_READ_CHARS,
      ledger ? { ledger, family: "search", budgetReason: "nearby_read_budget" } : undefined,
      withinBoundingBox(box),
    );

    const hits = nearbyStops(
      { entries: entries.records, builtAt: index.publishedAt },
      coordinate,
      options,
    );
    return { hits: hits.map(presentHit), builtAt: index.publishedAt };
  }
}

/**
 * A search hit as a passenger should read it.
 *
 * The index is built from the same feed names the tiles are, so a search for "white rose" listed
 * `White_Rose_Shopping_Centre`. Only the display fields are touched — `id` and `codes` are what a
 * result navigates by, and the tokens are what it matched on, so neither is rewritten. A route is
 * cleaned as a badge (a route number is short by nature and a long one is truncated); everything
 * else is cleaned as a name, which changes separators and nothing else.
 */
function presentHit(hit: SearchHit): SearchHit {
  const clean = hit.entry.kind === "route" ? routeBadgeName : passengerName;
  return {
    ...hit,
    entry: {
      ...hit.entry,
      title: clean(hit.entry.title),
      ...(hit.entry.subtitle === undefined ? {} : { subtitle: passengerName(hit.entry.subtitle) }),
    },
  };
}

/**
 * An index row as the planner's pattern.
 *
 * The row is deliberately not a `RoutePattern` on the wire: it carries what a planner needs and
 * leaves out what it does not, which is the whole point of the family. The shape reference is
 * empty because there is no shape here — a caller that needs geometry reads the route-pattern
 * index or the tiles, both of which have it.
 */
function toRoutePattern(row: PatternIndexRow): RoutePattern {
  return {
    id: row.id,
    serviceRouteId: row.serviceRouteId,
    direction: row.direction as RoutePattern["direction"],
    stopSequence: row.stopSequence,
    distanceMetres: row.distanceMetres,
    shapeRef: "",
  } as RoutePattern;
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
