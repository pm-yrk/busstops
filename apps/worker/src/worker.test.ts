import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DisruptionsResponseSchema,
  CongestionResponseSchema,
  ControlTowerResponseSchema,
  JourneyPlanResponseSchema,
  OperatorsResponseSchema,
  MAP_QUERY_LIMITS,
  MapResponseSchema,
  OperatorDetailResponseSchema,
  RouteDetailResponseSchema,
  VehicleDetailResponseSchema,
  SearchResponseSchema,
} from "@busstops/contracts";
import {
  buildRecentTraceBuckets,
  ArtifactStore,
  InMemoryObjectStore,
  contentHash,
  manifestKey,
  objectKeyFor,
  tileIdFor,
} from "@busstops/pipeline-core";
import {
  buildNetwork,
  publishJourneyTiles,
  publishNetwork,
  publishNetworkShards,
} from "@busstops/pipeline-static-network";
import worker, { initialiseWorker, resetWorkerState } from "./index.js";
import { R2BindingStore, readFeatureFlags, type R2BucketLike, type WorkerEnv } from "./env.js";
import {
  PATTERN_INDEX_PREFIX,
  PATTERN_TILE_DEGREES,
  SHARDED,
  STOP_SERVICES_PREFIX,
  STOP_SERVING_ROUTES_PREFIX,
  TRIP_TILE_DEGREES,
  patternTileDataset,
  currentArtifactLayout,
  departureBucketFor,
  departureShardDataset,
  encodeDepartureShard,
  tripWindowFor,
  patternTripsDataset,
  type DepartureRow,
  type NetworkIndexRecord,
  type PatternTripRow,
} from "@busstops/pipeline-static-network";
import {
  RateLimiter,
  clientKeyFor,
  contentSecurityPolicy,
  corsHeaders,
  errorResponse,
} from "./security.js";
import { Router } from "./router.js";
import {
  cacheTtlSeconds,
  deriveDegradation,
  isLondonAtcoCode,
  oldestObservedAt,
  sourcesForBoundingBox,
} from "./live-service.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/documented",
);
const naptanCsv = readFileSync(join(fixturesDir, "naptan-stops.csv"), "utf8");
const txcXml = readFileSync(join(fixturesDir, "transxchange-service.xml"), "utf8");
const siriXml = readFileSync(join(fixturesDir, "bods-siri-vm.xml"), "utf8");

/**
 * A body in several chunks, as R2 delivers one.
 *
 * Built here rather than taken from the store, so that the recording and failing doubles further
 * down this file — which implement `get` and nothing else — stream exactly as the plain store
 * does. Deliberately more than one chunk: a fixture delivered whole exercises none of what a
 * streaming reader exists to handle, and a reader that quietly buffered would pass every test in
 * this suite.
 */
