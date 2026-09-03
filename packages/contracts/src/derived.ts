import { z } from "zod";
import {
  BaseEntitySchema,
  ConfidenceSchema,
  CoordinateSchema,
  IsoInstantSchema,
} from "./common.js";

/**
 * Derived/analytical entities. See docs/06_DATA_MODEL.md "Derived entities" and
 * docs/08_ANALYTICS_ENGINE.md for the algorithms that populate them.
 */

/** Every metric carries denominator, coverage and confidence — never a bare number. */
export const MetricEnvelopeSchema = z.object({
  /** Count of eligible observations/journeys underlying this metric. */
  denominator: z.number().int().nonnegative(),
  /** 0..1 fraction of the theoretically expected sample actually observed. */
  coverage: z.number().min(0).max(1),
  confidence: ConfidenceSchema,
  windowStart: IsoInstantSchema,
  windowEnd: IsoInstantSchema,
});
export type MetricEnvelope = z.infer<typeof MetricEnvelopeSchema>;

const IntervalMetricCoreSchema = z.object({
  ...MetricEnvelopeSchema.shape,
  /** Fraction 0..1 within the configured on-time window (default -60s..+300s). */
  punctuality: z.number().min(0).max(1).nullable(),
  /** Operated eligible / scheduled eligible, 0..1. */
  reliability: z.number().min(0).max(1).nullable(),
  medianDelaySeconds: z.number().nullable(),
  meanDelaySeconds: z.number().nullable(),
  p90DelaySeconds: z.number().nullable(),
  confirmedCancellations: z.number().int().nonnegative(),
  sourceOutageAffected: z.number().int().nonnegative(),
});

export const RouteIntervalMetricSchema = BaseEntitySchema.extend({
  ...IntervalMetricCoreSchema.shape,
  serviceRouteId: z.string().uuid(),
  headwayAdherence: z.number().min(0).max(1).nullable(),
});
export type RouteIntervalMetric = z.infer<typeof RouteIntervalMetricSchema>;

export const OperatorIntervalMetricSchema = BaseEntitySchema.extend({
  ...IntervalMetricCoreSchema.shape,
  operatorId: z.string().uuid(),
  /** Context-adjusted metrics compare to expected performance given corridor/time/weather. */
  contextAdjustedPunctuality: z.number().min(0).max(1).nullable(),
  contextAdjustedReliability: z.number().min(0).max(1).nullable(),
  rankingSuppressed: z.boolean().default(false),
  rankingSuppressedReason: z.string().optional(),
});
export type OperatorIntervalMetric = z.infer<typeof OperatorIntervalMetricSchema>;

export const AreaIntervalMetricSchema = BaseEntitySchema.extend({
  ...IntervalMetricCoreSchema.shape,
  areaId: z.string().uuid(),
  /** 0-100 documented weighted composite; see analytics package for formula/version. */
  networkHealth: z.number().min(0).max(100).nullable(),
  networkHealthComponents: z
    .object({
      punctuality: z.number(),
      reliability: z.number(),
      excessDelay: z.number(),
      headwayStability: z.number(),
      severeIncidentBurden: z.number(),
      dataCoverage: z.number(),
    })
    .optional(),
  networkHealthVersion: z.string(),
});
export type AreaIntervalMetric = z.infer<typeof AreaIntervalMetricSchema>;

export const SegmentIntervalMetricSchema = BaseEntitySchema.extend({
  ...MetricEnvelopeSchema.shape,
  corridorId: z.string().min(1),
  direction: z.enum(["forward", "backward", "bidirectional"]),
  sampleCount: z.number().int().nonnegative(),
  /** Robust (median/trimmed) observed speed in m/s. */
  robustSpeedMetresPerSecond: z.number().nonnegative().nullable(),
  baselineSpeedMetresPerSecond: z.number().nonnegative().nullable(),
  excessTravelTimeSecondsPerTraversal: z.number().nullable(),
  affectedVehicleCount: z.number().int().nonnegative(),
  affectedRouteIds: z.array(z.string().uuid()).default([]),
});
export type SegmentIntervalMetric = z.infer<typeof SegmentIntervalMetricSchema>;

export const BaselineDimensionSchema = z.object({
  corridorOrRouteId: z.string().min(1),
  direction: z.enum(["forward", "backward", "bidirectional"]).optional(),
  localWeekdayType: z.enum(["weekday", "saturday", "sunday_or_holiday"]),
  windowStartMinuteOfDay: z.number().int().min(0).max(1425),
});
export type BaselineDimension = z.infer<typeof BaselineDimensionSchema>;

