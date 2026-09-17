import { z } from "zod";
import {
  BoundingBoxSchema,
  ConfidenceSchema,
  CoordinateSchema,
  IsoInstantSchema,
} from "./common.js";
import { DeparturePredictionSchema, VehicleStateSchema } from "./live.js";
import { GovernorStateSchema, IncidentSchema, SourceHealthSchema } from "./derived.js";
import { StopAccessibilitySchema } from "./accessibility.js";
import { DisruptionBoardSchema, DisruptionNoticeSchema } from "./disruptions.js";
import { StopWeatherSchema } from "./weather.js";
import { OperatorSchema, ServiceRouteSchema, StopSchema } from "./static.js";

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
  /**
   * Official disruption notices touching this viewport.
   *
   * Separate from `incidents` because they are different claims: an incident is something Bus
   * Stops inferred from watching buses, a notice is something an operator published. The map
   * draws both, and says which is which.
   */
  disruptions: z.array(DisruptionNoticeSchema),
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
    /**
     * Accessibility, as facts with sources rather than a verdict.
     *
     * Mostly `unknown` today and honestly so: the sources that would answer these questions are
     * sparse, and a stop nobody has surveyed must say that rather than default to "no".
     */
    accessibility: StopAccessibilitySchema,
    /** Official notices naming this stop or a route that calls here. */
    disruptions: z.array(DisruptionNoticeSchema),
    /**
     * What it is like standing here, or null.
     *
     * Null is a real answer and a common one: the weather job publishes a degree square at a
     * time and a square it has not reached yet, or could not get an answer for, has none. The
     * stop page then shows no vignette. Filling the gap with a nearby square, or with a picture
     * of a sky nobody measured, would make the one thing on the page that is a drawing also the
     * one thing that is not true.
     */
    weather: StopWeatherSchema.nullable(),
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

/**
 * A metric as it is published to a client: never a bare number. The denominator and the
 * suppression flag travel with the value so a figure computed from four observations cannot be
 * rendered as though it were computed from four hundred.
 */
export const PublishedMetricSchema = z.object({
  label: z.string(),
  /** Null when suppressed, which is a legitimate and common state. */
  value: z.number().nullable(),
  unit: z.enum(["percent", "seconds", "minutes", "count", "points"]),
  denominator: z.number().int().nonnegative(),
  suppressed: z.boolean(),
  /** Why the figure is missing or qualified, in the words shown to the reader. */
  note: z.string().nullable(),
  confidence: ConfidenceSchema.nullable(),
});
export type PublishedMetric = z.infer<typeof PublishedMetricSchema>;

export const RouteDetailResponseSchema = apiEnvelope(
  z.object({
    route: ServiceRouteSchema,
    operator: OperatorSchema.nullable(),
    variants: z.array(
      z.object({
        patternId: z.string().uuid(),
        direction: z.enum(["outbound", "inbound", "circular"]),
        description: z.string(),
        distanceMetres: z.number().nonnegative(),
        stops: z.array(
          z.object({
            stopId: z.string().uuid(),
            atcoCode: z.string(),
            name: z.string(),
            locality: z.string().nullable(),
            sequence: z.number().int().nonnegative(),
          }),
        ),
      }),
    ),
    /** Vehicles currently observed on this route, if any live source covers it. */
    activeVehicles: z.array(
      z.object({
        vehicleRef: z.string(),
        destinationName: z.string().nullable(),
        delaySeconds: z.number().nullable(),
        observedAt: IsoInstantSchema,
        coordinate: CoordinateSchema,
      }),
    ),
    /** Typical frequency, when the timetable supports stating one. */
    headwaySummary: z.string().nullable(),
    reliability: z.array(PublishedMetricSchema),
    incidents: z.array(IncidentSchema),
    ticketUrl: z.string().url().nullable(),
  }),
);
export type RouteDetailResponse = z.infer<typeof RouteDetailResponseSchema>;

export const DisruptionRankingSchema = z.enum(["delay_burden", "most_abnormal"]);
export type DisruptionRanking = z.infer<typeof DisruptionRankingSchema>;

export const DisruptionItemSchema = z.object({
  incident: IncidentSchema,
  /** Current value against its baseline, both stated, so the reader can judge the gap. */
  currentValueSeconds: z.number().nullable(),
  baselineValueSeconds: z.number().nullable(),
  /** Empirical frequency of conditions at least this bad, with its sample size. */
  occurrenceFrequency: z.number().min(0).max(1).nullable(),
  occurrenceSample: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative(),
  affectedRouteNames: z.array(z.string()),
  affectedVehicleCount: z.number().int().nonnegative(),
  /** Total delay across affected vehicles: the burden ranking's basis. */
  delayBurdenVehicleMinutes: z.number().nonnegative().nullable(),
  /** Whether conditions are improving, and how that was judged. */
  recoveryTrend: z.enum(["improving", "steady", "worsening", "unknown"]),
  officialContext: z.array(z.string()),
});
export type DisruptionItem = z.infer<typeof DisruptionItemSchema>;