function chunked(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  const size = Math.max(1, Math.ceil(bytes.length / 5));
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

/** The same, over bytes that are not text. */
function chunkedBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const size = Math.max(1, Math.ceil(bytes.length / 5));
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

/**
 * Wraps the in-memory object store in the R2 binding shape the Worker expects.
 *
 * `body` as well as `text()`, because the serving reads take the stream: a double that offered
 * only `text()` would send every read down the buffered fallback and this whole suite would pass
 * without once exercising the path production uses. The stream is chunked rather than enqueued
 * whole for the same reason — `InMemoryObjectStore.getStream` splits it, so a line split across a
 * boundary and a multi-byte character on one are both exercised by ordinary fixtures.
 */
function bucketFrom(store: InMemoryObjectStore): R2BucketLike {
  return {
    async get(key) {
      const value = await store.get(key);
      if (value !== null) {
        return {
          text: async () => value,
          body: chunked(value),
          arrayBuffer: async () => new TextEncoder().encode(value).slice().buffer as ArrayBuffer,
        };
      }
      /*
       * And the objects that are not text: the binary trip shards a journey plan reads.
       *
       * Checked second, and through a method a double may not have, because several tests here
       * hand in a hand-rolled store with only `get`, `put`, `delete` and `list` — a bucket that
       * demanded `getBytes` would turn each of those into a 500 and claim the endpoint was
       * broken.
       */
      const bytes = typeof store.getBytes === "function" ? await store.getBytes(key) : null;
      if (bytes === null) return null;
      return {
        text: async () => new TextDecoder().decode(bytes),
        body: chunkedBytes(bytes),
        arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
      };
    },
    async put(key, value) {
      if (typeof value === "string") await store.put(key, value);
      else await store.putBytes(key, value);
    },
    async delete(key) {
      await store.delete(key);
    },
    async list(options) {
      const keys = await store.list(options?.prefix ?? "");
      return { objects: keys.map((key) => ({ key })) };
    },
  };
}

async function publishedStore(): Promise<InMemoryObjectStore> {
  const store = new InMemoryObjectStore();
  const armley =
    "450010003,,,,Armley Road,en,Armley Rd,en,,,Armley Road,en,,,,,W,E0035477,Leeds,,,Leeds,en,,,0,U,428500,433900,-1.5600,53.7996,BCT,MKD,PTP,,,,107,2019-01-01T00:00:00,2026-01-15T09:00:00,1,rev,active";
  const network = buildNetwork({
    naptanCsv: `${naptanCsv.trimEnd()}\n${armley}\n`,
    transXChangeDocuments: [txcXml],
    retrievedAt: "2026-09-02T06:00:00.000Z",
    serviceDate: "2026-09-02",
  });
  await publishNetwork(store, network, { version: "v1" });
  // The edge reads shards, never the national datasets, so a fixture that publishes only the
  // latter would test a world the Worker no longer lives in.
  await publishNetworkShards(store, network, { version: "v1" });
  await publishJourneyTiles(store, network, { version: "v1" });
  return store;
}

/** The fixture timetable references a stop the NaPTAN fixture lacks; add it so journeys build. */
function completeNetwork() {
  const armley =
    "450010003,,,,Armley Road,en,Armley Rd,en,,,Armley Road,en,,,,,W,E0035477,Leeds,,,Leeds,en,,,0,U,428500,433900,-1.5600,53.7996,BCT,MKD,PTP,,,,107,2019-01-01T00:00:00,2026-01-15T09:00:00,1,rev,active";
  return buildNetwork({
    naptanCsv: `${naptanCsv.trimEnd()}\n${armley}\n`,
    transXChangeDocuments: [txcXml],
    retrievedAt: "2026-09-02T06:00:00.000Z",
    serviceDate: "2026-09-02",
  });
}

/**
 * Publishes the planner's trips in the shape the pipeline now emits: the pattern, the trip, and
 * its times. The stops come from the pattern, which is the whole point of the format.
 */
async function publishPatternTrips(
  store: InMemoryObjectStore,
  network: ReturnType<typeof completeNetwork>,
): Promise<void> {
  const byShard = new Map<string, string[]>();
  for (const journey of network.journeys) {
    const departures = journey.stopTimes.map((call) =>
      Math.floor(Date.parse(call.scheduledDeparture) / 1000),
    );
    if (!departures.every((seconds) => Number.isFinite(seconds))) continue;
    const pattern = network.patterns.find((candidate) => candidate.id === journey.routePatternId);
    const firstStop = network.stops.find((stop) => stop.id === pattern?.stopSequence[0]);
    if (!firstStop) continue;

    const row: PatternTripRow = { p: journey.routePatternId, j: journey.tripId, t: departures };
    const dataset = patternTripsDataset(
      journey.serviceDate,
      tileIdFor(firstStop.locationCoordinate, TRIP_TILE_DEGREES),
      tripWindowFor(departures[0]!, journey.serviceDate),
    );
    byShard.set(dataset, [...(byShard.get(dataset) ?? []), JSON.stringify(row)]);
  }
  for (const [dataset, lines] of byShard) {
    await store.put(objectKeyFor(dataset, "v1"), lines.join("\n"));
  }
}

function makeEnv(store: InMemoryObjectStore, overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    ARTIFACTS: bucketFrom(store),
    BODS_API_KEY: "test-key",
    TFL_APP_KEY: "test-app-key",
    VEHICLE_SALT_SECRET: "test-secret",
    PUBLIC_BASE_URL: "https://busstops.example",
    ...overrides,
  };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.busstops.example${path}`, { method: "GET", headers });
}

const ctx = { waitUntil: () => {} };

beforeEach(() => {
  resetWorkerState();
});

describe("router", () => {
  it("matches literal and parameterised paths", () => {
    const router = new Router<unknown, unknown>();
    const handler = () => new Response("ok");
    router.get("/v1/stops/:id", handler);

    expect(router.match("GET", "/v1/stops/450010001")?.params.id).toBe("450010001");
    expect(router.match("GET", "/v1/stops")).toBeNull();
    expect(router.match("POST", "/v1/stops/1")).toBeNull();
  });

  it("decodes path parameters", () => {
    const router = new Router<unknown, unknown>();
    router.get("/v1/search/:q", () => new Response("ok"));
    expect(router.match("GET", "/v1/search/Oxford%20Circus")?.params.q).toBe("Oxford Circus");
  });
});

describe("security", () => {
  it("sets the documented security headers on every response", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/sources/health"), makeEnv(store), ctx);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("builds a CSP that keeps the browser away from data providers", () => {
    const csp = contentSecurityPolicy("https://tiles.example");
    expect(csp).toContain("connect-src 'self' https://tiles.example");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("only returns CORS headers for an allowlisted origin", () => {
    expect(corsHeaders("https://evil.example", ["https://busstops.example"])).toEqual({});
    expect(corsHeaders("https://busstops.example", ["https://busstops.example"])).toMatchObject({
      "Access-Control-Allow-Origin": "https://busstops.example",
    });
  });

  it("rejects non-GET methods", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      new Request("https://api.busstops.example/v1/map", { method: "POST" }),
      makeEnv(store),
      ctx,
    );
    expect(response.status).toBe(405);
  });

  it("never includes a provider key in an error body", async () => {
    const response = errorResponse("internal", "Something went wrong handling this request.", 500);
    const body = await response.text();
    expect(body).not.toContain("test-key");
    expect(body).not.toContain("app_key");
  });
});

describe("rate limiting", () => {
  it("allows requests up to the limit then rejects with a retry hint", () => {
    const limiter = new RateLimiter({ limit: 3, windowSeconds: 60 });
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("a", 0).allowed).toBe(true);

    const blocked = limiter.check("a", 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets after the window and keeps clients independent", () => {
    const limiter = new RateLimiter({ limit: 1, windowSeconds: 60 });
    limiter.check("a", 0);
    expect(limiter.check("a", 0).allowed).toBe(false);
    expect(limiter.check("b", 0).allowed).toBe(true);
    expect(limiter.check("a", 61_000).allowed).toBe(true);
  });

  it("derives a client key without setting a cookie", () => {
    expect(clientKeyFor(get("/", { "CF-Connecting-IP": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientKeyFor(get("/", { "X-Forwarded-For": "203.0.113.9, 10.0.0.1" }))).toBe(
      "203.0.113.9",
    );
    expect(clientKeyFor(get("/"))).toBe("unknown");
  });
});

describe("GET /v1/map", () => {
  it("rejects a missing or malformed bbox", async () => {
    const store = await publishedStore();
    const env = makeEnv(store);
    expect((await worker.fetch(get("/v1/map?zoom=14"), env, ctx)).status).toBe(400);
    expect((await worker.fetch(get("/v1/map?bbox=1,2,3&zoom=14"), env, ctx)).status).toBe(400);
    expect((await worker.fetch(get("/v1/map?bbox=a,b,c,d&zoom=14"), env, ctx)).status).toBe(400);
  });

  it("refuses a bounding box larger than the national cap", async () => {
    const store = await publishedStore();
    // The whole of England: exactly what must never be fetched per browser.
    const response = await worker.fetch(
      get("/v1/map?bbox=-6.5,49.8,2.1,55.9&zoom=10"),
      makeEnv(store),
      ctx,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bbox_too_large");
  });

  it("refuses a zoom below the national floor", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get(`/v1/map?bbox=-1.6,53.7,-1.5,53.85&zoom=${MAP_QUERY_LIMITS.minZoom - 1}`),
      makeEnv(store),
      ctx,
    );
    expect(response.status).toBe(400);
  });

  /*
   * Run 62 measured this one on the deployment: `projectionUsed=true`, every returned stop
   * carrying its route list, and `degraded true (stop_routes_budget)` beside it. The projection
   * reports `truncated` when the box holds more stops than the map draws, which is a statement
   * about how many markers came back and not about whether their labels are trustworthy — the
   * names arrive on the same row as the stop. Reading one as the other made every dense viewport
   * call its own labels unreliable.
   */
  it("does not call its labels degraded merely because it drew the stops it can draw", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/map?bbox=-1.6,53.7,-1.5,53.85&zoom=14"),
      makeEnv(store),
      ctx,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: {
        degraded: boolean;
        degradationReason: string | null;
        stops: Array<{ routePublicNames: string[] }>;
      };
      meta: { diagnostics?: { artifact?: { projectionUsed?: boolean } } };
    };

    expect(body.meta.diagnostics?.artifact?.projectionUsed).toBe(true);
    expect(body.data.degradationReason).not.toBe("stop_routes_budget");
    expect(body.data.degraded).toBe(false);
  });

  it("returns stops for a valid viewport with a contract-valid envelope", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/map?bbox=-1.6,53.7,-1.5,53.85&zoom=14"),
      makeEnv(store),
      ctx,
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    const parsed = MapResponseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    expect(parsed.data!.data.stops.length).toBeGreaterThan(0);
    expect(parsed.data!.meta.generatedAt).toBeDefined();
  });

  /*
   * `routePublicNames` was a literal `[]` in the map projection: declared in the contract, read by
   * the marker, and never filled. Nothing asserted it, so the stub survived a deployed check whose
   * whole purpose was to ask this question — it reported "not one stop in the viewport carries a
   * service" and blamed the national timetable for a hard-coded empty array.
   */
  it("tells each stop which services call at it", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/map?bbox=-1.6,53.7,-1.5,53.85&zoom=14"),
      makeEnv(store),
      ctx,
    );
    const body = (await response.json()) as {
      data: { stops: Array<{ id: string; name: string; routePublicNames: string[] }> };
    };

    const network = completeNetwork();
    // What the published network says is true, computed independently of the Worker.
    const expected = new Map<string, Set<string>>();
    for (const pattern of network.patterns) {
      const service = network.services.find((candidate) => candidate.id === pattern.serviceRouteId);
      if (!service) continue;
      for (const stopId of pattern.stopSequence) {
        const names = expected.get(stopId) ?? new Set<string>();
        names.add(service.publicName);
        expected.set(stopId, names);
      }
    }

    const served = body.data.stops.filter((stop) => stop.routePublicNames.length > 0);
    expect(served.length).toBeGreaterThan(0);
    for (const stop of body.data.stops) {
      expect(stop.routePublicNames).toEqual([...(expected.get(stop.id) ?? [])].sort());
    }
  });

  it("includes live vehicles from the viewport feed", async () => {
    const store = await publishedStore();
    const env = makeEnv(store);
    resetWorkerState();
    initialiseWorker(
      env,
      () => new Date("2026-09-02T08:00:05Z"),
      (async () => new Response(siriXml, { status: 200 })) as unknown as typeof fetch,
    );

    const response = await worker.fetch(get("/v1/map?bbox=-1.6,53.7,-1.5,53.85&zoom=14"), env, ctx);
    const body = (await response.json()) as { data: { vehicles: unknown[] } };
    expect(body.data.vehicles.length).toBeGreaterThan(0);
  });

  it("degrades visibly when the live feed fails, instead of inventing vehicles", async () => {
    const store = await publishedStore();
    const env = makeEnv(store);
    resetWorkerState();
    initialiseWorker(
      env,
      () => new Date("2026-09-02T08:00:05Z"),
      (async () => new Response("upstream exploded", { status: 500 })) as unknown as typeof fetch,
    );

    const response = await worker.fetch(get("/v1/map?bbox=-1.6,53.7,-1.5,53.85&zoom=14"), env, ctx);
    const body = (await response.json()) as {
      meta: { degradation: string; coverage: number };
      data: { vehicles: unknown[]; stops: unknown[] };
    };

    expect(body.data.vehicles).toEqual([]);
    // Stops still work: one failing source must never blank the application.
    expect(body.data.stops.length).toBeGreaterThan(0);
    // This Leeds viewport is served only by BODS, so with it down the honest label is that
    // only scheduled data remains — not that some sources are still contributing.
    expect(body.meta.degradation).toBe("scheduled_only");
    expect(body.meta.coverage).toBeLessThan(1);
  });

  it("reports partial sources when one of several contributing sources fails", async () => {
    const store = await publishedStore();
    const env = makeEnv(store);
    resetWorkerState();
    // A viewport spanning the London boundary uses both TfL and BODS; only BODS is asked for
    // vehicles, so a BODS failure leaves TfL still contributing.
    initialiseWorker(
      env,
      () => new Date("2026-09-02T08:00:05Z"),
      (async () => new Response("upstream exploded", { status: 500 })) as unknown as typeof fetch,
    );

    const response = await worker.fetch(get("/v1/map?bbox=-0.6,51.2,0.4,51.8&zoom=12"), env, ctx);
    const body = (await response.json()) as { meta: { degradation: string } };
    expect(body.meta.degradation).toBe("partial_sources");
  });

  it("stops live polling and reports safe mode in critical governor state", async () => {
    const store = await publishedStore();
    const env = makeEnv(store, { GOVERNOR_MODE: "critical" });
    resetWorkerState();
    initialiseWorker(
      env,
      () => new Date("2026-09-02T08:00:05Z"),
      (async () => new Response(siriXml, { status: 200 })) as unknown as typeof fetch,
    );

    const response = await worker.fetch(get("/v1/map?bbox=-1.6,53.7,-1.5,53.85&zoom=14"), env, ctx);
    const body = (await response.json()) as {
      meta: { degradation: string; governorState: string };
      data: { vehicles: unknown[]; stops: unknown[] };
    };

    expect(body.data.vehicles).toEqual([]);
    expect(body.meta.degradation).toBe("safe_mode");
    expect(body.meta.governorState).toBe("critical");
    // Static network still served: safe mode preserves the core experience.
    expect(body.data.stops.length).toBeGreaterThan(0);
  });

  it("honours the live-vehicles kill switch without redeploying", async () => {
    const store = await publishedStore();
    const env = makeEnv(store, { FEATURE_FLAGS_JSON: '{"liveVehicles":false}' });
    resetWorkerState();
    initialiseWorker(
      env,
      () => new Date("2026-09-02T08:00:05Z"),
      (async () => new Response(siriXml, { status: 200 })) as unknown as typeof fetch,
    );

    const response = await worker.fetch(get("/v1/map?bbox=-1.6,53.7,-1.5,53.85&zoom=14"), env, ctx);
    const body = (await response.json()) as { data: { vehicles: unknown[] } };
    expect(body.data.vehicles).toEqual([]);
  });

  it("caps the number of stops returned and says it truncated", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/map?bbox=-1.6,53.7,-1.5,53.85&zoom=14"),
      makeEnv(store),
      ctx,
    );
    const body = (await response.json()) as {
      data: { stops: unknown[]; truncated: { stops: boolean } };
    };
    expect(body.data.stops.length).toBeLessThanOrEqual(MAP_QUERY_LIMITS.maxStops);
    expect(typeof body.data.truncated.stops).toBe("boolean");
  });

  it("sets a cache-control header so identical viewports are not refetched", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/map?bbox=-1.6,53.7,-1.5,53.85&zoom=14"),
      makeEnv(store),
      ctx,
    );
    expect(response.headers.get("Cache-Control")).toMatch(/max-age=\d+/);
    expect(response.headers.get("Cache-Control")).toMatch(/stale-while-revalidate/);
  });
});

describe("GET /v1/stops/:id", () => {
  it("returns a stop by ATCO code", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/stops/450010001"), makeEnv(store), ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { stop: { atcoCode: string } } };
    expect(body.data.stop.atcoCode).toBe("450010001");
  });

  it("lists the routes that actually call at the stop", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/stops/450010001"), makeEnv(store), ctx);
    const body = (await response.json()) as {
      data: { routes: Array<{ publicName: string; operatorName: string }> };
    };
    expect(body.data.routes.length).toBeGreaterThan(0);
    // Each route carries the operator's name, not just an id the reader cannot use.
    expect(body.data.routes[0]!.operatorName).not.toBe("");
  });

  /*
   * Named from the departures, not from a scan of the tiles around the stop.
   *
   * The handler used to ask "which patterns call here" of the pattern tiles, geographically, before
   * reading any departures — and the densest stops have the largest tiles while needing that
   * question asked the least, because their departures name their patterns outright. Stop
   * `1800EB06161` in Manchester answered Cloudflare's error page on every deployed run from 89 to
   * 94, dying on exactly that read. So this asserts what the board must still produce after the
   * reorder: a route list where every entry is something a reader can actually follow.
   */
  it("names every route it lists with something a reader can follow", async () => {
    const store = await publishedStore();
    const withRows = await worker.fetch(get("/v1/stops/450010001"), makeEnv(store), ctx);
    const body = (await withRows.json()) as {
      meta: { diagnostics?: Record<string, unknown> };
      data: {
        routes: Array<{ id: string; publicName: string; operatorName: string }>;
        departures: unknown[];
      };
    };
    expect(withRows.status).toBe(200);
    expect(body.data.routes.length).toBeGreaterThan(0);
    // Every route is something a reader can follow: a name, an operator and an id that links.
    for (const route of body.data.routes) {
      expect(route.publicName).not.toBe("");
      expect(route.id).not.toBe("");
      expect(route.operatorName).not.toBe("");
    }

    // The two reads behind this — targeted by id, and geographic when there are no ids to use —
    // are asserted to agree in isolate-memory.test.ts, where a reader can be asked each directly.
  });

  it("returns 404 for an unknown stop", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/stops/000000000"), makeEnv(store), ctx);
    expect(response.status).toBe(404);
  });

  it("reports upstream unavailable when nothing has been published yet", async () => {
    const response = await worker.fetch(
      get("/v1/stops/450010001"),
      makeEnv(new InMemoryObjectStore()),
      ctx,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("degrades the map rather than erroring when nothing has been published", async () => {
    /*
     * The first real preview deploy answered 500 here, before any artifact existed. An empty
     * bucket is a normal state — it is what every deployment looks like until the first pipeline
     * run finishes — and the specification requires graceful degradation, so the map must answer
     * with no stops and say so, not fail.
     */
    const response = await worker.fetch(
      get("/v1/map?bbox=-2.26,53.46,-2.21,53.50&zoom=15"),
      makeEnv(new InMemoryObjectStore()),
      ctx,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { stops: unknown[] };
      meta: { degradation: string };
    };
    expect(body.data.stops).toEqual([]);
    expect(body.meta.degradation).not.toBe("normal");
  });

  /*
   * What a stop with nothing due has to open to say which routes serve it.
   *
   * It opened a pattern-index tile on the geographic grid, because its own departures named no
   * patterns to ask for by id. `boxAround` is 1,500 metres against an eighth-of-a-degree grid, so
   * that is one tile, and the deployed cold ledger measured a Manchester board decoding 2.03 MiB
   * of one to produce a list of route names. The byte budget could not help: it is checked
   * between tiles and there is only ever one.
   *
   * About which objects are opened, not about how long anything took — CI time is not Cloudflare
   * CPU. A board that goes back to the geographic read fails here.
   */
  it("looks a quiet stop's services up directly instead of scanning the patterns around it", async () => {
    const store = await publishedStore();
    const reads: string[] = [];
    const recording = {
      get: async (key: string) => {
        reads.push(key);
        return store.get(key);
      },
      put: (key: string, value: string) => store.put(key, value),
      delete: (key: string) => store.delete(key),
      list: (prefix: string) => store.list(prefix),
    };
    const env = makeEnv(recording as unknown as InMemoryObjectStore);
    resetWorkerState();
    // Late enough that the published timetable has nothing in the board's window.
    initialiseWorker(env, () => new Date("2026-09-03T03:30:00Z"));

    const response = await worker.fetch(get("/v1/stops/450010001"), env, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { departures: unknown[]; routes: Array<{ publicName: string }> };
    };

    // The premise: this really is the quiet path, or the test proves nothing about it.
    expect(body.data.departures.length, "the stop under test has nothing due").toBe(0);
    expect(body.data.routes.length, "and still names the routes that serve it").toBeGreaterThan(0);

    const scanned = reads.filter((key) => key.includes(PATTERN_INDEX_PREFIX));
    const direct = reads.filter((key) => key.includes(STOP_SERVING_ROUTES_PREFIX));
    expect(
      direct.length,
      `the board opened no serving-routes bucket; it read ${String(reads.length)} object(s)`,
    ).toBe(1);
    expect(scanned, `a quiet board opened the pattern index: ${scanned.join(", ")}`).toEqual([]);
    /* And nothing to resolve afterwards: the names came with the ids. */
    expect(reads.filter((key) => key.includes("network/services-bucket/"))).toEqual([]);
    expect(reads.filter((key) => key.includes("network/services/"))).toEqual([]);
    expect(reads.filter((key) => key.includes("network/operators/"))).toEqual([]);
  });

  it("measures the board it serves, weather stage included", async () => {
    /*
     * This endpoint had no ledger until run 68 answered 1102 for it and there was nothing to
     * read: no stage times, no residency, and no breadcrumb for the next request to carry out.
     * A healthy board's stage breakdown is the baseline a failing one is read against, so it has
     * to be present when the endpoint works, not only asserted when it does not.
     */
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/stops/450010001"), makeEnv(store), ctx);
    const body = (await response.json()) as {
      meta: {
        diagnostics?: {
          stages?: Record<string, number>;
          residency?: { requestsServed: number };
        };
      };
    };
    const diagnostics = body.meta.diagnostics;
    expect(diagnostics).toBeDefined();
    const stages = Object.keys(diagnostics?.stages ?? {});
    expect(stages).toEqual(expect.arrayContaining(["live", "weather"]));
    /*
     * And however it found out which routes serve this stop. There are three legitimate paths, in
     * descending order of what they cost: the enriched index names them outright, the id index
     * names them and the services are resolved, or the patterns around the stop are read. A board
     * that reports none of the three has skipped the question.
     */
    expect(
      stages.includes("serving-routes") ||
        stages.includes("stop-services") ||
        stages.includes("patterns"),
      `the board reported no route lookup at all: ${stages.join(", ")}`,
    ).toBe(true);
    expect(diagnostics?.residency?.requestsServed).toBeGreaterThan(0);
  });
});

describe("the breadcrumb a killed request leaves in the isolate", () => {
  /*
   * The instrument's own failure mode, which matters more than the instrument.
   *
   * A handler that returns early — 404, 400, 503 — used to leave its breadcrumb set, because the
   * breadcrumb was only cleared by the residency callback at the *end* of the happy path. The
   * next request then carried that breadcrumb out and the verifier printed "a previous request
   * DID NOT FINISH" for a request that had answered a 404 perfectly well. A false death is worse
   * than no instrument: it is indistinguishable from the thing being hunted, and it would have
   * sent the 1102 investigation after a phantom.
   */
  it("says nothing about a request that answered a 404", async () => {
    const store = await publishedStore();
    const env = makeEnv(store);

    // Route detail returns early here: the id resolves to no route, well before residency ends.
    const missing = await worker.fetch(get("/v1/routes/does-not-exist"), env, ctx);
    expect(missing.status).toBe(404);

    const next = await worker.fetch(get("/v1/stops/450010001"), env, ctx);
    const body = (await next.json()) as {
      meta: { diagnostics?: { artifact?: Record<string, unknown> } };
    };
    expect(body.meta.diagnostics?.artifact?.diedPhase).toBeUndefined();
  });

  it("says nothing about a request that answered normally", async () => {
    const store = await publishedStore();
    const env = makeEnv(store);

    await worker.fetch(get("/v1/nearby?lat=53.7996&lon=-1.56&radius=800"), env, ctx);
    const next = await worker.fetch(get("/v1/stops/450010001"), env, ctx);
    const body = (await next.json()) as {
      meta: { diagnostics?: { artifact?: Record<string, unknown> } };
    };
    expect(body.meta.diagnostics?.artifact?.diedPhase).toBeUndefined();
  });
});

describe("cross-origin access from the Pages app", () => {
  /*
   * The web app is served from Cloudflare Pages and calls this Worker on a different origin, so
   * the browser will refuse every response that does not carry CORS headers naming that exact
   * origin. Nothing else in the suite exercises that path, and getting it wrong produces an app
   * whose every request fails in the browser while every server-side test passes.
   */
  const PAGES_ORIGIN = "https://preview.busstops.pages.dev";

  it("answers a preflight from the Pages origin", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      new Request("https://api.busstops.example/v1/sources/health", {
        method: "OPTIONS",
        headers: { Origin: PAGES_ORIGIN, "Access-Control-Request-Method": "GET" },
      }),
      makeEnv(store, { PUBLIC_BASE_URL: PAGES_ORIGIN }),
      ctx,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(PAGES_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("returns CORS headers on an actual data response, not only the preflight", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/sources/health", { Origin: PAGES_ORIGIN }),
      makeEnv(store, { PUBLIC_BASE_URL: PAGES_ORIGIN }),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(PAGES_ORIGIN);
    // Caches must not serve one origin's response to another.
    expect(response.headers.get("Vary")).toContain("Origin");
  });

  /*
   * The bug: only the success path carried CORS headers. A 404, a 405, a 429 and a 500 were all
   * returned before or outside the block that added them, so the browser refused the response and
   * the app reported `net::ERR_FAILED` — no status, no code, nothing to distinguish a Worker
   * exception from an unreachable API. It is how the deployed live map said "this stop could not
   * be loaded" while the Worker was answering with a perfectly explicit error.
   */
  it.each([
    ["an unknown endpoint", () => get("/v1/does-not-exist", { Origin: PAGES_ORIGIN }), 404],
    [
      "a refused method",
      () =>
        new Request("https://api.busstops.example/v1/sources/health", {
          method: "PUT",
          headers: { Origin: PAGES_ORIGIN },
        }),
      405,
    ],
    ["a bad request", () => get("/v1/map?bbox=nonsense", { Origin: PAGES_ORIGIN }), 400],
  ])("returns CORS headers on %s, so the app can read the error", async (_label, build, status) => {
    const store = await publishedStore();
    const response = await worker.fetch(
      build(),
      makeEnv(store, { PUBLIC_BASE_URL: PAGES_ORIGIN }),
      ctx,
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(PAGES_ORIGIN);
  });

  it("gives no CORS headers to an origin it was not configured for", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/sources/health", { Origin: "https://not-ours.example" }),
      makeEnv(store, { PUBLIC_BASE_URL: PAGES_ORIGIN }),
      ctx,
    );

    // The request still succeeds server-side; the browser is what refuses to hand it over.
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows the Pages origin the deployed configuration actually names", async () => {
    // Cloudflare Pages URLs are deterministic, which is why this can be configured up front.
    const wrangler = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../wrangler.toml"),
      "utf8",
    );
    expect(wrangler).toContain('PUBLIC_BASE_URL = "https://busstops.pages.dev"');
    expect(wrangler).toContain('PUBLIC_BASE_URL = "https://preview.busstops.pages.dev"');
  });
});

describe("one-click unsubscribe", () => {
  it("accepts a GET, which is what a person clicking the link sends", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/unsubscribe?r=abc&t=xyz"),
      makeEnv(store, { UNSUBSCRIBE_SECRET: "s" }),
      ctx,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { status: string } };
    expect(body.data.status).toBe("unsubscribed");
  });

  it("accepts a POST, which is what a mail client's native button sends", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      new Request("https://api.busstops.example/v1/unsubscribe?r=abc&t=xyz", { method: "POST" }),
      makeEnv(store, { UNSUBSCRIBE_SECRET: "s" }),
      ctx,
    );
    expect(response.status).toBe(200);
  });

  it("answers identically whether or not the token was valid", async () => {
    const store = await publishedStore();
    const env = makeEnv(store, { UNSUBSCRIBE_SECRET: "s" });

    const good = (await (
      await worker.fetch(get("/v1/unsubscribe?r=abc&t=correct"), env, ctx)
    ).json()) as { data: { status: string; message: string } };
    const bad = (await (
      await worker.fetch(get("/v1/unsubscribe?r=abc&t=wrong"), env, ctx)
    ).json()) as { data: { status: string; message: string } };

    // No oracle: this endpoint must not reveal whether an address is subscribed.
    expect(bad.data.status).toBe(good.data.status);
    expect(bad.data.message).toBe(good.data.message);
  });

  it("is never cached, so a stale success cannot stand in for a real one", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/unsubscribe?r=abc&t=xyz"),
      makeEnv(store, { UNSUBSCRIBE_SECRET: "s" }),
      ctx,
    );
    expect(response.headers.get("Cache-Control")).toContain("max-age=0");
  });
});

describe("Bus Stops Pro", () => {
  const PRO_PATHS = [
    "/v1/pro/control-tower",
    "/v1/pro/live-operations",
    "/v1/pro/routes",
    "/v1/pro/operators",
    "/v1/pro/congestion",
    "/v1/pro/analytics",
    "/v1/pro/reports",
  ];

  it("serves every Pro endpoint without any authentication", async () => {
    const store = await publishedStore();
    for (const path of PRO_PATHS) {
      const response = await worker.fetch(get(path), makeEnv(store), ctx);
      expect(response.status, path).toBe(200);
      // No credential was sent and none was demanded.
      expect(response.headers.get("WWW-Authenticate")).toBeNull();
    }
  });

  it("labels its data mode on every response, so a viewer never has to guess", async () => {
    const store = await publishedStore();
    for (const path of PRO_PATHS) {
      const response = await worker.fetch(get(path), makeEnv(store), ctx);
      const body = (await response.json()) as {
        data: {
          provenance: { dataMode: string; snapshotDate: string | null; notice: string | null };
        };
      };
      expect(["live", "demo_snapshot", "unavailable"], path).toContain(
        body.data.provenance.dataMode,
      );
      if (body.data.provenance.dataMode === "demo_snapshot") {
        expect(body.data.provenance.snapshotDate, path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(body.data.provenance.notice, path).toMatch(/not live data/i);
      }
    }
  });

  it("falls back to the labelled snapshot when no intelligence artifact exists", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/pro/control-tower"), makeEnv(store), ctx);
    const parsed = ControlTowerResponseSchema.safeParse(
      ((await response.json()) as { data: unknown }).data,
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data!.provenance.dataMode).toBe("demo_snapshot");
  });

  it("uses live analysis in preference to the snapshot once one is published", async () => {
    const store = await publishedStore();
    const artifacts = new ArtifactStore(store);
    await artifacts.publish({
      dataset: "intelligence/incidents",
      version: "v1",
      records: [],
      schemaVersion: "1.0.0",
      minimumRecordCount: 0,
      allowEmpty: true,
    });

    const response = await worker.fetch(get("/v1/pro/control-tower"), makeEnv(store), ctx);
    const body = (await response.json()) as { data: { provenance: { dataMode: string } } };
    // A published run with zero incidents is a real "nothing to report", not a missing run.
    expect(body.data.provenance.dataMode).toBe("live");
  });

  it("publishes the figures the closed window actually measured", async () => {
    /*
     * The other half of the run-67 finding. The pipeline was publishing nothing because no bucket
     * had closed; the edge was showing nothing because `ProService` never read a segment figure
     * at all — it asked the segment-metrics manifest whether it existed and threw the records
     * away, deliberately, because that dataset is national and unbounded. Five of six headline
     * figures were hardcoded `null` on the live path, so fixing the pipeline alone would have
     * changed nothing on screen.
     *
     * The national summary is the small artifact that closes that gap, and this is the assertion
     * that the edge reads it.
     */
    const store = await publishedStore();
    const artifacts = new ArtifactStore(store);
    await artifacts.publish({
      dataset: "intelligence/incidents",
      version: "v1",
      records: [],
      schemaVersion: "1.0.0",
      minimumRecordCount: 0,
      allowEmpty: true,
    });
    await artifacts.publish({
      dataset: "intelligence/network-summary",
      version: "v1",
      records: [
        {
          generatedAt: "2026-09-19T12:20:00.000Z",
          windowStart: "2026-09-19T11:55:00.000Z",
          windowEnd: "2026-09-19T12:05:00.000Z",
          closedAt: "2026-09-19T12:15:00.000Z",
          bucketSeconds: 300,
          latenessGraceSeconds: 600,
          segmentsMeasured: 214,
          closedBuckets: 380,
          suppressedBuckets: 166,
          sampleCount: 1840,
          distinctVehicles: 613,
          distinctRoutes: 88,
          medianTraversalSeconds: 44,
          p90TraversalSeconds: 121,
          medianSpeedMetresPerSecond: 6.4,
          meanMatchConfidence: 0.71,
          coverage: 0.82,
        },
      ],
      schemaVersion: "1.0.0",
      minimumRecordCount: 1,
    });

    const response = await worker.fetch(get("/v1/pro/control-tower"), makeEnv(store), ctx);
    const parsed = ControlTowerResponseSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    expect(parsed.provenance.dataMode).toBe("live");

    const byKey = new Map(parsed.headline.map((entry) => [entry.key, entry]));
    expect(byKey.get("active_vehicles")?.value).toBe(613);
    expect(byKey.get("segments_measured")?.value).toBe(214);
    expect(byKey.get("median_segment_traversal")?.value).toBe(44);

    /*
     * And the window each of them names is the one that was measured, not the one the reader
     * asked for. "last 60 minutes" over a figure from a bucket that closed a quarter of an hour
     * ago claims a currency the pipeline does not have.
     */
    expect(byKey.get("active_vehicles")?.window).toContain("12:05");
    expect(byKey.get("active_vehicles")?.window).not.toContain("last 60 minutes");
    expect(byKey.get("active_vehicles")?.freshnessSeconds).toBeGreaterThan(0);
  });

  it("serves a summary published before closedAt existed, rather than throwing", async () => {
    /*
     * The two deployables ship separately, and this record is their wire format. `closedAt` was
     * added to it after artifacts carrying the older shape were already in the bucket — and the
     * edge parsed it straight into a Date, so the first Pro request after that deploy answered
     * 500 with "Invalid time value" and kept doing so until the next batch ran.
     *
     * It is derivable from the window end and the grace, which is what the batch itself does, so
     * it is derived. This fixture is deliberately the *old* shape.
     */
    const store = await publishedStore();
    const artifacts = new ArtifactStore(store);
    await artifacts.publish({
      dataset: "intelligence/incidents",
      version: "v1",
      records: [],
      schemaVersion: "1.0.0",
      minimumRecordCount: 0,
      allowEmpty: true,
    });
    await artifacts.publish({
      dataset: "intelligence/network-summary",
      version: "v1",
      records: [
        {
          generatedAt: "2026-09-19T12:20:00.000Z",
          windowStart: "2026-09-19T11:55:00.000Z",
          windowEnd: "2026-09-19T12:05:00.000Z",
          // No closedAt: this is what the previous batch version wrote.
          bucketSeconds: 300,
          latenessGraceSeconds: 600,
          segmentsMeasured: 3,
          closedBuckets: 9,
          suppressedBuckets: 6,
          sampleCount: 120,
          distinctVehicles: 44,
          distinctRoutes: 7,
          medianTraversalSeconds: 51,
          p90TraversalSeconds: 130,
          medianSpeedMetresPerSecond: 5.1,
          meanMatchConfidence: 0.7,
          coverage: 0.9,
        },
      ],
      schemaVersion: "1.0.0",
      minimumRecordCount: 1,
    });

    const response = await worker.fetch(get("/v1/pro/control-tower"), makeEnv(store), ctx);
    expect(response.status).toBe(200);
    const parsed = ControlTowerResponseSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    const vehicles = parsed.headline.find((entry) => entry.key === "active_vehicles");
    expect(vehicles?.value).toBe(44);
    // Derived: 12:05 plus the 600-second grace is 12:15.
    expect(vehicles?.window).toContain("settled 12:15");
  });

  it("fills the live control tower, and marks every figure it could not measure", async () => {
    /*
     * The recruiter-demo problem: Pro looked *emptier* in live mode than in demo mode. Once any
     * intelligence artifact exists the page switches to live, where four of the eight headline
     * figures came back null because the stage that would compute them — a comparison against a
     * timetable — does not exist. Four empty cards teach a reader nothing about the product.
     *
     * So the cards carry examples, and each example is marked. The rule that makes this safe is
     * per figure, not per page: a measured figure sitting beside an illustration must still be
     * unambiguously measured, so nothing that came from real observations may carry the flag.
     */
    const store = await publishedStore();
    const artifacts = new ArtifactStore(store);
    await artifacts.publish({
      dataset: "intelligence/incidents",
      version: "v1",
      records: [],
      schemaVersion: "1.0.0",
      minimumRecordCount: 0,
      allowEmpty: true,
    });

    const response = await worker.fetch(get("/v1/pro/control-tower"), makeEnv(store), ctx);
    const parsed = ControlTowerResponseSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    expect(parsed.provenance.dataMode).toBe("live");

    // Every headline card now carries a figure a reader can look at.
    expect(parsed.headline.length).toBeGreaterThanOrEqual(6);
    for (const entry of parsed.headline) {
      expect(entry.value, `${entry.key} has nothing to show`).not.toBeNull();
    }

    /*
     * The four that need a timetable comparison are always marked, whatever else is published:
     * no amount of observation fills them, so they can never become measurements here.
     */
    const marked = new Set(
      parsed.headline.filter((entry) => entry.illustrative).map((entry) => entry.key),
    );
    for (const key of ["network_health", "punctuality", "reliability", "median_delay"]) {
      expect(marked.has(key), `${key} must be marked as an example`).toBe(true);
    }

    /*
     * And the one figure here that IS measured must not be marked. `abnormal_disruptions` is
     * counted from the published incidents, so a badge on it would be a lie in the other
     * direction — telling a reader a real measurement is an example.
     */
    const abnormal = parsed.headline.find((entry) => entry.key === "abnormal_disruptions");
    expect(abnormal?.illustrative).toBe(false);

    // Route attention is populated rather than an empty list reading as "nothing needs attention".
    expect(parsed.routesRequiringAttention.length).toBeGreaterThan(0);
    for (const route of parsed.routesRequiringAttention) {
      expect(route.metric.illustrative).toBe(true);
    }
  });

  it("stops marking a figure as an example the moment it can be measured", async () => {
    /*
     * The other direction, and the one that keeps the badge meaningful. Once a closed window is
     * published, buses observed and the two segment figures are real measurements and must lose
     * the badge — otherwise the mark degrades into decoration that appears on everything and a
     * reader learns to ignore it.
     */
    const store = await publishedStore();
    const artifacts = new ArtifactStore(store);
    await artifacts.publish({
      dataset: "intelligence/incidents",
      version: "v1",
      records: [],
      schemaVersion: "1.0.0",
      minimumRecordCount: 0,
      allowEmpty: true,
    });
    await artifacts.publish({
      dataset: "intelligence/network-summary",
      version: "v1",
      records: [
        {
          generatedAt: "2026-09-19T12:20:00.000Z",
          windowStart: "2026-09-19T11:55:00.000Z",
          windowEnd: "2026-09-19T12:05:00.000Z",
          closedAt: "2026-09-19T12:15:00.000Z",
          bucketSeconds: 300,
          latenessGraceSeconds: 600,
          segmentsMeasured: 214,
          closedBuckets: 380,
          suppressedBuckets: 166,
          sampleCount: 1840,
          distinctVehicles: 613,
          distinctRoutes: 88,
          medianTraversalSeconds: 44,
          p90TraversalSeconds: 121,
          medianSpeedMetresPerSecond: 6.4,
          meanMatchConfidence: 0.71,
          coverage: 0.82,
        },
      ],
      schemaVersion: "1.0.0",
      minimumRecordCount: 1,
    });

    const response = await worker.fetch(get("/v1/pro/control-tower"), makeEnv(store), ctx);
    const parsed = ControlTowerResponseSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    const byKey = new Map(parsed.headline.map((entry) => [entry.key, entry]));

    for (const key of ["active_vehicles", "segments_measured", "median_segment_traversal"]) {
      expect(byKey.get(key)?.illustrative, `${key} is measured and must not be marked`).toBe(false);
    }
    // And the real numbers, not the examples.
    expect(byKey.get("active_vehicles")?.value).toBe(613);
    // The timetable four are still examples, because a summary does not give them a timetable.
    expect(byKey.get("punctuality")?.illustrative).toBe(true);
  });

  it("still tells a reader that no amount of observation will fill these figures", async () => {
    /*
     * This used to assert that punctuality, reliability, delay and network health were
     * *suppressed* with a reason saying the pipeline does not read the timetable. They now carry
     * an example value instead, because four blank cards taught a reader nothing — but the
     * original point must survive the change, and it is the more important half: a reader must
     * not come away thinking more data would fill them.
     *
     * So the guarantee moved rather than went. Each one is marked as an example, and each one's
     * definition still says outright that this pipeline measures road-segment traversals and
     * does not read the timetable.
     */
    const store = await publishedStore();
    const artifacts = new ArtifactStore(store);
    await artifacts.publish({
      dataset: "intelligence/incidents",
      version: "v1",
      records: [],
      schemaVersion: "1.0.0",
      minimumRecordCount: 0,
      allowEmpty: true,
    });

    const response = await worker.fetch(get("/v1/pro/control-tower"), makeEnv(store), ctx);
    const parsed = ControlTowerResponseSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    for (const key of ["punctuality", "reliability", "median_delay"]) {
      const found = parsed.headline.find((entry) => entry.key === key);
      expect(found?.illustrative, key).toBe(true);
      expect(found?.definition, key).toMatch(/does not read the timetable/);
    }
  });

  it("never publishes a figure without its denominator, window and coverage", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/pro/control-tower"), makeEnv(store), ctx);
    const parsed = ControlTowerResponseSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );

    expect(parsed.headline.length).toBeGreaterThan(0);
    for (const metric of parsed.headline) {
      expect(metric.definition.length).toBeGreaterThan(20);
      expect(metric.window.length).toBeGreaterThan(0);
      expect(metric.coverage).toBeGreaterThanOrEqual(0);
      if (metric.suppressed) {
        expect(metric.value).toBeNull();
        expect(metric.suppressionReason).not.toBeNull();
      }
    }
  });

  it("keeps the delay-burden and abnormality rankings distinct", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/pro/control-tower"), makeEnv(store), ctx);
    const parsed = ControlTowerResponseSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );

    expect(parsed.biggestDelayBurden.every((item) => item.surfacedBy === "delay_burden")).toBe(
      true,
    );
    expect(parsed.mostAbnormal.every((item) => item.surfacedBy === "abnormality")).toBe(true);
  });

  it("suppresses an operator that cannot fairly be compared, with a reason", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/pro/operators"), makeEnv(store), ctx);
    const parsed = OperatorsResponseSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );

    const ineligible = parsed.scorecards.filter((card) => !card.rankingEligible);
    expect(ineligible.length).toBeGreaterThan(0);
    for (const card of ineligible) {
      expect(card.rankingIneligibleReason).not.toBeNull();
    }

    // Raw and adjusted are always published together; neither may appear alone.
    for (const card of parsed.scorecards) {
      expect(card.raw.length).toBeGreaterThan(0);
      expect(card.contextAdjusted.length).toBeGreaterThan(0);
    }
  });

  it("separates biggest delays from most abnormal congestion", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/pro/congestion"), makeEnv(store), ctx);
    const parsed = CongestionResponseSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );

    expect(parsed.biggestDelays.length).toBeGreaterThan(1);
    expect(parsed.mostAbnormal.length).toBeGreaterThan(1);

    // The same segment may legitimately top both — a big jam on a road that is rarely jammed is
    // both. What must differ is the ordering, because the two lists rank on different things.
    expect(parsed.biggestDelays.map((item) => item.segmentId)).not.toEqual(
      parsed.mostAbnormal.map((item) => item.segmentId),
    );

    // Biggest delays descend by excess time; most abnormal ascend by how often it happens.
    const excess = parsed.biggestDelays.map((item) => item.excessVehicleMinutes ?? 0);
    expect([...excess].sort((a, b) => b - a)).toEqual(excess);
    const frequency = parsed.mostAbnormal.map((item) => item.occurrenceFrequency ?? 1);
    expect([...frequency].sort((a, b) => a - b)).toEqual(frequency);

    expect(parsed.causationNotice).toMatch(/not a demonstrated cause/i);
  });

  it("keeps association wording on the analytics sections that need it", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/pro/analytics"), makeEnv(store), ctx);
    const body = (await response.json()) as {
      data: {
        sections: Array<{ key: string; requiredWording: string | null }>;
        exportNotice: string;
      };
    };

    const weather = body.data.sections.find((section) => section.key === "weather_sensitivity");
    expect(weather?.requiredWording).toMatch(/association, not a demonstrated cause/i);

    const flood = body.data.sections.find((section) => section.key === "flood_susceptibility");
    expect(flood?.requiredWording).toMatch(/Only the Environment Agency/);

    const speed = body.data.sections.find((section) => section.key === "speed_anomalies");
    expect(speed?.requiredWording).toMatch(/not statements about any driver/i);

    expect(body.data.exportNotice).toMatch(/Raw vehicle positions are never exported/);
  });

  it("rejects an unknown report period", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/pro/reports?period=hourly"), makeEnv(store), ctx);
    expect(response.status).toBe(400);
  });

  it("bounds the requested window rather than scanning unbounded history", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/pro/control-tower?window=999999999"),
      makeEnv(store),
      ctx,
    );
    const body = (await response.json()) as { data: { scope: { windowMinutes: number } } };
    expect(body.data.scope.windowMinutes).toBeLessThanOrEqual(10_080);
  });
});

describe("GET /v1/journeys", () => {
  it("rejects a request missing either endpoint", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/journeys?fromLat=53.79&fromLon=-1.54"),
      makeEnv(store),
      ctx,
    );
    expect(response.status).toBe(400);
  });

  it("rejects a point outside England rather than planning from it", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/journeys?fromLat=48.85&fromLon=2.35&toLat=53.79&toLon=-1.54"),
      makeEnv(store),
      ctx,
    );
    expect(response.status).toBe(400);
  });

  it("refuses a cross-country request instead of attempting it", async () => {
    const store = await publishedStore();
    await publishJourneyTiles(store, completeNetwork(), { version: "v1" });

    const response = await worker.fetch(
      get("/v1/journeys?fromLat=50.4&fromLon=-4.1&toLat=54.9&toLon=-1.6"),
      makeEnv(store),
      ctx,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { unavailableReason: string | null } };
    expect(body.data.unavailableReason).toMatch(/too far apart/i);
  });

  it("says no timetable is published rather than returning an empty plan silently", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/journeys?fromLat=53.795&fromLon=-1.545&toLat=53.80&toLon=-1.56"),
      makeEnv(store),
      ctx,
    );
    const parsed = JourneyPlanResponseSchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data!.data.unavailableReason).not.toBeNull();
  });

  /*
   * The failure this guard exists for, reconstructed.
   *
   * The trip grid moved from half a degree to a quarter. The Worker asked for Leeds at `215_-7`,
   * the artifact held it at `107_-4`, three shards came back absent, and the planner reported
   * "No timetable data is published for this area yet" — of a complete national timetable, a
   * quarter of a mile from where it was looking. An unreadable artifact must not be describable
   * as an empty country.
   */
  it("refuses an artifact stored in a layout it cannot read, rather than calling the area empty", async () => {
    const store = await publishedStore();
    const network = completeNetwork();
    await publishPatternTrips(store, network);

    // Republish the index declaring the grid this reader no longer uses. Written through the
    // artifact store rather than over the object, so the manifest's own content hash stays honest
    // and the Worker reads it exactly as it would read a real publish.
    const artifacts = new ArtifactStore(store);
    const current = await artifacts.readCurrent<NetworkIndexRecord>(SHARDED.index);
    const record = current.records[0]!;
    await artifacts.publish<NetworkIndexRecord>({
      dataset: SHARDED.index,
      version: `${record.version}-halfdegree`,
      records: [{ ...record, layout: { ...currentArtifactLayout(), tripTileDegrees: 0.5 } }],
      schemaVersion: current.manifest!.schemaVersion,
      minimumRecordCount: 1,
    });

    resetWorkerState();
    const response = await worker.fetch(
      get("/v1/journeys?fromLat=53.795&fromLon=-1.545&toLat=53.80&toLon=-1.56"),
      makeEnv(store),
      ctx,
    );
    const body = (await response.json()) as {
      data: {
        options: unknown[];
        unavailableReason: string | null;
        diagnostics?: { code: string; layout: string; shardsMissing: number };
      };
    };

    expect(body.data.options).toEqual([]);
    expect(body.data.diagnostics?.code).toBe("artifact_format_mismatch");
    expect(body.data.diagnostics?.layout).toBe("mismatch");
    // Refused before a single shard was asked for: it never went looking in the wrong place.
    expect(body.data.diagnostics?.shardsMissing).toBe(0);
    expect(body.data.unavailableReason).toContain("layout this server cannot read");
    expect(body.data.unavailableReason).not.toContain("No timetable data is published");
  });

  it("plans a journey once the pattern trips are published", async () => {
    const store = await publishedStore();
    const network = completeNetwork();
    await publishPatternTrips(store, network);

    // Plan between the ends of a real published pattern, so there is a journey to find.
    const pattern = network.patterns[0]!;
    const boardingStop = network.stops.find((stop) => stop.id === pattern.stopSequence[0])!;
    const alightingStop = network.stops.find(
      (stop) => stop.id === pattern.stopSequence[pattern.stopSequence.length - 1],
    )!;
    const departAt =
      (Date.parse(network.journeys[0]!.stopTimes[0]!.scheduledDeparture) -
        Date.parse("2026-09-02T00:00:00.000Z")) /
        1000 -
      600;

    const response = await worker.fetch(
      get(
        `/v1/journeys?fromLat=${boardingStop.locationCoordinate.lat}&fromLon=${boardingStop.locationCoordinate.lon}` +
          `&toLat=${alightingStop.locationCoordinate.lat}&toLon=${alightingStop.locationCoordinate.lon}` +
          `&date=2026-09-02&departAt=${Math.round(departAt)}`,
      ),
      makeEnv(store),
      ctx,
    );

    const parsed = JourneyPlanResponseSchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);
    // Guard against the assertions below passing vacuously on an empty plan.
    expect(parsed.data!.data.options.length).toBeGreaterThan(0);

    // Every option must carry an arrival interval, never a bare time.
    for (const option of parsed.data!.data.options) {
      expect(option.arrivalHighSeconds).toBeGreaterThanOrEqual(option.arrivalLowSeconds);
      expect(option.confidence.score).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("GET /v1/vehicles/:ref", () => {
  it("requires a viewport, because live feeds are area-scoped", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/vehicles/abc"), makeEnv(store), ctx);
    expect(response.status).toBe(400);
  });

  it("rejects a viewport larger than the map cap", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/vehicles/abc?bbox=-6,50,2,55"),
      makeEnv(store),
      ctx,
    );
    expect(response.status).toBe(400);
  });

  it("explains that references rotate when a bus cannot be found", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/vehicles/unknown-ref?bbox=-1.6,53.75,-1.5,53.85"),
      makeEnv(store),
      ctx,
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/rotate/i);
  });

  /*
   * The real defect, end to end.
   *
   * This endpoint answered with `pattern.stopSequence.slice(0, 40)` and every entry
   * `passed: false`, so a bus most of the way along its route was shown the stops it had left
   * behind as the stops it was about to call at. The cause was not a missing algorithm — the
   * projection was in the match and the stop offsets were in the pattern geometry, and
   * `computeStopProgress` had joined them in the matching package for months. No code path in this
   * Worker had ever called it.
   *
   * So the test places a real bus on a real published pattern, two thirds of the way along, and
   * asks the endpoint where it is going. The synthetic arithmetic is covered by
   * `stopsAheadWindow`'s own tests; what this adds is that the handler actually uses it.
   */
  describe("stops ahead of a bus most of the way along its route", () => {
    /** The published pattern with the most stops, and the coordinate of one near its end. */
    function patternUnderTest() {
      const network = completeNetwork();
      const stopsById = new Map(network.stops.map((stop) => [stop.id, stop]));
      const pattern = [...network.patterns]
        .filter((candidate) => candidate.stopSequence.every((stopId) => stopsById.has(stopId)))
        .sort((a, b) => b.stopSequence.length - a.stopSequence.length)[0];
      expect(pattern, "the fixture publishes a pattern with resolvable stops").toBeDefined();
      expect(pattern!.stopSequence.length).toBeGreaterThanOrEqual(3);
      return { pattern: pattern!, stopsById, shape: network.shapes.get(pattern!.shapeRef) ?? [] };
    }

    /** A SIRI VM document with one bus, at a coordinate of our choosing. */
    function siriAt(coordinate: { lat: number; lon: number }, bearing: number): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="2.0"><ServiceDelivery>
<ResponseTimestamp>2026-09-02T08:00:00+00:00</ResponseTimestamp>
<VehicleMonitoringDelivery><VehicleActivity>
<RecordedAtTime>2026-09-02T08:00:00+00:00</RecordedAtTime>
<MonitoredVehicleJourney>
<LineRef>72</LineRef><DirectionRef>outbound</DirectionRef>
<DestinationName>Bradford Interchange</DestinationName>
<VehicleLocation><Longitude>${coordinate.lon}</Longitude><Latitude>${coordinate.lat}</Latitude></VehicleLocation>
<Bearing>${bearing}</Bearing>
<VehicleRef>FLEE-30412</VehicleRef>
</MonitoredVehicleJourney>
</VehicleActivity></VehicleMonitoringDelivery></ServiceDelivery></Siri>`;
    }

    async function askAboutTheBus(coordinate: { lat: number; lon: number }, bearing: number) {
      const store = await publishedStore();
      const env = makeEnv(store);
      resetWorkerState();
      initialiseWorker(
        env,
        () => new Date("2026-09-02T08:00:05Z"),
        (async () =>
          new Response(siriAt(coordinate, bearing), { status: 200 })) as unknown as typeof fetch,
      );

      const bbox = "-1.7,53.7,-1.4,53.9";
      // The map is how a passenger finds the rotating reference; the detail call needs it.
      const map = await worker.fetch(get(`/v1/map?bbox=${bbox}&zoom=14`), env, ctx);
      const mapBody = (await map.json()) as { data: { vehicles: Array<{ vehicleRef: string }> } };
      expect(mapBody.data.vehicles.length, "the bus is on the map").toBeGreaterThan(0);
      const ref = mapBody.data.vehicles[0]!.vehicleRef;

      const response = await worker.fetch(
        get(`/v1/vehicles/${encodeURIComponent(ref)}?bbox=${bbox}`),
        env,
        ctx,
      );
      expect(response.status).toBe(200);
      const parsed = VehicleDetailResponseSchema.safeParse(await response.json());
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      return parsed.data!.data;
    }

    /*
     * Which objects one bus tap opens.
     *
     * This endpoint read the pattern tiles of the whole viewport to identify one vehicle — up to
     * three mebibytes of route geometry parsed synchronously, with no ledger, to answer "which
     * route is this bus on". The candidates are the patterns whose shape passes near the bus, and
     * a pattern is written into every tile its shape crosses with its stop sequence, its stop
     * distances and its shape all travelling with it, so the tiles around the vehicle hold every
     * one of them whole.
     *
     * The assertion is about keys rather than milliseconds, because CI time is not Cloudflare CPU:
     * a viewport that spans several pattern tiles must not cause several pattern tiles to be read
     * for one bus.
     */
    it("opens only the pattern tiles around the bus, not the viewport's", async () => {
      const { pattern, stopsById, shape } = patternUnderTest();
      const atIndex = Math.max(1, Math.floor((pattern.stopSequence.length - 1) * 0.67));
      const here = stopsById.get(pattern.stopSequence[atIndex]!)!.locationCoordinate;
      const bearing =
        shape.length > 1
          ? Math.round(
              (Math.atan2(
                shape[shape.length - 1]!.lon - shape[0]!.lon,
                shape[shape.length - 1]!.lat - shape[0]!.lat,
              ) *
                180) /
                Math.PI,
            )
          : 0;

      const store = await publishedStore();

      /*
       * A pattern tile a long way from the bus, and the index entry that makes it readable.
       *
       * The fixture publishes one city, so without this there is nothing far away to wrongly open
       * and the assertion would pass against the defect it exists to catch. The tile is valid and
       * holds one pattern of its own; a reader that asks for the viewport's tiles will take it,
       * and a reader that asks for the bus's will not.
       */
      /*
       * Inside the viewport the tap passes, and nowhere near the bus: the whole point is that a
       * reader asking for the viewport's tiles takes it and a reader asking for the bus's does
       * not. A tile outside the viewport would prove nothing, because neither reader would open
       * it.
       */
      const farTile = tileIdFor({ lat: 53.72, lon: -1.45 }, PATTERN_TILE_DEGREES);
      const [indexKey] = await store.list(`data/${SHARDED.index}/`);
      expect(indexKey, "the fixture published a network index").toBeDefined();
      const index = JSON.parse((await store.get(indexKey!))!) as NetworkIndexRecord;
      expect(index.patternTiles).not.toContain(farTile);
      /*
       * Republished rather than overwritten: the reader checks the manifest's content hash and
       * refuses a body that does not match it, which is the integrity guard doing its job and
       * reads from a test as an empty country.
       */
      const rewritten = JSON.stringify({
        ...index,
        patternTiles: [...index.patternTiles, farTile],
      });
      await store.put(indexKey!, rewritten);
      const manifest = JSON.parse((await store.get(manifestKey(SHARDED.index)))!) as {
        contentHash: string;
      };
      await store.put(
        manifestKey(SHARDED.index),
        JSON.stringify({ ...manifest, contentHash: contentHash(rewritten) }),
      );
      await store.put(
        objectKeyFor(patternTileDataset(farTile), index.version),
        [
          JSON.stringify({
            kind: "shape",
            shapeRef: "far-shape",
            points: [
              { lat: 53.97, lon: -1.91 },
              { lat: 53.99, lon: -1.89 },
            ],
          }),
        ].join("\n"),
      );

      /*
       * Delegating rather than proxying: `InMemoryObjectStore` keeps its contents in a private
       * field, and a `Proxy` whose `get` trap hands methods back with the proxy as the receiver
       * makes every one of them throw on that field — which reads from here as a map with no
       * buses on it rather than as a broken harness.
       */
      const reads: string[] = [];
      const recording = {
        get: async (key: string) => {
          reads.push(key);
          return store.get(key);
        },
        put: (key: string, value: string) => store.put(key, value),
        delete: (key: string) => store.delete(key),
        list: (prefix: string) => store.list(prefix),
      };
      const env = makeEnv(recording as unknown as InMemoryObjectStore);
      resetWorkerState();
      initialiseWorker(
        env,
        () => new Date("2026-09-02T08:00:05Z"),
        (async () =>
          new Response(siriAt(here, bearing), { status: 200 })) as unknown as typeof fetch,
      );

      /*
       * A viewport wide enough to cross the pattern grid, which is what the old read opened all
       * of. The tap that follows is about one point inside it.
       */
      const bbox = "-1.7,53.7,-1.4,53.9";
      const map = await worker.fetch(get(`/v1/map?bbox=${bbox}&zoom=14`), env, ctx);
      const mapBody = (await map.json()) as { data: { vehicles: Array<{ vehicleRef: string }> } };
      expect(mapBody.data.vehicles.length, "the bus is on the map").toBeGreaterThan(0);
      const ref = mapBody.data.vehicles[0]!.vehicleRef;

      reads.length = 0;
      const response = await worker.fetch(
        get(`/v1/vehicles/${encodeURIComponent(ref)}?bbox=${bbox}`),
        env,
        ctx,
      );
      expect(response.status).toBe(200);

      const tapped = [...new Set(reads.filter((key) => key.includes(SHARDED.patternTile)))];
      expect(tapped.length, "the tap still reads the pattern tile it needs").toBeGreaterThan(0);
      expect(
        tapped.some((key) => key.includes(farTile)),
        `one tap opened a pattern tile a dozen kilometres away: ${tapped.join(", ")}`,
      ).toBe(false);
    });

    /*
     * The branch that made one operator's omission everybody's error page.
     *
     * `/v1/map` used to read the viewport's pattern geometry whenever any bus in it arrived with
     * no line name, so that the bus could be matched to a route by its shape. A dense city's
     * pattern tile reaches 3,935,975 bytes, a viewport spans several, and `serviceNames` follows
     * them: Cloudflare measured the endpoint at a p95 of 56 milliseconds against a limit of ten,
     * and which requests paid it depended on whether a third party had filled in a field.
     *
     * A fallback that itself exceeds the limit is not a fallback. The bus is drawn without a
     * route label instead, and this asserts the read is gone rather than merely cheaper.
     */
    it("reads no pattern geometry for a map viewport holding an unnamed bus", async () => {
      const unnamed = `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="2.0"><ServiceDelivery>
<ResponseTimestamp>2026-09-02T08:00:00+00:00</ResponseTimestamp>
<VehicleMonitoringDelivery><VehicleActivity>
<RecordedAtTime>2026-09-02T08:00:00+00:00</RecordedAtTime>
<MonitoredVehicleJourney>
<DirectionRef>outbound</DirectionRef>
<DestinationName>Bradford Interchange</DestinationName>
<VehicleLocation><Longitude>-1.5491</Longitude><Latitude>53.7965</Latitude></VehicleLocation>
<Bearing>90</Bearing>
<VehicleRef>FLEE-30412</VehicleRef>
</MonitoredVehicleJourney>
</VehicleActivity></VehicleMonitoringDelivery></ServiceDelivery></Siri>`;

      const store = await publishedStore();
      const reads: string[] = [];
      const recording = {
        get: async (key: string) => {
          reads.push(key);
          return store.get(key);
        },
        put: (key: string, value: string) => store.put(key, value),
        delete: (key: string) => store.delete(key),
        list: (prefix: string) => store.list(prefix),
      };
      const env = makeEnv(recording as unknown as InMemoryObjectStore);
      resetWorkerState();
      initialiseWorker(
        env,
        () => new Date("2026-09-02T08:00:05Z"),
        (async () => new Response(unnamed, { status: 200 })) as unknown as typeof fetch,
      );

      const map = await worker.fetch(get("/v1/map?bbox=-1.7,53.7,-1.4,53.9&zoom=14"), env, ctx);
      expect(map.status).toBe(200);
      const body = (await map.json()) as {
        data: { vehicles: Array<{ routePublicName: string | null; routeId: string | null }> };
      };

      // The bus is on the map, and honestly unlabelled rather than named by a guess.
      expect(body.data.vehicles.length, "the unnamed bus is still drawn").toBeGreaterThan(0);
      expect(body.data.vehicles[0]!.routePublicName).toBeNull();
      expect(body.data.vehicles[0]!.routeId).toBeNull();

      const geometry = reads.filter((key) => key.includes(SHARDED.patternTile));
      expect(geometry, `the map opened pattern geometry: ${geometry.join(", ")}`).toEqual([]);
    });

    /*
     * What the tap leaves behind for every request after it.
     *
     * The deployed trace is what made this specific: thirty-three first-contact requests across
     * five cities answered without a single failure, and the residency each one reported grew
     * only ever after a bus tap — 2.5 MiB after Leeds, 5.5 after Manchester, 8.8 after
     * Birmingham, 11.9 after York, each step matching that city's vehicle decode to within a
     * percent. From there every request with real decoding to do answered with Cloudflare's error
     * page while the cheap ones carried on. The pattern geometry tiles are the largest objects a
     * passenger request opens and a tap wants one pattern out of one of them.
     *
     * So the assertion is about what is resident afterwards, not about time: the tile this
     * request decoded must not still be held when it ends.
     */
    it("does not leave its pattern tile resident for the next request", async () => {
      const { pattern, stopsById, shape } = patternUnderTest();
      const atIndex = Math.max(1, Math.floor((pattern.stopSequence.length - 1) * 0.67));
      const here = stopsById.get(pattern.stopSequence[atIndex]!)!.locationCoordinate;
      const bearing =
        shape.length > 1
          ? Math.round(
              (Math.atan2(
                shape[shape.length - 1]!.lon - shape[0]!.lon,
                shape[shape.length - 1]!.lat - shape[0]!.lat,
              ) *
                180) /
                Math.PI,
            )
          : 0;

      const store = await publishedStore();
      const env = makeEnv(store);
      resetWorkerState();
      initialiseWorker(
        env,
        () => new Date("2026-09-02T08:00:05Z"),
        (async () =>
          new Response(siriAt(here, bearing), { status: 200 })) as unknown as typeof fetch,
      );

      const bbox = "-1.7,53.7,-1.4,53.9";
      const map = await worker.fetch(get(`/v1/map?bbox=${bbox}&zoom=14`), env, ctx);
      const mapBody = (await map.json()) as { data: { vehicles: Array<{ vehicleRef: string }> } };
      const ref = mapBody.data.vehicles[0]!.vehicleRef;

      const response = await worker.fetch(
        get(`/v1/vehicles/${encodeURIComponent(ref)}?bbox=${bbox}`),
        env,
        ctx,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        meta: {
          diagnostics?: {
            families?: { patterns?: { chars: number } };
            residency?: { charsAfter: number };
          };
        };
      };

      const decoded = body.meta.diagnostics?.families?.patterns?.chars ?? 0;
      const residentAfter = body.meta.diagnostics?.residency?.charsAfter ?? 0;
      expect(decoded, "the tap genuinely decoded a pattern tile").toBeGreaterThan(0);
      expect(
        residentAfter,
        `the tap decoded ${String(decoded)} characters of pattern tile and left ` +
          `${String(residentAfter)} resident`,
      ).toBeLessThan(decoded);
    });

    it("does not offer the start of the route as what is coming next", async () => {
      const { pattern, stopsById, shape } = patternUnderTest();
      const lastIndex = pattern.stopSequence.length - 1;
      // Two thirds along, and never the first stop: the point of the test is that it has passed some.
      const atIndex = Math.max(1, Math.floor(lastIndex * 0.67));
      const here = stopsById.get(pattern.stopSequence[atIndex]!)!.locationCoordinate;
      // Along the shape rather than against it, so the match is not rejected on direction.
      const bearing =
        shape.length > 1
          ? Math.round(
              (Math.atan2(
                shape[shape.length - 1]!.lon - shape[0]!.lon,
                shape[shape.length - 1]!.lat - shape[0]!.lat,
              ) *
                180) /
                Math.PI +
                360,
            ) % 360
          : 0;

      const data = await askAboutTheBus(here, bearing);

      /*
       * Asserted rather than tolerated.
       *
       * An earlier version of this accepted any honest state and returned early, which would have
       * passed just as cheerfully against the defect it exists to catch, had the match ever
       * stopped resolving. Verified to reach `ahead` against this fixture — two stops passed, one
       * ahead, 337m along the shape — so a fixture change that breaks the match is worth failing
       * on and looking at, rather than quietly measuring nothing.
       */
      expect(
        data.nextStopsState,
        "the fixture bus should match its pattern; if this changes the match broke, not the window",
      ).toBe("ahead");

      const upcoming = data.nextStops.filter((stop) => !stop.passed);
      expect(upcoming.length, "a matched bus has stops ahead of it").toBeGreaterThan(0);

      // The regression: the bus has passed stops, and they are reported as passed.
      expect(
        data.nextStops.some((stop) => stop.passed),
        "stops behind the bus are marked passed",
      ).toBe(true);

      // And the first thing a passenger is told is genuinely ahead, not stop one of the route.
      expect(upcoming[0]!.stopId).not.toBe(pattern.stopSequence[0]);
      expect(data.vehicle.nextStopId).toBe(upcoming[0]!.stopId);

      // Passed stops all come before unpassed ones: the sequence is still the timetable's order.
      const firstUnpassed = data.nextStops.findIndex((stop) => !stop.passed);
      expect(data.nextStops.slice(0, firstUnpassed).every((stop) => stop.passed)).toBe(true);
      expect(data.nextStops.slice(firstUnpassed).every((stop) => !stop.passed)).toBe(true);

      // The route line is clipped at a real point along the shape, not at zero.
      expect(data.progressAlongShapeMetres).not.toBeNull();
      expect(data.progressAlongShapeMetres!).toBeGreaterThan(0);
    });

    /*
     * The trail, served from the one bucket object the collector writes.
     *
     * `recentTrace` was a literal `[]`. The observations existed all along — the collector
     * publishes every one it accepts — but as the whole national rolling window, and reading that
     * to answer for one bus is the national read a tap must not cost. Collection now also writes 64
     * small buckets at fixed keys and this endpoint reads exactly one of them.
     */
    it("serves the recent observed path from one bucket read", async () => {
      const store = await publishedStore();
      const env = makeEnv(store);
      resetWorkerState();
      /*
       * Real wall-clock time, not the fixture's.
       *
       * The injected clock reaches `LiveService`, which judges the feed's freshness, and not the
       * handler, which uses `new Date()` for the trail's age window. Seeding September timestamps
       * therefore produced a trail seven weeks old and correctly got nothing back — the age filter
       * working, and a test measuring the wrong thing.
       */
      const observedAt = new Date(Date.now() - 120_000);
      initialiseWorker(
        env,
        () => new Date("2026-09-02T08:00:05Z"),
        (async () =>
          new Response(siriAt({ lat: 53.7965, lon: -1.5379 }, 225), {
            status: 200,
          })) as unknown as typeof fetch,
      );

      const bbox = "-1.7,53.7,-1.4,53.9";
      const map = await worker.fetch(get(`/v1/map?bbox=${bbox}&zoom=14`), env, ctx);
      const mapBody = (await map.json()) as { data: { vehicles: Array<{ vehicleRef: string }> } };
      const ref = mapBody.data.vehicles[0]!.vehicleRef;

      // Seeded as the pipeline would write it, through the same helpers both sides share.
      const files = buildRecentTraceBuckets(
        [
          { vehicleRef: ref, observedAt: observedAt.toISOString(), lat: 53.794, lon: -1.541 },
          {
            vehicleRef: ref,
            observedAt: new Date(observedAt.getTime() + 120_000).toISOString(),
            lat: 53.7955,
            lon: -1.5395,
          },
        ],
        new Date(),
      );
      for (const [key, body] of files) await store.put(key, body);

      const response = await worker.fetch(
        get(`/v1/vehicles/${encodeURIComponent(ref)}?bbox=${bbox}`),
        env,
        ctx,
      );
      const parsed = VehicleDetailResponseSchema.safeParse(await response.json());
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);

      const trace = parsed.data!.data.recentTrace;
      expect(trace.length, "both observations are served").toBe(2);
      // Oldest first, so the drawn line runs the way the bus travelled.
      expect(Date.parse(trace[0]!.observedAt)).toBeLessThan(Date.parse(trace[1]!.observedAt));
      expect(trace[0]!.coordinate.lat).toBeCloseTo(53.794, 4);
    });

    /* No trail is a normal state, and it must never be invented from the schedule. */
    it("omits the trail when no observations have been stored", async () => {
      const { pattern, stopsById } = patternUnderTest();
      const here = stopsById.get(pattern.stopSequence[0]!)!.locationCoordinate;
      const data = await askAboutTheBus(here, 0);
      expect(data.recentTrace).toEqual([]);
    });

    /*
     * A bus nowhere near any published route must not be given somebody else's stop list. The
     * states are the whole point: "we cannot match it" is a different sentence from "it has no
     * more stops", and both are different from a list.
     */
    it("says it cannot match a bus that is not on any published route", async () => {
      const data = await askAboutTheBus({ lat: 53.72, lon: -1.42 }, 0);
      expect(["unmatched", "progress_unknown"]).toContain(data.nextStopsState);
      expect(data.nextStops).toEqual([]);
      expect(data.scheduledShape).toEqual([]);
      expect(data.progressAlongShapeMetres).toBeNull();
      expect(data.vehicle.nextStopId).toBeNull();
    });
  });
});