export const BaselineSchema = BaseEntitySchema.extend({
  dimension: BaselineDimensionSchema,
  comparableWindowDays: z.number().int().positive(),
  sampleCount: z.number().int().nonnegative(),
  quantiles: z.object({
    p10: z.number(),
    p25: z.number(),
    p50: z.number(),
    p75: z.number(),
    p90: z.number(),
  }),
  mad: z.number().nonnegative(),
  lastUpdatedAt: IsoInstantSchema,
  /** Below the configured minimum comparable-period count, classification must show "insufficient baseline". */
  sufficientSample: z.boolean(),
});
export type Baseline = z.infer<typeof BaselineSchema>;

export const IncidentTypeSchema = z.enum([
  "bunching",
  "service_gap",
  "diversion",
  "skipped_stop",
  "speed_anomaly",
  "congestion",
  "road_closure",
  "weather_disruption",
  "flood_risk",
  "data_quality",
]);
export type IncidentType = z.infer<typeof IncidentTypeSchema>;

export const IncidentSeveritySchema = z.enum([
  "typical",
  "elevated",
  "abnormal",
  "highly_abnormal",
]);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

export const IncidentLifecycleSchema = z.enum(["emerging", "active", "recovering", "resolved"]);
export type IncidentLifecycle = z.infer<typeof IncidentLifecycleSchema>;

