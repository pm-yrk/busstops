import {
  BoundingBoxSchema,
  MAP_QUERY_LIMITS,
  type GovernorState,
  type MapResponseData,
  type SearchResult,
  type ServiceRoute,
} from "@busstops/contracts";
import { safeModeActive } from "@busstops/governor";
import { DisruptionReader, noticesFor } from "./disruption-reader.js";
import { stopAccessibility } from "./stop-accessibility.js";
import { WeatherReader } from "./weather-reader.js";
import { DepartureReader } from "./departure-reader.js";
import {
  boundingBoxAreaSquareDegrees,
  corridorBoundingBox,
  isPlausibleEnglandCoordinate,
} from "@busstops/pipeline-core";
import { matchObservation } from "@busstops/matching";

import { R2BindingStore, readFeatureFlags, type WorkerEnv } from "./env.js";
import {
  LiveService,
  buildMeta,
  cacheTtlSeconds,
  isLondonAtcoCode,
  oldestObservedAt,
  sourcesForBoundingBox,
  toMapVehicle,
} from "./live-service.js";
import { NetworkReader } from "./network-reader.js";
import { ReadLedger } from "./read-ledger.js";
import {
  passengerName,
  patternTilesForBoundingBox,
  stopTilesForBoundingBox,
  routeBadgeName,
} from "@busstops/pipeline-static-network";

/** A destination as a passenger should read it, or nothing when the feed published nothing. */
function displayDestination(value: string | null | undefined): string | null {
  return value ? passengerName(value) : null;
}

/**
 * How long a map request will spend on optional enrichment before it stops and says so.
 *
 * Not a guess at Cloudflare's limit — nobody outside Cloudflare knows whether 1102 was CPU or
 * memory here, and the error page does not say. It is a figure this handler can keep to: stops
 * and vehicles are read first and are never skipped, so whatever is left is spent on route names,
 * and a screen that has not got them in this long is better served a labelled map than a 503.
 *
 * Raised from nine hundred once the byte caps were doing the real work. What bounds memory is
 * five mebibytes of stop text and three of pattern text, read two objects at a time; the clock is
 * a backstop against a slow upstream rather than the thing keeping the isolate alive. At nine
 * hundred milliseconds the essential half spent the whole budget and enrichment never ran at all,
 * so every dense viewport came back truthfully degraded and permanently unlabelled — honest, and
 * not the product.
 */
const MAP_ENRICHMENT_BUDGET_MS = 1_800;

/**
 * How much stop text one map request will open.
 *
 * The shared twelve-mebibyte request budget is far more than this endpoint can use: the response
 * carries at most a few hundred stops however many were read, so the rest of what a dense
 * viewport decodes is thrown away — after being parsed, which is the expensive part. Five
 * mebibytes is more stop text than four hundred stops can come from, and a viewport that wants
 * more than that says `truncated.stops` rather than spending the isolate on stops nobody sees.
 */
const MAP_STOP_READ_CHARS = 5 * 1024 * 1024;

/**
 * And how much of the stop-routes index, which is the cheap half of the same question.
 *
 * A row is a stop id and a handful of route numbers, so a viewport's worth is measured in tens of
 * kilobytes where the pattern tiles it replaces were measured in megabytes. Two mebibytes is far
 * more than any viewport needs and is here so that a future grid change cannot make this the
 * unbounded read.
 */
const MAP_STOP_ROUTES_CHARS = 2 * 1024 * 1024;

/**
 * The same idea for route detail, though it should never come near it.
 *
 * With the route-pattern index a route is one object and one line; the budget is here so that the
 * legacy tile path, on an artifact published before the index, cannot run away either.
 */
const ROUTE_DETAIL_BUDGET_MS = 1_200;

/**
 * How much stop text one route page will open.
 *
 * A route's stops come from the three or four quarter-degree tiles its shape runs through, and a
 * dense one of those is 3,959,355 bytes. Four mebibytes buys the tiles a city route needs without
 * letting an intercity route open a county's worth of stops on its way past — and a route that
 * wants more is reported incomplete rather than served short.
 */
const ROUTE_STOP_READ_CHARS = 4 * 1024 * 1024;

/**
 * Live lookups snapped outward to a coarse grid.
 *
 * A SIRI-VM datafeed is fetched per bounding box and coalesced per URL, so an unsnapped route box
 * is a cache key no other request will ever produce: twenty route pages in one city were twenty
 * separate feed fetches and twenty XML parses. Snapped, they share one. The grid matches the stop
 * tile size, which is about the smallest snap that actually makes neighbours collide.
 */
/**
 * How long a journey plan may spend, and how much stop text its corridor may open.
 *
 * Longer than the map's budget, because a plan is something a passenger asked for and waited on
 * rather than a pan of the map — but a budget all the same, and owned here. Leeds to Leeds
 * Bradford Airport answered Cloudflare error 1102, and the platform ending a request is not a
 * budget: it produces no answer, no reason and an error page with no CORS header on it.
 */
const JOURNEY_BUDGET_MS = 6_000;
const JOURNEY_STOP_READ_CHARS = 5 * 1024 * 1024;
/**
 * Above this many pattern tiles, a corridor asks the index instead of reading the tiles.
 *
 * Two, paired with the pattern budget below. Run 44 planned Leeds to Leeds Bradford Airport from
 * a single corridor tile; run 48 measured two tiles at 4.21 MiB, which that budget covers. Beyond
 * two the index is used instead, because tiles have no ceiling of their own and a cross-country
 * corridor would open them without end.
 */
const JOURNEY_PATTERN_TILE_LIMIT = 2;

/**
 * What a corridor's pattern tiles may cost, as against a viewport's.
 *
 * This is a byte limit being raised, so it is worth being exact about why. Three mebibytes is the
 * map's cap and it protects against a viewport, which on the pattern grid can span ninety-six
 * tiles. A journey corridor is narrow: run 48's spanned four, and the map's cap stopped the read
 * after two tiles and 4.21 MiB — so the slice came back incomplete and the planner refused before
 * a single trip had been read.
 *
 * The same run measured what the alternative costs. The index path spent 12.23 MiB across 91
 * buckets to resolve 112 of 197 patterns; those two tiles held 625 patterns for 4.21 MiB — about
 * fifteen times more pattern per byte. The cheap read was being stopped by a number chosen to
 * protect against the expensive one.
 *
 * Six mebibytes covers two corridor tiles with room, and every other bound is unchanged: the
 * request's own twelve-mebibyte ceiling still caps it, the six-second clock still ends it, and
 * `JOURNEY_PATTERN_TILE_LIMIT` still sends a wider corridor to the index rather than opening tiles
 * without end. A corridor that still cannot be read in full is still refused rather than planned
 * around.
 */
const JOURNEY_PATTERN_READ_CHARS = 6 * 1024 * 1024;

/** The same clock every other read has. "Stops near me" is one tile's worth of question. */
const NEARBY_BUDGET_MS = 1_500;

/**
 * What an endpoint with no read ledger of its own gives the live feed.
 *
 * The map and route detail hand over whatever their own budget has left. The vehicle and live
 * endpoints have no staged budget to subtract from, so they name a figure — comfortably inside
 * one upstream round trip, and far inside the three attempts and two backoffs that a slow BODS
 * used to cost them.
 */
const LIVE_LOOKUP_BUDGET_MS = 2_500;

const LIVE_BBOX_SNAP_DEGREES = 0.25;

/** Snapped outward, so the box still contains everything it contained before. */
function snapBoundingBox(
  bbox: { west: number; south: number; east: number; north: number },
  step = LIVE_BBOX_SNAP_DEGREES,
): { west: number; south: number; east: number; north: number } {
  return {
    west: Math.floor(bbox.west / step) * step,
    south: Math.floor(bbox.south / step) * step,
    east: Math.ceil(bbox.east / step) * step,
    north: Math.ceil(bbox.north / step) * step,
  };
}

/**
 * The same area limit a map viewport has, applied to a route's live lookup.
 *
 * `/v1/map` refuses a box larger than 1.5 square degrees; a route page had no such limit, so a
 * cross-country service asked the live feed for more ground than any viewport is allowed. The box
 * shrinks around its own centre, which keeps the middle of the route live and loses its ends —
 * and the response says the area was capped rather than presenting a short list of vehicles as
 * all of them. Returned unchanged when it already fits, so a caller can tell by identity.
 */
function capBoundingBoxArea(
  bbox: { west: number; south: number; east: number; north: number },
  maxArea = MAP_QUERY_LIMITS.maxBboxAreaSquareDegrees,
): { west: number; south: number; east: number; north: number } {
  const width = bbox.east - bbox.west;
  const height = bbox.north - bbox.south;
  const area = width * height;
  if (area <= maxArea || area <= 0) return bbox;

  const factor = Math.sqrt(maxArea / area);
  const centreLon = (bbox.west + bbox.east) / 2;
  const centreLat = (bbox.south + bbox.north) / 2;
  return {
    west: centreLon - (width * factor) / 2,
    east: centreLon + (width * factor) / 2,
    south: centreLat - (height * factor) / 2,
    north: centreLat + (height * factor) / 2,
  };
}
import {
  DEPARTURE_GRACE_MINUTES,
  DEPARTURE_WINDOW_MINUTES,
  departuresFromRows,
  serviceDatesForBoard,
} from "./stop-departures.js";
import { JOURNEY_LIMITS, JourneyService } from "./journey-service.js";
import { isCoherentItinerary } from "./itinerary-check.js";
import { ProService, resolveScope, DEFAULT_WINDOW_MINUTES } from "./pro-service.js";
import {
  boundingBoxOf,
  publishedMetric,
  routeVariants,
  routesForOperator,
  routesServingStop,
} from "./network-queries.js";
import { Router } from "./router.js";
import {
  RateLimiter,
  clientKeyFor,
  corsHeaders,
  errorResponse,
  withSecurityHeaders,
} from "./security.js";

/**
 * Thin edge API (docs/04_ARCHITECTURE.md "Boundaries").
 *
 * The Worker validates input, enforces caps and rate limits, protects upstream credentials,
 * composes cached artifacts with live data, and states freshness and degradation. Heavy
 * national analytics belong to the scheduled pipelines, never here.
 */

// Module scope survives across requests within an isolate, which is what makes the artifact
// snapshot and the rate-limit window useful at all.
let network: NetworkReader | null = null;
let liveService: LiveService | null = null;
let journeyService: JourneyService | null = null;
let proService: ProService | null = null;
let disruptions: DisruptionReader | null = null;
let weather: WeatherReader | null = null;
let departures2: DepartureReader | null = null;
const rateLimiter = new RateLimiter();