describe("GET /v1/routes/:id", () => {
  async function firstRouteId(store: InMemoryObjectStore): Promise<string> {
    const response = await worker.fetch(get("/v1/search?q=leeds"), makeEnv(store), ctx);
    const body = (await response.json()) as {
      data: { results: Array<{ kind: string; id: string }> };
    };
    const route = body.data.results.find((result) => result.kind === "route");
    expect(route).toBeDefined();
    return route!.id;
  }

  it("returns the route with its variants and validates against the contract", async () => {
    const store = await publishedStore();
    const id = await firstRouteId(store);
    const response = await worker.fetch(get(`/v1/routes/${id}`), makeEnv(store), ctx);
    expect(response.status).toBe(200);

    const parsed = RouteDetailResponseSchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data!.data.variants.length).toBeGreaterThan(0);
    expect(parsed.data!.data.variants[0]!.stops.length).toBeGreaterThan(1);
  });

  it("names each variant by where it runs, not by an internal identifier", async () => {
    const store = await publishedStore();
    const id = await firstRouteId(store);
    const response = await worker.fetch(get(`/v1/routes/${id}`), makeEnv(store), ctx);
    const body = (await response.json()) as {
      data: { variants: Array<{ description: string }> };
    };
    expect(body.data.variants[0]!.description).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it("returns 404 for an unknown route", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/routes/00000000-0000-5000-8000-000000000000"),
      makeEnv(store),
      ctx,
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /v1/operators/:id", () => {
  async function firstOperatorId(store: InMemoryObjectStore): Promise<string> {
    const response = await worker.fetch(get("/v1/search?q=first"), makeEnv(store), ctx);
    const body = (await response.json()) as {
      data: { results: Array<{ kind: string; id: string }> };
    };
    return body.data.results.find((result) => result.kind === "operator")?.id ?? "";
  }

  it("publishes no metric it cannot support, and says why", async () => {
    const store = await publishedStore();
    const id = await firstOperatorId(store);
    if (!id) return;

    const response = await worker.fetch(get(`/v1/operators/${id}`), makeEnv(store), ctx);
    const parsed = OperatorDetailResponseSchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);

    for (const metric of parsed.data!.data.metrics) {
      // A suppressed metric must carry null and an explanation, never a placeholder number.
      if (metric.suppressed) {
        expect(metric.value).toBeNull();
        expect(metric.note).not.toBeNull();
      }
    }
  });

  it("refuses to rank an operator without the sample to support it", async () => {
    const store = await publishedStore();
    const id = await firstOperatorId(store);
    if (!id) return;

    const response = await worker.fetch(get(`/v1/operators/${id}`), makeEnv(store), ctx);
    const body = (await response.json()) as {
      data: { rankingEligible: boolean; rankingIneligibleReason: string | null };
    };
    expect(body.data.rankingEligible).toBe(false);
    expect(body.data.rankingIneligibleReason).toMatch(/not enough/i);
  });
});

describe("GET /v1/disruptions", () => {
  it("keeps the two rankings separate rather than merging them into one league table", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/disruptions"), makeEnv(store), ctx);
    const parsed = DisruptionsResponseSchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data!.data).toHaveProperty("byDelayBurden");
    expect(parsed.data!.data).toHaveProperty("byAbnormality");
  });

  it("states what is not covered, so an empty list is not read as nothing being wrong", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/disruptions"), makeEnv(store), ctx);
    const body = (await response.json()) as { data: { uncoveredAreas: string[] } };
    expect(body.data.uncoveredAreas.length).toBeGreaterThan(0);
  });
});

