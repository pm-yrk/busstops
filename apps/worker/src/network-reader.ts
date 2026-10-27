import type {
  Coordinate,
  Operator,
  RoutePattern,
  ScheduledJourney,
  ServiceRoute,
  Stop,
} from "@busstops/contracts";
import { compareRouteNames, type RouteStop } from "./network-queries.js";
import {
  ArtifactStore,
  canStream,
  objectKeyFor,
  type ObjectStore,
  haversineMetres,
} from "@busstops/pipeline-core";
import { readFilteredLinesStreaming, type StreamLineStats } from "./stream-lines.js";
import { NearestLines, tileFloorMetres } from "./nearest-lines.js";
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
  serviceBucketDataset,
  serviceBucketFor,
  SERVICE_NAMES_DATASET,
  type ServiceName,
  searchPrefixesForWord,
  searchTileDataset,
  searchTilesForBoundingBox,
  stopLocatorDataset,
  stopTileDataset,
  mapStopTilesForBoundingBox,
  STOP_TILE_DEGREES,
  stopTilesForBoundingBox,
  stopTilesForShapes,
  tokenize,
  decodeRoutePatternsForService,
  decodePatternIndexFor,
  passengerName,
  patternIndexBucketFor,
  patternIndexDataset,
  patternIndexTileDataset,
  stopRoutesDataset,
  stopServicesBucketFor,
  stopServicesDataset,
  stopServingRoutesBucketFor,
  stopServingRoutesDataset,
  type StopServingOperator,
  type StopServingRoutesHeader,
  mapStopsDataset,
  stopDetailDataset,
  stopDetailBucketFor,
  type StopDetailRow,
  type MapStopRow,
  type PatternIndexRow,
  type StopRoutesRow,
  routeBadgeName,
  routePatternsBucketFor,
  routePatternsDataset,
} from "@busstops/pipeline-static-network";
import { PLACES_DATASET, placeAsSearchEntry, type PlaceRecord } from "@busstops/pipeline-places";
import {
  looksLikePostcode,
  normalisePostcode,
  outwardCode,
  postcodeBucketDataset,
} from "@busstops/pipeline-postcodes";
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
 *
 * Operators and services were the exception, held whole, and that stopped being true on 3 October
 * because the exception was the problem. `services()` is 13,626 records behind an FNV-1a hash of a
 * 4.7 MiB object; `/v1/map` called it for any viewport holding a bus with no line name and the
 * journey planner's corridor slice called it unconditionally, so the first request in any isolate
 * to reach either line answered Cloudflare's error page and every request after it, reading the
 * result out of the isolate's cache, was fine. Both are read by id now — `servicesByIds`,
 * `operatorsByIds` — and the two whole-table methods carry a warning saying nothing on a request
 * path may call them. The record counts in that old sentence had also drifted: 1,043 services had
 * become 13,626, which is how a comment stops being a measurement.
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
const MAX_CACHED_SHARDS = 16;

/**
 * How many service buckets one request may read. **A subrequest budget, not a byte trade-off** —
 * getting that backwards is what made it too small twice.
 *
 * In bytes the buckets always win: 256 buckets at the measured 18 KiB each *is* the 4,669,134-byte
 * object, so any number below 256 reads fewer bytes than the whole of it. What genuinely bounds
 * this is Cloudflare's fifty subrequests per invocation, which a board also spends on the index,
 * its stop, its departure shards, its operators, and its live and disruption reads.
 *
 * Eight was a guess. Twenty-four came from measuring Tombland in Norwich at twenty-five services
 * on one board — and the next run measured that same board at twenty-six, so it fell back again.
 * Setting the cap at the busiest board yet seen is how it keeps being exceeded by the busiest board
 * next seen, so thirty-two sits clear of it with about eighteen subrequests left for the rest.
 *
 * A request wanting more than this is not a board. It is the map, which wants every name and has
 * `network/service-names` to read instead.
 */
const MAX_SERVICE_BUCKETS_PER_REQUEST = 32;
/*
 * Twenty-four mebibytes, up from three, and the reason is the same CPU the old number was defending.
 *
 * The three-mebibyte version argued that a warm cache taxes whichever request triggers garbage
 * collection, from one run where a journey died on an isolate holding 2.42 MiB. Three more runs
 * have now measured the other side of it, and it is much larger: at 3 MiB a single city stop tile
 * — `network/stops-tile/103_-1` is 8.1 MiB — could not be held *at all*, so every viewport, every
 * route page and every board re-fetched and re-decoded megabytes that the isolate had already
 * decoded minutes earlier. A cache hit costs no parse, and the parse is the thing a Workers Free
 * invocation has ten milliseconds of.
 *
 * Twenty-four mebibytes of source text is a large fraction of the isolate once parsed, which is
 * why it is a ceiling with LRU eviction under it rather than an invitation. It is deliberately
 * well short of the national datasets — `network/stops` alone is 197.7 MiB — so the thing this
 * bound exists to prevent, the national network arriving a tile at a time, is still prevented.
 */
export const MAX_CACHED_SHARD_CHARS = 24 * 1024 * 1024;

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
const MAX_SEARCH_BUCKETS_PER_QUERY = 8;

/**
 * How much prefix-bucket text one query may open.
 *
 * Measured: a published bucket reaches 1,644,719 bytes, and twelve of those is nineteen mebibytes of
 * text to answer "Leeds Station". Even scanning that much costs more than the 10 ms of CPU a free
 * Worker invocation is allowed, before a single entry is built. Two mebibytes is two or three real
 * buckets, which is what a two or three word query actually needs; a longer query loses its tail
 * rather than losing its answer.
 */
const MAX_SEARCH_READ_CHARS = 1_200_000;

/** Characters of a typed word the text filter tests. Generous on purpose; see `searchLineFilter`. */
const SEARCH_STEM_LENGTH = 3;

/**
 * Which index lines are worth building, tested as text.
 *
 * A bucket filed under "le" holds every entry whose word starts with those letters — Leeds, Leicester,
 * Lewisham, Leyland — and a query for "leeds" wants a fraction of them. The test is the first three
 * characters of each word typed rather than the whole word, which is deliberately generous: "lee"
 * keeps Leeds, Leedstown and a misspelt "Lees", and the ranker decides between them. Testing the
 * whole word would make the filter stricter than the ranking it feeds, which is how a filter starts
 * deciding results instead of reducing work.
 *
 * The line is tested whole, so an entry matching on a token rather than on its title survives.
 *
 * A one-letter word is no test at all, which is correct: there is nothing to narrow by, and
 * narrowing on nothing would mean dropping the bucket's contents.
 */
/**
 * Which gazetteer lines are worth building, tested against mixed-case text.
 *
 * Separate from `searchLineFilter`, and the difference is the whole reason filtering the gazetteer
 * failed once before. A stop's search entry is published with `tokens` built by `tokenize`, which
 * lowercases — so a lowercase stem matches that text as it stands. A **place** is published as a
 * `PlaceRecord`: its searchable words are `name` and `subtitle`, in the case a cartographer wrote
 * them, and the tokens are derived in the Worker at read time. Run 82 filtered these with a
 * lowercase stem and lost Manchester Arndale, Bullring and Bristol Temple Meads — because "man"
 * does not occur in "Manchester Arndale".
 *
 * So each stem is tested in both the forms a Title Case name can present it: as typed, which
 * catches a match inside a word, and with its first letter capitalised, which catches a match at
 * the start of one. No `toLowerCase` on the line, because that allocates a copy of it and the
 * copies are the cost this exists to avoid.
 */
export function placeLineFilter(words: readonly string[]): LineFilter | undefined {
  const stems = words
    .map((word) => word.toLowerCase().slice(0, SEARCH_STEM_LENGTH))
    .filter((stem) => stem.length >= 2);
  if (stems.length === 0) return undefined;
  const forms = stems.flatMap((stem) => [stem, stem[0]!.toUpperCase() + stem.slice(1)]);
  /*
   * Tested inside the two fields a passenger is typing at, not anywhere in the line.
   *
   * A record's own key names are in that text too, and they collide: `"prominence"` contains
   * "min", so a search for "Minster" matched every landmark in the country and the filter narrowed
   * nothing. Over-matching is safe — it costs a parse, it never loses a result — which is exactly
   * why it would have gone unnoticed as a quiet loss of the saving. `name` and `subtitle` are
   * where the searchable words are, and bounding the test to their values removes the collision
   * rather than hoping no query stem looks like a field name.
   */
  return (body, start, end) =>
    forms.some(
      (form) =>
        containsInField(body, start, end, "name", form) ||
        containsInField(body, start, end, "subtitle", form),
    );
}

/**
 * Whether one quoted field's value contains a needle, without building the value.
 *
 * `valueAt` above answers the same question by slicing the value out, which is an allocation per
 * field per line — some thousands of them for a gazetteer, which is the cost these filters exist
 * to avoid. This walks to the value's bounds and searches inside them.
 */
function containsInField(
  body: string,
  start: number,
  end: number,
  field: string,
  needle: string,
): boolean {
  const key = `"${field}":"`;
  const at = body.indexOf(key, start);
  if (at < 0 || at >= end) return false;
  const from = at + key.length;
  // The closing quote of the value. A name containing an escaped quote would end the span early,
  // which costs a candidate rather than inventing one, and no place name in the gazetteer has one.
  const to = body.indexOf('"', from);
  if (to < 0 || to > end) return false;
  const found = body.indexOf(needle, from);
  return found >= 0 && found < to;
}

export function searchLineFilter(words: readonly string[]): LineFilter | undefined {
  const stems = words
    .map((word) => word.toLowerCase().slice(0, SEARCH_STEM_LENGTH))
    .filter((stem) => stem.length >= 2);
  if (stems.length === 0) return undefined;
  /*
   * No `toLowerCase` on the line, which is the point.
   *
   * Lowercasing a line allocates a copy of it, and a 1.6 MB bucket holds some six thousand lines —
   * so the first version of this filter traded one allocation per line for the parse it was meant to
   * avoid, and search got *worse*. It does not need to: every entry's `tokens` are built by
   * `tokenize`, which lowercases, so a lowercase stem matches the published text as it stands. A
   * mixed-case title is not the thing being matched on; its tokens are.
   */
  /*
   * Bounded to this line, which it was not.
   *
   * This returned `(line: string) => boolean` and was passed where a `LineFilter` — `(body,
   * start, end)` — was expected. TypeScript accepts a function of fewer parameters there, so it
   * compiled, and at run time it was handed the *whole object body* as its `line`. `stems.some(
   * stem => body.includes(stem))` is true whenever the stem occurs anywhere in a five-mebibyte
   * bucket, which for any real query it does — so the filter kept every line and search parsed all
   * twenty thousand records of every bucket it opened. The careful note above about not allocating
   * a copy of each line was describing something that never ran.
   *
   * `indexOf` from `start`, rejected unless the hit is before `end`: the same shape as every other
   * filter here, no allocation, and actually about one line.
   */
  return (body, start, end) =>
    stems.some((stem) => {
      const at = body.indexOf(stem, start);
      return at >= 0 && at < end;
    });
}

/**
 * How much search-tile text a "stops near me" answers from.
 *
 * Search entries are filed on the stop grid, so a tile in a city holds tens of thousands of them —
 * all decoded to answer a question about eight hundred metres, which is what put `nearby` over the
 * limit in run 44. The parse is filtered to the box now, so that part is fixed.
 *
 * The *scan* is not free, though, and that is what is left. A published search tile reaches
 * 1,832,129 bytes, and an eight-hundred-metre box that happens to straddle a tile corner wants
 * four of them — seven mebibytes of text to walk, against the 10 ms of CPU a free invocation gets
 * at roughly 3 ms a mebibyte. Run 79 measured the result: `nearby` answered Cloudflare's error
 * page for a real point in central Manchester.
 *
 * Two mebibytes is one tile, and `readTiles` reads outwards from the middle of the box, so what a
 * corner loses is the far side of a neighbouring square — stops that are mostly further away than
 * the ones it keeps. A shorter list of real stops beats an error page.
 */
const NEARBY_READ_CHARS = 2 * 1024 * 1024;

/**
 * How many projection tiles one request may open. **A subrequest budget, not a byte trade-off.**
 *
 * The projection is filed on a sixteenth of a degree, which is the whole point of it — a city
 * viewport reads twelve small squares instead of four big ones. But `maxBboxAreaSquareDegrees` is
 * 1.5, and 1.5 square degrees of sixteenths is 384 tiles, against the fifty subrequests a Workers
 * Free invocation gets in total. A viewport that is large but perfectly legal would therefore stop
 * being slow and start being impossible, which is a worse failure than the one the finer grid was
 * chosen to fix. The same arithmetic catches a long route's corridor: a cross-country shape spans
 * far more sixteenths than quarters.
 *
 * So the read is bounded by count as well as by bytes, and the surplus is reported as truncation —
 * which the map and route detail already carry through to the degradation the response states.
 * Thirty-two leaves about eighteen subrequests for the index, the live feed and everything else,
 * the same division the service-bucket cap above makes.
 *
 * Which thirty-two is not arbitrary: they are taken nearest the middle of what was asked for, for
 * the reason the stop cap gives — an arbitrary slice would drop the centre of the screen.
 */
const MAP_STOP_TILES_PER_REQUEST = 32;

/** The middle of a set of points, for ranking the tiles of a shape that is longer than one read. */
function midpointOf(points: readonly Coordinate[]): Coordinate {
  if (points.length === 0) return { lat: 0, lon: 0 };
  let lat = 0;
  let lon = 0;
  for (const point of points) {
    lat += point.lat;
    lon += point.lon;
  }
  return { lat: lat / points.length, lon: lon / points.length };
}

/**
 * The tiles nearest the middle of a bounding box, at most `limit` of them.
 *
 * Tile ids are `"<latIndex>_<lonIndex>"`, so the centre is comparable in index space without
 * reconstructing coordinates — and index space is the right space anyway, because it is uniform
 * in tiles rather than in degrees.
 */
