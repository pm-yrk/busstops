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
  SearchResponseSchema,
} from "@busstops/contracts";
import { ArtifactStore, InMemoryObjectStore } from "@busstops/pipeline-core";
import {
  buildNetwork,
  publishJourneyTiles,
  publishNetwork,
} from "@busstops/pipeline-static-network";
import worker, { initialiseWorker, resetWorkerState } from "./index.js";
import { R2BindingStore, readFeatureFlags, type R2BucketLike, type WorkerEnv } from "./env.js";
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

/** Wraps the in-memory object store in the R2 binding shape the Worker expects. */
function bucketFrom(store: InMemoryObjectStore): R2BucketLike {
  return {
    async get(key) {
      const value = await store.get(key);
      return value === null ? null : { text: async () => value };
    },
    async put(key, value) {
      await store.put(key, value);
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

  it("plans a journey once the journey tiles are published", async () => {
    const store = await publishedStore();
    const network = completeNetwork();
    await publishJourneyTiles(store, network, { version: "v1" });

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
        { observedAt: "2026-09-02T08:00:00.000Z" },
        { observedAt: "2026-09-02T07:58:00.000Z" },
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