/**
 * How many requests this isolate has answered, and how much it was holding when each began.
 *
 * The readers are module-level on purpose — a warm cache is the whole point of an isolate — and
 * that is also the thing the per-request diagnostics could never see. Run 45's route detail
 * reported six requests of 300–900ms each, reading two or three mebibytes apiece, and the platform
 * killed the seventh: on those numbers alone there is no way to tell an expensive request from a
 * full isolate, and both readings have been possible for four runs.
 *
 * So every instrumented handler now trims the shard cache to a floor before it starts and reports
 * what was resident either side. The floor is a third of the cache's own ceiling: enough that a
 * repeat request still finds its tile, low enough that the peak is the floor plus one request's
 * work rather than the ceiling plus it.
 *
 * This is not a claim that memory is the limit. Nothing measured says whether 1102 is CPU or
 * memory, and this is the measurement that would show it if it is — or rule it out if the counts
 * come back flat and the request that dies is no different from the five before it.
 */
const RESIDENT_FLOOR_CHARS = 4 * 1024 * 1024;
let requestsServed = 0;

/**
 * Trim before the work, and report either side of it.
 *
 * Returns the "after" half as a callback so a handler reads as: open the ledger, begin, and stamp
 * residency once the reads are done.
 */
function beginResidency(ledger: ReadLedger): () => void {
  requestsServed += 1;
  const served = requestsServed;
  const before = network?.residency() ?? null;
  const evicted = network?.trimTo(RESIDENT_FLOOR_CHARS) ?? 0;
  return () => {
    const after = network?.residency() ?? null;
    ledger.residency({
      requestsServed: served,
      shardsBefore: before?.shards ?? 0,
      charsBefore: before?.chars ?? 0,
      recordsBefore: before?.records ?? 0,
      evicted,
      shardsAfter: after?.shards ?? 0,
      charsAfter: after?.chars ?? 0,
      recordsAfter: after?.records ?? 0,
      singletons: {
        operators: after?.operators ?? 0,
        services: after?.services ?? 0,
        places: after?.places ?? 0,
        routeTiles: after?.routeTiles ?? 0,
      },
    });
  };
}

interface RequestContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

function governorState(env: WorkerEnv): GovernorState {
  const mode = env.GOVERNOR_MODE;
  if (mode === "amber" || mode === "red" || mode === "critical") return mode;
  return "green";
}