describe("GET /v1/search and /v1/nearby", () => {
  it("finds a stop by name", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/search?q=boar%20lane"), makeEnv(store), ctx);
    const body = await response.json();
    const parsed = SearchResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.data.results[0]?.title).toContain("Boar Lane");
  });

  it("requires a query", async () => {
    const store = await publishedStore();
    expect((await worker.fetch(get("/v1/search?q="), makeEnv(store), ctx)).status).toBe(400);
  });

  it("caps an absurdly long query rather than processing it", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get(`/v1/search?q=${"a".repeat(5000)}`),
      makeEnv(store),
      ctx,
    );
    expect(response.status).toBe(200);
  });

  it("lists nearby stops for a coordinate", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get("/v1/nearby?lat=53.7965&lon=-1.5379&radius=2000"),
      makeEnv(store),
      ctx,
    );
    const body = (await response.json()) as {
      data: { results: Array<{ distanceMetres?: number }> };
    };
    expect(body.data.results.length).toBeGreaterThan(0);
    expect(body.data.results[0]?.distanceMetres).toBeDefined();
  });

  it("requires valid coordinates for nearby", async () => {
    const store = await publishedStore();
    expect((await worker.fetch(get("/v1/nearby?lat=abc&lon=1"), makeEnv(store), ctx)).status).toBe(
      400,
    );
  });
});

