import { z } from "zod";
import {
  BoundingBoxSchema,
  ConfidenceSchema,
  CoordinateSchema,
  IsoInstantSchema,
} from "./common.js";
import { IncidentSchema } from "./derived.js";

/**
 * Bus Stops Pro contracts (docs/10_BUS_STOPS_PRO.md).
 *
 * Two rules run through every shape here.
 *
 * First, no bare numbers. Every figure carries its definition, denominator, comparison window,
 * freshness and confidence, because a punctuality percentage without those is not a measurement,
 * it is a claim. The `ProMetric` shape makes it impossible to publish one without them.
 *
 * Second, the provenance of the whole payload is explicit. The Pro demo is public and may be
 * served from a dated snapshot when live national analytics are not available; a viewer must
 * never have to guess which they are looking at, so `dataMode` is required on every response.
 */

export const ProDataModeSchema = z.enum(["live", "demo_snapshot", "unavailable"]);
export type ProDataMode = z.infer<typeof ProDataModeSchema>;

export const ProProvenanceSchema = z.object({
  dataMode: ProDataModeSchema,
  /** Set for demo_snapshot: the date the snapshot describes, shown prominently in the UI. */
  snapshotDate: z.string().nullable(),
  /** One sentence the UI must display verbatim when the mode is not `live`. */
  notice: z.string().nullable(),
});
export type ProProvenance = z.infer<typeof ProProvenanceSchema>;

export const MetricUnitSchema = z.enum([
  "percent",
  "seconds",
  "minutes",
  "count",
  "points",
  "vehicle_minutes",
]);
export type MetricUnit = z.infer<typeof MetricUnitSchema>;

/**
 * A metric as Pro publishes it. Everything needed to judge the number travels with it, and a
 * suppressed metric carries null plus the reason rather than a placeholder.
 */
export const ProMetricSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Plain-language definition, shown in the drilldown. Never optional. */
  definition: z.string(),
  value: z.number().nullable(),
  unit: MetricUnitSchema,
  /** How many observations the figure rests on. */
  denominator: z.number().int().nonnegative(),
  /** The comparison window, e.g. "last 60 minutes" or "same weekday, last 8 weeks". */
  window: z.string(),
  /** Age of the newest observation contributing, in seconds. */
  freshnessSeconds: z.number().nonnegative().nullable(),
  /** 0..1 share of the requested scope with usable data. */
  coverage: z.number().min(0).max(1),
  confidence: ConfidenceSchema.nullable(),
  suppressed: z.boolean(),
  suppressionReason: z.string().nullable(),
  /** Comparable baseline for the same definition and window, when one exists. */
  baselineValue: z.number().nullable(),
  /** What a reader can click through to in order to check the figure. */
  evidence: z.array(z.string()).default([]),
});
export type ProMetric = z.infer<typeof ProMetricSchema>;

export const ProScopeSchema = z.object({
  /** Area, operator or route the view is scoped to; null means all of England. */
  areaId: z.string().nullable(),
  operatorId: z.string().nullable(),
  routeId: z.string().nullable(),
  /** Time window in minutes looking back from now. */
  windowMinutes: z.number().int().positive(),
  boundingBox: BoundingBoxSchema.nullable(),
});
export type ProScope = z.infer<typeof ProScopeSchema>;

export const SourceHealthSummarySchema = z.object({
  healthy: z.number().int().nonnegative(),
  degraded: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  down: z.number().int().nonnegative(),
  /** Named so a reader can see which source is missing, not just how many. */
  problems: z.array(z.object({ source: z.string(), status: z.string(), detail: z.string() })),
});
export type SourceHealthSummary = z.infer<typeof SourceHealthSummarySchema>;

export const PriorityExceptionSchema = z.object({
  incident: IncidentSchema,
  /** Why this is near the top: the ranking that surfaced it. */
  surfacedBy: z.enum(["delay_burden", "abnormality", "source_health", "recovery_stalled"]),
  impactVehicleMinutes: z.number().nonnegative().nullable(),
  abnormalityPercentile: z.number().min(0).max(1).nullable(),
  affectedRouteNames: z.array(z.string()),
  recoveryTrend: z.enum(["improving", "steady", "worsening", "unknown"]),
});
export type PriorityException = z.infer<typeof PriorityExceptionSchema>;

export const ControlTowerResponseSchema = z.object({
  provenance: ProProvenanceSchema,
  scope: ProScopeSchema,
  generatedAt: IsoInstantSchema,
  /** Headline metrics. Order is meaningful: network health leads. */
  headline: z.array(ProMetricSchema),
  sourceHealth: SourceHealthSummarySchema,
  priorityExceptions: z.array(PriorityExceptionSchema),
  biggestDelayBurden: z.array(PriorityExceptionSchema),
  mostAbnormal: z.array(PriorityExceptionSchema),
  routesRequiringAttention: z.array(
    z.object({
      routeId: z.string(),
      routeName: z.string(),
      operatorName: z.string(),
      reason: z.string(),
      metric: ProMetricSchema,
    }),
  ),
  /** Deterministic, generated from the figures above; no model, no free text. */
  outlook: z.string(),
  intelligenceSummary: z.array(z.string()),
  /** Stated first when coverage is weak, per the specification's "lead with that fact". */
  coverageWarning: z.string().nullable(),
});
export type ControlTowerResponse = z.infer<typeof ControlTowerResponseSchema>;

export const LiveOperationsItemSchema = z.object({
  incident: IncidentSchema,
  coordinate: CoordinateSchema.nullable(),
  affectedRouteNames: z.array(z.string()),
  freshnessSeconds: z.number().nonnegative().nullable(),
  recoveryTrend: z.enum(["improving", "steady", "worsening", "unknown"]),
});
export type LiveOperationsItem = z.infer<typeof LiveOperationsItemSchema>;