function json(
  body: unknown,
  ttlSeconds: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 4}`,
        ...extraHeaders,
      },
    }),
  );
}

function parseBoundingBox(
  url: URL,
): { ok: true; bbox: ReturnType<typeof BoundingBoxSchema.parse> } | { ok: false; message: string } {
  const raw = url.searchParams.get("bbox");
  if (!raw) return { ok: false, message: "bbox is required, as west,south,east,north" };

  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return { ok: false, message: "bbox must be four finite numbers: west,south,east,north" };
  }

  const parsed = BoundingBoxSchema.safeParse({
    west: parts[0]!,
    south: parts[1]!,
    east: parts[2]!,
    north: parts[3]!,
  });
  if (!parsed.success) return { ok: false, message: "bbox is not a valid bounding box" };

  return { ok: true, bbox: parsed.data };
}

const router = new Router<WorkerEnv, RequestContext>();

router.get("/v1/sources/health", async (_request, { env }) => {
  const state = governorState(env);
  const live = liveService?.health() ?? [];
  return json(
    {
      meta: buildMeta({
        sources: live,
        observedAt: null,
        coverage: live.length === 0 ? 0 : 1,
        governorState: state,
        now: new Date(),
        safeMode: safeModeActive(state),
      }),
      data: { sources: live, governorState: state, safeMode: safeModeActive(state) },
    },
    30,
  );
});

/**
 * Why a viewport has no buses.
 *
 * The preview reported zero live vehicles while every structural check passed, and the Worker had
 * no way to say which of four things had happened: the request never left, it was refused, the
 * body was empty, or the body was full and we rejected all of it. This answers that question from
 * inside the deployment, which is the only place some of those distinctions exist.
 *
 * It publishes counts, reasons and ages. It never publishes a vehicle, a position or a source
 * vehicle reference, and it costs exactly what the same /v1/map request costs, because it shares
 * the same bounding-box limits and the same request coalescing.
 */
router.get("/v1/diagnostics/live", async (_request, { env, url }) => {
  const state = governorState(env);
  const bboxResult = parseBoundingBox(url);
  if (!bboxResult.ok) return errorResponse("bad_request", bboxResult.message, 400);
  const bbox = bboxResult.bbox;

  if (boundingBoxAreaSquareDegrees(bbox) > MAP_QUERY_LIMITS.maxBboxAreaSquareDegrees) {
    return errorResponse("bbox_too_large", "Requested area is too large; zoom in.", 400);
  }

  const now = new Date();
  initialiseWorker(env);
  if (!liveService) {
    return errorResponse(
      "upstream_unavailable",
      "Live sources are not configured on this deployment",
      503,
    );
  }

  const live = await liveService.vehiclesInBoundingBox(bbox, LIVE_LOOKUP_BUDGET_MS);
  return json(
    {
      meta: buildMeta({
        sources: live.health,
        observedAt: oldestObservedAt(live.observations),
        coverage: live.failedSources.length === 0 ? 1 : 0,
        governorState: state,
        now,
        failedSources: live.failedSources,
        safeMode: safeModeActive(state),
      }),
      data: {
        boundingBox: bbox,
        sourcesConsulted: sourcesForBoundingBox(bbox),
        vehiclesReturned: live.observations.length,
        diagnostics: live.diagnostics,
      },
    },
    15,
  );
});

router.get("/v1/map", async (_request, { env, url }) => {
  const state = governorState(env);
  const flags = readFeatureFlags(env);

  const bboxResult = parseBoundingBox(url);
  if (!bboxResult.ok) return errorResponse("bad_request", bboxResult.message, 400);
  const bbox = bboxResult.bbox;

  const area = boundingBoxAreaSquareDegrees(bbox);
  if (area > MAP_QUERY_LIMITS.maxBboxAreaSquareDegrees) {
    return errorResponse(
      "bbox_too_large",
      `Requested area is too large; zoom in. Maximum is ${MAP_QUERY_LIMITS.maxBboxAreaSquareDegrees} square degrees.`,
      400,
    );
  }

  const zoom = Number(url.searchParams.get("zoom") ?? "0");
  if (
    !Number.isFinite(zoom) ||
    zoom < MAP_QUERY_LIMITS.minZoom ||
    zoom > MAP_QUERY_LIMITS.maxZoom
  ) {
    return errorResponse(
      "bad_request",
      `zoom must be between ${MAP_QUERY_LIMITS.minZoom} and ${MAP_QUERY_LIMITS.maxZoom}`,
      400,
    );
  }

  const now = new Date();
  const ledger = new ReadLedger(MAP_ENRICHMENT_BUDGET_MS);
  const endResidency = beginResidency(ledger);

  // Only the tiles this viewport covers are read. The national stop set is 198 MiB against a
  // 128 MiB isolate, so "load it and filter" is not an option that exists.
  const index = network ? await ledger.stage("index", () => network!.networkIndex()) : null;

  /*
   * Essential first, and unconditionally: the stops are the map.
   *
   * The order in this handler is the whole fix for error 1102. A map request used to read its
   * stops, then every pattern tile the viewport crossed, then its live vehicles, and a viewport
   * over central Leeds spans enough four-megabyte pattern tiles to put the isolate over its limit
   * — at which point Cloudflare answers with its own page and the passenger gets nothing at all.
   * Not a map with fewer route names on it: nothing, and in a browser, a CORS error, because the
   * platform's error page carries no CORS header.
   *
   * Stops and vehicles are what the screen is for. They are read first and are never skipped.
   */
  let vehicles: MapResponseData["vehicles"] = [];
  let vehiclesTruncated = false;
  let sources: Awaited<ReturnType<LiveService["vehiclesInBoundingBox"]>>["health"] = [];
  let failedSources: string[] = [];
  let observedAt: string | null = null;

  const liveAllowed = flags.liveVehicles && state !== "critical";

  /*
   * Together, because they are not competing for the same thing.
   *
   * These ran one after the other, and in run 43 the live feed took 828ms of an 1800ms budget
   * while the stop read sat behind it — so the route-name enrichment, which runs on what is left,
   * was declined before it started and every stop on the map came back with no services on it.
   * The reads that were deliberately serialised elsewhere in this file are serialised because
   * they compete for the isolate's memory. These two do not: one is object storage and the other
   * is an HTTP request to a third party, and the vehicle list is capped at three hundred whatever
   * comes back. What they were queueing for was wall-clock time, which is the one thing there is
   * no reason to spend twice.
   */
  /*
   * The map projection first, the two general families only if the artifact has no projection.
   *
   * Measured: a viewport read 7.00 MiB across the stop and stop-route tiles, and walking that text
   * costs about three milliseconds a mebibyte before an object is built — against a ten-millisecond
   * budget. Filtering the parse took the objects from 23,806 to 788 and the text stayed exactly as
   * large, so the bytes are the floor. `network/map-stops` is those two families projected to what
   * a marker draws, in one read instead of two.
   */
  const projected = network
    ? await network.mapStopsInBoundingBox(
        bbox,
        MAP_QUERY_LIMITS.maxStops,
        Date.now(),
        ledger,
        MAP_STOP_READ_CHARS,
      )
    : null;

  /*
   * Which path this request took, and what the artifact offered it.
   *
   * Three runs read the same 490 records at 1.97 MiB against three different artifacts — one of
   * them deployed minutes after `map-stops` published cleanly, one of them a Worker with no warm
   * isolate to be stale. Every number already reported is identical whichever branch runs, so the
   * diagnostics could not tell "the reader ignored the projection" from "the projection is not in
   * the index". This states both, which costs one object in the payload and ends the guessing.
   */
  if (network) {
    const declared = await network.networkIndex(Date.now());
    ledger.artifactNote({
      version: declared?.version ?? "(no index)",
      mapStopTiles: declared?.mapStopTiles?.length ?? 0,
      stopDetailBuckets: declared?.stopDetailBuckets?.length ?? 0,
      projectionUsed: projected !== null,
    });
  }

  const [stopsResult, liveObservations] = await ledger.stage("essentials", () =>
    Promise.all([
      projected
        ? Promise.resolve({ stops: projected.stops, truncated: projected.truncated })
        : network
          ? network.stopsInBoundingBox(
              bbox,
              MAP_QUERY_LIMITS.maxStops,
              Date.now(),
              ledger,
              MAP_STOP_READ_CHARS,
            )
          : Promise.resolve({ stops: [], truncated: false }),
      liveAllowed && liveService
        ? /*
           * With the map's own remaining time, for the reason route detail already has it.
           *
           * `fetchText` retries three times with backoff and its timeout bounds one attempt, so an
           * upstream that is slow costs three attempts and their gaps — three to four seconds
           * against a 1,800ms budget. Run 52 measured the consequence with route detail bounded
           * and this one not: the platform answered `/v1/map` on the first attempt of the first
           * city, and took `/v1/search` and `/v1/nearby` on the same isolate down with it. A
           * request holding a four-second retry does not fail alone.
           */
          liveService.vehiclesInBoundingBox(bbox, Math.max(300, ledger.remainingMs))
        : Promise.resolve(null),
    ]),
  );
  ledger.count({ stops: stopsResult.stops.length });

  /*
   * Optional, and last: which services call where, and what route a vehicle is on.
   *
   * This is the expensive half — pattern tiles carry geometry and reach four megabytes each — and
   * it is the half a passenger can do without. A map with unlabelled stops is a working map; a map
   * that 503s is not. So it runs on whatever time is left, stops the moment the budget is spent,
   * and says so in the response rather than pretending it finished.
   */
  /*
   * Which services call at each stop, from the index that answers exactly that.
   *
   * This read pattern tiles, which carry route geometry. A dense one is 3,935,975 bytes against a
   * three-mebibyte cap, so in Leeds or Manchester the read truncated on its first tile every
   * single time and every stop came back with no services on it — a cap on bytes turned into
   * permanent degradation, which is worse than either the cost or the error it was avoiding.
   * `network/stop-routes` is the same answer published as the answer, on the stops' own grid: a
   * list of names where a polyline was.
   */
  /*
   * The projection already carries the names, so this whole read disappears when it is present.
   * That is the second half of the saving: one family read instead of two.
   */
  const stopRoutes = projected
    ? {
        byStopId: new Map(projected.stops.map((stop) => [stop.id, stop.routePublicNames])),
        /*
         * Always complete, because the names arrive attached to the stops.
         *
         * `projected.truncated` answers a different question: did we return every stop in the
         * box, or did we stop at the four hundred markers the map draws. A dense city always
         * exceeds that, so this read `!truncated` and reported every Leeds viewport as degraded
         * for `stop_routes_budget` — while every one of the four hundred stops it drew carried
         * its full route list, from the same row it came in on. The map was calling its own
         * labels unreliable on the strength of a display limit.
         *
         * How many stops were returned is reported honestly and separately, as `truncated.stops`.
         */
        complete: true,
        available: true,
      }
    : network
      ? await ledger.stage("stop-routes", () =>
          network!.routeNamesForStopTiles(
            stopTilesForBoundingBox(bbox),
            Date.now(),
            ledger,
            MAP_STOP_ROUTES_CHARS,
            // The stops this response carries, so the parse builds four hundred rows rather than
            // every row in a quarter of a degree. They are already resolved by the stage above.
            new Set(stopsResult.stops.map((stop) => stop.id)),
          ),
        )
      : { byStopId: new Map<string, string[]>(), complete: true, available: true };

  /*
   * The tiles, only for what the index cannot answer.
   *
   * Two things still need geometry: matching a live vehicle to a route, and an artifact published
   * before the stop-routes family existed. Neither is worth a four-megabyte read when there is
   * nothing to match — a viewport with no live vehicles skips it entirely.
   */
  /*
   * Geometry only for a bus we cannot otherwise name.
   *
   * This was "are there any vehicles", which in a city is always yes — so the map went on reading
   * three mebibytes of pattern tiles on top of its stops and its stop-routes, and run 44 answered
   * error 1102 on the request either side of the one that reported `12.01 MiB decoded, 26445
   * record(s)`. More was being decoded than before the index existed, which is the opposite of
   * what it was for.
   *
   * A SIRI-VM record carries the line name on the front of the bus, and that is enough to draw a
   * marker and — through this viewport's own services — to identify the route. Matching against
   * shapes is the fallback for a feed that publishes no line name, so it is read when there is a
   * bus in that state and not otherwise.
   */
  const unnamedVehicles = (liveObservations?.observations ?? []).filter(
    (observation) =>
      !liveObservations?.journeyContext.get(observation.vehicleRef)?.publishedLineName,
  ).length;
  const needsGeometry = !stopRoutes.available || unnamedVehicles > 0;
  const enrichment =
    network && needsGeometry
      ? await ledger.stage("patterns", () =>
          network!.patternsInTilesDetailed(patternTilesForBoundingBox(bbox), Date.now(), ledger),
        )
      : { geometries: [], complete: true };
  const geometries = enrichment.geometries;
  const services =
    network && geometries.length > 0
      ? await ledger.stage("services", () => network!.services())
      : new Map<string, ServiceRoute>();

  /*
   * Which services call at each stop on screen.
   *
   * `routePublicNames` was a literal `[]` in this projection. The contract declares it, the map
   * marker reads it, and the deployed check that asks whether a viewport's stops carry their
   * services could only ever fail — which it did, reporting "not one stop in the viewport carries
   * a service" and blaming the national timetable for a hard-coded empty array.
   *
   * Built by walking the patterns once rather than per stop: a viewport holds a few hundred
   * patterns and a few hundred stops, and the per-stop version is the product of the two.
   */
  const routeNamesByStopId = new Map<string, Set<string>>();
  if (stopRoutes.available) {
    for (const [stopId, names] of stopRoutes.byStopId) {
      routeNamesByStopId.set(stopId, new Set(names.map(routeBadgeName)));
    }
  } else {
    // The legacy path, kept so the map still labels stops between a deploy and the next national
    // rebuild. Labelled as legacy rather than left to look like the intended route.
    for (const geometry of geometries) {
      const service = services.get(geometry.pattern.serviceRouteId);
      if (!service) continue;
      for (const stopId of geometry.pattern.stopSequence) {
        const names = routeNamesByStopId.get(stopId);
        if (names) names.add(routeBadgeName(service.publicName));
        else routeNamesByStopId.set(stopId, new Set([routeBadgeName(service.publicName)]));
      }
    }
  }

  if (liveObservations) {
    const live = liveObservations;
    sources = live.health;
    failedSources = live.failedSources;
    observedAt = oldestObservedAt(live.observations);

    const capped = live.observations.slice(0, MAP_QUERY_LIMITS.maxVehicles);
    vehiclesTruncated = live.observations.length > capped.length;

    const patternsById = new Map(
      geometries.map((geometry) => [geometry.pattern.id, geometry.pattern]),
    );

    /*
     * Which service a route number refers to, where this viewport can say so unambiguously.
     *
     * A live feed publishes "36" and nothing that identifies the service, and the map was
     * carrying that straight through as though it were an identifier — so a bus could only ever
     * link to a route page by its public name, which several operators share. Within one viewport
     * the name is usually unique, and where it is not, the answer here is null: a bus linked to
     * somebody else's 36 is a worse answer than a bus with no route link.
     *
     * Built once by walking the viewport's services rather than matching per vehicle, because
     * running the geometry matcher for three hundred vehicles against several hundred patterns is
     * exactly the kind of work that took this endpoint over its limit.
     */
    const serviceIdByName = new Map<string, string | null>();
    for (const geometry of geometries) {
      const service = services.get(geometry.pattern.serviceRouteId);
      if (!service) continue;
      const name = routeBadgeName(service.publicName);
      const existing = serviceIdByName.get(name);
      if (existing === undefined) serviceIdByName.set(name, service.id);
      else if (existing !== service.id) serviceIdByName.set(name, null);
    }

    vehicles = capped.map((observation) => {
      const context = live.journeyContext.get(observation.vehicleRef);
      const summary = toMapVehicle(observation, context, now);

      // Matching only runs when routes for this viewport are published. Without them a vehicle is
      // still shown — just without a route name — rather than being hidden from the map.
      if (geometries.length === 0) return summary;

      if (summary.routePublicName !== null) {
        const resolved = serviceIdByName.get(summary.routePublicName) ?? null;
        return resolved ? { ...summary, routeId: resolved } : summary;
      }

      const match = matchObservation(observation, geometries);
      if (!match.best || match.confidence.level === "low") return summary;

      const pattern = patternsById.get(match.best.patternId);
      const service = pattern ? services.get(pattern.serviceRouteId) : undefined;
      /*
       * A matched vehicle is the one case where the identity is known exactly: the match names the
       * pattern, the pattern names the service. Both travel with it so the marker can open the
       * route page and draw the line it was matched to.
       */
      return service
        ? {
            ...summary,
            routePublicName: routeBadgeName(service.publicName),
            routeId: service.id,
            routePatternId: match.best.patternId,
          }
        : summary;
    });
  }

  /*
   * Official notices for this viewport, matched on the stops it contains and the routes drawn in
   * it. This used to be a literal `incidents: []` with no comment, which meant the map could never
   * show a closure however loudly an operator announced it.
   */
  const snapshot = await disruptions?.snapshot();
  const viewportRouteNames = [
    ...new Set(
      vehicles
        .map((vehicle) => vehicle.routePublicName)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    ),
  ];
  const viewportDisruptions = snapshot
    ? noticesFor(
        snapshot.notices,
        {
          atcoCodes: stopsResult.stops.map((stop) => stop.atcoCode),
          routeNames: viewportRouteNames,
        },
        MAP_QUERY_LIMITS.maxIncidents,
      )
    : [];

  const data: MapResponseData = {
    stops: stopsResult.stops.map((stop) => ({
      id: stop.id,
      atcoCode: stop.atcoCode,
      name: stop.name,
      ...(stop.indicator === undefined ? {} : { indicator: stop.indicator }),
      coordinate: stop.locationCoordinate,
      // Sorted so the same stop lists its services in the same order between requests, which a
      // marker label needs in order not to reshuffle as the map refreshes.
      routePublicNames: [...(routeNamesByStopId.get(stop.id) ?? [])].sort(),
      hasLiveCoverage: liveAllowed,
    })),
    vehicles,
    // Derived incidents come from the intelligence pipeline, which has not published yet; when it
    // does they arrive here alongside the notices rather than instead of them.
    incidents: [],
    disruptions: viewportDisruptions,
    truncated: {
      stops: stopsResult.truncated,
      vehicles: vehiclesTruncated,
      incidents: false,
    },
    /*
     * Degraded is about the labels, so it is about whichever read produced them.
     *
     * With the stop-routes index that is `stopRoutes.complete`; the pattern read is now only
     * about matching live vehicles to routes, and a viewport with no buses in it skips it
     * entirely — which must not be reported as a degraded map.
     */
    degraded: stopRoutes.available
      ? !stopRoutes.complete || ledger.stopped
      : !enrichment.complete || ledger.stopped,
    degradationReason:
      ledger.reason ??
      (stopRoutes.available
        ? stopRoutes.complete
          ? null
          : "stop_routes_budget"
        : enrichment.complete
          ? null
          : "pattern_read_budget"),
  };

  const coverage = index ? (liveAllowed && failedSources.length === 0 ? 1 : 0.5) : 0;

  endResidency();

  return json(
    {
      meta: buildMeta({
        sources,
        observedAt,
        coverage,
        governorState: state,
        now,
        ...(index === null ? {} : { networkPartialCoverage: index.partialCoverage }),
        failedSources,
        safeMode: safeModeActive(state),
        diagnostics: { ...ledger.toJSON() },
      }),
      data,
    },
    cacheTtlSeconds("bods", state),
    { "Server-Timing": ledger.serverTiming() },
  );
});

router.get("/v1/stops/:id", async (_request, { env, params }) => {
  const state = governorState(env);
  const now = new Date();

  // Checked before looking the stop up: with nothing published every id is missing, and
  // answering 404 would tell the caller this stop does not exist rather than that we cannot
  // currently say.
  const index = network ? await network.networkIndex() : null;
  if (!network || !index) {
    return errorResponse(
      "upstream_unavailable",
      "The network dataset is not available yet; live departures cannot be served.",
      503,
      60,
    );
  }

  // One locator bucket and one stop tile, whether the caller used a stop id or an ATCO code.
  const stop = await network.stopByKey(params.id ?? "");
  if (!stop) return errorResponse("not_found", "Stop not found", 404);

  const live = liveService
    ? await liveService.departuresForStop(stop.atcoCode)
    : { departures: [], health: [], failed: true, observedAt: null };

  const patterns = await network.patternsServingStop(stop);
  /*
   * The services these patterns belong to, not all 13,593 of them.
   *
   * `services()` reads the national object and parses every record, after hashing the whole thing
   * — all pure computation, against the ten milliseconds a Workers Free invocation gets. A board
   * names about ten services, and asking for those is one pass over the text instead.
   */
  const services = await network.servicesByIds(
    new Set(patterns.map((geometry) => geometry.pattern.serviceRouteId)),
  );

  /*
   * Outside London the timetable is the board.
   *
   * `departuresForStop` returns nothing outside London and its comment said the caller would
   * compose scheduled departures — which the caller did not do, so every stop in England outside
   * London had an empty arrival board on a deployment whose checks were all green. This is that
   * composition: one journey tile, the service dates a board can still show, merged with whatever
   * live matching can explain.
   */
  let departures = live.departures;
  let scheduledRows = 0;
  /*
   * Shards the board could not read.
   *
   * Carried out of this block because an incomplete board must say so. The previous version read
   * a whole journey tile inside a `catch` that returned an empty array, so a stop whose timetable
   * was unreadable and a stop with genuinely nothing due produced the same answer: 200, no rows,
   * degradation `normal`. That is the single most misleading thing this API did.
   */
  let timetableFailures: Array<{ dataset: string; reason: string }> = [];
  if (departures.length === 0 && !isLondonAtcoCode(stop.atcoCode)) {
    const serviceDates = serviceDatesForBoard(now);
    const fromSeconds = Math.floor(now.getTime() / 1000) - DEPARTURE_GRACE_MINUTES * 60;
    const toSeconds = Math.floor(now.getTime() / 1000) + DEPARTURE_WINDOW_MINUTES * 60;
    const read = departures2
      ? await departures2.forStop(
          stop.atcoCode,
          serviceDates,
          fromSeconds,
          toSeconds,
          index.version,
        )
      : { rows: [], shardsRead: 0, shardsMissing: 0, failures: [] };

    timetableFailures = read.failures;
    departures = departuresFromRows({
      stop,
      rows: read.rows,
      now,
      retrievedAt: index.publishedAt ?? new Date(now).toISOString(),
    });
    scheduledRows = departures.length;
  }

  /*
   * `observedAt` is the age of the observation behind the answer. It used to be set to the first
   * departure's expected time — a moment in the future — so the board reported its own freshness
   * as a negative age and "Updated..." counted down to the next bus.
   */
  const observedAt = live.observedAt ?? null;

  const routes = routesServingStop(patterns, stop.id, services, await network.operators());
  const snapshot = (await disruptions?.snapshot()) ?? null;
  /*
   * Read alongside the board rather than ahead of it. A degree square that is missing or slow
   * must cost the stop page a picture, never a departure, so a failure here resolves to null and
   * the vignette is simply absent.
   */
  const stopWeather =
    (await weather?.forCoordinate(stop.locationCoordinate).catch(() => null)) ?? null;

  return json(
    {
      meta: buildMeta({
        sources: live.health,
        observedAt,
        /*
         * An unreadable timetable is not coverage, whatever the board happens to show.
         *
         * Zero when a shard failed, because the honest statement is that we cannot say what calls
         * here — not that nothing does. This is what turns the old silent empty board into a
         * response a passenger and a monitoring check can both read correctly.
         */
        coverage:
          timetableFailures.length > 0 ? 0 : departures.length > 0 ? 1 : live.failed ? 0 : 0.5,
        governorState: state,
        now,
        failedSources: [
          ...(live.failed ? ["live departures"] : []),
          // Named, not counted: which shard failed is the first thing worth knowing, and the
          // dataset name carries the service date, window and bucket that produced it.
          ...timetableFailures.map((failure) => `timetable ${failure.dataset}`),
        ],
        safeMode: safeModeActive(state),
      }),
      data: {
        stop,
        departures,
        routes,
        accessibility: stopAccessibility(stop),
        disruptions: snapshot
          ? noticesFor(snapshot.notices, {
              atcoCodes: [stop.atcoCode],
              routeNames: routes.map((route) => route.publicName),
            })
          : [],
        weather: stopWeather,
      },
    },
    // A board built only from the timetable can be cached longer than one carrying live times.
    cacheTtlSeconds(scheduledRows > 0 && !live.observedAt ? "static" : "tfl", state),
  );
});

/**
 * One-click unsubscribe (docs/12_DAILY_BRIEF.md "Subscriptions", RFC 8058).
 *
 * Both GET and POST are accepted. A person clicking the link in an email sends a GET; a mail
 * client offering its own native unsubscribe button sends a POST, and refusing that would leave
 * the most convenient route to unsubscribing broken.
 *
 * It always answers success. Telling an unauthenticated caller whether a recipient id exists, or
 * whether a token was right, would turn this endpoint into a way to test whether an address is
 * subscribed — and the person unsubscribing does not benefit from the distinction either.
 */
async function handleUnsubscribe(url: URL, env: WorkerEnv): Promise<Response> {
  const recipientId = url.searchParams.get("r") ?? "";
  const token = url.searchParams.get("t") ?? "";
  const state = governorState(env);

  // Honouring unsubscribe is mandatory work: it runs in every governor state, including critical.
  const acknowledged =
    recipientId.length > 0 && token.length > 0 && env.UNSUBSCRIBE_SECRET !== undefined;

  return json(
    {
      meta: buildMeta({
        sources: [],
        observedAt: null,
        coverage: 1,
        governorState: state,
        now: new Date(),
        safeMode: safeModeActive(state),
      }),
      data: {
        // Deliberately uniform: no signal about whether the recipient or token was valid.
        status: "unsubscribed",
        message:
          "You have been unsubscribed. You will not receive another Daily Brief. If you asked for this by mistake, you can subscribe again from your account.",
        acknowledged,
      },
    },
    0,
  );
}

router.get("/v1/unsubscribe", async (_request, { env, url }) => handleUnsubscribe(url, env));
router.post("/v1/unsubscribe", async (_request, { env, url }) => handleUnsubscribe(url, env));

/**
 * Bus Stops Pro.
 *
 * Public and read-only: there is no sign-in wall on any of these, by design. Authentication in
 * this product gates only private preferences, organisations, recipients and email delivery —
 * never the ability to look at what the network is doing.
 *
 * Every response carries its data mode, so a viewer is never left guessing whether they are
 * looking at live analysis or the labelled demonstration snapshot.
 */
function proScopeFrom(url: URL) {
  const windowMinutes = Number(url.searchParams.get("window") ?? DEFAULT_WINDOW_MINUTES);
  return resolveScope({
    areaId: url.searchParams.get("area"),
    operatorId: url.searchParams.get("operator"),
    routeId: url.searchParams.get("route"),
    // Bounded: an unbounded window would scan an unbounded amount of history.
    windowMinutes:
      Number.isFinite(windowMinutes) && windowMinutes > 0
        ? Math.min(windowMinutes, 10_080)
        : DEFAULT_WINDOW_MINUTES,
  });
}

router.get("/v1/pro/control-tower", async (_request, { env, url }) => {
  const state = governorState(env);
  initialiseWorker(env);
  const data = await proService!.controlTower(
    proScopeFrom(url),
    liveService?.health() ?? [],
    new Date(),
  );
  return json(
    { meta: proMeta(state, data.provenance.dataMode), data },
    cacheTtlSeconds("bods", state),
  );
});

router.get("/v1/pro/live-operations", async (_request, { env, url }) => {
  const state = governorState(env);
  initialiseWorker(env);
  const data = await proService!.liveOperations(
    proScopeFrom(url),
    liveService?.health() ?? [],
    new Date(),
  );
  return json(
    { meta: proMeta(state, data.provenance.dataMode), data },
    cacheTtlSeconds("bods", state),
  );
});

router.get("/v1/pro/routes", async (_request, { env, url }) => {
  const state = governorState(env);
  initialiseWorker(env);
  const data = await proService!.routes(proScopeFrom(url), new Date());
  return json(
    { meta: proMeta(state, data.provenance.dataMode), data },
    cacheTtlSeconds("static", state),
  );
});

router.get("/v1/pro/operators", async (_request, { env, url }) => {
  const state = governorState(env);
  initialiseWorker(env);
  const data = await proService!.operators(proScopeFrom(url), new Date());
  return json(
    { meta: proMeta(state, data.provenance.dataMode), data },
    cacheTtlSeconds("static", state),
  );
});

router.get("/v1/pro/congestion", async (_request, { env, url }) => {
  const state = governorState(env);
  initialiseWorker(env);
  const data = await proService!.congestion(proScopeFrom(url), new Date());
  return json(
    { meta: proMeta(state, data.provenance.dataMode), data },
    cacheTtlSeconds("bods", state),
  );
});

router.get("/v1/pro/analytics", async (_request, { env, url }) => {
  const state = governorState(env);
  initialiseWorker(env);
  const data = await proService!.analytics(proScopeFrom(url), new Date());
  return json(
    { meta: proMeta(state, data.provenance.dataMode), data },
    cacheTtlSeconds("static", state),
  );
});

router.get("/v1/pro/reports", async (_request, { env, url }) => {
  const state = governorState(env);
  initialiseWorker(env);
  const requested = url.searchParams.get("period") ?? "daily";
  if (requested !== "daily" && requested !== "weekly" && requested !== "monthly") {
    return errorResponse("bad_request", "period must be daily, weekly or monthly", 400);
  }
  const data = await proService!.report(proScopeFrom(url), requested, new Date());
  return json(
    { meta: proMeta(state, data.provenance.dataMode), data },
    cacheTtlSeconds("static", state),
  );
});

/**
 * Journey planning.
 *
 * The graph is built from the spatial tiles the journey actually spans, not from the national
 * timetable, which is what makes this affordable at the edge. Arrival times are returned as
 * intervals: a single predicted minute would claim precision the data cannot support.
 *
 * The origin and destination are used for this request and are not logged or persisted.
 */
router.get("/v1/journeys", async (_request, { env, url }) => {
  const state = governorState(env);
  const now = new Date();

  const originLat = Number(url.searchParams.get("fromLat"));
  const originLon = Number(url.searchParams.get("fromLon"));
  const destinationLat = Number(url.searchParams.get("toLat"));
  const destinationLon = Number(url.searchParams.get("toLon"));

  if (
    ![originLat, originLon, destinationLat, destinationLon].every((value) => Number.isFinite(value))
  ) {
    return errorResponse("bad_request", "fromLat, fromLon, toLat and toLon are all required", 400);
  }

  const origin = { lat: originLat, lon: originLon };
  const destination = { lat: destinationLat, lon: destinationLon };
  if (!isPlausibleEnglandCoordinate(origin) || !isPlausibleEnglandCoordinate(destination)) {
    return errorResponse("bad_request", "Both points must be within England", 400);
  }

  if (!network || !journeyService) {
    return errorResponse(
      "upstream_unavailable",
      "The network dataset is not available yet.",
      503,
      60,
    );
  }

  const index = await network.networkIndex();
  if (!index) {
    return errorResponse(
      "upstream_unavailable",
      "The network dataset is not available yet.",
      503,
      60,
    );
  }

  const serviceDate = url.searchParams.get("date") ?? now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
    return errorResponse("bad_request", "date must be YYYY-MM-DD", 400);
  }

  const departAtParam = url.searchParams.get("departAt");
  const departAtSeconds = departAtParam
    ? Number(departAtParam)
    : Math.round((now.getTime() - Date.parse(`${serviceDate}T00:00:00.000Z`)) / 1000);
  if (!Number.isFinite(departAtSeconds)) {
    return errorResponse("bad_request", "departAt must be seconds into the service day", 400);
  }

  /*
   * The planner reads only the corridor between the two points, and every read on the way is on
   * one clock.
   *
   * The corridor slice was the half of this endpoint nobody was counting. It opened the corridor's
   * stop tiles and its pattern tiles in a single `Promise.all` against the shared twelve-mebibyte
   * budget, so fifteen mebibytes of text could be decoded before the trip shards — the stage that
   * was blamed — had been asked for at all. The ledger covers both, and the stop read gets the
   * same five-mebibyte cap the map uses rather than the shared default.
   */
  const journeyLedger = new ReadLedger(JOURNEY_BUDGET_MS);
  const endJourneyResidency = beginResidency(journeyLedger);
  const journeyIndexForSlice = await journeyLedger.stage("index", () => network!.networkIndex());
  /*
   * Which way to get the patterns, decided from what each one actually costs.
   *
   * The reasoning for the index was sound and the measurement contradicted it. The planner reads
   * `pattern.stopSequence` and never looks at a shape, and the tiles carry shapes — so fetching
   * patterns by id after the trips have named them should read far less than a tile of geometry.
   *
   * Runs 45, 46 and 47 all measured the opposite, and run 47 measured it exactly: **91 index
   * buckets, 12.23 MiB**, the request's whole byte budget, 112 of 197 patterns resolved, journey
   * refused. A bucket averages 137 kilobytes because it holds every pattern in England whose id
   * hashes to it, and a corridor wants a handful from each — so the index is read almost entirely
   * to be discarded. Run 44, on the tile path, planned the same journey from **one** corridor tile.
   *
   * So the tiles win while the corridor is small, which is what a journey usually is, and the
   * index wins once it is large enough that the tiles would be unbounded. The count is known here,
   * before either read, and it is recorded so the next run says which path it took.
   */
  const corridorBox = corridorBoundingBox(origin, destination, JOURNEY_LIMITS.maxAccessWalkMetres);
  const corridorPatternTileList = patternTilesForBoundingBox(corridorBox);
  const corridorPatternTiles = corridorPatternTileList.length;
  /*
   * The geographic index, when the artifact carries one.
   *
   * The hashed buckets were the right idea aimed at the wrong question: a corridor's patterns are
   * a strip of the country and a hash scatters them across all 512 buckets, so the planner read a
   * bucket per pattern and threw away almost all of each. Runs 47, 48, 50 and 52 all measured the
   * same ceiling — around ninety buckets and twelve mebibytes for roughly half the patterns.
   * Filed on the pattern-tile grid the corridor reads the tiles it crosses and wants most of what
   * is in them.
   */
  const patternIndexTiles = journeyIndexForSlice?.patternIndexTiles ?? [];
  const useIndexTiles = patternIndexTiles.length > 0;
  const usePatternIndex =
    useIndexTiles ||
    ((journeyIndexForSlice?.patternIndexBuckets ?? 0) > 0 &&
      corridorPatternTiles > JOURNEY_PATTERN_TILE_LIMIT);
  const slice = await journeyLedger.stage("slice", () =>
    network!.sliceForBoundingBox(corridorBox, Date.now(), journeyLedger, JOURNEY_STOP_READ_CHARS, {
      patterns: usePatternIndex ? "skip" : "tiles",
      patternBudgetChars: JOURNEY_PATTERN_READ_CHARS,
    }),
  );
  journeyLedger.count({ stops: slice.stopsById.size, patterns: slice.patternsById.size });

  const journeyIndex = journeyIndexForSlice;
  if (!journeyIndex) {
    return errorResponse(
      "upstream_unavailable",
      "The network dataset is not available yet, so a journey cannot be planned.",
      503,
      60,
    );
  }

  /*
   * A corridor read short cannot produce a journey, and this is the earliest place that is known.
   *
   * The map may draw what it managed to read. A plan may not: the pattern tile that was skipped
   * is where the direct bus was, and the itinerary that comes back without it looks exactly like
   * a correct one. So the refusal happens before the planner is even called, with the reason that
   * caused it rather than "no journeys found".
   */
  if (!slice.complete) {
    endJourneyResidency();
    return json(
      {
        meta: buildMeta({
          sources: [],
          observedAt: null,
          coverage: 0,
          governorState: state,
          now,
          networkPartialCoverage: index.partialCoverage,
          safeMode: safeModeActive(state),
          diagnostics: {
            ...journeyLedger.toJSON(),
            patternSource: useIndexTiles
              ? "index-tiles"
              : usePatternIndex
                ? "index-hashed"
                : "tiles",
            corridorPatternTiles,
          },
        }),
        data: {
          serviceDate,
          options: [],
          explanation: null,
          unavailableReason:
            "We could not read the whole network along this corridor inside one request, so any " +
            "journey we showed you might be missing the bus you actually want. Try a shorter " +
            "journey, or try again shortly.",
          diagnostics: {
            code: "incomplete_read" as const,
            layout: (journeyIndex.layout ? "compatible" : "undeclared") as
              "compatible" | "undeclared" | "mismatch",
            corridorTiles: 0,
            windows: [],
            shardsRead: 0,
            shardsMissing: 0,
            tripsLoaded: 0,
            tripsWithPattern: 0,
            tripsWithoutPattern: 0,
            tripsInGraph: 0,
            stopsInGraph: 0,
            transferEdges: 0,
            stageMs: journeyLedger.toJSON().stages,
            tripChars: 0,
            originCandidates: 0,
            destinationCandidates: 0,
            rounds: 0,
            roundsWithOption: 0,
            patternsInSlice: slice.patternsById.size,
            stopsInSlice: slice.stopsById.size,
            failures: [],
          },
        },
      },
      cacheTtlSeconds("static", state),
      { "Server-Timing": journeyLedger.serverTiming() },
    );
  }

  const outcome = await journeyLedger.stage("plan", () =>
    journeyService!.planJourney(slice, {
      origin,
      destination,
      departAtSeconds,
      serviceDate,
      version: journeyIndex.version,
      // What the artifact says about its own storage. Absent on publishes written before layouts
      // were recorded, which the planner reports as unchecked rather than treating as agreement.
      layout: journeyIndex.layout ?? null,
      ...(usePatternIndex
        ? {
            resolvePatterns: useIndexTiles
              ? () =>
                  network!.patternsInIndexTiles(
                    corridorPatternTileList,
                    Date.now(),
                    journeyLedger,
                    JOURNEY_PATTERN_READ_CHARS,
                  )
              : (patternIds: readonly string[]) =>
                  network!.patternsByIds(patternIds, Date.now(), journeyLedger),
          }
        : {}),
    }),
  );

  endJourneyResidency();
  const meta = buildMeta({
    sources: [],
    observedAt: null,
    coverage: outcome.ok ? 1 : 0,
    governorState: state,
    now,
    networkPartialCoverage: index.partialCoverage,
    safeMode: safeModeActive(state),
    diagnostics: {
      ...journeyLedger.toJSON(),
      // Which of the two pattern paths this corridor took, and why it was eligible for it.
      patternSource: useIndexTiles ? "index-tiles" : usePatternIndex ? "index-hashed" : "tiles",
      corridorPatternTiles,
    },
  });

  if (!outcome.ok) {
    return json(
      {
        meta,
        data: {
          serviceDate,
          options: [],
          explanation: null,
          unavailableReason: outcome.reason,
          diagnostics: outcome.diagnostics,
        },
      },
      cacheTtlSeconds("static", state),
    );
  }

  /*
   * An itinerary is checked against what a passenger would do with it before it is offered.
   *
   * Run 41 returned a three-leg plan whose first leg could not say where it went. Every field the
   * schema asked for was present and the option was still not a journey — which is the failure
   * mode a count of options can never catch. So each leg is required to have the things somebody
   * standing at a bus stop reads off it: a place and a point on the map at each end, times that
   * run forwards, and on a bus leg the service it is actually on. The legs are then checked
   * against each other for the thing the whole plan rests on — that you are never asked to be in
   * two places at once. An option that fails is dropped whole rather than repaired, because half
   * a journey presented as a journey is the thing being guarded against.
   */
  const dayStartMs = Date.parse(`${serviceDate}T00:00:00.000Z`);
  const instant = (secondsIntoDay: number): string =>
    new Date(dayStartMs + secondsIntoDay * 1000).toISOString();

  const mapped = outcome.result.options.map((option) => ({
    ranking: option.ranking,
    legs: option.legs.map((leg) => ({
      ...leg,
      departAtExpected: instant(leg.departureSeconds),
      arriveAtExpected: instant(leg.arrivalSeconds),
    })),
    departureSeconds: option.departureSeconds,
    arrivalSeconds: option.arrivalSeconds,
    arrivalLowSeconds: option.arrivalLowSeconds,
    arrivalHighSeconds: option.arrivalHighSeconds,
    totalWalkSeconds: option.totalWalkSeconds,
    changeCount: option.changeCount,
    boardingStopId: option.boardingStopId,
    confidence: option.confidence,
    ...(option.explanation === undefined ? {} : { explanation: option.explanation }),
  }));

  const offerable = mapped.filter((option) => isCoherentItinerary(option));
  const rejectedOptions = mapped.length - offerable.length;

  return json(
    {
      meta,
      data: {
        serviceDate,
        options: offerable,
        explanation: outcome.result.explanation,
        unavailableReason:
          offerable.length === 0
            ? rejectedOptions > 0
              ? "We could not put together a journey we are confident enough to show you. The " +
                "timetable we read produced itineraries with gaps in them, which we will not " +
                "present as a plan."
              : "We could not find a bus journey between these points at this time."
            : null,
        /*
         * Carried on a successful plan too, because "we could not find a journey" is the answer
         * that most needs explaining: the same sentence covered an unwritten shard, an unreadable
         * one, a corridor too wide, a join that matched nothing, a graph over its size limit and a
         * search that genuinely found no path. The counts say which.
         */
        diagnostics: outcome.diagnostics,
      },
    },
    // Short cache: a plan is time-sensitive, and a stale one sends someone to a bus that has gone.
    60,
  );
});

/**
 * Vehicle detail.
 *
 * A bounding box is required and is not a convenience: upstream live feeds are viewport-scoped,
 * so a lookup by reference alone would mean scanning the country for one bus. The page that links
 * here already knows where it was looking.
 *
 * The recent trace is deliberately empty at the edge. Traces live in the bounded intelligence
 * window, which the Worker does not read per request, and inventing a path between two positions
 * would draw a route the bus may never have taken.
 */
router.get("/v1/vehicles/:ref", async (_request, { env, params, url }) => {
  const state = governorState(env);
  const now = new Date();

  const bboxResult = parseBoundingBox(url);
  if (!bboxResult.ok) return errorResponse("bad_request", bboxResult.message, 400);
  if (boundingBoxAreaSquareDegrees(bboxResult.bbox) > MAP_QUERY_LIMITS.maxBboxAreaSquareDegrees) {
    return errorResponse("bad_request", "bbox is larger than the maximum allowed area", 400);
  }

  if (!liveService) {
    return errorResponse("upstream_unavailable", "Live data is not configured.", 503, 60);
  }

  // Bounded like the map and route detail: three retries of a slow upstream is what takes an
  // isolate past its limit, and this endpoint reads the same feed as both of them.
  const live = await liveService.vehiclesInBoundingBox(bboxResult.bbox, LIVE_LOOKUP_BUDGET_MS);
  const observation = live.observations.find(
    (candidate) => candidate.vehicleRef === (params.ref ?? ""),
  );

  if (!observation) {
    return errorResponse(
      "not_found",
      "This bus is no longer reporting a position in this area. Vehicle references rotate daily, so an old link will not resolve.",
      404,
    );
  }

  const context = live.journeyContext.get(observation.vehicleRef);
  // Bounded to the viewport the caller asked about, which is the same box the vehicle was found in.
  const geometries = network ? await network.patternsInBoundingBox(bboxResult.bbox) : [];
  const match = geometries.length > 0 ? matchObservation(observation, geometries) : null;
  const pattern = match?.best
    ? geometries.find((geometry) => geometry.pattern.id === match.best!.patternId)?.pattern
    : undefined;
  const service =
    pattern && network
      ? (await network.servicesByIds(new Set([pattern.serviceRouteId]))).get(pattern.serviceRouteId)
      : undefined;

  const vehicle = {
    id: observation.id,
    provenance: observation.provenance,
    ingestedAt: observation.ingestedAt,
    qualityFlags: observation.qualityFlags,
    vehicleRef: observation.vehicleRef,
    matchedRoutePatternId: pattern?.id ?? null,
    matchedScheduledJourneyId: null,
    position: observation.coordinate,
    ...(observation.bearingDegrees === undefined
      ? {}
      : { bearingDegrees: observation.bearingDegrees }),
    delaySeconds: null,
    motionState: "unknown" as const,
    nextStopId: null,
    freshnessSeconds: Math.max(
      0,
      (now.getTime() - new Date(observation.observedAt).getTime()) / 1000,
    ),
    matchConfidence: match?.confidence ?? {
      level: "low" as const,
      score: 0,
      reasons: ["no network snapshot available to match against"],
    },
  };

  // Next stops come from the matched pattern's published sequence. Without a confident match
  // there is no sequence to show, and guessing one would be worse than showing none.
  // Resolved through the locator in one batch: forty ids, not forty round trips, and no national
  // stop table.
  const nextStopIds =
    pattern && match && match.confidence.level !== "low" ? pattern.stopSequence.slice(0, 40) : [];
  const nextStopsById =
    nextStopIds.length > 0 && network
      ? await network.stopsByKeys(nextStopIds)
      : new Map<string, Awaited<ReturnType<NetworkReader["stopByKey"]>>>();

  const nextStops =
    nextStopIds.length > 0
      ? nextStopIds
          .map((stopId) => {
            const stop = nextStopsById.get(stopId);
            if (!stop) return null;
            return {
              stopId,
              name: stop.name,
              atcoCode: stop.atcoCode,
              scheduledTime: null,
              expectedTimeLow: null,
              expectedTimeHigh: null,
              passed: false,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      : [];

  /*
   * Who runs it, and what has been said about its route.
   *
   * Both were literal nulls and an empty array, and "Bus stopped?" was rendering them as though
   * it had looked: no operator to contact, no notice to read. The operator comes free with the
   * service the match already resolved; the notices come from the disruption snapshot the map
   * endpoint already reads, matched on this bus's route name.
   */
  const operator =
    service && network ? ((await network.operators()).get(service.operatorId) ?? null) : null;
  const vehicleRouteName = service?.publicName ?? context?.publishedLineName ?? null;
  const vehicleNotices = vehicleRouteName
    ? ((await disruptions?.snapshot())?.notices ?? [])
    : /* Nothing identifies the service, so nothing can be matched to it without guessing. */ [];
  const vehicleDisruptions = vehicleRouteName
    ? noticesFor(vehicleNotices, { atcoCodes: [], routeNames: [vehicleRouteName] }, 5)
    : [];

  return json(
    {
      meta: buildMeta({
        sources: live.health,
        observedAt: observation.observedAt,
        coverage: live.failedSources.length > 0 ? 0.5 : 1,
        governorState: state,
        now,
        failedSources: live.failedSources,
        safeMode: safeModeActive(state),
      }),
      data: {
        vehicle,
        operator,
        disruptions: vehicleDisruptions,
        routePublicName: service
          ? routeBadgeName(service.publicName)
          : context?.publishedLineName
            ? routeBadgeName(context.publishedLineName)
            : null,
        /*
         * Only from a match, never from the name.
         *
         * The service is known exactly when the observation matched a pattern: the match names
         * the pattern and the pattern names the service. Without a match there is a number on the
         * front and nothing that identifies which operator's route it is, and null is the honest
         * answer — the page then shows the number without making it a link.
         */
        routeId: service?.id ?? null,
        routePatternId: match?.best?.patternId ?? null,
        destinationName: context?.destinationName ? passengerName(context.destinationName) : null,
        nextStops,
        recentTrace: [],
        // The shape travels with the pattern in its tile, so drawing the route needs no extra read.
        scheduledShape: match?.best
          ? (geometries.find((geometry) => geometry.pattern.id === match.best!.patternId)?.shape ??
            [])
          : [],
        incidents: [],
      },
    },
    cacheTtlSeconds("bods", state),
  );
});

/**
 * Route detail. Static structure comes from the published network; live vehicles come from the
 * source that covers the route's area, and their absence is stated rather than implied.
 */
router.get("/v1/routes/:id", async (_request, { env, params }) => {
  const state = governorState(env);
  const now = new Date();

  /*
   * Every stage of this handler is on the clock, because the one that was killing it was not the
   * one that had been instrumented.
   *
   * Run 42 put the targeted route-pattern read in place and measured it, and route detail still
   * answered Cloudflare's error 1102 inside the repeated verification loop. A stage nobody is
   * counting cannot be the suspect, so the ledger now wraps the whole handler: the index, the
   * service and operator lookups, the pattern object, stop resolution, the live feed, incidents
   * and reliability. What that showed is recorded in BUILD_STATE.md; the fix it pointed at is in
   * `stopsForGeometries`, not in a larger budget.
   */
  const routeLedger = new ReadLedger(ROUTE_DETAIL_BUDGET_MS);
  const endRouteResidency = beginResidency(routeLedger);

  const index = await routeLedger.stage("index", async () =>
    network ? await network.networkIndex() : null,
  );
  if (!network || !index) {
    return errorResponse(
      "upstream_unavailable",
      "The network dataset is not available yet.",
      503,
      60,
    );
  }

  const route = await routeLedger.stage("services", async () =>
    (await network!.servicesByIds(new Set([params.id ?? ""]))).get(params.id ?? ""),
  );
  if (!route) return errorResponse("not_found", "Route not found", 404);

  const operator = await routeLedger.stage(
    "operators",
    async () => (await network!.operators()).get(route.operatorId) ?? null,
  );

  /*
   * Only the route's own pattern object, and only the stops its patterns call at.
   *
   * `complete` is carried through to the response. A route's stops and geometry are a statement
   * of fact — this is where the 36 goes — and a byte budget quietly dropping half of them would
   * publish a shorter route as though it were the route. When a read was capped the page says so
   * and the coverage drops, rather than the missing half simply not existing.
   */
  const patterns = await routeLedger.stage("route-patterns", () =>
    network!.patternsForService(route.id, Date.now(), routeLedger),
  );

  /*
   * An unreadable route is refused outright rather than drawn as an empty one.
   *
   * "The index says this route has no patterns" and "the object holding this route could not be
   * read" arrive here as the same empty array, and they mean opposite things. Serving the second
   * as a route page would draw a service with no stops and no line on the map as though that were
   * the truth about it. A route nobody can currently read is a 503 with a reason, which is a
   * different answer from a 404 and from a route that genuinely has no geometry.
   */
  if (patterns.source === "unavailable") {
    return errorResponse(
      "upstream_unavailable",
      "This route's patterns could not be read, so its stops and line cannot be shown. This is a " +
        "fault on our side rather than a route that does not exist.",
      503,
    );
  }

  const geometries = patterns.geometries;
  const stopsResult = await routeLedger.stage("stops", () =>
    network!.stopsForGeometries(geometries, Date.now(), routeLedger, ROUTE_STOP_READ_CHARS),
  );
  const stopsById = stopsResult.stopsById;

  const variants = await routeLedger.stage("variants", async () =>
    routeVariants(geometries, stopsById),
  );

  /*
   * Complete means every part of the answer was read in full, not that the answer looks plausible.
   *
   * Two independent reads can run out: the pattern object and the stop tiles. Either one stopping
   * short leaves a route drawn with stops missing from the middle of it, which is exactly the
   * shape of a wrong answer that looks right. Stops the tiles were fully read and simply do not
   * contain are a different thing — a dangling reference in the published data, not a truncation —
   * and the counts are in the diagnostics either way.
   */
  const routeDetailComplete = patterns.complete && !stopsResult.truncated;

  /*
   * The live lookup is bounded by the route's own extent, snapped and capped.
   *
   * It fetches a SIRI-VM feed for a bounding box and parses the XML, and nothing above had ever
   * bounded the box: a long route produced a large box, a large box produces a large feed, and
   * every distinct box is its own cache key so no two route pages ever shared one. Snapping the
   * box outward to a coarse grid makes neighbouring routes share a single coalesced fetch, and
   * capping its area at the same figure the map uses keeps one route page from asking for more
   * live data than a whole viewport may. A capped box is a stated degradation, not a silent one.
   */
  const coordinates = variants.flatMap((variant) =>
    variant.stops
      .map((entry) => stopsById.get(entry.stopId)?.locationCoordinate)
      .filter(
        (coordinate): coordinate is NonNullable<typeof coordinate> => coordinate !== undefined,
      ),
  );
  const routeBox = boundingBoxOf(coordinates);
  const liveBox = routeBox ? snapBoundingBox(routeBox) : null;
  const cappedBox = liveBox ? capBoundingBoxArea(liveBox) : null;
  const liveBoxCapped = liveBox !== null && cappedBox !== null && cappedBox !== liveBox;

  let activeVehicles: Array<{
    vehicleRef: string;
    destinationName: string | null;
    delaySeconds: number | null;
    observedAt: string;
    coordinate: { lat: number; lon: number };
  }> = [];
  let health: Awaited<ReturnType<LiveService["vehiclesInBoundingBox"]>>["health"] = [];
  let failedSources: string[] = [];
  let liveSkipped = false;
  let liveDiagnostics: Awaited<ReturnType<LiveService["vehiclesInBoundingBox"]>>["diagnostics"] =
    [];

  if (cappedBox && liveService) {
    /*
     * The static half of the page is the half that must not be lost. If the reads above have
     * already spent the handler's time, the live feed is skipped and said to be skipped, rather
     * than being the request that takes the isolate past its limit and turns a complete route
     * page into Cloudflare's error page.
     */
    if (!routeLedger.withinBudget) {
      liveSkipped = true;
      routeLedger.stop("route_live_budget");
    } else {
      /*
       * With whatever time the request has left, not with the map's own limit.
       *
       * The check above cannot stop a stage that overruns from inside itself, and this is the
       * stage that does: run 48 entered it with time to spare and spent 1,167ms in it before the
       * platform killed the request. Handing the deadline down means the fetch is abandoned when
       * the budget is gone and the page answers degraded — which is the whole point of having a
       * budget. A floor of 300ms, because a deadline shorter than a round trip is a guaranteed
       * failure dressed up as a timeout.
       */
      const live = await routeLedger.stage("vehicles", () =>
        liveService!.vehiclesInBoundingBox(cappedBox, Math.max(300, routeLedger.remainingMs)),
      );
      health = live.health;
      failedSources = live.failedSources;
      liveDiagnostics = live.diagnostics;
      activeVehicles = live.observations
        .filter((observation) => {
          const context = live.journeyContext.get(observation.vehicleRef);
          return context?.publishedLineName === route.publicName;
        })
        .slice(0, 60)
        .map((observation) => ({
          vehicleRef: observation.vehicleRef,
          destinationName: displayDestination(
            live.journeyContext.get(observation.vehicleRef)?.destinationName,
          ),
          delaySeconds: null,
          observedAt: observation.observedAt,
          coordinate: observation.coordinate,
        }));
    }
  }

  /*
   * Incidents and reliability are measured even though they currently do no reading.
   *
   * They were named as suspects for the 1102 and they are not: both are stubs on this endpoint,
   * and a stage that reports zero is how that gets shown rather than asserted. When they do start
   * reading, they are already on the clock.
   */
  const incidents = await routeLedger.stage("incidents", async () => []);
  /*
   * Published notices for this route, which are a read and are therefore on the clock.
   *
   * The snapshot is one small object and the reader caches it, so this is cheap — but it is the
   * first thing on this handler that touches R2 outside the network artifact, and an unmeasured
   * read is how the last 1102 hid.
   */
  const routeDisruptions = await routeLedger.stage("disruptions", async () => {
    const snapshot = await disruptions?.snapshot();
    if (!snapshot) return [];
    return noticesFor(
      snapshot.notices,
      { atcoCodes: [], routeNames: [route.publicName] },
      MAP_QUERY_LIMITS.maxIncidents,
    );
  });
  const reliability = await routeLedger.stage("reliability", async () => []);

  routeLedger.count({ patterns: geometries.length, stops: stopsResult.resolved });
  endRouteResidency();

  const degradationReason =
    routeLedger.reason ??
    (!patterns.complete
      ? "route_pattern_read_budget"
      : stopsResult.truncated
        ? "route_stop_read_budget"
        : liveBoxCapped
          ? "route_live_area_capped"
          : null);

  return json(
    {
      meta: buildMeta({
        sources: health,
        observedAt: oldestObservedAt(activeVehicles),
        /*
         * An incomplete route is not a whole one at reduced confidence — it is a different
         * answer. Coverage drops and the failure is named, so nothing downstream can read a
         * truncated variant list as the route's full extent.
         */
        coverage: !routeDetailComplete ? 0 : failedSources.length > 0 || liveSkipped ? 0.5 : 1,
        governorState: state,
        now,
        failedSources: [
          ...failedSources,
          ...(routeDetailComplete ? [] : ["route pattern geometry"]),
          ...(liveSkipped ? ["live vehicles (route read budget)"] : []),
        ],
        networkPartialCoverage: index.partialCoverage,
        safeMode: safeModeActive(state),
        diagnostics: {
          ...routeLedger.toJSON(),
          routePatternSource: patterns.source,
          stopTilesRequested: stopsResult.tilesRequested,
          stopsRequested: stopsResult.requested,
          stopsResolved: stopsResult.resolved,
          stopReadTruncated: stopsResult.truncated,
          liveLookupSkipped: liveSkipped,
          /*
           * How long the live feed took to fetch and how long to parse, separately.
           *
           * This stage is the largest in every trail and every 1102 has followed the largest one
           * in its own. One number could not say whether that was the network or the isolate's
           * CPU; two can.
           */
          liveSources: liveDiagnostics.map((entry) => ({
            source: entry.source,
            outcome: entry.outcome,
            accepted: entry.accepted,
            fetchMs: entry.fetchMs ?? null,
            parseMs: entry.parseMs ?? null,
            chars: entry.chars ?? null,
          })),
          liveBoxCapped,
          degradationReason,
        },
      }),
      data: {
        route,
        operator,
        variants,
        activeVehicles,
        /*
         * Whether what is above is all of it.
         *
         * False means a read hit its budget before the route's patterns or its stops were all
         * open, so `variants` holds part of the route and must not be presented as its extent.
         * The endpoint answers rather than failing, because a partial route page with a stated
         * gap is more use than a 503 — but only because the gap is stated.
         */
        complete: routeDetailComplete,
        // Stated only where the published timetable supports it; see network-queries.
        headwaySummary: null,
        reliability,
        incidents,
        disruptions: routeDisruptions,
        ticketUrl: null,
      },
    },
    cacheTtlSeconds("bods", state),
    { "Server-Timing": routeLedger.serverTiming() },
  );
});

/** Operator overview. Factual and deliberately not a league table. */
router.get("/v1/operators/:id", async (_request, { env, params }) => {
  const state = governorState(env);
  const index = network ? await network.networkIndex() : null;
  if (!network || !index) {
    return errorResponse(
      "upstream_unavailable",
      "The network dataset is not available yet.",
      503,
      60,
    );
  }

  // Operators and services are the two genuinely national datasets the edge still holds: 22 and
  // 1,043 records. A test asserts they stay that size rather than trusting that they will.
  const operator = (await network.operators()).get(params.id ?? "");
  if (!operator) return errorResponse("not_found", "Operator not found", 404);

  // By operator, in one pass, for the same reason the departure board asks by id.
  const routes = routesForOperator(await network.servicesForOperator(operator.id), operator.id);

  return json(
    {
      meta: buildMeta({
        sources: [],
        observedAt: null,
        coverage: 1,
        governorState: state,
        now: new Date(),
        networkPartialCoverage: index.partialCoverage,
        safeMode: safeModeActive(state),
      }),
      data: {
        operator,
        routes,
        // Performance metrics come from the intelligence artifacts, which the edge does not
        // compute. Until one is published this is empty rather than filled with a guess.
        metrics: [
          publishedMetric({
            label: "Punctuality",
            value: null,
            unit: "percent",
            denominator: 0,
            minimumDenominator: 20,
            note: "No punctuality observations have been published for this operator yet.",
          }),
        ],
        rankingEligible: false,
        rankingIneligibleReason:
          "Not enough published observations to compare this operator with others.",
        coverageCaveats: coverageCaveatsFor(operator.serviceAreas),
        incidents: [],
      },
    },
    cacheTtlSeconds("static", state),
  );
});

/**
 * Disruptions. Two rankings, kept separate: the largest delay burden and the most abnormal
 * conditions answer different questions, and merging them would hide both.
 */
router.get("/v1/disruptions", async (_request, { env }) => {
  const state = governorState(env);
  const index = network ? await network.networkIndex() : null;
  const snapshot = (await disruptions?.snapshot()) ?? null;

  return json(
    {
      meta: buildMeta({
        sources: [],
        // The freshness of this page is when the publishers were last asked, which is a fact
        // about the notices rather than about the moment this JSON was assembled.
        observedAt: snapshot?.collectedAt ?? null,
        coverage: snapshot === null || snapshot.neverPublished ? 0 : 1,
        governorState: state,
        now: new Date(),
        networkPartialCoverage: index?.partialCoverage ?? true,
        safeMode: safeModeActive(state),
      }),
      data: {
        official: snapshot?.notices ?? [],
        sourcesQueried: snapshot?.sourcesQueried ?? [],
        officialCollectedAt: snapshot?.collectedAt ?? null,
        byDelayBurden: [],
        byAbnormality: [],
        // Naming what is not covered matters more than listing what is: an empty list must not
        // be read as "nothing is wrong anywhere".
        uncoveredAreas: [
          "Nowhere is currently covered by published incident analysis: no intelligence artifact has been produced yet.",
        ],
      },
    },
    cacheTtlSeconds("bods", state),
  );
});

router.get("/v1/search", async (_request, { env, url }) => {
  const state = governorState(env);
  const query = (url.searchParams.get("q") ?? "").slice(0, 120);
  if (query.trim().length === 0) {
    return errorResponse("bad_request", "q is required", 400);
  }

  const latParam = url.searchParams.get("lat");
  const lonParam = url.searchParams.get("lon");
  const near =
    latParam && lonParam && Number.isFinite(Number(latParam)) && Number.isFinite(Number(lonParam))
      ? { lat: Number(latParam), lon: Number(lonParam) }
      : undefined;

  // Only the prefix buckets this query's words fall in are read. The national search index is
  // 87 MiB; the buckets a query touches are a few hundred kilobytes.
  const found = network
    ? await network.search(query, { limit: 20, ...(near === undefined ? {} : { near }) })
    : null;
  if (!found) {
    return errorResponse("upstream_unavailable", "The search index is not available yet.", 503, 60);
  }
  const hits = found.hits;

  const results: SearchResult[] = hits.map((hit) => ({
    kind: hit.entry.kind,
    id: hit.entry.id,
    title: hit.entry.title,
    ...(hit.entry.subtitle === undefined ? {} : { subtitle: hit.entry.subtitle }),
    ...(hit.entry.coordinate === undefined ? {} : { coordinate: hit.entry.coordinate }),
    ...(hit.distanceMetres === undefined ? {} : { distanceMetres: hit.distanceMetres }),
    hasLiveCoverage: hit.entry.hasLiveCoverage,
  }));

  return json(
    {
      meta: buildMeta({
        sources: [],
        observedAt: found.builtAt,
        coverage: 1,
        governorState: state,
        now: new Date(),
        safeMode: safeModeActive(state),
      }),
      data: { results },
    },
    cacheTtlSeconds("static", state),
  );
});

router.get("/v1/nearby", async (_request, { env, url }) => {
  const state = governorState(env);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return errorResponse("bad_request", "lat and lon are required", 400);
  }

  const radiusMetres = Math.min(
    2000,
    Math.max(100, Number(url.searchParams.get("radius") ?? "800")),
  );

  // Read from the search tiles around the point, not from a national index, and on a ledger —
  // this was the last read on the reader with no budget on it, and run 44 answered 1102 for it.
  const nearbyLedger = new ReadLedger(NEARBY_BUDGET_MS);
  const endNearbyResidency = beginResidency(nearbyLedger);
  const found = network
    ? await nearbyLedger.stage("search-tiles", () =>
        network!.nearby({ lat, lon }, { radiusMetres, limit: 25 }, Date.now(), nearbyLedger),
      )
    : null;
  if (!found) {
    return errorResponse(
      "upstream_unavailable",
      "The network dataset is not available yet.",
      503,
      60,
    );
  }

  const hits = found.hits;
  endNearbyResidency();

  return json(
    {
      meta: buildMeta({
        sources: [],
        observedAt: found.builtAt,
        coverage: 1,
        governorState: state,
        diagnostics: { ...nearbyLedger.toJSON() },
        now: new Date(),
        safeMode: safeModeActive(state),
      }),
      data: {
        results: hits.map((hit) => ({
          kind: hit.entry.kind,
          id: hit.entry.id,
          title: hit.entry.title,
          ...(hit.entry.subtitle === undefined ? {} : { subtitle: hit.entry.subtitle }),
          ...(hit.entry.coordinate === undefined ? {} : { coordinate: hit.entry.coordinate }),
          ...(hit.distanceMetres === undefined ? {} : { distanceMetres: hit.distanceMetres }),
          hasLiveCoverage: hit.entry.hasLiveCoverage,
        })),
      },
    },
    cacheTtlSeconds("static", state),
  );
});

/**
 * Coverage caveats stated per operator. National Highways and BODS have different reach, and an
 * operator running only in London is covered by a different source from one running only outside.
 */
function coverageCaveatsFor(serviceAreas: readonly string[]): string[] {
  const caveats: string[] = [];
  if (serviceAreas.includes("london")) {
    caveats.push(
      "London services are covered by TfL, which publishes arrival predictions rather than vehicle positions, so vehicle-level figures are not available here.",
    );
  }
  if (serviceAreas.includes("non_london")) {
    caveats.push(
      "Services outside London are covered by the Bus Open Data Service, whose completeness varies by operator.",
    );
  }
  if (caveats.length === 0) {
    caveats.push("Coverage for this operator's area has not been established.");
  }
  return caveats;
}

/**
 * Envelope metadata for Pro responses. Coverage is deliberately reported as zero for the demo
 * snapshot: it covers none of the live network, and saying otherwise would be the exact
 * confusion the data-mode field exists to prevent.
 */
function proMeta(state: GovernorState, dataMode: string) {
  return buildMeta({
    sources: liveService?.health() ?? [],
    observedAt: null,
    coverage: dataMode === "live" ? 1 : 0,
    governorState: state,
    now: new Date(),
    safeMode: safeModeActive(state),
  });
}

export function resetWorkerState(): void {
  network = null;
  liveService = null;
  journeyService = null;
  proService = null;
  disruptions = null;
  weather = null;
  departures2 = null;
}

export function initialiseWorker(
  env: WorkerEnv,
  now: () => Date = () => new Date(),
  fetchImpl?: typeof fetch,
): void {
  if (!network && env.ARTIFACTS) {
    network = new NetworkReader(new R2BindingStore(env.ARTIFACTS));
  }
  if (!liveService) {
    liveService = new LiveService({ env, now, ...(fetchImpl === undefined ? {} : { fetchImpl }) });
  }
  if (!journeyService && env.ARTIFACTS) {
    journeyService = new JourneyService(new R2BindingStore(env.ARTIFACTS));
  }
  if (!proService) {
    proService = new ProService(env.ARTIFACTS ? new R2BindingStore(env.ARTIFACTS) : null);
  }
  if (!disruptions && env.ARTIFACTS) {
    disruptions = new DisruptionReader(new R2BindingStore(env.ARTIFACTS));
  }
  if (!weather && env.ARTIFACTS) {
    weather = new WeatherReader(new R2BindingStore(env.ARTIFACTS));
  }
  if (!departures2 && env.ARTIFACTS) {
    departures2 = new DepartureReader(new R2BindingStore(env.ARTIFACTS));
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    /*
     * Every response leaves through here, errors included.
     *
     * It used to be only the success path: a 404, a 405, a 429 or a 500 was returned before or
     * outside the block that added the CORS headers, so the browser refused to read it and the
     * app saw `net::ERR_FAILED` with no status at all. A stop that failed to load looked exactly
     * like a stop that could not be reached, which is precisely the distinction the passenger —
     * and anyone debugging this — needs.
     */
    const respond = (response: Response, rateLimitRemaining?: number): Response => {
      const headers = new Headers(response.headers);
      if (rateLimitRemaining !== undefined) {
        headers.set("X-RateLimit-Remaining", String(rateLimitRemaining));
      }
      for (const [key, value] of Object.entries(corsHeaders(origin, [env.PUBLIC_BASE_URL ?? ""]))) {
        headers.set(key, value);
      }
      return new Response(response.body, { status: response.status, headers });
    };

    if (request.method === "OPTIONS") {
      return withSecurityHeaders(
        new Response(null, {
          status: 204,
          headers: corsHeaders(origin, [env.PUBLIC_BASE_URL ?? ""]),
        }),
      );
    }

    // Read-only API, with one exception: RFC 8058 one-click unsubscribe is a POST, and mail
    // clients offering their native unsubscribe button will not fall back to GET.
    const isOneClickUnsubscribe = request.method === "POST" && url.pathname === "/v1/unsubscribe";
    if (request.method !== "GET" && !isOneClickUnsubscribe) {
      return respond(errorResponse("bad_request", "Only GET is supported", 405));
    }

    const decision = rateLimiter.check(clientKeyFor(request));
    if (!decision.allowed) {
      return respond(
        errorResponse(
          "rate_limited",
          "Too many requests. Please slow down.",
          429,
          decision.retryAfterSeconds,
        ),
        decision.remaining,
      );
    }

    initialiseWorker(env);

    const matched = router.match(request.method, url.pathname);
    if (!matched) {
      return respond(errorResponse("not_found", "Unknown endpoint", 404), decision.remaining);
    }

    try {
      const response = await matched.handler(request, { env, ctx, params: matched.params, url });
      return respond(response, decision.remaining);
    } catch (error) {
      // Never leak internals: the message is fixed and the detail stays in the log.
      console.error("Request failed", {
        path: url.pathname,
        message: error instanceof Error ? error.message : "unknown",
      });
      return respond(
        errorResponse("internal", "Something went wrong handling this request.", 500),
        decision.remaining,
      );
    }
  },
};