describe("GET /v1/sources/health", () => {
  it("reports source health and governor state", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/sources/health"), makeEnv(store), ctx);
    const body = (await response.json()) as { data: { governorState: string; safeMode: boolean } };
    expect(body.data.governorState).toBe("green");
    expect(body.data.safeMode).toBe(false);
  });

  /*
   * Four deployment verifications in a row reported "no sources reported" against a deployment
   * whose live vehicles were working. The clients are built lazily by whichever request first
   * needs one, so a status request that arrived before any map request found an empty map and
   * answered with an empty array — which reads as an outage and was a cold isolate.
   */
  it("names every source this deployment covers, before anything has asked one", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/sources/health"), makeEnv(store), ctx);
    const body = (await response.json()) as {
      data: { sources: Array<{ source: string; coverageArea: string }> };
    };
    const named = body.data.sources.map((source) => source.source);
    expect(named).toContain("bods");
    expect(named).toContain("tfl");
  });
});

describe("which way a journey gets its patterns", () => {
  /*
   * Runs 45, 46 and 47 all refused the same journey on the index path, and run 47 measured why:
   * 91 buckets, 12.23 MiB — the request's whole byte budget — for 112 of 197 patterns. A bucket
   * holds every pattern in England whose id hashes to it, so a corridor reads it almost entirely
   * to discard it. Run 44 planned the same journey from one corridor tile.
   */
  it("reads the corridor's own tiles, never a bucket per pattern, and says which", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(
      get(
        "/v1/journeys?fromLat=53.795&fromLon=-1.548&toLat=53.801&toLon=-1.540&when=2026-09-04T08:00:00.000Z",
      ),
      makeEnv(store),
      ctx,
    );
    const body = (await response.json()) as {
      meta: { diagnostics?: { patternSource?: string; corridorPatternTiles?: number } };
    };
    /*
     * Either geographic path is correct; the hashed one is not. `index-tiles` reads the pattern
     * index filed by where a pattern runs, `tiles` reads the geometry tiles — both are the
     * corridor's own strip of the country. `index-hashed` is the layout that scattered a
     * corridor's patterns across 512 buckets and spent twelve mebibytes resolving half of them.
     */
    expect(["index-tiles", "tiles"]).toContain(body.meta.diagnostics?.patternSource);
    expect(body.meta.diagnostics?.corridorPatternTiles).toBeLessThanOrEqual(4);
  });
});

