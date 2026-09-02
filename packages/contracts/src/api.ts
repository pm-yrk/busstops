import { z } from "zod";
import { BoundingBoxSchema, CoordinateSchema, IsoInstantSchema } from "./common.js";
import { DeparturePredictionSchema, VehicleStateSchema } from "./live.js";
import { GovernorStateSchema, IncidentSchema, SourceHealthSchema } from "./derived.js";
import { StopSchema } from "./static.js";

/**
 * Versioned API envelopes. Every response states when it was generated, what was
 * observed, which sources contributed, how fresh they are, and whether the platform
 * is degraded. See docs/04_ARCHITECTURE.md "API design".
 */

export const API_VERSION = "v1" as const;

export const DegradationStatusSchema = z.enum([
  "normal",
  "partial_sources",
  "stale_data",
  "scheduled_only",
  "safe_mode",
]);
export type DegradationStatus = z.infer<typeof DegradationStatusSchema>;

export const ResponseMetaSchema = z.object({
  generatedAt: IsoInstantSchema,
  /** Oldest upstream observation contributing to this payload. */
  observedAt: IsoInstantSchema.nullable(),
  sources: z.array(SourceHealthSchema),
  /** 0..1 share of the requested scope actually covered by live data. */
  coverage: z.number().min(0).max(1),
  degradation: DegradationStatusSchema,
  governorState: GovernorStateSchema,
  attribution: z.array(z.string()),
});
export type ResponseMeta = z.infer<typeof ResponseMetaSchema>;

export function apiEnvelope<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    meta: ResponseMetaSchema,
    data: dataSchema,
  });
}

/** Hard caps that protect the free tier and prevent bbox/query DoS. */
export const MAP_QUERY_LIMITS = {
  maxBboxAreaSquareDegrees: 1.5,
  minZoom: 9,
  maxZoom: 19,
  maxStops: 400,
  maxVehicles: 300,
  maxIncidents: 100,
  timeoutMs: 8000,
} as const;

export const MapQuerySchema = z.object({
  bbox: BoundingBoxSchema,
  zoom: z.number().int().min(MAP_QUERY_LIMITS.minZoom).max(MAP_QUERY_LIMITS.maxZoom),
  layers: z
    .array(z.enum(["stops", "vehicles", "congestion", "disruptions"]))
    .min(1)
    .default(["stops", "vehicles"]),
});
export type MapQuery = z.infer<typeof MapQuerySchema>;

export const MapStopSummarySchema = z.object({
  id: z.string().uuid(),
  atcoCode: z.string(),
  name: z.string(),
  indicator: z.string().optional(),
  coordinate: CoordinateSchema,
  routePublicNames: z.array(z.string()).default([]),
  hasLiveCoverage: z.boolean(),
});
export type MapStopSummary = z.infer<typeof MapStopSummarySchema>;

export const MapVehicleSummarySchema = z.object({
  vehicleRef: z.string(),
  coordinate: CoordinateSchema,
  bearingDegrees: z.number().nullable(),
  routePublicName: z.string().nullable(),
  destinationName: z.string().nullable(),
  delaySeconds: z.number().nullable(),
  freshnessSeconds: z.number().nonnegative(),
  motionState: z.enum(["moving", "stationary", "unknown"]),
});
export type MapVehicleSummary = z.infer<typeof MapVehicleSummarySchema>;

export const MapResponseDataSchema = z.object({
  stops: z.array(MapStopSummarySchema),
  vehicles: z.array(MapVehicleSummarySchema),
  incidents: z.array(IncidentSchema),
  /** True when results were capped, so the UI can prompt the user to zoom in. */
  truncated: z.object({
    stops: z.boolean(),
    vehicles: z.boolean(),
    incidents: z.boolean(),
  }),
});
export type MapResponseData = z.infer<typeof MapResponseDataSchema>;

export const MapResponseSchema = apiEnvelope(MapResponseDataSchema);
export type MapResponse = z.infer<typeof MapResponseSchema>;

export const StopDeparturesResponseSchema = apiEnvelope(
  z.object({
    stop: StopSchema,
    departures: z.array(DeparturePredictionSchema),
    /** Routes serving this stop, for the arrival board and route links. */
    routes: z.array(
      z.object({ id: z.string().uuid(), publicName: z.string(), operatorName: z.string() }),
    ),
  }),
);
export type StopDeparturesResponse = z.infer<typeof StopDeparturesResponseSchema>;

export const VehicleDetailResponseSchema = apiEnvelope(
  z.object({
    vehicle: VehicleStateSchema,
    routePublicName: z.string().nullable(),
    destinationName: z.string().nullable(),
    nextStops: z.array(
      z.object({
        stopId: z.string().uuid(),
        name: z.string(),
        atcoCode: z.string(),
        scheduledTime: IsoInstantSchema.nullable(),
        expectedTimeLow: IsoInstantSchema.nullable(),
        expectedTimeHigh: IsoInstantSchema.nullable(),
        passed: z.boolean(),
      }),
    ),
    recentTrace: z.array(z.object({ coordinate: CoordinateSchema, observedAt: IsoInstantSchema })),
    scheduledShape: z.array(CoordinateSchema),
    incidents: z.array(IncidentSchema),
  }),
);
export type VehicleDetailResponse = z.infer<typeof VehicleDetailResponseSchema>;

export const SearchResultSchema = z.object({
  kind: z.enum(["stop", "route", "operator", "area", "place"]),
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  coordinate: CoordinateSchema.optional(),
  distanceMetres: z.number().nonnegative().optional(),
  hasLiveCoverage: z.boolean().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = apiEnvelope(z.object({ results: z.array(SearchResultSchema) }));
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const SourcesHealthResponseSchema = apiEnvelope(
  z.object({
    sources: z.array(SourceHealthSchema),
    governorState: GovernorStateSchema,
    safeMode: z.boolean(),
  }),
);
export type SourcesHealthResponse = z.infer<typeof SourcesHealthResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      "bad_request",
      "not_found",
      "rate_limited",
      "upstream_unavailable",
      "bbox_too_large",
      "timeout",
      "safe_mode",
      "internal",
    ]),
    message: z.string(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