export const EvidenceRefSchema = z.object({
  kind: z.enum([
    "vehicle_observation",
    "road_event",
    "flood_notice",
    "weather_observation",
    "segment_metric",
    "official_source",
  ]),
  refId: z.string(),
  description: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const IncidentSchema = BaseEntitySchema.extend({
  type: IncidentTypeSchema,
  startedAt: IsoInstantSchema,
  endedAt: IsoInstantSchema.nullable(),
  geometry: z.union([CoordinateSchema, z.object({ corridorId: z.string() })]),
  affectedRouteIds: z.array(z.string().uuid()).default([]),
  affectedVehicleRefs: z.array(z.string()).default([]),
  severity: IncidentSeveritySchema,
  confidence: ConfidenceSchema,
  evidence: z.array(EvidenceRefSchema).default([]),
  /** Whether this is confirmed by an official source or purely bus-probe derived. */
  officialStatus: z.enum(["official", "derived"]),
  lifecycle: IncidentLifecycleSchema,
  /** Deterministic, cautiously-worded human summary, e.g. "likely diversion". */
  narrative: z.string(),
});
export type Incident = z.infer<typeof IncidentSchema>;

export const DiversionEventSchema = IncidentSchema.extend({
  type: z.literal("diversion"),
  departureStopId: z.string().uuid().nullable(),
  rejoinStopId: z.string().uuid().nullable(),
  bypassedStopIds: z.array(z.string().uuid()).default([]),
  addedDistanceMetres: z.number().nullable(),
  addedTimeSeconds: z.number().nullable(),
});
export type DiversionEvent = z.infer<typeof DiversionEventSchema>;

export const BunchingEventSchema = IncidentSchema.extend({
  type: z.literal("bunching"),
  routePatternId: z.string().uuid(),
  leaderVehicleRef: z.string(),
  followerVehicleRef: z.string(),
  minObservedHeadwaySeconds: z.number().nonnegative(),
  scheduledHeadwaySeconds: z.number().nonnegative().nullable(),
});
export type BunchingEvent = z.infer<typeof BunchingEventSchema>;

export const ServiceGapEventSchema = IncidentSchema.extend({
  type: z.literal("service_gap"),
  routePatternId: z.string().uuid(),
  observedHeadwaySeconds: z.number().nonnegative().nullable(),
  scheduledHeadwaySeconds: z.number().nonnegative().nullable(),
  missingScheduledJourneyIds: z.array(z.string().uuid()).default([]),
});
export type ServiceGapEvent = z.infer<typeof ServiceGapEventSchema>;

export const SpeedAnomalySchema = IncidentSchema.extend({
  type: z.literal("speed_anomaly"),
  corridorId: z.string(),
  vehicleRef: z.string(),
  observedSpeedMetresPerSecond: z.number().nonnegative(),
  speedLimitContextMph: z.number().positive().nullable(),
});
export type SpeedAnomaly = z.infer<typeof SpeedAnomalySchema>;

export const SkippedStopEvidenceSchema = IncidentSchema.extend({
  type: z.literal("skipped_stop"),
  scheduledJourneyId: z.string().uuid(),
  stopId: z.string().uuid(),
});
export type SkippedStopEvidence = z.infer<typeof SkippedStopEvidenceSchema>;

export const WeatherConditionSchema = z.object({
  temperatureCelsius: z.number(),
  precipitationMmPerHour: z.number().nonnegative(),
  windSpeedMetresPerSecond: z.number().nonnegative(),
  weatherCode: z.number().int(),
});
export type WeatherCondition = z.infer<typeof WeatherConditionSchema>;

export const WeatherObservationSchema = BaseEntitySchema.extend({
  gridCell: z.string(),
  observedAt: IsoInstantSchema,
  condition: WeatherConditionSchema,
});
export type WeatherObservation = z.infer<typeof WeatherObservationSchema>;

export const WeatherForecastSchema = BaseEntitySchema.extend({
  gridCell: z.string(),
  modelRunAt: IsoInstantSchema,
  forecastFor: IsoInstantSchema,
  forecastHorizonHours: z.number().nonnegative(),
  condition: WeatherConditionSchema,
});
export type WeatherForecast = z.infer<typeof WeatherForecastSchema>;

export const FloodNoticeSeveritySchema = z.enum(["alert", "warning", "severe_warning"]);
export type FloodNoticeSeverity = z.infer<typeof FloodNoticeSeveritySchema>;

export const FloodNoticeSchema = BaseEntitySchema.extend({
  eaFloodAreaId: z.string(),
  severity: FloodNoticeSeveritySchema,
  description: z.string(),
  raisedAt: IsoInstantSchema,
  /** Present only while officially active; null once EA marks it removed. */
  activeUntil: IsoInstantSchema.nullable(),
  officialUrl: z.string().url(),
});
export type FloodNotice = z.infer<typeof FloodNoticeSchema>;

export const RoadEventTypeSchema = z.enum([
  "closure",
  "roadworks",
  "incident",
  "congestion_report",
]);
export type RoadEventType = z.infer<typeof RoadEventTypeSchema>;

export const RoadEventSchema = BaseEntitySchema.extend({
  type: RoadEventTypeSchema,
  sourceSystem: z.enum(["national_highways", "webtris", "street_manager"]),
  coordinate: CoordinateSchema.optional(),
  corridorId: z.string().optional(),
  startedAt: IsoInstantSchema,
  endedAt: IsoInstantSchema.nullable(),
  description: z.string(),
  officialUrl: z.string().url().optional(),
});
export type RoadEvent = z.infer<typeof RoadEventSchema>;

export const RiskForecastSchema = BaseEntitySchema.extend({
  scopeId: z.string(),
  scopeType: z.enum(["route", "corridor", "area"]),
  forecastFor: IsoInstantSchema,
  riskBand: z.enum(["low", "moderate", "elevated", "high"]),
  probabilityLow: z.number().min(0).max(1),
  probabilityHigh: z.number().min(0).max(1),
  expectedAdditionalMinutesLow: z.number().nonnegative(),
  expectedAdditionalMinutesHigh: z.number().nonnegative(),
  confidence: ConfidenceSchema,
  contributingFactors: z.array(z.string()).default([]),
});
export type RiskForecast = z.infer<typeof RiskForecastSchema>;

export const JourneyLegSchema = z.object({
  mode: z.enum(["walk", "bus", "coach", "tram"]),
  fromCoordinate: CoordinateSchema,
  toCoordinate: CoordinateSchema,
  fromStopId: z.string().uuid().optional(),
  toStopId: z.string().uuid().optional(),
  routePatternId: z.string().uuid().optional(),
  departAtEarliest: IsoInstantSchema,
  departAtExpected: IsoInstantSchema,
  arriveAtExpected: IsoInstantSchema,
  durationSecondsLow: z.number().nonnegative(),
  durationSecondsHigh: z.number().nonnegative(),
});
export type JourneyLeg = z.infer<typeof JourneyLegSchema>;

export const JourneyPlanRankingSchema = z.enum(["fastest", "least_walking", "fewest_changes"]);
export type JourneyPlanRanking = z.infer<typeof JourneyPlanRankingSchema>;

export const JourneyOptionSchema = z.object({
  ranking: JourneyPlanRankingSchema,
  legs: z.array(JourneyLegSchema).min(1),
  arrivalEstimateLow: IsoInstantSchema,
  arrivalEstimateHigh: IsoInstantSchema,
  confidence: ConfidenceSchema,
  totalWalkSeconds: z.number().nonnegative(),
  changeCount: z.number().int().nonnegative(),
  reliabilityPenaltySeconds: z.number().nonnegative(),
  explanation: z.string().optional(),
});
export type JourneyOption = z.infer<typeof JourneyOptionSchema>;

export const JourneyPlanSchema = z.object({
  /** Hash of normalized request parameters, used as a short-lived cache key only. */
  requestFingerprint: z.string(),
  generatedAt: IsoInstantSchema,
  originCoordinate: CoordinateSchema,
  destinationCoordinate: CoordinateSchema,
  options: z.array(JourneyOptionSchema),
});
export type JourneyPlan = z.infer<typeof JourneyPlanSchema>;

export const DailyBriefSnapshotSchema = BaseEntitySchema.extend({
  organisationId: z.string().uuid().nullable(),
  scopeAreaIds: z.array(z.string().uuid()),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: IsoInstantSchema,
  artifactVersion: z.string(),
  coverageCaveat: z.string().nullable(),
  yesterday: z.object({
    networkHealth: z.number().min(0).max(100).nullable(),
    networkHealthChangeVsBaseline: z.number().nullable(),
    punctuality: z.number().min(0).max(1).nullable(),
    reliability: z.number().min(0).max(1).nullable(),
    medianDelaySeconds: z.number().nullable(),
    denominator: z.number().int().nonnegative(),
    topPerformingRouteIds: z.array(z.string().uuid()).default([]),
    requiresAttentionRouteIds: z.array(z.string().uuid()).default([]),
    biggestDelayBurdenIncidentId: z.string().uuid().nullable(),
    biggestAbnormalDisruptionIncidentId: z.string().uuid().nullable(),
    keyEventIds: z.array(z.string().uuid()).default([]),
    dataQualityIssues: z.array(z.string()).default([]),
  }),
  today: z.object({
    riskBand: z.enum(["low", "moderate", "elevated", "high"]),
    confidence: ConfidenceSchema,
    weatherWindowSummary: z.string(),
    activeFloodNoticeIds: z.array(z.string().uuid()).default([]),
    plannedRoadworksIds: z.array(z.string().uuid()).default([]),
    highestRiskCorridors: z.array(
      z.object({
        corridorId: z.string(),
        probabilityBand: z.string(),
        expectedAdditionalMinutesLow: z.number(),
        expectedAdditionalMinutesHigh: z.number(),
      }),
    ),
    investigationPriorities: z.array(z.string()).default([]),
  }),
  narrative: z.string(),
});
export type DailyBriefSnapshot = z.infer<typeof DailyBriefSnapshotSchema>;

export const SourceHealthStatusSchema = z.enum(["healthy", "degraded", "stale", "down"]);
export type SourceHealthStatus = z.infer<typeof SourceHealthStatusSchema>;

export const SourceHealthSchema = z.object({
  source: z.string(),
  coverageArea: z.string(),
  status: SourceHealthStatusSchema,
  lastSuccessfulFetchAt: IsoInstantSchema.nullable(),
  lastAttemptAt: IsoInstantSchema.nullable(),
  ageSeconds: z.number().nonnegative().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  message: z.string().optional(),
});
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const GovernorStateSchema = z.enum(["green", "amber", "red", "critical"]);
export type GovernorState = z.infer<typeof GovernorStateSchema>;

export const QuotaStateSchema = z.object({
  resource: z.string(),
  utilizationFraction: z.number().min(0),
  projectedUtilizationFraction: z.number().min(0).optional(),
  state: GovernorStateSchema,
  updatedAt: IsoInstantSchema,
  allowance: z.number().nonnegative(),
  allowanceUnit: z.string(),
  allowanceSourceUrl: z.string().url().optional(),
  /**
   * When the allowance was last confirmed against the provider's published terms, or null when
   * it never has been. Nullable on purpose: substituting "now" for an unverified figure would
   * make a guess indistinguishable from a checked fact.
   */
  allowanceVerifiedAt: IsoInstantSchema.nullable(),
  /** False when the provider does not meter this resource under our conditions. */
  metered: z.boolean().default(true),
});
export type QuotaState = z.infer<typeof QuotaStateSchema>;