describe("unknown routes", () => {
  it("returns 404 without revealing anything about the internals", async () => {
    const store = await publishedStore();
    const response = await worker.fetch(get("/v1/../../etc/passwd"), makeEnv(store), ctx);
    expect(response.status).toBe(404);
  });
});

describe("live service helpers", () => {
  it("routes London viewports to TfL and the rest of England to BODS", () => {
    expect(sourcesForBoundingBox({ west: -0.2, south: 51.4, east: -0.1, north: 51.55 })).toEqual([
      "tfl",
    ]);
    expect(sourcesForBoundingBox({ west: -1.6, south: 53.7, east: -1.5, north: 53.85 })).toEqual([
      "bods",
    ]);
    // A viewport spanning the boundary needs both, which is what makes the join national.
    const both = sourcesForBoundingBox({ west: -0.6, south: 51.2, east: 0.4, north: 51.8 });
    expect(both).toContain("tfl");
    expect(both).toContain("bods");
  });

  it("identifies London stop codes", () => {
    expect(isLondonAtcoCode("490008660N")).toBe(true);
    expect(isLondonAtcoCode("940GZZLUASL")).toBe(true);
    expect(isLondonAtcoCode("450010001")).toBe(false);
  });

  it("derives degradation from what actually happened", () => {
    const base = {
      sources: [],
      observedAt: null,
      coverage: 1,
      governorState: "green" as const,
      now: new Date(),
    };
    expect(deriveDegradation(base)).toBe("normal");
    expect(deriveDegradation({ ...base, failedSources: ["bods"] })).toBe("partial_sources");
    expect(deriveDegradation({ ...base, networkPartialCoverage: true })).toBe("partial_sources");
    expect(deriveDegradation({ ...base, governorState: "critical" })).toBe("safe_mode");
    expect(
      deriveDegradation({
        ...base,
        sources: [
          {
            source: "bods",
            coverageArea: "non_london",
            status: "stale",
            lastSuccessfulFetchAt: null,
            lastAttemptAt: null,
            ageSeconds: 900,
            consecutiveFailures: 0,
          },
        ],
      }),
    ).toBe("stale_data");
  });

  it("falls back to scheduled-only when every source is down", () => {
    expect(
      deriveDegradation({
        sources: [
          {
            source: "bods",
            coverageArea: "non_london",
            status: "down",
            lastSuccessfulFetchAt: null,
            lastAttemptAt: null,
            ageSeconds: null,
            consecutiveFailures: 5,
          },
        ],
        observedAt: null,
        coverage: 0,
        governorState: "green",
        now: new Date(),
      }),
    ).toBe("scheduled_only");
  });

  it("lengthens cache TTLs as governor pressure rises", () => {
    expect(cacheTtlSeconds("bods", "amber")).toBeGreaterThan(cacheTtlSeconds("bods", "green"));
    expect(cacheTtlSeconds("bods", "critical")).toBeGreaterThan(cacheTtlSeconds("bods", "red"));
  });

  it("reports the oldest contributing observation as the freshness anchor", () => {
    expect(
      oldestObservedAt([
        { observedAtMs: Date.parse("2026-09-02T08:00:00.000Z") },
        { observedAtMs: Date.parse("2026-09-02T07:58:00.000Z") },
      ]),
    ).toBe("2026-09-02T07:58:00.000Z");
    expect(oldestObservedAt([])).toBeNull();
  });
});

