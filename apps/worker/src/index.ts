import {
  BoundingBoxSchema,
  MAP_QUERY_LIMITS,
  type GovernorState,
  type MapResponseData,
  type SearchResult,
} from "@busstops/contracts";
import { safeModeActive } from "@busstops/governor";
import { boundingBoxAreaSquareDegrees } from "@busstops/pipeline-core";
import { matchObservation } from "@busstops/matching";
import { nearbyStops, searchIndex } from "@busstops/pipeline-static-network";
import { R2BindingStore, readFeatureFlags, type WorkerEnv } from "./env.js";
import {
  LiveService,
  buildMeta,
  cacheTtlSeconds,
  oldestObservedAt,
  toMapVehicle,
} from "./live-service.js";
import { NetworkRepository } from "./network-repository.js";
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
let repository: NetworkRepository | null = null;
let liveService: LiveService | null = null;
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

  const snapshot = repository ? await repository.load() : null;
  const now = new Date();

  const stopsResult = snapshot
    ? NetworkRepository.stopsInBoundingBox(snapshot, bbox, MAP_QUERY_LIMITS.maxStops)
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

    const geometries = snapshot ? NetworkRepository.patternGeometries(snapshot) : [];
    const capped = live.observations.slice(0, MAP_QUERY_LIMITS.maxVehicles);
    vehiclesTruncated = live.observations.length > capped.length;

    vehicles = capped.map((observation) => {
      const context = live.journeyContext.get(observation.vehicleRef);
      const summary = toMapVehicle(observation, context, now);

      // Matching only runs when the network snapshot is loaded. Without it a vehicle is still
      // shown — just without a route name — rather than being hidden from the map.
      if (geometries.length === 0 || summary.routePublicName !== null) return summary;

      const match = matchObservation(observation, geometries);
      if (!match.best || match.confidence.level === "low") return summary;

      const pattern = snapshot?.patternsById.get(match.best.patternId);
      const service = pattern ? snapshot?.services.get(pattern.serviceRouteId) : undefined;
      return service ? { ...summary, routePublicName: service.publicName } : summary;
    });
  }

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
    incidents: [],
    truncated: {
      stops: stopsResult.truncated,
      vehicles: vehiclesTruncated,
      incidents: false,
    },
  };

  const coverage = snapshot ? (liveAllowed && failedSources.length === 0 ? 1 : 0.5) : 0;

  return json(
    {
      meta: buildMeta({
        sources,
        observedAt,
        coverage,
        governorState: state,
        now,
        ...(snapshot === null ? {} : { networkPartialCoverage: snapshot.partialCoverage }),
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
  const snapshot = repository ? await repository.load() : null;
  const now = new Date();

  if (!snapshot) {
    return errorResponse(
      "upstream_unavailable",
      "The network dataset is not available yet; live departures cannot be served.",
      503,
      60,
    );
  }

  const stop = snapshot.stopsById.get(params.id ?? "") ?? snapshot.stopsByAtco.get(params.id ?? "");
  if (!stop) return errorResponse("not_found", "Stop not found", 404);

  const live = liveService
    ? await liveService.departuresForStop(stop.atcoCode)
    : { departures: [], health: [], failed: true };

  return json(
    {
      meta: buildMeta({
        sources: live.health,
        observedAt: live.departures[0]?.expectedTime ?? null,
        coverage: live.failed ? 0 : 1,
        governorState: state,
        now,
        failedSources: live.failed ? ["live departures"] : [],
        safeMode: safeModeActive(state),
      }),
      data: {
        stop,
        departures: live.departures,
        routes: [],
      },
    },
    cacheTtlSeconds("tfl", state),
  );
});

router.get("/v1/search", async (_request, { env, url }) => {
  const state = governorState(env);
  const query = (url.searchParams.get("q") ?? "").slice(0, 120);
  if (query.trim().length === 0) {
    return errorResponse("bad_request", "q is required", 400);
  }

  const snapshot = repository ? await repository.load() : null;
  if (!snapshot) {
    return errorResponse("upstream_unavailable", "The search index is not available yet.", 503, 60);
  }

  const latParam = url.searchParams.get("lat");
  const lonParam = url.searchParams.get("lon");
  const near =
    latParam && lonParam && Number.isFinite(Number(latParam)) && Number.isFinite(Number(lonParam))
      ? { lat: Number(latParam), lon: Number(lonParam) }
      : undefined;

  const hits = searchIndex(snapshot.searchIndex, query, {
    limit: 20,
    ...(near === undefined ? {} : { near }),
  });

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
        observedAt: snapshot.publishedAt,
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

  const snapshot = repository ? await repository.load() : null;
  if (!snapshot) {
    return errorResponse(
      "upstream_unavailable",
      "The network dataset is not available yet.",
      503,
      60,
    );
  }

  const hits = nearbyStops(snapshot.searchIndex, { lat, lon }, { radiusMetres, limit: 25 });

  return json(
    {
      meta: buildMeta({
        sources: [],
        observedAt: snapshot.publishedAt,
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

export function resetWorkerState(): void {
  repository = null;
  liveService = null;
}

export function initialiseWorker(
  env: WorkerEnv,
  now: () => Date = () => new Date(),
  fetchImpl?: typeof fetch,
): void {
  if (!repository && env.ARTIFACTS) {
    repository = new NetworkRepository(new R2BindingStore(env.ARTIFACTS));
  }
  if (!liveService) {
    liveService = new LiveService({ env, now, ...(fetchImpl === undefined ? {} : { fetchImpl }) });
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: RequestContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withSecurityHeaders(
        new Response(null, {
          status: 204,
          headers: corsHeaders(request.headers.get("Origin"), [env.PUBLIC_BASE_URL ?? ""]),
        }),
      );
    }

    if (request.method !== "GET") {
      return errorResponse("bad_request", "Only GET is supported", 405);
    }

    const decision = rateLimiter.check(clientKeyFor(request));
    if (!decision.allowed) {
      return errorResponse(
        "rate_limited",
        "Too many requests. Please slow down.",
        429,
        decision.retryAfterSeconds,
      );
    }

    initialiseWorker(env);

    const matched = router.match(request.method, url.pathname);
    if (!matched) return errorResponse("not_found", "Unknown endpoint", 404);

    try {
      const response = await matched.handler(request, { env, ctx, params: matched.params, url });
      const headers = new Headers(response.headers);
      headers.set("X-RateLimit-Remaining", String(decision.remaining));
      for (const [key, value] of Object.entries(
        corsHeaders(request.headers.get("Origin"), [env.PUBLIC_BASE_URL ?? ""]),
      )) {
        headers.set(key, value);
      }
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      // Never leak internals: the message is fixed and the detail stays in the log.
      console.error("Request failed", {
        path: url.pathname,
        message: error instanceof Error ? error.message : "unknown",
      });
      return errorResponse("internal", "Something went wrong handling this request.", 500);
    }
  },
};