export const LiveOperationsResponseSchema = z.object({
  provenance: ProProvenanceSchema,
  scope: ProScopeSchema,
  generatedAt: IsoInstantSchema,
  items: z.array(LiveOperationsItemSchema),
  /** Feeds that are stale or missing, which are themselves an operational exception. */
  feedProblems: z.array(z.object({ source: z.string(), status: z.string(), detail: z.string() })),
  availableFilters: z.object({
    operators: z.array(z.object({ id: z.string(), name: z.string() })),
    eventTypes: z.array(z.string()),
    severities: z.array(z.string()),
  }),
});
export type LiveOperationsResponse = z.infer<typeof LiveOperationsResponseSchema>;

export const RouteComparisonRowSchema = z.object({
  routeId: z.string(),
  routeName: z.string(),
  operatorName: z.string(),
  metrics: z.array(ProMetricSchema),
  worstCorridor: z.string().nullable(),
  worstTimeWindow: z.string().nullable(),
  weatherSensitivity: z.string().nullable(),
});
export type RouteComparisonRow = z.infer<typeof RouteComparisonRowSchema>;

export const RoutesResponseSchema = z.object({
  provenance: ProProvenanceSchema,
  scope: ProScopeSchema,
  generatedAt: IsoInstantSchema,
  rows: z.array(RouteComparisonRowSchema),
  /** Set when the rows cannot fairly be compared with one another. */
  comparabilityWarning: z.string().nullable(),
});
export type RoutesResponse = z.infer<typeof RoutesResponseSchema>;

export const OperatorScorecardSchema = z.object({
  operatorId: z.string(),
  operatorName: z.string(),
  /** Raw and context-adjusted are always published together, never one alone. */
  raw: z.array(ProMetricSchema),
  contextAdjusted: z.array(ProMetricSchema),
  contextFactors: z.array(z.string()),
  rankingEligible: z.boolean(),
  rankingIneligibleReason: z.string().nullable(),
  coverageCaveats: z.array(z.string()),
});
export type OperatorScorecard = z.infer<typeof OperatorScorecardSchema>;

export const OperatorsResponseSchema = z.object({
  provenance: ProProvenanceSchema,
  scope: ProScopeSchema,
  generatedAt: IsoInstantSchema,
  scorecards: z.array(OperatorScorecardSchema),
  comparabilityWarning: z.string().nullable(),
});
export type OperatorsResponse = z.infer<typeof OperatorsResponseSchema>;

export const CongestionHotspotSchema = z.object({
  segmentId: z.string(),
  name: z.string(),
  coordinate: CoordinateSchema.nullable(),
  direction: z.string().nullable(),
  timeWindow: z.string(),
  currentSeconds: z.number().nullable(),
  typicalSeconds: z.number().nullable(),
  excessVehicleMinutes: z.number().nullable(),
  affectedRouteNames: z.array(z.string()),
  affectedVehicleCount: z.number().int().nonnegative(),
  occurrenceFrequency: z.number().min(0).max(1).nullable(),
  occurrenceSample: z.number().int().nonnegative(),
  confidence: ConfidenceSchema.nullable(),
  /** Roadworks and incidents nearby, shown as context. Never presented as a cause. */
  corroboration: z.array(z.string()),
});
export type CongestionHotspot = z.infer<typeof CongestionHotspotSchema>;

export const CongestionResponseSchema = z.object({
  provenance: ProProvenanceSchema,
  scope: ProScopeSchema,
  generatedAt: IsoInstantSchema,
  /** Kept separate, as on the passenger side: they answer different questions. */
  biggestDelays: z.array(CongestionHotspotSchema),
  mostAbnormal: z.array(CongestionHotspotSchema),
  causationNotice: z.string(),
});
export type CongestionResponse = z.infer<typeof CongestionResponseSchema>;

export const AnalyticsSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  /** What this section measures and what it deliberately does not claim. */
  description: z.string(),
  metrics: z.array(ProMetricSchema),
  rows: z.array(z.object({ label: z.string(), values: z.array(z.string()) })).default([]),
  columns: z.array(z.string()).default([]),
  /** Wording the UI must not paraphrase, e.g. association-not-causation statements. */
  requiredWording: z.string().nullable(),
});
export type AnalyticsSection = z.infer<typeof AnalyticsSectionSchema>;

export const AnalyticsResponseSchema = z.object({
  provenance: ProProvenanceSchema,
  scope: ProScopeSchema,
  generatedAt: IsoInstantSchema,
  sections: z.array(AnalyticsSectionSchema),
  /** Derived aggregates only; raw national telemetry is never exportable. */
  exportNotice: z.string(),
});
export type AnalyticsResponse = z.infer<typeof AnalyticsResponseSchema>;

export const ReportPeriodSchema = z.enum(["daily", "weekly", "monthly"]);
export type ReportPeriod = z.infer<typeof ReportPeriodSchema>;

export const ReportResponseSchema = z.object({
  provenance: ProProvenanceSchema,
  scope: ProScopeSchema,
  period: ReportPeriodSchema,
  periodStart: IsoInstantSchema,
  periodEnd: IsoInstantSchema,
  generatedAt: IsoInstantSchema,
  sections: z.array(
    z.object({
      title: z.string(),
      metrics: z.array(ProMetricSchema),
      narrative: z.string(),
    }),
  ),
  coverageCaveats: z.array(z.string()),
});
export type ReportResponse = z.infer<typeof ReportResponseSchema>;