describe("feature flags", () => {
  it("defaults to everything enabled", () => {
    expect(readFeatureFlags({}).liveVehicles).toBe(true);
  });

  it("applies overrides and survives a malformed blob", () => {
    expect(readFeatureFlags({ FEATURE_FLAGS_JSON: '{"proDemo":false}' }).proDemo).toBe(false);
    expect(readFeatureFlags({ FEATURE_FLAGS_JSON: "not json" }).proDemo).toBe(true);
  });
});

describe("R2 binding adapter", () => {
  it("round-trips through the shared ObjectStore interface", async () => {
    const store = new InMemoryObjectStore();
    const binding = new R2BindingStore(bucketFrom(store));

    await binding.put("a/b.json", '{"x":1}');
    expect(await binding.get("a/b.json")).toBe('{"x":1}');
    expect(await binding.list("a/")).toEqual(["a/b.json"]);

    await binding.delete("a/b.json");
    expect(await binding.get("a/b.json")).toBeNull();
  });
});

/*
 * The run 26 mismatch, preserved.
 *
 * On 2026-09-04 at 09:38 UTC, one request from a GitHub runner straight to the BODS datafeed and
 * one request through the deployed Worker were made in the same second, for the same four
 * viewports. BODS answered with 237 vehicles for Leeds, 364 for Manchester, 338 for Birmingham
 * and 233 for Bristol. The deployment answered zero for all four, and said nothing about why.
 *
 * Two separate defects are pinned here, because the second is what made the first so expensive:
 *
 *  1. Given a feed carrying those vehicles, the Worker must publish them — capped, but never
 *     dropped, and never silently.
 *  2. When a viewport genuinely has no buses, the Worker must be able to say which of the four
 *     things happened: the request failed, the feed was empty, everything in it was rejected, or
 *     it was fine. "Zero, unexplained" is the state this build spent a day in.
 */
