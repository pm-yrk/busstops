import { z } from "zod";
import {
  BaseEntitySchema,
  ConfidenceSchema,
  CoordinateSchema,
  IsoInstantSchema,
} from "./common.js";

/**
 * Live/short-lived entities. See docs/06_DATA_MODEL.md "Live entities".
 * Retention: current state replaces/expires quickly; raw traces target 24h, never above 48h.
 */

export const VehicleObservationSchema = BaseEntitySchema.extend({
  /** Opaque, possibly rotating/hashed vehicle or journey reference — never a stable public identifier. */
  vehicleRef: z.string().min(1),
  journeyRef: z.string().optional(),
  coordinate: CoordinateSchema,
  bearingDegrees: z.number().min(0).max(359).optional(),
  sourceSpeedMetresPerSecond: z.number().nonnegative().optional(),
  observedAt: IsoInstantSchema,

  /*
   * What the feed said this vehicle was working, as it said it.
   *
   * These were extracted by the SIRI adapter and then thrown away one line later: the collector
   * returned the observations and discarded the journey context they came with, so every
   * published observation reached the analytics batch with no route identity on it and the
   * national summary reported `distinctRoutes: 0` over hundreds of real observations. The
   * identity belongs on the observation — it is what the publisher asserted about that vehicle
   * at that moment — rather than in a side channel that does not survive being written to R2.
   *
   * Public route and operator identifiers only. The vehicle's own code is still never
   * republished; `vehicleRef` remains salted and rotating, and nothing here identifies a person.
   * All three are optional because a publisher that gives none is a real and common case, and an
   * observation with no line is still a position.
   */
  /** The publisher's line identifier, e.g. "FLDS:36". Matched against, never shown. */
  lineRef: z.string().min(1).optional(),
  /** The line as a passenger would read it, e.g. "36", "X1". */
  publishedLineName: z.string().min(1).optional(),
  /** The operator's national code, e.g. "FLDS". Resolved against the published operators. */
  operatorRef: z.string().min(1).optional(),
});
export type VehicleObservation = z.infer<typeof VehicleObservationSchema>;

export const VehicleMotionStateSchema = z.enum(["moving", "stationary", "unknown"]);
export type VehicleMotionState = z.infer<typeof VehicleMotionStateSchema>;

export const VehicleStateSchema = BaseEntitySchema.extend({
  vehicleRef: z.string().min(1),
  matchedRoutePatternId: z.string().uuid().nullable(),
  matchedScheduledJourneyId: z.string().uuid().nullable(),
  position: CoordinateSchema,
  bearingDegrees: z.number().min(0).max(359).optional(),
  /** Seconds; positive = late, negative = early. */
  delaySeconds: z.number().nullable(),
  motionState: VehicleMotionStateSchema,
  nextStopId: z.string().uuid().nullable(),
  /** Age of the underlying observation in seconds at publish time. */
  freshnessSeconds: z.number().nonnegative(),
  matchConfidence: ConfidenceSchema,
});
export type VehicleState = z.infer<typeof VehicleStateSchema>;

export const DeparturePredictionLiveStateSchema = z.enum([
  "live",
  "scheduled_only",
  "estimated",
  "cancelled",
  "no_service",
]);
export type DeparturePredictionLiveState = z.infer<typeof DeparturePredictionLiveStateSchema>;

export const DeparturePredictionSchema = BaseEntitySchema.extend({
  stopId: z.string().uuid(),
  scheduledJourneyId: z.string().uuid().nullable(),
  routePatternId: z.string().uuid().nullable(),
  serviceRoutePublicName: z.string().min(1),
  destinationName: z.string().min(1),
  scheduledTime: IsoInstantSchema.nullable(),
  /** Best current estimate; null when only a timetable time exists. */
  expectedTime: IsoInstantSchema.nullable(),
  liveState: DeparturePredictionLiveStateSchema,
  /** Half-width of the uncertainty interval around expectedTime, in seconds. */
  uncertaintySeconds: z.number().nonnegative().nullable(),
  confidence: ConfidenceSchema,
});
export type DeparturePrediction = z.infer<typeof DeparturePredictionSchema>;

export const RecentTracePointSchema = z.object({
  coordinate: CoordinateSchema,
  observedAt: IsoInstantSchema,
});
export type RecentTracePoint = z.infer<typeof RecentTracePointSchema>;

export const RecentTraceSchema = BaseEntitySchema.extend({
  vehicleRef: z.string().min(1),
  /** Bounded, simplified positions for current visualization/derivation only — never a Replay archive. */
  points: z.array(RecentTracePointSchema).max(500),
  windowStart: IsoInstantSchema,
  windowEnd: IsoInstantSchema,
});
export type RecentTrace = z.infer<typeof RecentTraceSchema>;