export const DisruptionsResponseSchema = apiEnvelope(
  z.object({
    /*
     * Two layers, kept apart on purpose.
     *
     * `official` is what an operator or authority published. The rankings below are what Bus
     * Stops worked out from watching buses. A passenger deciding whether to wait is entitled to
     * know which of those they are reading, and merging them into one list would take that away.
     * The official layer also does not wait for an analytics baseline: an operator saying a route
     * is suspended is useful on the first day, before anything has a baseline at all.
     */
    official: z.array(DisruptionNoticeSchema),
    /** Which publishers were asked and what came back, so silence is attributable. */
    sourcesQueried: DisruptionBoardSchema.shape.sourcesQueried,
    /** When the notices were collected from the publishers — not when this response was built. */
    officialCollectedAt: IsoInstantSchema.nullable(),

    /** Two rankings, never merged into one league table: they answer different questions. */
    byDelayBurden: z.array(DisruptionItemSchema),
    byAbnormality: z.array(DisruptionItemSchema),
    /** Areas where nothing can be said, distinct from areas where nothing is wrong. */
    uncoveredAreas: z.array(z.string()),
  }),
);
export type DisruptionsResponse = z.infer<typeof DisruptionsResponseSchema>;

export const OperatorDetailResponseSchema = apiEnvelope(
  z.object({
    operator: OperatorSchema,
    routes: z.array(
      z.object({
        id: z.string().uuid(),
        publicName: z.string(),
        description: z.string().nullable(),
      }),
    ),
    metrics: z.array(PublishedMetricSchema),
    /**
     * Whether this operator's sample supports comparison with others at all. Ranking below the
     * threshold would be a league-table claim the data cannot support.
     */
    rankingEligible: z.boolean(),
    rankingIneligibleReason: z.string().nullable(),
    coverageCaveats: z.array(z.string()),
    incidents: z.array(IncidentSchema),
  }),
);
export type OperatorDetailResponse = z.infer<typeof OperatorDetailResponseSchema>;

export const AreaDetailResponseSchema = apiEnvelope(
  z.object({
    areaId: z.string(),
    name: z.string(),
    boundingBox: BoundingBoxSchema.nullable(),
    stopCount: z.number().int().nonnegative(),
    routeCount: z.number().int().nonnegative(),
    operators: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
    metrics: z.array(PublishedMetricSchema),
    coverageCaveats: z.array(z.string()),
    incidents: z.array(IncidentSchema),
  }),
);
export type AreaDetailResponse = z.infer<typeof AreaDetailResponseSchema>;

export const JourneyPlanLegSchema = z.object({
  mode: z.enum(["walk", "bus"]),
  fromStopId: z.string().nullable(),
  toStopId: z.string().nullable(),
  fromName: z.string(),
  toName: z.string(),
  routeName: z.string().optional(),
  headsign: z.string().optional(),
  departureSeconds: z.number(),
  arrivalSeconds: z.number(),
});
export type JourneyPlanLeg = z.infer<typeof JourneyPlanLegSchema>;

export const JourneyPlanOptionSchema = z.object({
  ranking: z.enum(["fastest", "least_walking", "fewest_changes"]),
  legs: z.array(JourneyPlanLegSchema),
  departureSeconds: z.number(),
  arrivalSeconds: z.number(),
  /** An interval, never a single arrival time: a point estimate overstates what is known. */
  arrivalLowSeconds: z.number(),
  arrivalHighSeconds: z.number(),
  totalWalkSeconds: z.number().nonnegative(),
  changeCount: z.number().int().nonnegative(),
  boardingStopId: z.string().nullable(),
  confidence: ConfidenceSchema,
  explanation: z.string().optional(),
});
export type JourneyPlanOption = z.infer<typeof JourneyPlanOptionSchema>;

export const JourneyDiagnosticsSchema = z.object({
  code: z.enum(["planned", "no_options", "too_far", "no_data", "unreadable", "too_large"]),
  corridorTiles: z.number().int().nonnegative(),
  windows: z.array(z.number().int().nonnegative()),
  shardsRead: z.number().int().nonnegative(),
  shardsMissing: z.number().int().nonnegative(),
  tripsLoaded: z.number().int().nonnegative(),
  tripsWithPattern: z.number().int().nonnegative(),
  tripsWithoutPattern: z.number().int().nonnegative(),
  tripsInGraph: z.number().int().nonnegative(),
  stopsInGraph: z.number().int().nonnegative(),
  transferEdges: z.number().int().nonnegative(),
  originCandidates: z.number().int().nonnegative(),
  destinationCandidates: z.number().int().nonnegative(),
  rounds: z.number().int().nonnegative(),
  roundsWithOption: z.number().int().nonnegative(),
  patternsInSlice: z.number().int().nonnegative(),
  stopsInSlice: z.number().int().nonnegative(),
  failures: z.array(z.object({ dataset: z.string(), reason: z.string() })),
});
export type JourneyDiagnostics = z.infer<typeof JourneyDiagnosticsSchema>;

export const JourneyPlanResponseSchema = apiEnvelope(
  z.object({
    serviceDate: z.string(),
    options: z.array(JourneyPlanOptionSchema),
    /** Why one boarding stop was preferred to a nearer one, when that needs saying. */
    explanation: z.string().nullable(),
    /** Stated when no plan could be produced, in the words shown to the reader. */
    unavailableReason: z.string().nullable(),
    /**
     * Why the answer is the shape it is, in counts.
     *
     * Part of the contract rather than a debug extra, because the thing being guarded against is
     * a zero that cannot be interpreted. One sentence covered six unrelated situations — nothing
     * published here, a shard that could not be read, a corridor too wide to plan, trips whose
     * patterns were not in the slice, a graph over its size limit, and a search that genuinely
     * found no path — and without these a deployed check cannot tell a broken join from a quiet
     * moor, which is exactly the confusion that let an empty national timetable read as `normal`.
     */
    diagnostics: JourneyDiagnosticsSchema.optional(),
  }),
);
export type JourneyPlanResponse = z.infer<typeof JourneyPlanResponseSchema>;

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