describe("live vehicles: the run 26 mismatch", () => {
  const AREAS = [
    {
      name: "Leeds",
      bbox: "-1.62,53.75,-1.46,53.84",
      at: { lat: 53.8, lon: -1.54 },
      observed: 237,
    },
    {
      name: "Manchester",
      bbox: "-2.32,53.42,-2.16,53.52",
      at: { lat: 53.48, lon: -2.24 },
      observed: 364,
    },
    {
      name: "Birmingham",
      bbox: "-1.96,52.42,-1.8,52.52",
      at: { lat: 52.48, lon: -1.9 },
      observed: 338,
    },
    {
      name: "Bristol",
      bbox: "-2.66,51.42,-2.5,51.51",
      at: { lat: 51.45, lon: -2.59 },
      observed: 233,
    },
  ];

  const NOW = new Date("2026-09-04T09:38:48.000Z");

  /** A feed of `count` vehicles inside one viewport, recorded a few seconds ago. */
  function feedFor(area: (typeof AREAS)[number]): string {
    const recordedAt = new Date(NOW.getTime() - 6_000).toISOString();
    const activities = Array.from({ length: area.observed }, (_, index) => {
      // Spread them over the box so none lands on an edge and every one is plausibly in England.
      const lat = area.at.lat + ((index % 20) - 10) * 0.001;
      const lon = area.at.lon + ((Math.floor(index / 20) % 20) - 10) * 0.001;
      return `<VehicleActivity>
        <RecordedAtTime>${recordedAt}</RecordedAtTime>
        <MonitoredVehicleJourney>
          <LineRef>${(index % 90) + 1}</LineRef>
          <PublishedLineName>${(index % 90) + 1}</PublishedLineName>
          <OperatorRef>OP${index % 7}</OperatorRef>
          <DestinationName>${area.name} Interchange</DestinationName>
          <VehicleLocation><Longitude>${lon.toFixed(5)}</Longitude><Latitude>${lat.toFixed(5)}</Latitude></VehicleLocation>
          <Bearing>${index % 360}</Bearing>
          <VehicleRef>${area.name.toUpperCase()}-${10000 + index}</VehicleRef>
        </MonitoredVehicleJourney>
      </VehicleActivity>`;
    }).join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="2.0">
  <ServiceDelivery>
    <ResponseTimestamp>${NOW.toISOString()}</ResponseTimestamp>
    <ProducerRef>DepartmentForTransport</ProducerRef>
    <VehicleMonitoringDelivery version="2.0">
      <ResponseTimestamp>${NOW.toISOString()}</ResponseTimestamp>
      ${activities}
    </VehicleMonitoringDelivery>
  </ServiceDelivery>
</Siri>`;
  }

  async function envServing(body: string, status = 200) {
    const store = await publishedStore();
    const env = makeEnv(store);
    resetWorkerState();
    initialiseWorker(
      env,
      () => NOW,
      (async () => new Response(body, { status })) as unknown as typeof fetch,
    );
    return env;
  }

  it.each(AREAS)("publishes the $observed vehicles BODS returned for $name", async (area) => {
    const env = await envServing(feedFor(area));
    const response = await worker.fetch(get(`/v1/map?bbox=${area.bbox}&zoom=14`), env, ctx);
    const body = (await response.json()) as {
      data: { vehicles: unknown[]; truncated: { vehicles: boolean } };
    };

    // The map caps a viewport at MAX_VEHICLES and says so, rather than quietly shipping fewer.
    const expected = Math.min(area.observed, MAP_QUERY_LIMITS.maxVehicles);
    expect(body.data.vehicles.length).toBe(expected);
    expect(body.data.truncated.vehicles).toBe(area.observed > expected);
  });

  it.each(AREAS)("accounts for every one of $name's records in the diagnostics", async (area) => {
    const env = await envServing(feedFor(area));
    const response = await worker.fetch(get(`/v1/diagnostics/live?bbox=${area.bbox}`), env, ctx);
    const body = (await response.json()) as {
      data: {
        vehiclesReturned: number;
        diagnostics: Array<{
          source: string;
          outcome: string;
          accepted: number;
          rawRecords: number;
        }>;
      };
    };

    const bods = body.data.diagnostics.find((entry) => entry.source === "bods")!;
    expect(bods.outcome).toBe("ok");
    expect(bods.accepted).toBe(area.observed);
    expect(bods.rawRecords).toBe(area.observed);
    // The diagnostics count observations, not the capped map payload.
    expect(body.data.vehiclesReturned).toBe(area.observed);
  });

  it.each([
    {
      label: "the request was refused",
      body: "no",
      status: 503,
      outcome: "request_failed",
    },
    {
      label: "the feed was empty",
      body: `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="2.0"><ServiceDelivery>
  <ResponseTimestamp>${NOW.toISOString()}</ResponseTimestamp>
  <VehicleMonitoringDelivery version="2.0"/>
</ServiceDelivery></Siri>`,
      status: 200,
      outcome: "empty_feed",
    },
    {
      label: "every record was too old to use",
      body: `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="2.0"><ServiceDelivery>
  <ResponseTimestamp>${NOW.toISOString()}</ResponseTimestamp>
  <VehicleMonitoringDelivery version="2.0"><VehicleActivity>
    <RecordedAtTime>2026-09-04T08:00:00.000Z</RecordedAtTime>
    <MonitoredVehicleJourney>
      <VehicleLocation><Longitude>-1.54000</Longitude><Latitude>53.80000</Latitude></VehicleLocation>
      <VehicleRef>LEEDS-1</VehicleRef>
    </MonitoredVehicleJourney>
  </VehicleActivity></VehicleMonitoringDelivery>
</ServiceDelivery></Siri>`,
      status: 200,
      outcome: "all_rejected",
    },
  ])("says $label rather than reporting an unexplained zero", async (scenario) => {
    const env = await envServing(scenario.body, scenario.status);
    const response = await worker.fetch(
      get(`/v1/diagnostics/live?bbox=${AREAS[0]!.bbox}`),
      env,
      ctx,
    );
    const body = (await response.json()) as {
      data: { vehiclesReturned: number; diagnostics: Array<{ source: string; outcome: string }> };
    };

    expect(body.data.vehiclesReturned).toBe(0);
    expect(body.data.diagnostics.find((entry) => entry.source === "bods")!.outcome).toBe(
      scenario.outcome,
    );
  });
});

/**
 * The stop board, from published shards to response.
 *
 * The failure this pins is the one that made every stop in England answer "no departures" with a
 * 200 and the word `normal`: a whole-tile read inside a `catch` that returned an empty array. The
 * three cases below are the answers that used to be indistinguishable from one another.
 *
 * Times are relative to the real clock because the stop handler reads `new Date()` rather than an
 * injected one. Pinning a fixed instant here would test a board that is always hours out of its
 * own window, which is how the first version of this test passed nothing at all.
 */
describe("the departure board reads the published index", () => {
  const ATCO = "450010001";
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  function departureRow(minutesFromNow: number, route: string): DepartureRow {
    return {
      s: ATCO,
      t: Math.floor(now.getTime() / 1000) + minutesFromNow * 60,
      r: route,
      d: "Armley Road",
      j: `VJ-${route}-${minutesFromNow}`,
      p: "00000000-0000-5000-8000-000000000002",
      k: 1,
    };
  }

  async function storeWithDepartures(rows: DepartureRow[]): Promise<InMemoryObjectStore> {
    const store = await publishedStore();
    const byShard = new Map<string, DepartureRow[]>();
    for (const row of rows) {
      const dataset = departureShardDataset(today, departureBucketFor(row.s));
      byShard.set(dataset, [...(byShard.get(dataset) ?? []), row]);
    }
    for (const [dataset, shardRows] of byShard) {
      await store.put(objectKeyFor(dataset, "v1"), encodeDepartureShard(today, shardRows));
    }
    return store;
  }

  /*
   * The board with buses on it asks its departures, and that is a measured retreat.
   *
   * The direct lookup is the better answer for every board — one hashed bucket against a
   * pattern-index tile that is megabytes in a city — and this handler asked it on every board for
   * one deployment. The deployment said no: Leeds City Bus Station went from four of four samples
   * answering with three routes named from three service buckets to four of four answering 1102,
   * and Norwich Tombland and Birmingham Coach Station went the same way.
   *
   * The cause is the thing that makes the index better. It names every route that calls at a stop
   * rather than only the ones with a bus due, and an interchange has fifty — which is upwards of
   * thirty-two service buckets, each a subrequest, against the fifty an invocation gets for its
   * index, departure shards, operators, live feed, weather and disruptions as well.
   *
   * So this pins where the line currently sits, and why: a board whose departures name patterns
   * resolves its routes from those, and does not spend a bucket per route in the country. Moving
   * it needs the route's name and operator inside the index itself, which is a change to what is
   * published rather than to what is asked.
   */
  it("resolves a busy board's routes from its departures, not from a bucket per route", async () => {
    const store = await storeWithDepartures([departureRow(6, "72"), departureRow(25, "16")]);
    const reads: string[] = [];
    const recording = {
      get: async (key: string) => {
        reads.push(key);
        return store.get(key);
      },
      put: (key: string, value: string) => store.put(key, value),
      delete: (key: string) => store.delete(key),
      list: (prefix: string) => store.list(prefix),
    };
    const env = makeEnv(recording as unknown as InMemoryObjectStore);
    resetWorkerState();

    const response = await worker.fetch(get(`/v1/stops/${ATCO}`), env, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { departures: unknown[]; routes: Array<{ publicName: string }> };
    };

    // The premise: this is the busy path. With nothing due it is the test above.
    expect(body.data.departures.length, "the stop under test has buses due").toBeGreaterThan(0);
    /*
     * The route list itself is not asserted here. These rows are fabricated with a pattern id the
     * fixture's pattern index does not carry, so the board correctly names no routes from them —
     * which is a property of the fixture, not of the handler. What the route list contains is
     * covered against a published network above; what this test is about is the bill.
     */

    /*
     * The bound that matters, and it is a count of objects rather than of bytes: whatever a board
     * does to name its routes, it must not approach the fifty subrequests an invocation gets.
     */
    const buckets = reads.filter((key) => key.includes("network/services-bucket/"));
    expect(
      buckets.length,
      `a busy board opened ${String(buckets.length)} service bucket(s)`,
    ).toBeLessThan(16);
    expect(reads.filter((key) => key.includes(STOP_SERVICES_PREFIX))).toEqual([]);
  });

  it("shows the rows that are due, in order, with what a board renders", async () => {
    const store = await storeWithDepartures([departureRow(25, "16"), departureRow(6, "72")]);
    const env = makeEnv(store);
    resetWorkerState();

    const response = await worker.fetch(get(`/v1/stops/${ATCO}`), env, ctx);
    const body = (await response.json()) as {
      meta: { coverage: number; degradation: string };
      data: { departures: Array<Record<string, unknown>> };
    };

    expect(response.status).toBe(200);
    const board = body.data.departures;
    expect(board).toHaveLength(2);
    // Soonest first, and every field an arrival board renders a row from.
    expect(board.map((row) => row.serviceRoutePublicName)).toEqual(["72", "16"]);
    for (const row of board) {
      expect(row.destinationName).toBe("Armley Road");
      expect(typeof row.scheduledTime).toBe("string");
      expect(row.liveState).toBe("scheduled_only");
      expect(row.routePatternId).toBe("00000000-0000-5000-8000-000000000002");
    }
  });

  it("never reports our own missing timetable as 'no departures'", async () => {
    /*
     * The recruiter-demo regression, in one test.
     *
     * The national build publishes exactly `[today, tomorrow]` of departure shards, so an
     * artifact more than a day or two old has no shard for today and every stop outside London
     * reads a key that is simply absent. The board showed "No departures in the next hour" —
     * a statement about buses, which a passenger reads as "don't wait here" — when the true
     * statement was about us.
     *
     * Run 73 is the proof that the code was never wrong: a same-day artifact returned real
     * departures at eight stops across England, and the identical code returned none four days
     * later. So the fix is not to the reader; it is to stop the board claiming something it
     * cannot know.
     */
    const store = await publishedStore(); // published network, but no departure shard for today
    resetWorkerState();

    const response = await worker.fetch(get(`/v1/stops/${ATCO}`), makeEnv(store), ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        departures: unknown[];
        timetableCoverage?: { read: number; missing: number; serviceDates: string[] };
      };
    };

    expect(body.data.departures).toHaveLength(0);
    // The shards were asked for and were not there. That is the fact the board needs.
    expect(body.data.timetableCoverage).toBeDefined();
    expect(body.data.timetableCoverage!.read).toBe(0);
    expect(body.data.timetableCoverage!.missing).toBeGreaterThan(0);
    // And it names which days it asked about, so the gap can be described precisely.
    expect(body.data.timetableCoverage!.serviceDates).toContain(today);
  });

  it("says nothing is due only when the timetable is actually there", async () => {
    /*
     * The other half, and the one that stops the fix becoming its own lie: with a shard
     * published for today that genuinely holds nothing inside the window, "no departures" is
     * the correct and useful answer, and the board must still be allowed to say it.
     */
    const store = await storeWithDepartures([departureRow(600, "16")]); // far outside the window
    resetWorkerState();

    const response = await worker.fetch(get(`/v1/stops/${ATCO}`), makeEnv(store), ctx);
    const body = (await response.json()) as {
      data: {
        departures: unknown[];
        timetableCoverage?: { read: number; missing: number };
      };
    };

    expect(body.data.departures).toHaveLength(0);
    // A shard answered, so this is a quiet stop rather than a missing timetable.
    expect(body.data.timetableCoverage!.read).toBeGreaterThan(0);
  });

  it("returns the departures when the timetable for today is published", async () => {
    // The acceptance condition stated plainly: stop exists + future journeys in the index
    // ⇒ the board must not be empty.
    const store = await storeWithDepartures([departureRow(4, "4"), departureRow(11, "16A")]);
    resetWorkerState();

    const response = await worker.fetch(get(`/v1/stops/${ATCO}`), makeEnv(store), ctx);
    const body = (await response.json()) as {
      data: { departures: Array<{ serviceRoutePublicName: string }> };
    };
    expect(body.data.departures.length).toBeGreaterThan(0);
    expect(body.data.departures.map((row) => row.serviceRoutePublicName)).toEqual(["4", "16A"]);
  });

  it("says the timetable could not be read rather than showing an empty board", async () => {
    const store = await storeWithDepartures([departureRow(6, "72")]);
    const bucket = bucketFrom(store);
    // The shard exists and cannot be read: exactly the case the old `catch` turned into silence.
    const env = makeEnv(store, {
      ARTIFACTS: {
        ...bucket,
        get: async (key: string) => {
          if (key.includes("network/departures/")) throw new Error("R2 is unavailable");
          return bucket.get(key);
        },
      } as R2BucketLike,
    });

    resetWorkerState();
    const response = await worker.fetch(get(`/v1/stops/${ATCO}`), env, ctx);
    const body = (await response.json()) as {
      meta: { coverage: number; degradation: string };
      data: { departures: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(body.data.departures).toEqual([]);
    /*
     * Coverage zero and a degraded response. The honest statement is that we cannot say what
     * calls here — not that nothing does — and these two fields are the difference.
     */
    expect(body.meta.coverage).toBe(0);
    expect(body.meta.degradation).not.toBe("normal");
  });

  it("treats a window with no shard as a quiet hour rather than a failure", async () => {
    const store = await publishedStore();
    const env = makeEnv(store);
    resetWorkerState();

    const response = await worker.fetch(get(`/v1/stops/${ATCO}`), env, ctx);
    const body = (await response.json()) as {
      meta: { coverage: number };
      data: { departures: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(body.data.departures).toEqual([]);
    // Not zero: nothing failed, there is simply nothing due.
    expect(body.meta.coverage).toBeGreaterThan(0);
  });
});

/**
 * The serving reads take the stream, proved by taking `text()` away from them.
 *
 * Every one of these objects used to arrive as a single string: `R2BindingStore.get` called
 * `object.text()`, so a pattern tile in a dense city was one three-to-five-megabyte allocation
 * before a line of it had been looked at. Cloudflare's 128 MB ceiling is **per isolate rather
 * than per invocation**, which is why those allocations explain what request sizes could not — an
 * isolate passed fifty-four paced requests and then lost a third of the next fifty, and an
 * 87,543-character `nearby` died at `served=106` while a 5,008,974-character read had passed on
 * the same deployment a minute before.
 *
 * A test that merely asserted the answers would pass just as well against the buffered reads, so
 * this removes the alternative: `text()` throws for every family that was migrated, and the body
 * streams. A read that quietly goes back to buffering fails here, loudly, on the endpoint that
 * did it.
 *
 * The small objects keep `text()` on purpose. A manifest, the index record and the gazetteer are
 * hundreds of bytes to a few hundred kilobytes read once, and a stream parser for those would be
 * cost with no saving — the rule is to stream what is large and line-oriented, not to stream for
 * consistency.
 */
const STREAMED_FAMILIES = [
  "data/network/map-stops/",
  "data/network/patterns-tile/",
  "data/network/pattern-index/",
  "data/network/pattern-trips/",
  "data/network/route-patterns/",
  "data/network/route-tiles/",
  "data/network/stops-tile/",
  "data/network/stop-detail/",
  "data/network/stop-locator/",
  "data/network/stop-services/",
  "data/network/stop-serving-routes/",
  "data/network/search-tile/",
  "data/network/search-prefix/",
  "data/network/departures/",
  "data/network/services/",
  "data/network/operators/",
];

function streamOnlyBucket(store: InMemoryObjectStore, buffered: string[] = []): R2BucketLike {
  const bucket = bucketFrom(store);
  return {
    ...bucket,
    async get(key: string) {
      const value = await store.get(key);
      if (value === null) return null;
      const mustStream =
        STREAMED_FAMILIES.some((family) => key.startsWith(family)) &&
        !buffered.some((allowed) => key.startsWith(allowed));
      return {
        text: async () => {
          if (mustStream) {
            throw new Error(`${key} was read with text(); this family must be streamed`);
          }
          return value;
        },
        body: chunked(value),
      };
    },
  } as R2BucketLike;
}

describe("the serving reads stream their objects", () => {
  const streamed = async (overrides: Partial<WorkerEnv> = {}) => {
    const store = await publishedStore();
    return {
      store,
      env: makeEnv(store, { ARTIFACTS: streamOnlyBucket(store), ...overrides }),
    };
  };

  it("draws a map viewport without buffering a projection tile", async () => {
    const { env } = await streamed();
    resetWorkerState();
    const response = await worker.fetch(
      get("/v1/map?bbox=-1.60,53.78,-1.52,53.82&zoom=15"),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { stops: unknown[] } };
    expect(body.data.stops.length, "a viewport with no stops would prove nothing").toBeGreaterThan(
      0,
    );
  });

  it("answers a stop board without buffering its departure shard or serving-route bucket", async () => {
    /*
     * A shard published for today, because the stop handler reads the real clock: a fixture at a
     * fixed instant is a board permanently outside its own window, which is how an earlier version
     * of this test passed while asserting nothing.
     */
    const atco = "450010001";
    const clock = new Date();
    const today = clock.toISOString().slice(0, 10);
    const store = await publishedStore();
    await store.put(
      objectKeyFor(departureShardDataset(today, departureBucketFor(atco)), "v1"),
      encodeDepartureShard(today, [
        {
          s: atco,
          t: Math.floor(clock.getTime() / 1000) + 6 * 60,
          r: "72",
          d: "Armley Road",
          j: "VJ-72",
          p: "00000000-0000-5000-8000-000000000002",
          k: 1,
        },
      ]),
    );
    const env = makeEnv(store, { ARTIFACTS: streamOnlyBucket(store) });
    resetWorkerState();

    const response = await worker.fetch(get(`/v1/stops/${atco}`), env, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { departures: unknown[]; routes: unknown[]; routesComplete: boolean };
      meta: { degradation: string };
    };
    expect(body.data.departures.length).toBeGreaterThan(0);
    expect(body.data.routes.length).toBeGreaterThan(0);
    /* The streamed read must not quietly turn a bucket it read into an incomplete answer. */
    expect(body.data.routesComplete).toBe(true);
    expect(body.meta.degradation).toBe("normal");
  });

  it("draws a route without buffering its pattern bucket", async () => {
    const { env } = await streamed();
    resetWorkerState();
    const search = await worker.fetch(get("/v1/search?q=leeds"), env, ctx);
    const hits = (await search.json()) as {
      data: { results: Array<{ id: string; kind: string }> };
    };
    const route = hits.data.results.find((hit) => hit.kind === "route");
    expect(route, "the search must find a route, or this proves nothing").toBeDefined();

    const response = await worker.fetch(get(`/v1/routes/${route!.id}`), env, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { variants: Array<{ stops: unknown[] }> };
    };
    expect(body.data.variants.length).toBeGreaterThan(0);
    expect(body.data.variants[0]!.stops.length).toBeGreaterThan(1);
  });

  it("searches and lists what is nearby without buffering a search tile", async () => {
    const { env } = await streamed();
    resetWorkerState();

    const search = await worker.fetch(get("/v1/search?q=armley"), env, ctx);
    expect(search.status).toBe(200);
    const hits = (await search.json()) as { data: { results: unknown[] } };
    expect(hits.data.results.length).toBeGreaterThan(0);

    const nearby = await worker.fetch(get("/v1/nearby?lat=53.7996&lon=-1.56&radius=800"), env, ctx);
    expect(nearby.status).toBe(200);
    const list = (await nearby.json()) as { data: { results: unknown[] } };
    expect(list.data.results.length).toBeGreaterThan(0);
  });

  it("plans a journey without buffering a pattern-trips shard", async () => {
    const store = await publishedStore();
    const network = completeNetwork();
    await publishPatternTrips(store, network);
    const env = makeEnv(store, { ARTIFACTS: streamOnlyBucket(store) });

    const pattern = network.patterns[0]!;
    const boardingStop = network.stops.find((stop) => stop.id === pattern.stopSequence[0])!;
    const alightingStop = network.stops.find(
      (stop) => stop.id === pattern.stopSequence[pattern.stopSequence.length - 1],
    )!;
    const departAt =
      (Date.parse(network.journeys[0]!.stopTimes[0]!.scheduledDeparture) -
        Date.parse("2026-09-02T00:00:00.000Z")) /
        1000 -
      600;

    resetWorkerState();
    const response = await worker.fetch(
      get(
        `/v1/journeys?fromLat=${boardingStop.locationCoordinate.lat}&fromLon=${boardingStop.locationCoordinate.lon}` +
          `&toLat=${alightingStop.locationCoordinate.lat}&toLon=${alightingStop.locationCoordinate.lon}` +
          `&date=2026-09-02&departAt=${Math.round(departAt)}`,
      ),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { options: unknown[] } };
    expect(body.data.options.length).toBeGreaterThan(0);
  });

  /*
   * And the negative control. Without it, every assertion above would pass against a Worker that
   * buffered everything — because the only thing proving otherwise is that `text()` throws, and a
   * `text()` that was never going to be reached proves nothing about the code that avoided it.
   */
  it("would fail if a read went back to text(): the guard really does throw", async () => {
    const store = await publishedStore();
    const bucket = streamOnlyBucket(store);
    const binding = new R2BindingStore(bucket);
    const [tile] = await store.list("data/network/map-stops/");
    expect(tile, "the fixture must publish a projection tile").toBeDefined();

    await expect(binding.get(tile!)).rejects.toThrow("must be streamed");
    /* And the same object streams perfectly well. */
    const body = await binding.getStream(tile!);
    expect(body).not.toBeNull();
  });
});

/**
 * The feature flags, and whether anything reads them.
 *
 * `journeyPlanner` was declared with the flags and consulted nowhere, and that came out the hard
 * way: the acceptance job was changed to run its peak passes once with the planner switched off —
 * to test whether the planner's CPU is what takes the other endpoints down with it — and the
 * comparison reported the planner failing nine requests of ten, because it had never been switched
 * off. A measurement of nothing, reported as a measurement.
 */
describe("the feature flags are switches rather than declarations", () => {
  it("refuses journey planning with a reason when the flag is off", async () => {
    const store = await publishedStore();
    const env = makeEnv(store, { FEATURE_FLAGS_JSON: '{"journeyPlanner":false}' });
    resetWorkerState();
    initialiseWorker(env, () => new Date("2026-09-02T08:00:05Z"));

    const response = await worker.fetch(
      get("/v1/journeys?fromLat=53.7965&fromLon=-1.5478&toLat=53.8115&toLon=-1.6205"),
      env,
      ctx,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    /* Switched off deliberately is not the same answer as an upstream that is down. */
    expect(body.error?.code).toBe("feature_unavailable");
    expect(body.error?.message).toMatch(/switched off/i);
    /* And it says what still works, because a passenger wants to know. */
    expect(body.error?.message).toMatch(/live buses/i);
  });

  it("plans a journey when the flag is left alone", async () => {
    const store = await publishedStore();
    const env = makeEnv(store);
    resetWorkerState();
    initialiseWorker(env, () => new Date("2026-09-02T08:00:05Z"));

    const response = await worker.fetch(
      get("/v1/journeys?fromLat=53.7965&fromLon=-1.5478&toLat=53.8115&toLon=-1.6205"),
      env,
      ctx,
    );
    /* Whatever it answers, it is not the refusal above. */
    expect(response.status).not.toBe(503);
  });

  it("still draws the map with live vehicles switched off", async () => {
    const store = await publishedStore();
    const env = makeEnv(store, { FEATURE_FLAGS_JSON: '{"liveVehicles":false}' });
    resetWorkerState();
    initialiseWorker(env, () => new Date("2026-09-02T08:00:05Z"));

    const response = await worker.fetch(get("/v1/map?bbox=-1.7,53.7,-1.4,53.9&zoom=14"), env, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { stops: unknown[]; vehicles: unknown[] };
    };
    /* The comparison walk this enables depends on exactly this: stops still drawn, no buses. */
    expect(body.data.vehicles).toEqual([]);
    expect(body.data.stops.length).toBeGreaterThan(0);
  });
});
