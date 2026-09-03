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
