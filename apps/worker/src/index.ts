import {
  BoundingBoxSchema,
  MAP_QUERY_LIMITS,
  type GovernorState,
  type MapResponseData,
  type SearchResult,
} from "@busstops/contracts";
import { safeModeActive } from "@busstops/governor";
import { DisruptionReader, noticesFor } from "./disruption-reader.js";
import { stopAccessibility } from "./stop-accessibility.js";
import { WeatherReader } from "./weather-reader.js";
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
import { scheduledDeparturesForStop, serviceDatesForBoard } from "./stop-departures.js";
import { JOURNEY_LIMITS, JourneyService } from "./journey-service.js";
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
const rateLimiter = new RateLimiter();

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

  const live = await liveService.vehiclesInBoundingBox(bbox);
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
  // Only the tiles this viewport covers are read. The national stop set is 198 MiB against a
  // 128 MiB isolate, so "load it and filter" is not an option that exists.
  const index = network ? await network.networkIndex() : null;
  const stopsResult = network
    ? await network.stopsInBoundingBox(bbox, MAP_QUERY_LIMITS.maxStops)
    : { stops: [], truncated: false };

  let vehicles: MapResponseData["vehicles"] = [];
  let vehiclesTruncated = false;
  let sources: Awaited<ReturnType<LiveService["vehiclesInBoundingBox"]>>["health"] = [];
  let failedSources: string[] = [];
  let observedAt: string | null = null;

  const liveAllowed = flags.liveVehicles && state !== "critical";
  if (liveAllowed && liveService) {
    const live = await liveService.vehiclesInBoundingBox(bbox);
    sources = live.health;
    failedSources = live.failedSources;
    observedAt = oldestObservedAt(live.observations);

    // Matching only needs the routes that run through the viewport being drawn.
    const geometries = network ? await network.patternsInBoundingBox(bbox) : [];
    const capped = live.observations.slice(0, MAP_QUERY_LIMITS.maxVehicles);
    vehiclesTruncated = live.observations.length > capped.length;

    const patternsById = new Map(
      geometries.map((geometry) => [geometry.pattern.id, geometry.pattern]),
    );
    const services = network ? await network.services() : new Map();

    vehicles = capped.map((observation) => {
      const context = live.journeyContext.get(observation.vehicleRef);
      const summary = toMapVehicle(observation, context, now);

      // Matching only runs when routes for this viewport are published. Without them a vehicle is
      // still shown — just without a route name — rather than being hidden from the map.
      if (geometries.length === 0 || summary.routePublicName !== null) return summary;

      const match = matchObservation(observation, geometries);
      if (!match.best || match.confidence.level === "low") return summary;

      const pattern = patternsById.get(match.best.patternId);
      const service = pattern ? services.get(pattern.serviceRouteId) : undefined;
      return service ? { ...summary, routePublicName: service.publicName } : summary;
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
      routePublicNames: [],
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
  };

  const coverage = index ? (liveAllowed && failedSources.length === 0 ? 1 : 0.5) : 0;

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
      }),
      data,
    },
    cacheTtlSeconds("bods", state),
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
  const services = await network.services();

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
  if (departures.length === 0 && !isLondonAtcoCode(stop.atcoCode)) {
    const serviceDates = serviceDatesForBoard(now);
    const journeys = await network.journeysServingStop(stop, serviceDates);
    const stopNamesById = await network.stopsByIdsForJourneys(journeys);
    departures = scheduledDeparturesForStop({
      stop,
      journeys,
      patterns,
      services,
      stopNamesById,
      now,
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
        coverage: departures.length > 0 ? 1 : live.failed ? 0 : 0.5,
        governorState: state,
        now,
        failedSources: live.failed ? ["live departures"] : [],
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

  // The planner reads only the corridor between the two points, which it caps at a handful of
  // tiles — so a journey request never assembles the national network.
  const slice = await network.sliceForBoundingBox(
    corridorBoundingBox(origin, destination, JOURNEY_LIMITS.maxAccessWalkMetres),
  );
  const outcome = await journeyService.planJourney(slice, {
    origin,
    destination,
    departAtSeconds,
    serviceDate,
  });

  const meta = buildMeta({
    sources: [],
    observedAt: null,
    coverage: outcome.ok ? 1 : 0,
    governorState: state,
    now,
    networkPartialCoverage: index.partialCoverage,
    safeMode: safeModeActive(state),
  });

  if (!outcome.ok) {
    return json(
      {
        meta,
        data: { serviceDate, options: [], explanation: null, unavailableReason: outcome.reason },
      },
      cacheTtlSeconds("static", state),
    );
  }

  return json(
    {
      meta,
      data: {
        serviceDate,
        options: outcome.result.options.map((option) => ({
          ranking: option.ranking,
          legs: option.legs,
          departureSeconds: option.departureSeconds,
          arrivalSeconds: option.arrivalSeconds,
          arrivalLowSeconds: option.arrivalLowSeconds,
          arrivalHighSeconds: option.arrivalHighSeconds,
          totalWalkSeconds: option.totalWalkSeconds,
          changeCount: option.changeCount,
          boardingStopId: option.boardingStopId,
          confidence: option.confidence,
          ...(option.explanation === undefined ? {} : { explanation: option.explanation }),
        })),
        explanation: outcome.result.explanation,
        unavailableReason:
          outcome.result.options.length === 0
            ? "We could not find a bus journey between these points at this time."
            : null,
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

  const live = await liveService.vehiclesInBoundingBox(bboxResult.bbox);
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
    pattern && network ? (await network.services()).get(pattern.serviceRouteId) : undefined;

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
        routePublicName: service?.publicName ?? context?.publishedLineName ?? null,
        destinationName: context?.destinationName ?? null,
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

  const index = network ? await network.networkIndex() : null;
  if (!network || !index) {
    return errorResponse(
      "upstream_unavailable",
      "The network dataset is not available yet.",
      503,
      60,
    );
  }

  const route = (await network.services()).get(params.id ?? "");
  if (!route) return errorResponse("not_found", "Route not found", 404);

  const operator = (await network.operators()).get(route.operatorId) ?? null;

  // Only the tiles this route is published in, and only the stops its patterns call at.
  const geometries = await network.patternsForService(route.id);
  const stopIds = [...new Set(geometries.flatMap((geometry) => geometry.pattern.stopSequence))];
  const stopsById = await network.stopsByKeys(stopIds);
  const variants = routeVariants(geometries, stopsById);

  // Live vehicles are only fetched for the area this route actually covers, so a route page
  // never triggers a national feed request.
  const coordinates = variants.flatMap((variant) =>
    variant.stops
      .map((entry) => stopsById.get(entry.stopId)?.locationCoordinate)
      .filter(
        (coordinate): coordinate is NonNullable<typeof coordinate> => coordinate !== undefined,
      ),
  );
  const bbox = boundingBoxOf(coordinates);

  let activeVehicles: Array<{
    vehicleRef: string;
    destinationName: string | null;
    delaySeconds: number | null;
    observedAt: string;
    coordinate: { lat: number; lon: number };
  }> = [];
  let health: Awaited<ReturnType<LiveService["vehiclesInBoundingBox"]>>["health"] = [];
  let failedSources: string[] = [];

  if (bbox && liveService) {
    const live = await liveService.vehiclesInBoundingBox(bbox);
    health = live.health;
    failedSources = live.failedSources;
    activeVehicles = live.observations
      .filter((observation) => {
        const context = live.journeyContext.get(observation.vehicleRef);
        return context?.publishedLineName === route.publicName;
      })
      .slice(0, 60)
      .map((observation) => ({
        vehicleRef: observation.vehicleRef,
        destinationName: live.journeyContext.get(observation.vehicleRef)?.destinationName ?? null,
        delaySeconds: null,
        observedAt: observation.observedAt,
        coordinate: observation.coordinate,
      }));
  }

  return json(
    {
      meta: buildMeta({
        sources: health,
        observedAt: oldestObservedAt(activeVehicles),
        coverage: failedSources.length > 0 ? 0.5 : 1,
        governorState: state,
        now,
        failedSources,
        networkPartialCoverage: index.partialCoverage,
        safeMode: safeModeActive(state),
      }),
      data: {
        route,
        operator,
        variants,
        activeVehicles,
        // Stated only where the published timetable supports it; see network-queries.
        headwaySummary: null,
        reliability: [],
        incidents: [],
        ticketUrl: null,
      },
    },
    cacheTtlSeconds("bods", state),
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

  const routes = routesForOperator(await network.services(), operator.id);

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

  // Read from the search tiles around the point, not from a national index.
  const found = network ? await network.nearby({ lat, lon }, { radiusMetres, limit: 25 }) : null;
  if (!found) {
    return errorResponse(
      "upstream_unavailable",
      "The network dataset is not available yet.",
      503,
      60,
    );
  }

  const hits = found.hits;

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
