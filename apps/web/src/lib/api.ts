import {
  AnalyticsResponseSchema,
  CongestionResponseSchema,
  ControlTowerResponseSchema,
  DisruptionsResponseSchema,
  JourneyPlanResponseSchema,
  OperatorDetailResponseSchema,
  RouteDetailResponseSchema,
  VehicleDetailResponseSchema,
  LiveOperationsResponseSchema,
  MapResponseSchema,
  OperatorsResponseSchema,
  ReportResponseSchema,
  RoutesResponseSchema,
  SearchResponseSchema,
  StopDeparturesResponseSchema,
  apiEnvelope,
} from "@busstops/contracts";
import type {
  AnalyticsResponse,
  CongestionResponse,
  ControlTowerResponse,
  DisruptionsResponse,
  LiveOperationsResponse,
  OperatorsResponse,
  ReportResponse,
  RoutesResponse,
  JourneyPlanResponse,
  VehicleDetailResponse,
  MapResponse,
  OperatorDetailResponse,
  RouteDetailResponse,
  SearchResponse,
  StopDeparturesResponse,
} from "@busstops/contracts";

/**
 * Client for the Worker API.
 *
 * The browser never talks to a data provider directly — that is what keeps provider keys
 * server-side and the CSP tight. Requests carry an abort signal so a fast pan does not leave a
 * queue of stale viewport requests in flight.
 */

/**
 * Where the API lives.
 *
 * `VITE_API_URL` is set by the deployment workflow to the exact Worker origin it just deployed,
 * so a preview build talks to the preview Worker and a production build to the production one,
 * with no runtime lookup and nothing to configure by hand.
 *
 * The fallback is `/api` for local development, where the Vite dev server proxies to a local
 * `wrangler dev`. It is deliberately a relative path: if the build variable were ever missing in
 * a deployed bundle the calls would fail visibly against the site's own origin, rather than
 * silently reaching whatever origin a default happened to name.
 */
