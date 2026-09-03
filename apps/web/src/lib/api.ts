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
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
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

    return (await response.json()) as T;
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
    );
  }

  stop(id: string, signal?: AbortSignal): Promise<StopDeparturesResponse> {
    return this.request<StopDeparturesResponse>(`/v1/stops/${encodeURIComponent(id)}`, signal);
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
    return this.request<SearchResponse>(`/v1/search?${params.toString()}`, signal);
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
    return this.request<SearchResponse>(`/v1/nearby?${params.toString()}`, signal);
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
    );
  }

  route(id: string, signal?: AbortSignal): Promise<RouteDetailResponse> {
    return this.request<RouteDetailResponse>(`/v1/routes/${encodeURIComponent(id)}`, signal);
  }

  operator(id: string, signal?: AbortSignal): Promise<OperatorDetailResponse> {
    return this.request<OperatorDetailResponse>(`/v1/operators/${encodeURIComponent(id)}`, signal);
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
    return this.request<JourneyPlanResponse>(`/v1/journeys?${params.toString()}`, signal);
  }

  disruptions(signal?: AbortSignal): Promise<DisruptionsResponse> {
    return this.request<DisruptionsResponse>("/v1/disruptions", signal);
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

  proControlTower(
    scope?: ProScopeQuery,
    signal?: AbortSignal,
  ): Promise<{ data: ControlTowerResponse }> {
    return this.request(`/v1/pro/control-tower${this.proQuery(scope)}`, signal);
  }

  proLiveOperations(
    scope?: ProScopeQuery,
    signal?: AbortSignal,
  ): Promise<{ data: LiveOperationsResponse }> {
    return this.request(`/v1/pro/live-operations${this.proQuery(scope)}`, signal);
  }

  proRoutes(scope?: ProScopeQuery, signal?: AbortSignal): Promise<{ data: RoutesResponse }> {
    return this.request(`/v1/pro/routes${this.proQuery(scope)}`, signal);
  }

  proOperators(scope?: ProScopeQuery, signal?: AbortSignal): Promise<{ data: OperatorsResponse }> {
    return this.request(`/v1/pro/operators${this.proQuery(scope)}`, signal);
  }

  proCongestion(
    scope?: ProScopeQuery,
    signal?: AbortSignal,
  ): Promise<{ data: CongestionResponse }> {
    return this.request(`/v1/pro/congestion${this.proQuery(scope)}`, signal);
  }

  proAnalytics(scope?: ProScopeQuery, signal?: AbortSignal): Promise<{ data: AnalyticsResponse }> {
    return this.request(`/v1/pro/analytics${this.proQuery(scope)}`, signal);
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