function tilesNearestCentre(
  tiles: readonly string[],
  sizeDegrees: number,
  centre: Coordinate,
  limit: number,
): { tiles: string[]; dropped: number } {
  if (tiles.length <= limit) return { tiles: [...tiles], dropped: 0 };

  const centreLat = Math.floor(centre.lat / sizeDegrees);
  const centreLon = Math.floor(centre.lon / sizeDegrees);
  const ranked = [...tiles]
    .map((tile) => {
      const [lat, lon] = tile.split("_");
      const dLat = Number(lat) - centreLat;
      const dLon = Number(lon) - centreLon;
      return {
        tile,
        distance: Number.isFinite(dLat + dLon) ? dLat * dLat + dLon * dLon : Infinity,
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((entry) => entry.tile);

  return { tiles: ranked, dropped: tiles.length - limit };
}

/**
 * How many corridor stops a plan may hold. Measured, not chosen: a Leeds to Leeds Bradford
 * Airport corridor reported 3,774, and the planner refuses above `JOURNEY_LIMITS.maxStops`
 * anyway — this is the read's own bound, set well above a real corridor so that reaching it means
 * something has gone wrong rather than that the corridor was ordinary.
 */
const JOURNEY_CORRIDOR_STOP_LIMIT = 20_000;

/**
 * Above this, a limit is read as a safety bound rather than as a selector.
 *
 * `mapStopsInBoundingBox` serves two different questions through one method. A viewport and a
 * nearby search ask for a few hundred of the stops around a point and mean it — the cap is the
 * answer's own shape, so it is worth applying before anything is parsed. The journey corridor asks
 * for twenty thousand because it wants every stop in the corridor and is guarding against a read
 * that has gone wrong; selecting the nearest to the middle of a corridor would silently drop one
 * of its ends.
 *
 * Two thousand sits an order of magnitude above the largest real viewport request (four hundred,
 * or four hundred from a nearby search asking for a hundred) and an order of magnitude below the
 * corridor's bound, so neither caller is near it.
 */
const MAP_NEAREST_SELECTION_CEILING = 2_000;

/**
 * How much pattern text a departure board may open to answer "what calls here".
 *
 * Three quarters of a mebibyte, against the map's three. A board asks this question only when its
 * own departures could not answer it — nothing due, so no row named a pattern — and the stops
 * where that happens on a busy day are exactly the ones whose tiles are largest. Stop
 * `1800EB06161` in Manchester answered Cloudflare's error page on six consecutive deployed runs
 * and in run 95 the breadcrumb put it here precisely: `board:departures:done@237` with zero rows,
 * then nothing.
 *
 * A board that reaches this names fewer routes and says so — `routesComplete` is false — which is
 * a far better answer than the platform's error page, and it is only ever the fallback path.
 */
const BOARD_PATTERN_READ_CHARS = 768 * 1024;

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
/**
 * `index` is the line's ordinal in the object, counted over non-empty lines from zero.
 *
 * Added when these reads were put onto a stream. A header line used to be recognised by sitting at
 * offset zero of the body, and streaming makes that wrong rather than merely imprecise: when a
 * chunk boundary falls just after a newline the next line genuinely begins at offset zero of the
 * buffer that holds it, so a filter testing the offset would keep an arbitrary row and treat it as
 * the header. Every other filter ignores the parameter, and TypeScript lets them.
 *
 * Optional so that the places applying a filter to a line they already hold as its own string —
 * the gazetteer, and the filters' own tests — need not invent an ordinal. Both reads that stream
 * pass it. A filter that wanted it and did not get it sees `undefined`, which fails its test and
 * costs it the header; that is a visible incompleteness rather than a wrong answer, and
 * `stop-serving-routes.test.ts` holds the case where it would show.
 */
export type LineFilter = (body: string, start: number, end: number, index?: number) => boolean;

/**
 * Whether one stored line mentions a stop id, tested without building anything.
 *
 * A pattern tile line carries its stop sequence as quoted ids, so the quoted id is the needle and
 * `indexOf` bounded to this line is the test. Zero allocations per line is the point: the previous
 * version of this read allocated an object per line and that is what killed a cold board.
 */
/**
 * The pattern id at the head of a pattern-index line, read off the raw text.
 *
 * A row is stored as `["<id>",{...}]`, so the id is between the second character and the next
 * quote. Reading it this way costs one small string where `JSON.parse` of the row costs an object,
 * an array of stop ids, and the strings inside it.
 */
export function patternIdInIndexLine(body: string, start: number, end: number): string | null {
  if (body.charCodeAt(start) !== 0x5b /* [ */ || body.charCodeAt(start + 1) !== 0x22 /* " */) {
    return null;
  }
  const to = body.indexOf('"', start + 2);
  return to < 0 || to > end ? null : body.slice(start + 2, to);
}

/**
 * Keep only the pattern-index rows a request actually named.
 *
 * The comment on `patternsInIndexTiles` said a corridor wants most of what is in its tiles, and
 * that was the wrong way round: the trips name the patterns first, so the planner knows exactly
 * which rows it needs before the read starts. Run 89's journeys died inside this read with no
 * stage reached, and run 87's stopped itself at `pattern_index_budget` having resolved none of
 * 1,287 trips. Parsing the rows nobody asked for is the cost being removed.
 */
export function wantedPatternLineFilter(ids: readonly string[]): LineFilter | undefined {
  if (ids.length === 0) return undefined;
  const wanted = new Set(ids);
  return (body, start, end) => {
    const id = patternIdInIndexLine(body, start, end);
    return id !== null && wanted.has(id);
  };
}

export function stopMentionedInLine(stopId: string): LineFilter {
  const needle = `"${stopId}"`;
  return (body, start, end) => {
    const at = body.indexOf(needle, start);
    return at >= 0 && at < end;
  };
}

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
 * A filter that keeps only the pattern-tile lines whose geometry passes near one point.
 *
 * `/v1/vehicles/:ref` wants one pattern — the one its bus is on — and the read that identifies it
 * opened a pattern tile with no filter at all, so every shape and every pattern in it was built
 * into objects. Measured on the deployment, that is 3,156,408 characters for a tap in a dense
 * city, three and a half times the next largest passenger read and the biggest single allocation
 * any request makes.
 *
 * Why allocation rather than bytes is the thing to cut: identical requests pass on a fresh
 * isolate and fail on one that has served ninety, with nothing resident in any cache. Work that
 * is the same cannot explain that; a heap that has had a hundred multi-megabyte strings and
 * object graphs through it can.
 *
 * The test is numeric, not textual. An earlier sketch matched `"lat":53.7` as a string prefix,
 * which is wrong for a whole-degree coordinate — `JSON.stringify(53)` has no decimal point at all
 * — and silently drops the shapes it cannot match. This walks the line's `"lat":`/`"lon":` pairs
 * and compares them as numbers, which allocates nothing and cannot be defeated by formatting.
 *
 * Stateful, because the format is: a shape line always precedes the patterns that name it, so the
 * refs of the shapes that passed are what decides which patterns are worth building. Deliberately
 * permissive — a generous box, and a shape counts if any of its points is inside it — because
 * this only decides what to *build*. `matchObservation` still does the real geometry on whatever
 * survives, so a shape wrongly kept costs a little work and a shape wrongly dropped would cost a
 * passenger their route.
 */
function patternsNear(centre: Coordinate, marginDegrees: number): LineFilter {
  const west = centre.lon - marginDegrees;
  const east = centre.lon + marginDegrees;
  const south = centre.lat - marginDegrees;
  const north = centre.lat + marginDegrees;
  const kept = new Set<string>();

  /** Every `"<field>":` number in the line, tested in place until one passes. */
  const anyWithin = (body: string, start: number, end: number): boolean => {
    let at = start;
    for (;;) {
      const latAt = body.indexOf('"lat":', at);
      if (latAt < 0 || latAt >= end) return false;
      const lonAt = body.indexOf('"lon":', latAt);
      if (lonAt < 0 || lonAt >= end) return false;
      const lat = Number.parseFloat(body.slice(latAt + 6, lonAt - 1));
      /* The lon runs to the object's closing brace, which is the next one after it. */
      const closes = body.indexOf("}", lonAt);
      const lon = Number.parseFloat(body.slice(lonAt + 6, closes < 0 ? end : closes));
      if (lat >= south && lat <= north && lon >= west && lon <= east) return true;
      at = closes < 0 ? lonAt + 6 : closes;
    }
  };

  return (body, start, end) => {
    const ref = valueAt(body, start, end, "shapeRef");
    if (ref === null) return false;
    /*
     * A shape line carries points and a pattern line does not, which is how the two are told
     * apart without parsing either: a pattern's only coordinates would be in a field it has none
     * of. Checked by looking for the points array rather than by reading `kind`, so a line whose
     * key order changes still sorts itself correctly.
     */
    const points = body.indexOf('"points":', start);
    if (points >= 0 && points < end) {
      if (!anyWithin(body, points, end)) return false;
      kept.add(ref);
      return true;
    }
    return kept.has(ref);
  };
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
 * Where a map projection row is, read out of the raw line.
 *
 * The keys are one character — `y` and `x`, not `lat` and `lon` — because this family exists to be
 * cheap. The fallback matters more than it looks: a scan that cannot find a numeric `"y":` must not
 * be read as "this stop is not in the viewport", because that would take a marker off the screen
 * on the strength of a text search. So the line is parsed, once, and the row itself answers.
 */
function mapRowCoordinate(
  body: string,
  start: number,
  end: number,
): { lat: number; lon: number } | null {
  const lat = numberAt(body, start, end, "y");
  const lon = numberAt(body, start, end, "x");
  if (lat !== null && lon !== null) return { lat, lon };
  try {
    const row = JSON.parse(body.slice(start, end)) as MapStopRow;
    if (typeof row.y !== "number" || typeof row.x !== "number") return null;
    return { lat: row.y, lon: row.x };
  } catch {
    return null;
  }
}

/** One projection row as the map draws it. */
function mapStopFromRow(row: MapStopRow): MapStop {
  return {
    id: row.i,
    atcoCode: row.a,
    name: passengerName(row.n),
    locationCoordinate: { lat: row.y, lon: row.x },
    ...(row.d === undefined ? {} : { indicator: row.d }),
    routePublicNames: row.r ?? [],
  };
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

/**
 * The same question asked of a projection row, whose keys are one character each.
 *
 * Reusing `hasWantedKey` here looked right and rejected every line: a map row spells its id `i`
 * and its ATCO code `a`, so a filter looking for `"id"` and `"atcoCode"` matches nothing and the
 * route resolves no stops at all. The worker tests caught it immediately, which is the argument
 * for having had them.
 */
function hasWantedMapKey(
  body: string,
  start: number,
  end: number,
  wanted: ReadonlySet<string>,
): boolean {
  const id = valueAt(body, start, end, "i");
  if (id !== null && wanted.has(id)) return true;
  const atco = valueAt(body, start, end, "a");
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
  /*
   * The three fields a plan reads, not the whole published record.
   *
   * `buildGraphFor` takes `{ id, name, coordinate }` from each of these and nothing else, and the
   * corridor is read from the map projection, which carries exactly that. Typed as the narrower
   * shape rather than as `Stop` so the projection is not a special case and nothing downstream can
   * quietly start depending on a field the corridor no longer brings.
   */
  stopsById: ReadonlyMap<string, RouteStop>;
  patternsById: ReadonlyMap<string, RoutePattern>;
  services: ReadonlyMap<string, ServiceRoute>;
}

/**
 * A stop as the map draws it.
 *
 * Deliberately not a `Stop`: the projection does not carry provenance, quality flags, amenities or
 * NaPTAN status, and a type that claimed to would be inviting a caller to read a field that is not
 * there. What a marker needs is what this has.
 */
export interface MapStop {
  id: string;
  atcoCode: string;
  name: string;
  /** Named as `Stop` names it, so the map handler reads both through one shape. */
  locationCoordinate: Coordinate;
  indicator?: string;
  routePublicNames: string[];
}

/**
 * A serving route at a stop, as a board renders it: identity first, names as projections of it.
 */
export interface StopServingRoute {
  id: string;
  publicName: string;
  operatorId: string;
  operatorName: string;
}

/** A line of a serving-routes bucket: the header, or one stop's row. */
type StopServingRoutesLine = StopServingRoutesHeader | [string, Array<[string, string, number]>];

/** Where a nearby list was read from, so the endpoint can report which family it cost. */
export type NearbySource = "map_projection" | "search_tiles";

/**
 * A stop in a nearby list: what the surface shows, and nothing a text search would need.
 *
 * Deliberately not a `SearchHit`. The list used to be built from search entries, which meant the
 * reader had to produce `tokens` and `codes` for records that nobody was going to type at — and
 * a shape that demands them is a shape that quietly invites the search tiles back.
 */
export interface NearbyStop {
  id: string;
  title: string;
  subtitle?: string;
  coordinate: Coordinate;
  distanceMetres: number;
  hasLiveCoverage: boolean;
}

export interface StopsInViewport {
  stops: Stop[];
  truncated: boolean;
}

/**
 * How many of a search's results are kept for stops when anything else would take them all.
 *
 * Four, not one. A town matches several plausible places — "Leeds", "Leeds City Bus & Coach
 * Station", "Leeds Coach Station National Express Terminal" — and one stop beneath them reads as
 * an afterthought rather than as an answer.
 */
const MIN_STOP_RESULTS = 4;

/**
 * How much deeper than the caller's limit the ranking is taken, so the stops that prominent places
 * crowded out are still visible to `withReservedStops`. Four times twenty is eighty entries to
 * sort, which is nothing next to scoring the candidates in the first place.
 */
const SEARCH_RANK_DEPTH = 4;

/**
 * Guarantee a search offers somewhere to catch a bus.
 *
 * The scorer adds `entry.prominence`, and a gazetteer place is prominent where an individual bus
 * stop is not. That is right for ranking and wrong for the result *set*: searching "Leeds" on the
 * deployed preview returned twenty results and every one of them was a place, so a visitor typing
 * the most obvious thing they could type was offered twenty ways to plan a journey and no
 * departure board at all. The flow walk starts with that query and could get no further — it was
 * not that search was broken, it was that search answered a different question.
 *
 * So the ranking is left exactly as it is and the *set* is corrected: if the top results hold
 * fewer than `MIN_STOP_RESULTS` stops and better-than-nothing stops exist among the candidates,
 * the lowest-scoring non-stops are given up for the best-scoring stops. Score order is preserved
 * afterwards, so the list still reads as ranked rather than as two lists stapled together, and a
 * query that genuinely matched no stop is unchanged.
 */
export function withReservedStops(ranked: readonly SearchHit[], limit: number): SearchHit[] {
  const wanted = Math.min(MIN_STOP_RESULTS, limit);
  const top = ranked.slice(0, limit);
  const present = top.filter((hit) => hit.entry.kind === "stop").length;
  if (present >= wanted) return top;

  /*
   * The stops are taken from further down the same ranked list, not from a second ranking pass.
   *
   * The first version ranked the stop candidates again, which doubles the scoring work on the most
   * expensive path in the Worker — the one a visitor takes first, and the one whose cost is why the
   * read gate exists. It is also unnecessary: the scorer scores every candidate regardless of the
   * limit, so asking for a longer list costs nothing beyond the sort, and the stops that were
   * crowded out are already in it with their scores attached.
   */
  const below = ranked.slice(limit).filter((hit) => hit.entry.kind === "stop");
  if (below.length === 0) return top;

  const room = below.slice(0, wanted - present);
  /*
   * Room comes from the bottom and only from non-stops: the point is to make space, not to
   * re-rank, and taking the tail keeps the best matches whatever kind they are.
   */
  const keep = [...top];
  for (let i = keep.length - 1; i >= 0 && keep.length + room.length > limit; i -= 1) {
    if (keep[i]!.entry.kind !== "stop") keep.splice(i, 1);
  }

  const merged = [...keep, ...room];
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}

export class NetworkReader {
  private index: NetworkIndexRecord | null = null;
  private indexLoadedAt = 0;
  private indexInFlight: Promise<NetworkIndexRecord | null> | null = null;

  private readonly shards = new Map<string, CachedShard>();

  private operatorsCache: Map<string, Operator> | null = null;
  private servicesCache: Map<string, ServiceRoute> | null = null;
  /*
   * The national gazetteer, cached as *text* rather than as objects.
   *
   * There are 3,178 places and a search needs a handful of them, but the whole list was parsed on
   * the first search an isolate served — which is the search most likely to die, because a cold
   * isolate has no cache to spare it anything. Scanning 3,178 lines is cheap; building 3,178 objects
   * is not, and the ones built were thrown away by the ranking a moment later.
   *
   * So the lines are kept and the query's filter decides which become objects. Same answer, and the
   * cost falls with what was asked rather than with how much of England has a name.
   */
  private placeLinesCache: string[] | null = null;
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
    /**
     * Whether what is read may stay resident for the requests that follow.
     *
     * The cache is a working set and it is usually the right trade: a cache hit costs no parse,
     * and the parse is what a Workers Free invocation has ten milliseconds of. It is the wrong
     * trade for a read that one request wants and nobody else will — a pattern geometry tile is
     * 1.3 to 3.3 MiB in a city, and the deployed trace measured five bus taps leaving 11.9 MiB of
     * text and 5,756 parsed patterns resident between them, after which every later request that
     * had real decoding to do died with error 1102.
     */
    retain = true,
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
    const objectKey = objectKeyFor(dataset, version);

    /*
     * Streamed when the store can, which in the Worker it always can.
     *
     * This used to be `await this.store.get(key)` — one string the size of the object, built
     * before a single line of it was looked at, and a pattern tile in a dense city is three to
     * five megabytes of it. Cloudflare's 128 MB ceiling is **per isolate rather than per
     * invocation**, so those allocations accumulate across requests and the runtime sheds
     * whatever arrives once an isolate is full, irrespective of what that request itself costs.
     * It is why a paced walk passed fifty-four requests and then lost a third of the next fifty,
     * and why an 87,543-character `nearby` died at served=106 while a 5,008,974-character read
     * had passed on the same deployment a minute earlier.
     *
     * The buffered path is kept for a store that cannot stream — the in-memory one in a few older
     * tests — and is the same code it always was.
     */
    let records: T[];
    let chars: number;
    let missing = false;
    let streamed: StreamLineStats | null = null;

    if (canStream(this.store)) {
      let body: ReadableStream<Uint8Array> | null;
      try {
        body = await this.store.getStream(objectKey);
      } catch (error) {
        track?.ledger.record(track.family, { outcome: "failed", ms: Date.now() - began });
        throw error;
      }
      if (body === null) {
        missing = true;
        records = [];
        chars = 0;
      } else {
        try {
          const result = await readFilteredLinesStreaming<T>(body, { keep, key: objectKey });
          records = result.records;
          streamed = result.stats;
          chars = result.stats.chars;
        } catch (error) {
          /*
           * A body that failed mid-read, or one line of it longer than the cap. Both are faults
           * and both are reported as a failed read rather than as an empty object: a caller that
           * saw zero records would record "nothing is filed here", which is a claim about the
           * network rather than about the read.
           */
          track?.ledger.record(track.family, { outcome: "failed", ms: Date.now() - began });
          throw error;
        }
      }
    } else {
      let raw: string | null;
      try {
        raw = await this.store.get(objectKey);
      } catch (error) {
        track?.ledger.record(track.family, { outcome: "failed", ms: Date.now() - began });
        throw error;
      }
      records = [];
      if (raw !== null && keep) {
        /*
         * Walked rather than split. `split` would copy the whole body into forty thousand
         * substrings before the filter saw any of them, which is the allocation this path exists
         * to avoid; only the records that survive the test are ever built.
         */
        let line = 0;
        for (let start = 0; start < raw.length;) {
          const newline = raw.indexOf("\n", start);
          const end = newline < 0 ? raw.length : newline;
          if (end > start) {
            if (keep(raw, start, end, line)) records.push(JSON.parse(raw.slice(start, end)) as T);
            line += 1;
          }
          if (newline < 0) break;
          start = newline + 1;
        }
      } else if (raw !== null) {
        // No filter: every record is wanted, so the split costs nothing not needed anyway.
        for (const text of raw.split("\n")) {
          if (text.length > 0) records.push(JSON.parse(text) as T);
        }
      }
      missing = raw === null;
      chars = raw?.length ?? 0;
    }

    track?.ledger.record(track.family, {
      outcome: missing ? "missing" : "read",
      chars,
      records: records.length,
      ms: Date.now() - began,
      stream: streamed === null ? undefined : streamed,
    });
    // See `keep`: a partial parse must never be cached as though it were the whole tile.
    if (!keep && retain) this.shards.set(key, { records, chars, usedAt: now });
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
    /**
     * Gazetteer *lines* held as text, not landmarks parsed into objects.
     *
     * Renamed because the old name was about to mislead the one person reading it closely. It
     * printed `places=3178` for weeks, which read as "this isolate is holding 3,178 parsed
     * landmarks" — and it was, because the filter had been removed. The filter is back, so nothing
     * parsed survives a request and this counts the strings the text cache holds. Those are one
     * allocation each and were always going to be held; conflating them with the objects would
     * make the next run's diagnostics say the fix had not worked.
     */
    placeLines: number;
    routeTiles: number;
    textChars: number;
  } {
    let records = 0;
    for (const shard of this.shards.values()) records += shard.records.length;
    return {
      shards: this.shards.size,
      chars: this.cachedShardChars,
      records,
      operators: this.operatorsCache?.size ?? 0,
      services: this.servicesCache?.size ?? 0,
      placeLines: this.placeLinesCache?.length ?? 0,
      routeTiles: this.routeTilesCache?.size ?? 0,
      /*
       * Every string this reader is holding, not only the shard cache.
       *
       * `chars` above counts one cache of several, and reporting it as the isolate's residency is
       * how two rounds of this diagnosis went looking at request sizes. It read zero through a
       * peak walk in which a journey died — truthfully, because the shard cache was empty and the
       * megabytes were in the national text caches and the departure reader next door.
       *
       * 1102 is "exceeded resource limits", which is memory as well as CPU, so what an isolate is
       * carrying is a candidate cause and not background information. This is the figure to watch
       * it with: a sum, so a cache nobody thought of still shows up in it.
       */
      textChars:
        this.cachedShardChars +
        (this.placeLinesCache?.reduce((total, line) => total + line.length, 0) ?? 0),
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
    /** Passed through to the cache; see `readShardSized`. */
    retain = true,
    /**
     * Asked before each tile is fetched, so a read can stop when the rest cannot matter.
     *
     * The budget below answers "can this request afford another tile". This answers the different
     * and much better question "would another tile change the answer" — and a viewport can know
     * it: tiles arrive nearest-first, and once a bounded selection holds every marker it is
     * allowed to draw, a tile further away than the worst of them contributes nothing. The tile is
     * then never fetched, so what is saved is the subrequest, the bytes and the walk, not only the
     * parse. See `tileFloorMetres`.
     *
     * Consulted per tile rather than once, because the bound tightens as tiles are read.
     */
    worthReading?: (tile: string) => boolean,
  ): Promise<{ records: T[]; truncated: boolean }> {
    // Only tiles the publish actually wrote are requested: asking for the rest would be a read
    // operation per empty tile, metered, for a guaranteed miss.
    const present = new Set(available);
    const wanted = tiles.filter((tile) => present.has(tile));

    /*
     * Clamped by what the whole request has left, not only by what this family is allowed.
     *
     * Every budget passed in here is per-family and sized against the isolate's memory, so a
     * request that spends three of them in sequence — a journey reads stops, then the pattern
     * index, then trips — could decode fifteen mebibytes while every individual budget was
     * respected. The resource that actually runs out is CPU, it is spent per *request*, and
     * `ReadLedger` is the only object that spans the stages. So this is where the two meet.
     */
    const ceiling = track ? Math.min(budgetChars, track.ledger.remainingChars) : budgetChars;

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
      const offered = wanted.slice(start, start + batchSize);
      start += offered.length;
      const batch = worthReading ? offered.filter((tile) => worthReading(tile)) : offered;
      if (batch.length === 0) continue;
      const results = await Promise.all(
        batch.map((tile) =>
          this.readShardSized<T>(dataset(tile), version, now, track, keep, retain),
        ),
      );
      for (const result of results) {
        records.push(...result.records);
        chars += result.chars;
        read += 1;
      }

      /*
       * Two ways to run out, and a request can hit either first.
       *
       * The byte budget is what stops one viewport holding the national network. The clock is what
       * stops a request being stopped for it: a reader that only counts bytes will happily spend
       * two seconds doing so, and error 1102 does not care which resource ran out.
       */
      if (chars >= ceiling || track?.ledger.withinBudget === false) {
        const ranOut = start < wanted.length;
        if (ranOut && track && !track.ledger.withinBudget) track.ledger.stop(track.budgetReason);
        return { records, truncated: ranOut };
      }

      const averageChars = Math.max(1, Math.ceil(chars / Math.max(1, read)));
      const affordable = Math.floor((ceiling - chars) / averageChars);
      /*
       * A pruning read does not widen its batches, because the batch is also how far ahead it
       * commits to reading.
       *
       * `worthReading` is consulted when a batch is formed, so everything already in one is
       * fetched and walked whether or not the tiles before it settled the answer. At six tiles a
       * Manchester viewport opens the whole middle of the screen to fill four hundred markers it
       * had after two of them. Holding the batch at two keeps enough parallelism that the read is
       * not a serial chain of round trips, while letting the bound tighten four times as often —
       * and the resource this is defending is CPU, which waiting on a round trip does not spend.
       */
      const widest = worthReading ? FIRST_TILE_BATCH : TILE_READ_BATCH;
      batchSize = Math.max(1, Math.min(widest, affordable));
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
    /**
     * Whether the tiles this opens may stay resident afterwards.
     *
     * A pattern geometry tile is the largest object a passenger request touches — 1.3 to 3.3 MiB
     * in a city — and the one caller that wants a single bus identified does not want it kept.
     * See `readShardSized`.
     */
    retain = true,
    /**
     * Build only the patterns whose geometry passes near this point.
     *
     * For the one caller that wants a single pattern out of a tile: see `patternsNear`. Absent
     * means build everything, which is what a journey corridor and a viewport both need — they
     * want the whole slice, not one line of it.
     */
    near?: { centre: Coordinate; marginDegrees: number },
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
      near ? patternsNear(near.centre, near.marginDegrees) : undefined,
      retain,
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
  ): Promise<NetworkSlice & { complete: boolean; tooWide: boolean }> {
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
    /*
     * The projection, filtered to the box, and both halves of that were missing.
     *
     * This read had **no filter at all** — `stopsInTiles` over every tile the corridor touches,
     * parsing every stop in each of them including the ones outside the box — and it read the full
     * stop family, whose records carry provenance, quality flags, amenities, accessibility and
     * NaPTAN status and whose tiles reach 8.1 MiB. The planner reads three fields: the id, the name
     * and the coordinate. Run 95 put the death here, with the trail ending at
     * `journey:slice:begin` and the pattern tiles already skipped, so the corridor's stops were
     * the only thing left in the window.
     *
     * The map projection carries exactly those three fields at about a fifteenth of the bytes, and
     * the box test now runs before a record is built rather than after. The full family is still
     * the fallback for an artifact published without a projection.
     */
    const projected = await this.mapStopsInBoundingBox(
      bbox,
      /*
       * Everything in the corridor, not a screenful. The limit exists for a viewport, which ranks
       * by distance from the centre and drops the rest; a plan that silently lost the stops at one
       * end of its corridor would be a plan missing the bus somebody wants. Past this the read
       * reports itself truncated and the planner refuses, which is the correct answer.
       */
      JOURNEY_CORRIDOR_STOP_LIMIT,
      now,
      ledger,
      stopBudgetChars,
    );
    const stops = projected ?? {
      /* The general family, for an artifact with no projection. It is filed on the stop grid, so
       * a corridor spans a quarter of the squares and the per-request tile cap does not bite. */
      ...(await this.stopsInTiles(
        stopTilesForBoundingBox(bbox),
        now,
        ledger,
        stopBudgetChars,
        withinBoundingBox(bbox),
      )),
      tooWide: false,
    };
    const patterns =
      options.patterns === "skip"
        ? { geometries: [] as PatternGeometry[], complete: true }
        : await this.patternsInTilesDetailed(
            patternTilesForBoundingBox(bbox),
            now,
            ledger,
            options.patternBudgetChars,
          );
    /*
     * The services of the patterns this slice actually holds, not all 13,626 of them.
     *
     * `services()` is `readCurrent`: an FNV-1a hash over a 4.7 MiB object *and* a `JSON.parse` of
     * every record, before a caller takes the handful it wants. On a corridor that skips the
     * pattern tiles there are no ids yet, which is the right answer too — the planner resolves its
     * patterns from the trips and asks for their services then, which is the only place it looks a
     * service up at all. Run 92's journeys died between `journey:begin` and the slice, and this is
     * the one thing in that window that reads a national object.
     */
    const serviceIds = new Set(
      patterns.geometries.map((geometry) => geometry.pattern.serviceRouteId),
    );
    const services =
      serviceIds.size === 0
        ? new Map<string, ServiceRoute>()
        : await this.servicesByIds(serviceIds);
    return {
      stopsById: new Map(stops.stops.map((stop) => [stop.id, stop])),
      patternsById: new Map(
        patterns.geometries.map((geometry) => [geometry.pattern.id, geometry.pattern]),
      ),
      services,
      complete: !stops.truncated && patterns.complete,
      /*
       * Carried separately so the planner can say the useful thing. A corridor that needs more
       * objects than one invocation may open is a request for a journey this planner is not for,
       * which is a different sentence from "we could not read the whole timetable".
       */
      tooWide: stops.tooWide,
    };
  }

  /**
   * A viewport from the map projection, when the artifact carries one.
   *
   * Returns `null` when it does not, so the caller falls back to the stop and stop-route families
   * rather than describing an empty country — the same contract the pattern index uses, and for
   * the same reason: an artifact published before this existed has to keep working until it is
   * rebuilt.
   *
   * The saving is bytes, which is the floor the parse-time filters could not get under: walking
   * the text costs about three milliseconds a mebibyte before an object is built, and a viewport
   * was reading 7.00 MiB across two families to draw four hundred markers.
   */
  /**
   * Which grid this artifact's map projection is filed on.
   *
   * The Worker deploys before the data is rebuilt, so for a while a reader that knows about the
   * finer grid is serving an artifact written on the coarser one. Asking that artifact for a
   * sixteenth-of-a-degree tile id names an object that was never written: `readTiles` keeps only
   * the tiles the index lists, so the request would quietly read nothing and the viewport would
   * come back with no stops on it. A map that is empty and says nothing is a worse answer than a
   * map that is slow.
   *
   * So the grid comes from the artifact's own declared layout, and an artifact that predates the
   * declaration is read on the grid it was written on.
   */
  private mapStopGrid(index: NetworkIndexRecord): number {
    return index.layout?.mapStopTileDegrees ?? STOP_TILE_DEGREES;
  }

  async mapStopsInBoundingBox(
    bbox: { west: number; south: number; east: number; north: number },
    limit: number,
    now: number = Date.now(),
    ledger?: ReadLedger,
    budgetChars?: number,
  ): Promise<{ stops: MapStop[]; truncated: boolean; tooWide: boolean } | null> {
    const index = await this.networkIndex(now);
    if (!index?.mapStopTiles || index.mapStopTiles.length === 0) return null;

    const grid = this.mapStopGrid(index);
    const centre = { lat: (bbox.north + bbox.south) / 2, lon: (bbox.east + bbox.west) / 2 };
    const wanted = tilesNearestCentre(
      mapStopTilesForBoundingBox(bbox, grid),
      grid,
      centre,
      MAP_STOP_TILES_PER_REQUEST,
    );
    const track: ReadTrack | undefined = ledger
      ? { ledger, family: "stops", budgetReason: "stop_read_budget" }
      : undefined;
    const ceiling = Math.min(budgetChars ?? this.requestChars, this.requestChars);

    if (limit < MAP_NEAREST_SELECTION_CEILING) {
      return this.nearestMapStops(bbox, limit, centre, grid, wanted, index, now, ceiling, track);
    }

    /*
     * Everything in the box, for a caller whose limit is a safety bound rather than a selector.
     *
     * The journey corridor asks for twenty thousand stops because it wants all of them: ranking
     * by distance from the centre of a corridor and cutting would drop one end of it, which is a
     * plan missing the bus somebody wants. Nothing is gained by selecting before the parse when
     * every row is going to be parsed, and holding each line's text first would raise the peak
     * rather than lower it.
     */
    const read = await this.readTiles<MapStopRow>(
      mapStopsDataset,
      wanted.tiles,
      index.mapStopTiles,
      index.version,
      now,
      ceiling,
      track,
      // `y` and `x` rather than `lat` and `lon`: the projection's keys are one character.
      (body, start, end) => {
        const lat = numberAt(body, start, end, "y");
        const lon = numberAt(body, start, end, "x");
        if (lat === null || lon === null) return true;
        return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
      },
    );

    const inside = read.records.filter(
      (row) =>
        row.y >= bbox.south && row.y <= bbox.north && row.x >= bbox.west && row.x <= bbox.east,
    );
    const truncated = read.truncated || wanted.dropped > 0;
    if (inside.length <= limit) {
      return { stops: inside.map(mapStopFromRow), truncated, tooWide: wanted.dropped > 0 };
    }
    const ranked = inside
      .map((row) => ({ row, distance: haversineMetres(centre, { lat: row.y, lon: row.x }) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit)
      .map((entry) => mapStopFromRow(entry.row));
    return { stops: ranked, truncated: true, tooWide: wanted.dropped > 0 };
  }

  /**
   * The nearest `limit` markers to the middle of the box, chosen before a row is parsed.
   *
   * The viewport read that this replaces was proportional to the stops a city *contains* rather
   * than to the markers a screen draws, and that is the whole of the gap it was short by.
   * Manchester holds 3,006 projection rows inside the box and the map draws four hundred, so the
   * old read walked 878,854 characters, built 3,006 `MapStopRow` objects, took a haversine to each
   * of them, sorted all of them and then discarded five sixths. Cloudflare measured the endpoint
   * at 38 ms against a ten-millisecond limit.
   *
   * Three things change, and the third is the one that moves the floor:
   *
   * **The cap is applied before the parse, not after it.** `NearestLines` knows the
   * four-hundredth-nearest distance as it goes, so a row that cannot beat it is never sliced out
   * of the buffer, never parsed and never built. Only the keepers become objects.
   *
   * **Nothing is sorted that is not kept.** The heap costs one comparison for the common
   * rejection, against a sort over every row in the city.
   *
   * **Tiles that cannot contribute are never fetched.** `tileFloorMetres` floors the distance from
   * the centre to anywhere inside a tile; once the heap is full, a tile whose floor exceeds its
   * admission price is skipped. That is the read itself, not just its parse — the bytes never
   * arrive and the subrequest is never spent. A dense city viewport fills four hundred markers
   * from the tiles over the middle of the screen and skips the rest of the box.
   *
   * The answer is the same set of markers as the ranking it replaces, in the same order, except
   * that an exact tie is now broken on the row's own text rather than on which tile happened to be
   * fetched first. See `NearestLines`.
   */
  private async nearestMapStops(
    bbox: { west: number; south: number; east: number; north: number },
    limit: number,
    centre: Coordinate,
    grid: number,
    wanted: { tiles: string[]; dropped: number },
    index: NetworkIndexRecord,
    now: number,
    ceiling: number,
    track: ReadTrack | undefined,
  ): Promise<{ stops: MapStop[]; truncated: boolean; tooWide: boolean }> {
    const nearest = new NearestLines(limit, centre);
    let skipped = 0;

    const read = await this.readTiles<MapStopRow>(
      mapStopsDataset,
      wanted.tiles,
      index.mapStopTiles ?? [],
      index.version,
      now,
      ceiling,
      track,
      /*
       * Always `false`: this filter is the whole read.
       *
       * It takes the row's coordinates out of the raw line, decides whether the row is inside the
       * box and whether it beats the current admission price, and keeps the line's text when it
       * does. Nothing is handed back through `records`, because a row the stream reader parsed
       * would be a row parsed before it was known to be wanted — which is the cost being removed.
       */
      (body, start, end) => {
        const at = mapRowCoordinate(body, start, end);
        if (at === null) return false;
        const { lat, lon } = at;
        if (lat < bbox.south || lat > bbox.north || lon < bbox.west || lon > bbox.east) {
          return false;
        }
        nearest.offer(nearest.distanceTo(lat, lon), () => body.slice(start, end));
        return false;
      },
      true,
      (tile) => {
        if (tileFloorMetres(tile, grid, centre) <= nearest.admissionMetres) return true;
        skipped += 1;
        return false;
      },
    );

    const stops: MapStop[] = [];
    for (const kept of nearest.drain()) {
      /*
       * A line that reached here passed the coordinate scan, so an unparseable one is a fault in
       * the artifact rather than a row this viewport did not want. Skipped rather than thrown:
       * four hundred markers minus one is a map, and an exception is not.
       */
      try {
        stops.push(mapStopFromRow(JSON.parse(kept.text) as MapStopRow));
      } catch {
        continue;
      }
    }

    /*
     * Three ways to be short of the whole truth, and the map says the same thing about all of
     * them — this is not all of them — while the planner needs `tooWide` separately.
     *
     * The third is new with the selection: a tile skipped because it could not beat the admission
     * price was skipped *because* the cap was already full, so the cap is what bound the answer.
     * That is the same statement the old read made when more rows were inside the box than the
     * caller asked for, and it is made here from the count of candidates rather than from the
     * count of rows read, which the skipping deliberately makes smaller.
     */
    /* The rows this read built, which the stream could not count because it parsed none. */
    track?.ledger.built("stops", stops.length);

    const cappedByLimit = nearest.offeredCount > limit || (nearest.full && skipped > 0);
    return {
      stops,
      truncated: read.truncated || wanted.dropped > 0 || cappedByLimit,
      tooWide: wanted.dropped > 0,
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

    const fromDetail = await this.stopsFromDetail(keys, index, now);
    if (fromDetail) return fromDetail;

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
   * The stop-detail family, when the artifact carries one.
   *
   * Returns `null` when it does not, so the caller falls back to the locator and the stop tiles
   * rather than reporting a stop that exists as missing — the same contract the map projection and
   * the pattern index use.
   *
   * Two rounds at most. A stop is filed under its id, and its ATCO code is an alias row pointing
   * at that id, so a lookup by code reads its own bucket, learns the id, and reads the bucket the
   * record is in. Both are small hashed objects rather than a city's stop tile.
   */
  private async stopsFromDetail(
    keys: readonly string[],
    index: NetworkIndexRecord,
    now: number,
  ): Promise<Map<string, Stop> | null> {
    if (!index.stopDetailBuckets || index.stopDetailBuckets.length === 0) return null;

    const resolved = new Map<string, Stop>();
    const readBuckets = async (wanted: ReadonlySet<string>): Promise<StopDetailRow[]> => {
      const buckets = new Set([...wanted].map((key) => stopDetailBucketFor(key)));
      const rows = await Promise.all(
        [...buckets].map((bucket) =>
          this.readShardSized<StopDetailRow>(
            stopDetailDataset(bucket),
            index.version,
            now,
            undefined,
            // Only the rows asked about are built; the rest of the bucket is never parsed.
            (body, start, end) => {
              const key = valueAt(body, start, end, "k");
              return key === null || wanted.has(key);
            },
          ),
        ),
      );
      return rows.flatMap((read) => read.records);
    };

    /*
     * The same humanising the tile path does, at the same boundary.
     *
     * `readStopTiles` cleans the name on its way out, and a second way of reading a stop that did
     * not would put `White_Rose_Shopping_Centre` back in front of a passenger — which is exactly
     * what an existing test caught here. The identifiers are untouched: `id` and `atcoCode` are
     * what links are built from.
     */
    const present = (stop: Stop): Stop => ({ ...stop, name: passengerName(stop.name) });

    const firstPass = await readBuckets(new Set(keys));
    const aliases = new Map<string, string>();
    for (const row of firstPass) {
      if (row.s) resolved.set(row.k, present(row.s));
      else if (row.a) aliases.set(row.k, row.a);
    }

    if (aliases.size > 0) {
      const byId = await readBuckets(new Set(aliases.values()));
      const stopsById = new Map<string, Stop>();
      for (const row of byId) if (row.s) stopsById.set(row.k, present(row.s));
      for (const [key, id] of aliases) {
        const stop = stopsById.get(id);
        if (stop) resolved.set(key, stop);
      }
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
  /**
   * The map projection, read for a set of tiles and keyed both ways a route names a stop.
   *
   * A `MapStop` is not a `Stop` — it has no provenance, amenities or accessibility — but every
   * field a route variant prints is on it, and the difference in size is the whole point. The
   * shape returned here is widened to `Stop` for the caller, which is honest about what is
   * present: the fields the projection does not carry are absent rather than invented, and
   * nothing downstream of `routeVariants` reads them.
   *
   * Null when this artifact has no projection, so the general tiles still answer.
   */
  private async mapStopsForTiles(
    tiles: readonly string[],
    index: NetworkIndexRecord,
    now: number,
    budgetChars: number,
    ledger: ReadLedger | undefined,
    wanted: ReadonlySet<string>,
  ): Promise<{
    byId: Map<string, RouteStop>;
    byAtco: Map<string, RouteStop>;
    truncated: boolean;
  } | null> {
    if (!index.mapStopTiles || index.mapStopTiles.length === 0) return null;

    const read = await this.readTiles<MapStopRow>(
      mapStopsDataset,
      tiles,
      index.mapStopTiles,
      index.version,
      now,
      budgetChars,
      ledger ? { ledger, family: "stops", budgetReason: "route_stop_read_budget" } : undefined,
      (body, start, end) => hasWantedMapKey(body, start, end, wanted),
    );

    const byId = new Map<string, RouteStop>();
    const byAtco = new Map<string, RouteStop>();
    for (const row of read.records) {
      const stop: RouteStop = {
        id: row.i,
        atcoCode: row.a,
        name: passengerName(row.n),
        locationCoordinate: { lat: row.y, lon: row.x },
        ...(row.d === undefined ? {} : { indicator: row.d }),
      };
      byId.set(row.i, stop);
      byAtco.set(row.a, stop);
    }

    return { byId, byAtco, truncated: read.truncated };
  }

  async stopsForGeometries(
    geometries: readonly PatternGeometry[],
    now: number = Date.now(),
    ledger?: ReadLedger,
    budgetChars?: number,
  ): Promise<{
    stopsById: Map<string, RouteStop>;
    truncated: boolean;
    tilesRequested: number;
    requested: number;
    resolved: number;
  }> {
    const keys = [...new Set(geometries.flatMap((geometry) => geometry.pattern.stopSequence))];
    const empty = {
      stopsById: new Map<string, RouteStop>(),
      truncated: false,
      tilesRequested: 0,
      requested: keys.length,
      resolved: 0,
    };

    const index = await this.networkIndex(now);
    if (!index || keys.length === 0) return empty;

    /*
     * The shapes passed as shapes, not concatenated into one array first.
     *
     * `geometries.flatMap((g) => g.shape)` allocated a single array of every point of every
     * pattern — tens of thousands of coordinates for a long service — purely to hand it to a
     * function that iterates it once. See `stopTilesForShapes`, which also stops asking the tile
     * question of points whose neighbour already answered it.
     */
    const tiles = stopTilesForShapes(geometries.map((geometry) => geometry.shape));
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

    /*
     * The projection first, because a route page needs a marker's worth of a stop.
     *
     * Measured on the deployment, with per-family accounting: a Leeds route spent 4.56 MiB of its
     * 4.83 MiB resolving stops, reading three general tiles of full `Stop` records — four
     * kilobytes each, carrying provenance, quality flags, amenities and accessibility — to obtain
     * a name, an ATCO code and a coordinate. That is what puts this endpoint over the
     * ten-millisecond CPU ceiling, and it is the same read the map replaced.
     *
     * `network/map-stops` already holds exactly those fields at about a quarter the size, and
     * `routeVariants` uses nothing else: the id, the ATCO code, the name, and the coordinate the
     * live bounding box is built from. `locality` looks like an exception and is not — the
     * pipeline publishes an NPTG locality *code* rather than the gazetteer of names it points
     * into, so the Worker has always set that field to null on purpose. There is nothing to lose
     * by reading the smaller rows.
     *
     * Returns null when the artifact has no projection, and the general tiles answer below. The
     * filter is the same one: a line is matched by id or ATCO code before it is parsed.
     */
    /*
     * On the projection's own grid, which is finer than the general stop tiles.
     *
     * Both are derived from the same shapes; asking the projection for a quarter-degree tile id
     * would ask for an object that was never written and read a route with no stops on it.
     *
     * And bounded by count, because a corridor spans far more sixteenths of a degree than
     * quarters: a cross-country shape asks for more objects than the fifty subrequests an
     * invocation gets, which would turn a long route from expensive into impossible. Nearest the
     * middle of the route rather than the start, so what survives is the part of the line a
     * reader is most likely looking at, and the surplus is reported — `routeDetailComplete`
     * already carries a truncated stop read through to what the response says about itself.
     */
    const corridor = tilesNearestCentre(
      stopTilesForShapes(
        geometries.map((geometry) => geometry.shape),
        0.01,
        this.mapStopGrid(index),
      ),
      this.mapStopGrid(index),
      midpointOf(geometries.flatMap((geometry) => geometry.shape)),
      MAP_STOP_TILES_PER_REQUEST,
    );

    const projected = await this.mapStopsForTiles(
      corridor.tiles,
      index,
      now,
      budgetChars ?? this.requestChars,
      ledger,
      wanted,
    );
    if (projected) {
      const stopsById = new Map<string, RouteStop>();
      for (const key of keys) {
        const stop = projected.byId.get(key) ?? projected.byAtco.get(key);
        if (stop) stopsById.set(key, stop);
      }
      ledger?.count({ stops: stopsById.size });
      return {
        stopsById,
        /* The corridor's own cap counts as truncation, the same as a cut byte budget does. */
        truncated: projected.truncated || corridor.dropped > 0,
        tilesRequested: corridor.tiles.length,
        requested: keys.length,
        resolved: stopsById.size,
      };
    }

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

    const stopsById = new Map<string, RouteStop>();
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
          const objectKey = objectKeyFor(patternIndexDataset(bucket), index.version);
          try {
            /*
             * The bucket's wanted rows, built as its lines go past.
             *
             * This read the bucket as one string and then ran `decodePatternIndexFor` once per
             * wanted id — so a bucket was scanned from the top as many times as the request
             * wanted patterns from it, and the string itself was held whole while that happened.
             * Streaming walks it once and tests each line's own id against the set.
             */
            const wanted = new Set(ids);
            let chunks = 0;
            let scanned = 0;
            let carry = 0;
            let buffered = 0;
            let bodyChars = 0;
            const rows: Array<[string, PatternIndexRow]> = [];
            let missing = false;

            if (canStream(this.store)) {
              const body = await this.store.getStream(objectKey);
              if (body === null) missing = true;
              else {
                const result = await readFilteredLinesStreaming<[string, PatternIndexRow]>(body, {
                  key: objectKey,
                  keep: (buffer, lineStart, lineEnd) => {
                    const id = patternIdInIndexLine(buffer, lineStart, lineEnd);
                    return id !== null && wanted.has(id);
                  },
                  /* A row that will not parse is a pattern this reader has no stops for. */
                  onParseError: "skip",
                });
                rows.push(...result.records);
                bodyChars = result.stats.chars;
                chunks = result.stats.chunks;
                scanned = result.stats.linesScanned;
                carry = result.stats.maxCarryChars;
                buffered = result.stats.maxBufferChars;
              }
            } else {
              const raw = await this.store.get(objectKey);
              if (raw === null) missing = true;
              else {
                bodyChars = raw.length;
                for (const id of ids) {
                  const row = decodePatternIndexFor(raw, id);
                  if (row) rows.push([row.id, row]);
                }
              }
            }

            ledger?.record("patterns", {
              outcome: missing ? "missing" : "read",
              chars: bodyChars,
              records: rows.length,
              ms: Date.now() - began,
              stream:
                chunks === 0
                  ? undefined
                  : {
                      chunks,
                      linesScanned: scanned,
                      linesParsed: rows.length,
                      rowsRetained: rows.length,
                      maxBufferChars: buffered,
                      maxCarryChars: carry,
                      stoppedEarly: false,
                    },
            });
            return { rows, chars: bodyChars, missing, failed: false as const };
          } catch {
            ledger?.record("patterns", { outcome: "failed", ms: Date.now() - began });
            return { rows: [], chars: 0, missing: true, failed: true as const };
          }
        }),
      );
      start += batch.length;

      for (const body of bodies) {
        if (body.missing) {
          // A bucket the index promised and the store could not produce is a gap, not an absence.
          if (body.failed) complete = false;
          continue;
        }
        chars += body.chars;
        read += 1;
        for (const [, row] of body.rows) patterns.set(row.id, toRoutePattern(row));
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
    /**
     * The patterns the caller came for, so the rest are never built.
     *
     * Optional because an older caller that wants the whole tile still works, but the planner
     * always knows: it reads its trips first and the trips name their patterns. Without this the
     * read turned every row in every corridor tile into an object with an array of stop ids in it
     * — hundreds of patterns per tile to keep the couple of hundred a corridor runs on.
     */
    wantedPatternIds?: readonly string[],
  ): Promise<{ patterns: Map<string, RoutePattern>; complete: boolean; available: boolean }> {
    const index = await this.networkIndex(now);
    const published = index?.patternIndexTiles;
    if (!index || !published || published.length === 0) {
      return { patterns: new Map(), complete: false, available: false };
    }

    /*
     * Nothing named means nothing to read, and this is not a formality.
     *
     * The filter below is built from the ids and is `undefined` for an empty list — correct for a
     * caller that wants the whole tile, and a trap for the planner, whose want list is empty when
     * its corridor held no trips. Without this, that case opened every corridor tile and parsed
     * every row in it to answer a question nobody had asked. Complete, because an empty answer to
     * an empty question is a whole one.
     */
    if (wantedPatternIds && wantedPatternIds.length === 0) {
      return { patterns: new Map(), complete: true, available: true };
    }

    const result = await this.readTiles<[string, PatternIndexRow]>(
      patternIndexTileDataset,
      tiles,
      published,
      index.version,
      now,
      Math.min(budgetChars ?? this.requestChars, this.requestChars),
      ledger ? { ledger, family: "patterns", budgetReason: "pattern_index_budget" } : undefined,
      wantedPatternIds ? wantedPatternLineFilter(wantedPatternIds) : undefined,
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
    /** See `patternsInTilesDetailed`. The bus lookup is the caller that passes false. */
    retain = true,
    /**
     * Build only the patterns passing near the middle of the box.
     *
     * The bus lookup asks for a box around one vehicle and wants the one pattern it is on, so
     * everything else in the tile is built and thrown away — 3,156,408 characters of it in a
     * dense city, the largest allocation any passenger request makes. A viewport is the other
     * caller and genuinely wants all of them, so this is opt-in.
     */
    nearCentre = false,
  ): Promise<PatternGeometry[]> {
    return (
      await this.patternsInTilesDetailed(
        patternTilesForBoundingBox(bbox),
        now,
        ledger,
        undefined,
        retain,
        nearCentre
          ? {
              centre: { lat: (bbox.north + bbox.south) / 2, lon: (bbox.east + bbox.west) / 2 },
              /*
               * Half the box again, so a shape that clips a corner of it still counts. The
               * filter decides what to build and `matchObservation` decides what matched, so
               * generous here is cheap and mean here is a passenger losing their route.
               */
              marginDegrees: Math.max(bbox.north - bbox.south, bbox.east - bbox.west) * 0.75,
            }
          : undefined,
      )
    ).geometries;
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
      const objectKey = objectKeyFor(routePatternsDataset(bucket), index.version);
      /*
       * One service's line out of the bucket, found as the lines go past and then nothing else
       * read at all.
       *
       * The bucket held every service that hashes there, with the geometry of every one of their
       * patterns, and this buffered all of it to take one line — the largest route-patterns read
       * measured on the deployment was 939,225 characters to draw one route. Stopping at the
       * wanted line cancels the body, so the rest is never even decoded.
       */
      let streamedLines: PatternTileLine[] | null | undefined;
      let streamedChars = 0;
      let streamedStats: StreamLineStats | null = null;
      let raw: string | null = null;
      try {
        if (canStream(this.store)) {
          const body = await this.store.getStream(objectKey);
          if (body === null) {
            streamedLines = undefined;
          } else {
            const needle = `[${JSON.stringify(serviceId)},`;
            const result = await readFilteredLinesStreaming<[string, PatternTileLine[]]>(body, {
              key: objectKey,
              keep: (buffer, lineStart, lineEnd) =>
                buffer.startsWith(needle, lineStart) && lineStart + needle.length <= lineEnd,
              take: () => "keep-and-stop",
            });
            streamedChars = result.stats.chars;
            streamedStats = result.stats;
            streamedLines = result.records[0]?.[1] ?? null;
          }
        } else {
          raw = await this.store.get(objectKeyFor(routePatternsDataset(bucket), index.version));
        }
      } catch {
        ledger?.record("route-patterns", { outcome: "failed", ms: Date.now() - began });
        // The object exists as far as the index is concerned and could not be read. That is not
        // "this route has no patterns"; it is "we cannot say", and the caller must not round it
        // down to an empty route drawn as though it were complete.
        return { geometries: [], complete: false, source: "unavailable" };
      }

      /* `undefined` from the streamed path, `null` from the buffered one: the object is absent. */
      if (streamedLines === undefined && raw === null) {
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

      const lines =
        raw === null ? (streamedLines ?? null) : decodeRoutePatternsForService(raw, serviceId);
      ledger?.record("route-patterns", {
        outcome: "read",
        chars: raw === null ? streamedChars : raw.length,
        records: lines?.length ?? 0,
        ms: Date.now() - began,
        stream:
          streamedStats === null
            ? undefined
            : {
                chunks: streamedStats.chunks,
                linesScanned: streamedStats.linesScanned,
                linesParsed: streamedStats.linesParsed,
                rowsRetained: streamedStats.rowsRetained,
                maxBufferChars: streamedStats.maxBufferChars,
                maxCarryChars: streamedStats.maxCarryChars,
                stoppedEarly: streamedStats.stoppedEarly,
              },
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

  /**
   * The patterns that call at one stop, from the smallest published form of that fact.
   *
   * Two rounds of measurement are behind this, and the second contradicted the first.
   *
   * It began as `patternsInBoundingBox(...).filter(calls here)`, where the filter ran *after*
   * every line in the surrounding pattern tiles had been turned into an object — hundreds of
   * patterns and, worse, the polylines they share, to keep about ten stop sequences. Run 89
   * watched a Manchester board die here: last crumb `board:live:done` at `atMs: 0`, which is the
   * line that calls this.
   *
   * Moving the filter in front of the parse was not enough, and the fast loop after run 90 is
   * what showed it: Manchester Piccadilly came back with **two** routes where dozens call, other
   * boards still answered Cloudflare's error page, and both have the same cause. The bytes arrive
   * whether or not they are parsed, and scanning three mebibytes of geometry line by line is
   * itself several milliseconds of the ten a Workers Free invocation gets. No filter makes
   * megabytes of polyline affordable.
   *
   * So the board reads a different dataset. The pattern *index* tiles carry the same patterns on
   * the same grid with the shapes removed — run 48 measured a geometry tile at 4.21 MiB for 625
   * patterns, and these are those patterns without their polylines — so the scan is over roughly
   * a fifteenth of the text, and there is no shape to skip because there is none there. The
   * geometry path stays as the fallback for an artifact published before the index existed.
   *
   * Returns `RoutePattern`, not `PatternGeometry`: there is no shape here, and handing back a
   * geometry with an empty polyline would invite a caller to draw nothing.
   */
  /**
   * The patterns a handful of ids name, from the shape-free index tiles around a stop.
   *
   * The targeted version of `patternsCallingAtStop`, for the caller that already knows which
   * patterns it wants — a departure board, whose rows each carry their pattern id. The geographic
   * version has to scan whole tiles because it is answering "what calls here"; this one is
   * answering "where are these twelve", and the ids turn the scan into a cheap id test per line
   * with a parse only for the ones named.
   *
   * Stop `1800EB06161` is why this exists: a Manchester board that answered Cloudflare's error
   * page on every deployed run, dying immediately after `board:live:done`, which is the
   * geographic read. The densest stops have the largest tiles and need this read the least — they
   * have the most departures naming their patterns outright.
   */
  async patternsByIdsNearStop(
    stop: Stop,
    patternIds: ReadonlySet<string>,
    now: number = Date.now(),
    ledger?: ReadLedger,
  ): Promise<{ patterns: RoutePattern[]; complete: boolean; source: string }> {
    if (patternIds.size === 0) return { patterns: [], complete: true, source: "no_pattern_ids" };
    const index = await this.networkIndex(now);
    const indexTiles = index?.patternIndexTiles ?? [];
    if (!index || indexTiles.length === 0) {
      return { patterns: [], complete: false, source: "unavailable" };
    }
    if (ledger && !ledger.withinBudget) {
      ledger.stop("pattern_enrichment_budget");
      return { patterns: [], complete: false, source: "declined" };
    }

    const read = await this.readTiles<[string, PatternIndexRow]>(
      patternIndexTileDataset,
      patternTilesForBoundingBox(boxAround(stop.locationCoordinate)),
      indexTiles,
      index.version,
      now,
      Math.min(this.patternChars, this.requestChars),
      ledger
        ? { ledger, family: "patterns", budgetReason: "pattern_enrichment_budget" }
        : undefined,
      wantedPatternLineFilter([...patternIds]),
    );

    const patterns: RoutePattern[] = [];
    const seen = new Set<string>();
    for (const line of read.records) {
      if (!Array.isArray(line) || line.length !== 2) continue;
      const row = line[1];
      if (!row || typeof row !== "object" || !("stopSequence" in row)) continue;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      patterns.push(toRoutePattern(row));
    }
    ledger?.count({ patterns: patterns.length });
    /*
     * Complete means every id was found, not that the read finished. A board that resolved eight
     * of twelve patterns names eight routes, and the caller has to be able to say so rather than
     * presenting eight as the answer.
     */
    return {
      patterns,
      complete: !read.truncated && patterns.length === patternIds.size,
      source: "pattern_index_by_id",
    };
  }

  /**
   * Which services call at one stop, from the stop's own bucket.
   *
   * The board asked the pattern index on the geographic grid for this whenever its departures
   * named no patterns — which is every stop with nothing due — and the deployed cold ledger
   * measured one Manchester board decoding 2.03 MiB of a single tile to answer it. The byte
   * budget could not help: it is checked between tiles and `boxAround` asks for one.
   *
   * This is the same answer with no geography in it. One bucket, chosen by a hash of the stop id,
   * and the line is found by scanning for `["<id>"` so nothing else in the object is ever parsed.
   * It returns ids only; the names, the operators and everything a passenger reads come from
   * `servicesByIds` and `operatorsByIds`, which the board already calls.
   *
   * `available` is false on an artifact published before the family existed, which is what sends
   * the caller back to the pattern read rather than describing a stop as having no services.
   */
  async servicesCallingAtStop(
    stopId: string,
    now: number = Date.now(),
    ledger?: ReadLedger,
  ): Promise<{ serviceIds: string[]; available: boolean }> {
    const index = await this.networkIndex(now);
    const buckets = index?.stopServicesBuckets ?? 0;
    if (!index || buckets <= 0) return { serviceIds: [], available: false };

    const bucket = stopServicesBucketFor(stopId, buckets);
    /*
     * A bucket the publish did not write means nothing hashed there, which is an answer. A bucket
     * it did write and that cannot be read is not, and the shard list is what tells them apart.
     */
    if (index.stopServicesShards && !index.stopServicesShards.includes(bucket)) {
      return { serviceIds: [], available: true };
    }

    const needle = `["${stopId}"`;
    const rows = await this.readShardSized<[string, string[]]>(
      stopServicesDataset(bucket),
      index.version,
      now,
      ledger ? { ledger, family: "services", budgetReason: "stop_services_budget" } : undefined,
      (body, start, end) => body.startsWith(needle, start) && start + needle.length <= end,
      /* One stop's line out of a bucket: a partial parse must never be cached as the whole one. */
      false,
    );

    const row = rows.records.find(([id]) => id === stopId);
    return { serviceIds: row ? row[1] : [], available: true };
  }

  /**
   * Which routes serve a stop, named and attributed, from one bucket.
   *
   * `servicesCallingAtStop` above removed the geographic pattern scan and left the board holding
   * fifty service ids to resolve. Each lives in its own hashed service bucket, so an interchange
   * asked for upwards of thirty-two objects — each a subrequest against the fifty an invocation
   * gets for everything — and the deployed probe measured Leeds City Bus Station going from four
   * of four samples answering to four of four answering 1102. The enriched family carries the
   * name and the operator beside the id, so the cost is one object whatever the stop's size.
   *
   * Identity is not collapsed by name: several operators run a "1", and the service id and
   * operator id are both carried so a board links to the right timetable and the right operator.
   *
   * Null when this artifact does not declare the family, which is every artifact published before
   * it existed. The caller then uses what it used before rather than treating "we cannot read it"
   * as "no routes call here".
   */
  async servingRoutesAtStop(
    stopId: string,
    now: number = Date.now(),
    ledger?: ReadLedger,
  ): Promise<{ routes: StopServingRoute[]; complete: boolean } | null> {
    const index = await this.networkIndex(now);
    const buckets = index?.stopServingRoutesBuckets ?? 0;
    if (!index || buckets <= 0) return null;

    const bucket = stopServingRoutesBucketFor(stopId, buckets);
    /*
     * A bucket the publish did not write means nothing hashed there, which is an answer — a stop
     * no service calls at has no row and that is the truth about it. A bucket it did write and
     * that cannot be read is not an answer, and the shard list is what tells the two apart.
     */
    if (index.stopServingRoutesShards && !index.stopServingRoutesShards.includes(bucket)) {
      return { routes: [], complete: true };
    }

    const needle = `["${stopId}"`;
    /*
     * Two lines out of the bucket: the stop's own, and the header carrying the operator table.
     * The header is first by construction, so it is taken by position rather than by shape — a
     * filter that recognised it by content would also match a stop whose id began with a brace.
     */
    const read = await this.readShardSized<StopServingRoutesLine>(
      stopServingRoutesDataset(bucket),
      index.version,
      now,
      ledger
        ? { ledger, family: "services", budgetReason: "stop_serving_routes_budget" }
        : undefined,
      (body, start, end, line) =>
        line === 0 || (body.startsWith(needle, start) && start + needle.length <= end),
      /* One stop's line out of a bucket: a partial parse must never be cached as the whole one. */
      false,
    );

    let operators: StopServingOperator[] = [];
    let row: [string, Array<[string, string, number]>] | null = null;
    for (const line of read.records) {
      if (Array.isArray(line)) {
        if (line[0] === stopId) row = line as [string, Array<[string, string, number]>];
      } else if (Array.isArray(line.o)) {
        operators = line.o;
      }
    }

    /*
     * A row whose operator table did not come back is not a row this reader can attribute, and a
     * route attributed to "Unknown operator" when the artifact knows perfectly well who runs it
     * is a worse answer than saying the list is incomplete. The budget is the only thing that can
     * cause it — the header is the first line and costs a few kilobytes — so it is reported
     * rather than papered over.
     */
    if (row !== null && operators.length === 0 && row[1].length > 0) {
      return { routes: [], complete: false };
    }

    const routes = (row?.[1] ?? [])
      .map(([id, name, operatorIndex]) => {
        const operator = operators[operatorIndex];
        return {
          id,
          publicName: name,
          operatorId: operator?.[0] ?? "",
          operatorName: operator?.[1] ?? "Unknown operator",
        };
      })
      /*
       * Presented in the same order as the other two paths, which sort by name here rather than
       * in the publisher. A board whose routes reshuffled depending on which family answered
       * would reshuffle itself as the artifact rolled forward, for no reason a reader could see.
       */
      .sort((a, b) => compareRouteNames(a.publicName, b.publicName));
    /*
     * Complete when the bucket was actually read.
     *
     * `chars` is the text this read walked, so zero means the object was absent or the read did
     * not happen — and then "no row for this stop" is not a statement about the stop at all. With
     * the bucket read, a stop with no row genuinely has no service calling at it, which is the
     * answer for a withdrawn stop or a stop on a route that stopped running, and saying so is the
     * point of having a direct index.
     */
    if (read.chars === 0) return { routes: [], complete: false };
    return { routes, complete: true };
  }

  async patternsCallingAtStop(
    stop: Stop,
    now: number = Date.now(),
    ledger?: ReadLedger,
  ): Promise<{ patterns: RoutePattern[]; complete: boolean; source: string }> {
    const index = await this.networkIndex(now);
    if (!index) return { patterns: [], complete: false, source: "unavailable" };

    if (ledger && !ledger.withinBudget) {
      ledger.stop("pattern_enrichment_budget");
      return { patterns: [], complete: false, source: "declined" };
    }

    const tiles = patternTilesForBoundingBox(boxAround(stop.locationCoordinate));
    const indexTiles = index.patternIndexTiles ?? [];

    if (indexTiles.length > 0) {
      const read = await this.readTiles<[string, PatternIndexRow]>(
        patternIndexTileDataset,
        tiles,
        indexTiles,
        index.version,
        now,
        /*
         * The map's bound, and lowering it to the board's own was tried and reverted.
         *
         * The deployed cold ledger measures a Manchester board decoding 2.03 MiB here, and the
         * obvious response is to allow it less. It would change nothing: `boxAround` is 1,500
         * metres and the pattern grid is an eighth of a degree, so this read asks for one tile
         * almost every time, and a budget is only ever checked between tiles. The 2.03 MiB is one
         * object, and a smaller number would not have stopped it.
         *
         * Reducing it needs a smaller unit of storage rather than a smaller allowance, which is a
         * different piece of work from this one. The number is left where it is so nobody reads a
         * tighter bound as a saving that was never made.
         */
        Math.min(this.patternChars, this.requestChars),
        ledger
          ? { ledger, family: "patterns", budgetReason: "pattern_enrichment_budget" }
          : undefined,
        stopMentionedInLine(stop.id),
      );

      const patterns: RoutePattern[] = [];
      const seen = new Set<string>();
      for (const line of read.records) {
        // The header line parses as an object rather than a pair; a row is always `[id, row]`.
        if (!Array.isArray(line) || line.length !== 2) continue;
        const row = line[1];
        if (!row || typeof row !== "object" || !("stopSequence" in row)) continue;
        // The text test says the line mentions this stop. Calling here is the stronger claim, and
        // it is the one the board makes.
        if (!row.stopSequence.includes(stop.id)) continue;
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        patterns.push(toRoutePattern(row));
      }
      ledger?.count({ patterns: patterns.length });
      return { patterns, complete: !read.truncated, source: "pattern_index_tiles" };
    }

    const result = await this.readTiles<PatternTileLine>(
      patternTileDataset,
      tiles,
      index.patternTiles,
      index.version,
      now,
      // A board's own bound, not the map's. See BOARD_PATTERN_READ_CHARS.
      Math.min(BOARD_PATTERN_READ_CHARS, this.requestChars),
      ledger
        ? { ledger, family: "patterns", budgetReason: "pattern_enrichment_budget" }
        : undefined,
      stopMentionedInLine(stop.id),
    );

    const patterns: RoutePattern[] = [];
    const seen = new Set<string>();
    for (const line of result.records) {
      // Shape lines cannot mention a stop id and so should not survive the filter; a shapeRef that
      // happened to collide with one would, and is simply not a pattern.
      if (line.kind !== "pattern") continue;
      // The text test says the line mentions this stop somewhere. Calling here is a stronger
      // claim, and it is the claim the board makes.
      if (!line.pattern.stopSequence.includes(stop.id)) continue;
      if (seen.has(line.pattern.id)) continue;
      seen.add(line.pattern.id);
      patterns.push(line.pattern);
    }
    ledger?.count({ patterns: patterns.length });
    return { patterns, complete: !result.truncated, source: "pattern_tiles" };
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
  private async placeLines(): Promise<string[]> {
    if (this.placeLinesCache) return this.placeLinesCache;
    const artifacts = new ArtifactStore(this.store);
    try {
      const manifest = await artifacts.readManifest(PLACES_DATASET);
      const raw = manifest === null ? null : await this.store.get(manifest.objectKey);
      this.placeLinesCache = raw === null ? [] : raw.split("\n").filter((line) => line.length > 0);
    } catch {
      // A gazetteer that cannot be read costs a search its landmarks, not its answer.
      this.placeLinesCache = [];
    }
    return this.placeLinesCache;
  }

  /**
   * The landmarks a query could mean, and only those.
   *
   * This parsed all 3,178 of them and held the result for the isolate's life. That was a response
   * to run 82, where filtering lost Manchester Arndale, Bullring and Bristol Temple Meads — and
   * the diagnosis was wrong. The filter did not fail because filtering is unsafe here; it failed
   * because it used a lowercase stem against text a cartographer capitalised. `placeLineFilter`
   * tests both forms, which is what that run needed.
   *
   * Filtering matters because the parse is the cost. `places=3178` was resident in every isolate
   * that answered error 1102 across runs 90 to 96, and the request that paid for it is whichever
   * one happened to search first. A query names a handful of landmarks, so a handful is what gets
   * built; the text stays cached, so the bytes are paid for once either way.
   */
  private async placeEntriesMatching(words: readonly string[]): Promise<SearchIndexEntry[]> {
    const lines = await this.placeLines();
    const keep = placeLineFilter(words);
    const entries: SearchIndexEntry[] = [];
    for (const [ordinal, line] of lines.entries()) {
      /*
       * Tested on the whole line, which here *is* the record — `placeLines` splits the object into
       * lines and holds them, so each string is one place and the filter's bounds are its own
       * ends. No filter means the query had nothing to narrow by, and then every landmark is a
       * candidate, which is the same rule the stop index follows.
       */
      if (keep && !keep(line, 0, line.length, ordinal)) continue;
      try {
        entries.push(placeAsSearchEntry(JSON.parse(line) as PlaceRecord));
      } catch {
        // One unreadable line is one missing landmark, not a failed search.
      }
    }
    return entries;
  }

  /**
   * The whole national operator table. **Nothing on a request path may call this.**
   *
   * Kept because the tests use it as an oracle — "the filtered read agrees with the whole table"
   * is only checkable against the whole table — and because deleting it would not stop the next
   * caller, only hide what it costs. `readCurrent` runs an FNV-1a hash over the entire object and
   * `JSON.parse`s every record before returning one, which is tens of milliseconds against the
   * ten a Workers Free invocation gets. Three handlers called it, each for a single operator, and
   * each of them answered Cloudflare's error page on the first request in a fresh isolate and
   * worked on every one after. Ask `operatorsByIds` instead.
   */
  async operators(now: number = Date.now()): Promise<Map<string, Operator>> {
    if (this.operatorsCache) return this.operatorsCache;
    const artifacts = new ArtifactStore(this.store);
    const result = await artifacts.readCurrent<Operator>(DATASETS.operators);
    void now;
    this.operatorsCache = new Map(result.records.map((o) => [o.id, o]));
    return this.operatorsCache;
  }

  /**
   * The whole national service table, 13,626 records. **Nothing on a request path may call this.**
   *
   * The same warning as `operators()` above, and this is the one that was actually doing the
   * damage: `/v1/map` read it for every viewport holding a vehicle with no line name, and the
   * journey planner's corridor slice read it unconditionally. The map's own diagnostics printed
   * `services=13626` on the runs where half the endpoints answered error 1102. Ask
   * `servicesByIds` or `servicesForOperator`, both of which scan the text and parse only what was
   * asked for.
   */
  async services(now: number = Date.now()): Promise<Map<string, ServiceRoute>> {
    if (this.servicesCache) return this.servicesCache;
    const artifacts = new ArtifactStore(this.store);
    const result = await artifacts.readCurrent<ServiceRoute>(DATASETS.services);
    void now;
    this.servicesCache = new Map(result.records.map((s) => [s.id, s]));
    return this.servicesCache;
  }

  /**
   * The postcodes a query could mean, from the one object whose name the query contains.
   *
   * "LS1 4DY" matched nothing at all before this: the search index holds stops, routes, operators
   * and landmarks, and a postcode is none of them. The index is partitioned by outward code, which
   * is the part the query already carries — so `LS1 4DY` names `search/postcodes/LS1`, about
   * 55 KiB, and an absent object is a complete answer rather than a reason to look elsewhere.
   *
   * Filtered on the id before anything is parsed, like every other read here: a district holds a
   * few hundred to a few thousand postcodes and a query wants one of them, or the handful sharing
   * a half-typed sector. The exact match sorts first, because somebody who typed a whole postcode
   * means that one.
   *
   * Empty is the normal answer in three different cases — not a postcode, a district with no
   * object, a prefix nothing starts with — and search then finds stops and places exactly as it
   * did before.
   */
  async postcodeMatches(
    query: string,
    limit = 5,
    ledger?: ReadLedger,
  ): Promise<SearchIndexEntry[]> {
    if (!looksLikePostcode(query)) return [];
    const bare = query.toUpperCase().replace(/[\s-]+/g, "");

    /*
     * Which object to open, which a half-typed postcode does not always say.
     *
     * A whole postcode is unambiguous: `normalisePostcode` knows that `LS14DY` is `LS1 4DY` and
     * not district LS14, because the inward code is always three characters. A prefix is not.
     * `LS14` is district LS14 in Leeds *and* the first four characters of `LS1 4DY`, and nothing
     * in the text decides between them.
     *
     * So: if the query has a separator in it, the person has already said which — `LS1 4` means
     * district LS1. Without one, the longer reading is tried first and the shorter second, which
     * costs a second small read only for an ambiguous prefix that the longer reading does not
     * answer.
     */
    const separated = /[\s-]/.test(query.trim());
    const outwardCandidates: string[] = [];
    const push = (candidate: string | null | undefined) => {
      if (
        candidate &&
        /^[A-Z]{1,2}\d[A-Z\d]?$/.test(candidate) &&
        !outwardCandidates.includes(candidate)
      ) {
        outwardCandidates.push(candidate);
      }
    };
    if (separated) {
      push(
        query
          .trim()
          .toUpperCase()
          .split(/[\s-]+/)[0],
      );
    } else {
      push(outwardCode(query));
      push(bare.match(/^[A-Z]{1,2}\d[A-Z\d]?/)?.[0]);
      push(bare.match(/^[A-Z]{1,2}\d/)?.[0]);
    }
    if (outwardCandidates.length === 0) return [];

    const canonical = normalisePostcode(query);
    /*
     * The text to match against. A whole postcode is compared to its canonical form; a prefix is
     * compared without its space, because `LS1 4` and `LS14` are the same thing half-typed and the
     * stored id has a space in it.
     */
    const wantedBare = bare;

    let outward = outwardCandidates[0]!;
    let records: Array<{ id: string; coordinate: Coordinate }> = [];
    let chars = 0;

    const artifacts = new ArtifactStore(this.store);
    for (const candidate of outwardCandidates) {
      /*
       * This family's own version, from its own manifest.
       *
       * It used to be handed the *network index's* version, and the deployed probe is what found
       * that: the index is published on its own timeline — Code-Point Open is a quarterly product
       * that has nothing to do with a timetable build — so the key it composed named a version
       * that had never existed for a postcode object, every read missed, and search answered
       * nothing for every postcode in England. The unit tests passed because they published both
       * families at "v1", which made the two versions coincide and the fault invisible.
       */
      const dataset = postcodeBucketDataset(candidate);
      const manifest = await artifacts.readManifest(dataset);
      if (manifest === null) continue;
      const read = await this.readShardSized<{ id: string; coordinate: Coordinate }>(
        dataset,
        manifest.version,
        Date.now(),
        ledger ? { ledger, family: "postcodes", budgetReason: "postcode_read" } : undefined,
        (body, start, end) => {
          const id = valueAt(body, start, end, "id");
          if (id === null) return false;
          return id.replace(" ", "").startsWith(wantedBare);
        },
      );
      chars += read.chars;
      if (read.records.length > 0) {
        outward = candidate;
        records = read.records;
        break;
      }
    }

    ledger?.artifactNote({
      postcodeOutward: outward,
      postcodeChars: chars,
      postcodeMatches: records.length,
    });

    const matches = records
      .filter((record) => typeof record.id === "string" && record.coordinate)
      .sort((a, b) => (a.id === canonical ? -1 : b.id === canonical ? 1 : a.id.localeCompare(b.id)))
      .slice(0, limit);

    return matches.map((record) => ({
      kind: "postcode" as const,
      id: record.id,
      title: record.id,
      // The action, not the kind: the lozenge beside it already says "Postcode".
      subtitle: "Stops nearby",
      coordinate: record.coordinate,
      tokens: [],
      codes: [record.id],
      hasLiveCoverage: false,
      prominence: 0,
    }));
  }

  /**
   * Every service's id and the number on its front, which is all the map ever reads.
   *
   * The buckets fixed the board, which wants three services, and cannot fix the map, which wants
   * hundreds: a city viewport names a few hundred distinct services, those hash across nearly all
   * 256 buckets, and a Workers Free invocation gets fifty subrequests. So the map correctly falls
   * through to the whole services object, which the bucket proof measures at 4,669,134 bytes. It
   * is not counted in the endpoint instrument's `charsDecoded` — that is tracked shard reads, the
   * tiles — which is why this records its own cost in the artifact notes below.
   *
   * It is not the records the map needs, though. Every use of a resolved service in `/v1/map` is
   * `service.id` or `service.publicName`; the operator, the licence ids, the provenance and the
   * direction descriptions are all fetched, decoded and parsed to read two strings off each
   * record. This reads the projection instead: the same answer for about a sixth of the bytes.
   *
   * Null when the family is not published at this version, which is what a deployment reading an
   * older artifact sees, and the caller falls back to the services themselves.
   *
   * The manifest and the object directly rather than `readCurrent`, for the reason `placeLines`
   * does the same: `readCurrent` runs an FNV-1a hash over the whole object before anything is
   * parsed, and the hash is pure computation in the one budget this product is short of.
   */
  private serviceNamesCache: Map<string, string> | null = null;

  async serviceNames(ledger?: ReadLedger): Promise<Map<string, string> | null> {
    /*
     * Noted on every call, not only on the one that reads.
     *
     * The first version recorded its cost after the fetch and returned early from the cache above
     * it, so thirty measured map requests against a warm isolate produced no note at all — and an
     * absent note reads exactly like "the projection was never used". The note is a map write; the
     * read it describes is the expensive part, and saying which request paid for it is worth more
     * than the write costs.
     */
    if (this.serviceNamesCache) {
      ledger?.artifactNote({
        serviceNamesRecords: this.serviceNamesCache.size,
        serviceNamesResident: true,
      });
      return this.serviceNamesCache;
    }
    const artifacts = new ArtifactStore(this.store);
    try {
      const manifest = await artifacts.readManifest(SERVICE_NAMES_DATASET);
      if (manifest === null) return null;
      const raw = await this.store.get(manifest.objectKey);
      if (raw === null) return null;
      const names = new Map<string, string>();
      for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        const record = JSON.parse(line) as ServiceName;
        if (typeof record?.id === "string" && typeof record.publicName === "string") {
          names.set(record.id, record.publicName);
        }
      }
      ledger?.artifactNote({
        serviceNamesChars: raw.length,
        serviceNamesRecords: names.size,
        serviceNamesResident: false,
      });
      this.serviceNamesCache = names;
      return names;
    } catch (error) {
      /*
       * A projection that cannot be read is not a reason to answer nothing. The caller has a
       * complete path through the services themselves, and taking it is strictly better than a
       * map with no route numbers on it — but it is said out loud, because a silent fallback to a
       * 4.7 MiB read is the kind of regression that hides for weeks.
       */
      ledger?.artifactNote({
        serviceNamesFailed: error instanceof Error ? error.name : "unknown",
      });
      return null;
    }
  }

  /**
   * The national objects, scanned rather than held.
   *
   * These were read once per isolate and kept as text: 4,669,154 characters of services and an
   * operators table beside them, on the reasoning that text is cheap to hold and the saving is the
   * parse. That reasoning was about CPU and it was right about CPU — `readCurrent` hashes the
   * whole object and parses all 13,593 services before a caller sees one, and a board wants about
   * ten of them. But the limit that actually sheds these requests is 128 MB **per isolate across
   * requests**, so a string held for a hypothetical later reader is charged against every request
   * that follows it.
   *
   * So the object is streamed and only the wanted rows are built. The characters are paid for
   * again on a second read, which is a subrequest and no compute, and the national objects are a
   * fallback path in any case: the bucketed families answer first, and this is what is left for an
   * artifact published before they existed.
   *
   * Null means no manifest or no object — "we cannot say" — which every caller keeps distinct from
   * an empty result.
   */
  private async nationalRows<T>(
    dataset: string,
    keep: LineFilter,
    enough?: (retained: number) => boolean,
  ): Promise<{ rows: T[]; chars: number } | null> {
    const artifacts = new ArtifactStore(this.store);
    const manifest = await artifacts.readManifest(dataset);
    if (!manifest) return null;

    if (!canStream(this.store)) {
      const raw = await this.store.get(manifest.objectKey);
      if (raw === null) return null;
      const rows: T[] = [];
      let line = 0;
      for (let start = 0; start < raw.length;) {
        const newline = raw.indexOf("\n", start);
        const end = newline < 0 ? raw.length : newline;
        if (end > start) {
          if (keep(raw, start, end, line)) {
            try {
              rows.push(JSON.parse(raw.slice(start, end)) as T);
            } catch {
              /* A line that will not parse is a record this reader has no answer for. */
            }
            if (enough?.(rows.length) === true) break;
          }
          line += 1;
        }
        if (newline < 0) break;
        start = newline + 1;
      }
      return { rows, chars: raw.length };
    }

    const body = await this.store.getStream(manifest.objectKey);
    if (body === null) return null;
    const result = await readFilteredLinesStreaming<T>(body, {
      key: manifest.objectKey,
      keep,
      onParseError: "skip",
      take: (_row, retained) => (enough?.(retained + 1) === true ? "keep-and-stop" : "keep"),
    });
    return { rows: result.records, chars: result.stats.chars };
  }

  /**
   * The wanted services from their buckets, or null when the family is not published here.
   *
   * Null is the signal to fall back, and it is returned only when none of the buckets the wanted
   * ids fall into exists — which is what a version published before this family looks like. A
   * bucket that exists and does not contain an id is an answer, not a failure.
   */
  private async servicesFromBuckets(
    ids: ReadonlySet<string>,
    ledger?: ReadLedger,
    /**
     * Read what the cap allows instead of refusing, for a caller that must not fall back.
     *
     * The fallback is the whole national services object, 4.7 MiB, and for one caller that is now
     * the wrong answer rather than a slower one — see `servicesByIdsBounded`.
     */
    bounded = false,
  ): Promise<{ services: Map<string, ServiceRoute>; complete: boolean } | null> {
    const index = await this.networkIndex(Date.now());
    if (!index) return null;

    /*
     * Grouped, so a board asking for three ids that happen to share a bucket reads one object. The
     * cap is a bound on the worst case rather than an expected path: a request that already knows
     * fifty service ids is not a board, and for that many the whole object is the cheaper read.
     */
    const byBucket = new Map<number, string[]>();
    for (const id of ids) {
      const bucket = serviceBucketFor(id);
      const existing = byBucket.get(bucket);
      if (existing) existing.push(id);
      else byBucket.set(bucket, [id]);
    }
    if (byBucket.size > MAX_SERVICE_BUCKETS_PER_REQUEST && !bounded) return null;
    /*
     * Sorted before the cut, so a board that cannot have all its buckets reads the same ones
     * every time. An arbitrary slice would make the same stop list different routes on different
     * requests, which reads as the data being wrong rather than as the list being bounded.
     */
    const selected = [...byBucket]
      .sort((a, b) => a[0] - b[0])
      .slice(0, MAX_SERVICE_BUCKETS_PER_REQUEST);
    const complete = selected.length === byBucket.size;

    const found = new Map<string, ServiceRoute>();
    let bucketsPresent = 0;
    let chars = 0;

    /*
     * All the buckets at once, because the saving here is bytes and CPU, not round trips.
     *
     * Measured on the deployment: a Manchester board wanting two services read two buckets —
     * 40,844 characters against the whole object's 4,669,154 — and took 576 ms, while a Norwich
     * board that fell back to the whole object took 787 ms. Reading a hundredth of the bytes had
     * not made the board quicker, because the reads were sequential and each R2 round trip costs
     * more wall clock than the decode it avoids.
     *
     * Sequentially, the cap on buckets was also a cap on latency, which is the wrong thing for it
     * to be: it exists to stop a request reading two hundred objects, not to keep a four-service
     * board under a deadline. In parallel the wall clock is one round trip regardless of how many
     * buckets a board's departures happen to span.
     */
    const reads = await Promise.all(
      selected.map(async ([bucket, wanted]) => {
        const want = new Set(wanted);
        return this.readShardSized<ServiceRoute>(
          serviceBucketDataset(bucket),
          index.version,
          Date.now(),
          ledger ? { ledger, family: "services", budgetReason: "service_bucket_read" } : undefined,
          // Tested as text before anything is built, like every other filtered read here.
          (body, start, end) => {
            const id = valueAt(body, start, end, "id");
            return id !== null && want.has(id);
          },
        );
      }),
    );
    for (const read of reads) {
      if (read.chars > 0) bucketsPresent += 1;
      chars += read.chars;
      for (const service of read.records) found.set(service.id, service);
    }

    if (bucketsPresent === 0) {
      ledger?.artifactNote({ servicesPath: "fallback_no_buckets", servicesWanted: ids.size });
      return null;
    }

    ledger?.artifactNote({
      servicesPath: "buckets",
      servicesWanted: ids.size,
      servicesFound: found.size,
      serviceBucketsRead: selected.length,
      serviceBucketsWanted: byBucket.size,
      serviceBucketsPresent: bucketsPresent,
      serviceBucketChars: chars,
      serviceBucketsComplete: complete,
    });
    return { services: found, complete };
  }

  /**
   * The services a stop's own index named, from their buckets and never from the whole object.
   *
   * A board used to learn which services call at a stop from the patterns its departures named,
   * which bounded the question at a dozen ids. Asking `stop-services` instead makes the answer
   * complete — every route that calls there, not only the ones with a bus due in the next ninety
   * minutes — and a city interchange has fifty of them. `servicesByIds` answers more than
   * thirty-two buckets' worth by reading the national object, which is 4.7 MiB: for this caller
   * that turns a fix for a 2.03 MiB pattern tile into something twice as expensive.
   *
   * So this one does not have that fallback. It reads what the cap allows and says whether that
   * was all of them, and the board puts that in `routesComplete` — which is the field that exists
   * to stop a bounded read being presented as a statement about the bus service.
   */
  async servicesByIdsBounded(
    ids: ReadonlySet<string>,
    ledger?: ReadLedger,
  ): Promise<{ services: Map<string, ServiceRoute>; complete: boolean }> {
    if (ids.size === 0) return { services: new Map(), complete: true };

    if (this.servicesCache) {
      const services = new Map<string, ServiceRoute>();
      for (const id of ids) {
        const service = this.servicesCache.get(id);
        if (service) services.set(id, service);
      }
      ledger?.artifactNote({ servicesPath: "resident", servicesWanted: ids.size });
      return { services, complete: true };
    }

    const bucketed = await this.servicesFromBuckets(ids, ledger, true);
    if (bucketed) return bucketed;

    /*
     * Null means this artifact has no service buckets at all — a version published before the
     * family existed — and that is the one case the whole object is still the right read.
     *
     * The distinction is the point. "The family exists and this request wants more of it than the
     * cap allows" is the expensive case this method was written for, and it is answered by
     * reading the cap's worth and saying the list is bounded. "The family does not exist" is an
     * artifact-age question with no cheaper answer at all, and refusing it would mean a board on
     * an older artifact listing no routes while reporting that as the complete truth.
     */
    return { services: await this.servicesByIds(ids, ledger), complete: true };
  }

  /**
   * Only the services asked for — from their buckets where the partitioned family exists, and from
   * the whole object where it does not.
   *
   * A board asks for two or three ids. Scanning the whole object for them is cheap in itself and
   * deliberately so, but it cannot avoid fetching and UTF-8 decoding 4.7 MiB first, on every
   * board, because a filtered read cannot populate the record cache: an entry holding one
   * request's two services would answer the next request's question with almost nothing.
   *
   * So the ids are grouped by bucket and only those buckets are read — about 19 KiB each. The
   * fallback is not a nicety: a version published before this family existed has no buckets at
   * all, and the reader has to behave exactly as it used to against one. It falls back when *no*
   * wanted bucket exists, not when an id is simply absent from its bucket — an unknown id is
   * ordinary (a pattern naming a service the network no longer publishes) and must not cost a
   * 4.7 MiB read to establish.
   */
  async servicesByIds(
    ids: ReadonlySet<string>,
    ledger?: ReadLedger,
  ): Promise<Map<string, ServiceRoute>> {
    const found = new Map<string, ServiceRoute>();
    if (ids.size === 0) return found;

    // A warm isolate that has already read them all for some other reason should use that.
    if (this.servicesCache) {
      for (const id of ids) {
        const service = this.servicesCache.get(id);
        if (service) found.set(id, service);
      }
      ledger?.artifactNote({ servicesPath: "resident", servicesWanted: ids.size });
      return found;
    }

    const bucketed = await this.servicesFromBuckets(ids, ledger);
    if (bucketed !== null) return bucketed.services;

    const read = await this.nationalRows<ServiceRoute>(
      DATASETS.services,
      (body, start, end) => {
        const id = valueAt(body, start, end, "id");
        return id !== null && ids.has(id);
      },
      (retained) => retained >= ids.size,
    );
    if (read === null) return found;
    /*
     * The figure the partitioned family exists to replace. Recorded so a run can state the old
     * cost and the new one side by side rather than asserting an improvement. `chars` is what was
     * decoded rather than the object's size — the scan stops once every wanted id is found, so on
     * a lucky request the two differ by most of the object.
     */
    ledger?.artifactNote({
      servicesPath: "whole_object",
      servicesWanted: ids.size,
      servicesObjectChars: read.chars,
    });
    for (const service of read.rows) found.set(service.id, service);
    return found;
  }

  /**
   * The national operators text, held without being parsed — the same treatment `services` got, for
   * the same measured reason.
   *
   * `readCurrent` runs an FNV-1a hash over the whole object *and* `JSON.parse`s every record before
   * a caller sees one. Both are pure computation, which is the resource a free invocation has ten
   * milliseconds of. A stop board wanted the operators of about two routes and was paying for all
   * 631 — and run 81's breadcrumb puts the cold board's death immediately after
   * `board:services:done`, which is exactly where `await network.operators()` sits.
   */
  /** Only the operators asked for, built by one pass over the text. */
  async operatorsByIds(ids: ReadonlySet<string>): Promise<Map<string, Operator>> {
    const found = new Map<string, Operator>();
    if (ids.size === 0) return found;

    // A warm isolate that has already read them all for some other reason should use that.
    if (this.operatorsCache) {
      for (const id of ids) {
        const operator = this.operatorsCache.get(id);
        if (operator) found.set(id, operator);
      }
      return found;
    }

    const read = await this.nationalRows<Operator>(
      DATASETS.operators,
      (body, start, end) => {
        const id = valueAt(body, start, end, "id");
        return id !== null && ids.has(id);
      },
      (retained) => retained >= ids.size,
    );
    if (read === null) return found;
    for (const operator of read.rows) found.set(operator.id, operator);
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

    const read = await this.nationalRows<ServiceRoute>(
      DATASETS.services,
      (body, start, end) => valueAt(body, start, end, "operatorId") === operatorId,
    );
    if (read === null) return found;
    for (const service of read.rows) found.set(service.id, service);
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
    ledger?: ReadLedger,
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
    /*
     * The parse is filtered, and the read is bounded. This was the most expensive path in the
     * Worker and it is a path a visitor takes first.
     *
     * A published prefix bucket reaches 1,644,719 bytes, twelve were opened in parallel, every line
     * of every one was turned into an object, and then the whole set was ranked. "Piccadilly" is one
     * word and one bucket and answered fine; "Leeds Station" is two, and run 79 measured the result —
     * Cloudflare error 1102, which a browser reports as a CORS failure, so a visitor searching for a
     * landmark got nothing at all.
     *
     * Two bounds, in the currency that runs out. The lines are tested as text before anything is
     * built, on the first few characters of each word typed, so a bucket filed under "le" costs its
     * "leeds" entries rather than all of them. And the buckets are read in word order until a byte
     * budget is spent, rather than all at once: words are taken in the order they were meant, so what
     * is dropped is the tail of a long query and not the subject of it.
     */
    const keep = searchLineFilter(lookups);
    const buckets: SearchIndexEntry[][] = [];
    let searchChars = 0;
    for (const prefix of wanted) {
      if (searchChars >= MAX_SEARCH_READ_CHARS) break;
      if (ledger && !ledger.withinBudget) break;
      const bucket = await this.readShardSized<SearchIndexEntry>(
        searchPrefixDataset(prefix),
        index.version,
        now,
        ledger ? { ledger, family: "search", budgetReason: "search_read_budget" } : undefined,
        keep,
      );
      searchChars += bucket.chars;
      buckets.push(bucket.records);
    }

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
    for (const entry of await this.placeEntriesMatching(lookups)) {
      unique.set(`${entry.kind}:${entry.id}`, entry);
    }

    const candidates = [...unique.values()];
    /*
     * Ranked deeper than the caller asked for, so stops crowded out of the top by prominent
     * gazetteer places are still on the list with their scores. The scorer scores every candidate
     * whatever the limit, so this costs the sort and nothing else — see `withReservedStops`.
     */
    const deepLimit = Math.min(options.limit * SEARCH_RANK_DEPTH, candidates.length);
    const rankOptions =
      options.near === undefined ? { limit: deepLimit } : { limit: deepLimit, near: options.near };
    const hits = withReservedStops(
      rankSearch({ entries: candidates, builtAt: index.publishedAt }, query, rankOptions),
      options.limit,
    );
    return { hits: hits.map(presentHit), builtAt: index.publishedAt };
  }

  /** Stops near a point, from the tiles around it. */
  /**
   * Stops near a point, from the map projection rather than from the text-search index.
   *
   * The two answer different questions and only one of them is this one. A search tile carries
   * every kind the index holds — places, routes, operators, areas, postcodes — and for each of
   * them the tokens and codes that make typing work; `nearbyStops` then threw all of that away
   * and kept the stops. The deployed ledger measured the waste: 1.87 MB of search text walked to
   * list the stops within eight hundred metres of a point, while the projection tile covering the
   * same ground is a third of that and carries exactly the marker fields a nearby list shows.
   *
   * It is also the family `/v1/map` reads, so a page that draws the map and lists what is around
   * you now reads one set of tiles instead of two, and any future retiling of the projection
   * makes this cheaper too — a radius of a few hundred metres is the read that gains most from a
   * smaller square.
   *
   * The search tiles remain the fallback, for an artifact published before the projection
   * existed: an empty list from a reader that could have answered is the failure worth avoiding.
   */
  async nearby(
    coordinate: Coordinate,
    options: { radiusMetres: number; limit: number },
    now: number = Date.now(),
    ledger?: ReadLedger,
  ): Promise<{ stops: NearbyStop[]; builtAt: string; source: NearbySource } | null> {
    const index = await this.networkIndex(now);
    if (!index) return null;

    const box = boxAround(coordinate, options.radiusMetres);

    if (index.mapStopTiles && index.mapStopTiles.length > 0) {
      /*
       * The projection's own limit, not the caller's.
       *
       * `mapStopsInBoundingBox` ranks by distance from the centre of the box when it has to cut,
       * and the centre of this box is the point asked about — so cutting there would cut the same
       * way this does. It is asked for more than the caller wants anyway, because the box is a
       * square around a circle and the corners are outside the radius.
       */
      const projected = await this.mapStopsInBoundingBox(
        box,
        Math.max(options.limit * 4, 100),
        now,
        ledger,
        NEARBY_READ_CHARS,
      );
      if (projected) {
        const stops = projected.stops
          .map((stop) => ({
            id: stop.id,
            title: stop.name,
            ...(stop.indicator === undefined ? {} : { subtitle: stop.indicator }),
            coordinate: stop.locationCoordinate,
            distanceMetres: haversineMetres(coordinate, stop.locationCoordinate),
            /*
             * Published as a constant, and read back as one rather than guessed at.
             *
             * The search index derives this from a list of ATCO prefixes with live coverage, and
             * no caller has ever passed one — so every published entry says `true`, and a stop
             * read from the projection can say the same thing without carrying the flag. If that
             * list is ever populated, both paths have to learn it together; the structural test
             * names this line so the pair cannot drift quietly.
             */
            hasLiveCoverage: true,
          }))
          .filter((stop) => stop.distanceMetres <= options.radiusMetres)
          .sort((a, b) => a.distanceMetres - b.distanceMetres)
          .slice(0, options.limit);
        return { stops, builtAt: index.publishedAt, source: "map_projection" };
      }
    }

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
    const stops = hits.map(presentHit).map((hit) => ({
      id: hit.entry.id,
      title: hit.entry.title,
      ...(hit.entry.subtitle === undefined ? {} : { subtitle: hit.entry.subtitle }),
      coordinate: hit.entry.coordinate ?? coordinate,
      distanceMetres: hit.distanceMetres ?? 0,
      hasLiveCoverage: hit.entry.hasLiveCoverage,
    }));
    return { stops, builtAt: index.publishedAt, source: "search_tiles" };
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