export function defaultApiBaseUrl(): string {
  const configured = import.meta.env?.VITE_API_URL;
  return configured && configured.length > 0 ? configured : "/api";
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ProScopeQuery {
  areaId?: string | null;
  operatorId?: string | null;
  routeId?: string | null;
  windowMinutes?: number;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? defaultApiBaseUrl()).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
    path: string,
    signal?: AbortSignal,
    schema?: { safeParse: (value: unknown) => { success: boolean; data?: unknown } },
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      let code = "internal";
      let message = `Request failed with status ${response.status}`;
      let retryAfterSeconds: number | undefined;
      try {
        const body = (await response.json()) as {
          error?: { code?: string; message?: string; retryAfterSeconds?: number };
        };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
        retryAfterSeconds = body.error?.retryAfterSeconds;
      } catch {
        // A non-JSON error body is still an error; the status carries the meaning.
      }
      throw new ApiError(message, response.status, code, retryAfterSeconds);
    }

    const body = (await response.json()) as unknown;

    /*
     * Validated at the boundary when a schema is supplied. Rendering an unvalidated payload is
     * how a malformed response becomes a blank white page instead of an error state — and the
     * person looking at it has no idea whether the bus is coming or the site is broken.
     *
     * Six of the ten calls here skipped it, which is how the vehicle page came to crash on a
     * response the contract explicitly permits. `disruptions` and `operator` on vehicle detail
     * both carry `.default()`, meaning the server may omit them — but a default is applied by
     * *parsing*, and nothing parsed, so the page read `undefined.length` and the error boundary
     * caught it. Every call that has a schema now passes it: validation and defaults are the
     * same act, and skipping it leaves each page to guess which optional fields arrived.
     */
    if (schema) {
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError(
          "The server sent a response we could not read. This is a problem at our end, not yours.",
          502,
          "invalid_response",
        );
      }
      return parsed.data as T;
    }

    return body as T;
  }

  map(
    bbox: { west: number; south: number; east: number; north: number },
    zoom: number,
    signal?: AbortSignal,
  ): Promise<MapResponse> {
    const bboxParam = [bbox.west, bbox.south, bbox.east, bbox.north]
      .map((v) => v.toFixed(5))
      .join(",");
    return this.request<MapResponse>(
      `/v1/map?bbox=${encodeURIComponent(bboxParam)}&zoom=${Math.round(zoom)}`,
      signal,
      MapResponseSchema,
    );
  }

  stop(id: string, signal?: AbortSignal): Promise<StopDeparturesResponse> {
    return this.request<StopDeparturesResponse>(
      `/v1/stops/${encodeURIComponent(id)}`,
      signal,
      StopDeparturesResponseSchema,
    );
  }

  search(
    query: string,
    near?: { lat: number; lon: number },
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (near) {
      params.set("lat", near.lat.toFixed(5));
      params.set("lon", near.lon.toFixed(5));
    }
    return this.request<SearchResponse>(
      `/v1/search?${params.toString()}`,
      signal,
      SearchResponseSchema,
    );
  }

  nearby(
    coordinate: { lat: number; lon: number },
    radiusMetres = 800,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    const params = new URLSearchParams({
      lat: coordinate.lat.toFixed(5),
      lon: coordinate.lon.toFixed(5),
      radius: String(radiusMetres),
    });
    return this.request<SearchResponse>(
      `/v1/nearby?${params.toString()}`,
      signal,
      SearchResponseSchema,
    );
  }

  /**
   * A vehicle lookup carries the viewport it was found in. Upstream feeds are viewport-scoped,
   * so there is no national "get bus by reference" to call.
   */
  vehicle(
    ref: string,
    bbox: { west: number; south: number; east: number; north: number },
    signal?: AbortSignal,
  ): Promise<VehicleDetailResponse> {
    const bboxParam = [bbox.west, bbox.south, bbox.east, bbox.north]
      .map((v) => v.toFixed(5))
      .join(",");
    return this.request<VehicleDetailResponse>(
      `/v1/vehicles/${encodeURIComponent(ref)}?bbox=${encodeURIComponent(bboxParam)}`,
      signal,
      VehicleDetailResponseSchema,
    );
  }

  route(id: string, signal?: AbortSignal): Promise<RouteDetailResponse> {
    return this.request<RouteDetailResponse>(
      `/v1/routes/${encodeURIComponent(id)}`,
      signal,
      RouteDetailResponseSchema,
    );
  }

  operator(id: string, signal?: AbortSignal): Promise<OperatorDetailResponse> {
    return this.request<OperatorDetailResponse>(
      `/v1/operators/${encodeURIComponent(id)}`,
      signal,
      OperatorDetailResponseSchema,
    );
  }

  /**
   * Plans a journey. The coordinates are sent for this request only; the server does not log or
   * store them, and the client does not persist them either.
   */
  journey(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    options: { departAtSeconds?: number; serviceDate?: string } = {},
    signal?: AbortSignal,
  ): Promise<JourneyPlanResponse> {
    const params = new URLSearchParams({
      fromLat: origin.lat.toFixed(5),
      fromLon: origin.lon.toFixed(5),
      toLat: destination.lat.toFixed(5),
      toLon: destination.lon.toFixed(5),
    });
    if (options.departAtSeconds !== undefined) {
      params.set("departAt", String(Math.round(options.departAtSeconds)));
    }
    if (options.serviceDate) params.set("date", options.serviceDate);
    return this.request<JourneyPlanResponse>(
      `/v1/journeys?${params.toString()}`,
      signal,
      JourneyPlanResponseSchema,
    );
  }

  disruptions(signal?: AbortSignal): Promise<DisruptionsResponse> {
    return this.request<DisruptionsResponse>("/v1/disruptions", signal, DisruptionsResponseSchema);
  }

  /**
   * Bus Stops Pro. No authentication is sent or required: the demo is public by design, and
   * these endpoints expose no organisation-specific or operational-secret data.
   */
  private proQuery(scope: ProScopeQuery = {}): string {
    const params = new URLSearchParams();
    if (scope.areaId) params.set("area", scope.areaId);
    if (scope.operatorId) params.set("operator", scope.operatorId);
    if (scope.routeId) params.set("route", scope.routeId);
    if (scope.windowMinutes) params.set("window", String(scope.windowMinutes));
    const query = params.toString();
    return query.length > 0 ? `?${query}` : "";
  }

  private static readonly PRO_SCHEMAS = {
    controlTower: apiEnvelope(ControlTowerResponseSchema),
    liveOperations: apiEnvelope(LiveOperationsResponseSchema),
    routes: apiEnvelope(RoutesResponseSchema),
    operators: apiEnvelope(OperatorsResponseSchema),
    congestion: apiEnvelope(CongestionResponseSchema),
    analytics: apiEnvelope(AnalyticsResponseSchema),
    report: apiEnvelope(ReportResponseSchema),
  };

  proControlTower(
    scope?: ProScopeQuery,
    signal?: AbortSignal,
  ): Promise<{ data: ControlTowerResponse }> {
    return this.request(
      `/v1/pro/control-tower${this.proQuery(scope)}`,
      signal,
      ApiClient.PRO_SCHEMAS.controlTower,
    );
  }

  proLiveOperations(
    scope?: ProScopeQuery,
    signal?: AbortSignal,
  ): Promise<{ data: LiveOperationsResponse }> {
    return this.request(
      `/v1/pro/live-operations${this.proQuery(scope)}`,
      signal,
      ApiClient.PRO_SCHEMAS.liveOperations,
    );
  }

  proRoutes(scope?: ProScopeQuery, signal?: AbortSignal): Promise<{ data: RoutesResponse }> {
    return this.request(
      `/v1/pro/routes${this.proQuery(scope)}`,
      signal,
      ApiClient.PRO_SCHEMAS.routes,
    );
  }

  proOperators(scope?: ProScopeQuery, signal?: AbortSignal): Promise<{ data: OperatorsResponse }> {
    return this.request(
      `/v1/pro/operators${this.proQuery(scope)}`,
      signal,
      ApiClient.PRO_SCHEMAS.operators,
    );
  }

  proCongestion(
    scope?: ProScopeQuery,
    signal?: AbortSignal,
  ): Promise<{ data: CongestionResponse }> {
    return this.request(
      `/v1/pro/congestion${this.proQuery(scope)}`,
      signal,
      ApiClient.PRO_SCHEMAS.congestion,
    );
  }

  proAnalytics(scope?: ProScopeQuery, signal?: AbortSignal): Promise<{ data: AnalyticsResponse }> {
    return this.request(
      `/v1/pro/analytics${this.proQuery(scope)}`,
      signal,
      ApiClient.PRO_SCHEMAS.analytics,
    );
  }

  proReport(
    period: "daily" | "weekly" | "monthly",
    scope?: ProScopeQuery,
    signal?: AbortSignal,
  ): Promise<{ data: ReportResponse }> {
    const query = this.proQuery(scope);
    return this.request(
      `/v1/pro/reports${query.length > 0 ? `${query}&` : "?"}period=${period}`,
      signal,
      ApiClient.PRO_SCHEMAS.report,
    );
  }

  /**
   * One-click unsubscribe. Deliberately a plain GET with no confirmation step: the click in the
   * email is the confirmation, and asking again is where people give up and report spam instead.
   */
  unsubscribe(
    recipientId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ data: { status: string; message: string } }> {
    const params = new URLSearchParams({ r: recipientId, t: token });
    return this.request(`/v1/unsubscribe?${params.toString()}`, signal);
  }

  sourcesHealth(signal?: AbortSignal): Promise<unknown> {
    return this.request<unknown>("/v1/sources/health", signal);
  }
}

export const apiClient = new ApiClient();
