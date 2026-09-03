import { z } from "zod";
import {
  BaseEntitySchema,
  CoordinateSchema,
  CoverageAreaSchema,
  IsoInstantSchema,
  ModeSchema,
  ValidityWindowSchema,
} from "./common.js";

/**
 * Static/scheduled network entities. See docs/06_DATA_MODEL.md "Static entities".
 */

export const OperatorSchema = BaseEntitySchema.extend({
  name: z.string().min(1),
  shortName: z.string().optional(),
  /** e.g. Traveline National Dataset / VOSN licence number, DfT operator code. */
  licenceRegistryIds: z.array(z.string()).default([]),
  contactUrl: z.string().url().optional(),
  ticketDomains: z.array(z.string()).default([]),
  serviceAreas: z.array(CoverageAreaSchema).default([]),
  active: z.boolean().default(true),
});
export type Operator = z.infer<typeof OperatorSchema>;

export const LocalityAreaSchema = BaseEntitySchema.extend({
  /** NPTG locality code, or an internal analysis-area code. */
  code: z.string().min(1),
  name: z.string().min(1),
  parentAreaId: z.string().uuid().nullable().default(null),
  /** Admin/analysis hierarchy tier, e.g. "locality" | "district" | "county" | "region". */
  tier: z.enum(["locality", "district", "county", "region", "national"]),
  centroid: CoordinateSchema.optional(),
});
export type LocalityArea = z.infer<typeof LocalityAreaSchema>;

export const StopTypeSchema = z.enum([
  "on_street_bus",
  "bus_station_bay",
  "coach_bay",
  "tram_stop",
  "other",
]);
export type StopType = z.infer<typeof StopTypeSchema>;

export const StopAmenitySchema = z.object({
  key: z.enum([
    "shelter",
    "seating",
    "step_free",
    "tactile_paving",
    "real_time_display",
    "lighting",
  ]),
  /** true/false only when sourced; unknown amenities are omitted rather than guessed. */
  value: z.boolean(),
  provenance: z.string(),
});
export type StopAmenity = z.infer<typeof StopAmenitySchema>;

export const StopSchema = BaseEntitySchema.extend({
  /** NaPTAN ATCO code — canonical stop identity. */
  atcoCode: z.string().min(1),
  naptanCode: z.string().optional(),
  name: z.string().min(1),
  indicator: z.string().optional(),
  locationCoordinate: CoordinateSchema,
  /** Compass bearing in degrees the stop faces, if sourced. */
  bearing: z.number().min(0).max(359).optional(),
  stopType: StopTypeSchema,
  localityId: z.string().uuid().nullable().default(null),
  amenities: z.array(StopAmenitySchema).default([]),
  active: z.boolean().default(true),
  /** NaPTAN status: active | pending | deleted, preserved as-is for reconciliation. */
  naptanStatus: z.enum(["active", "pending", "deleted"]).default("active"),
  /** If this stop was superseded/merged, the successor stop's internal UUID. */
  supersededByStopId: z.string().uuid().nullable().default(null),
});
export type Stop = z.infer<typeof StopSchema>;

export const ServiceRouteSchema = BaseEntitySchema.extend({
  operatorId: z.string().uuid(),
  /** Public-facing line name/number, e.g. "38", "X1". */
  publicName: z.string().min(1),
  mode: ModeSchema,
  description: z.string().optional(),
  branding: z.string().optional(),
  coverageArea: CoverageAreaSchema,
  ...ValidityWindowSchema.shape,
});
export type ServiceRoute = z.infer<typeof ServiceRouteSchema>;

export const RoutePatternSchema = BaseEntitySchema.extend({
  serviceRouteId: z.string().uuid(),
  direction: z.enum(["outbound", "inbound", "circular"]),
  /** Ordered stop IDs for this pattern. */
  stopSequence: z.array(z.string().uuid()).min(2),
  /** Encoded polyline or GeoJSON LineString reference for the canonical shape. */
  shapeRef: z.string().min(1),
  distanceMetres: z.number().nonnegative(),
  ...ValidityWindowSchema.shape,
});
export type RoutePattern = z.infer<typeof RoutePatternSchema>;

export const StopTimeSchema = z.object({
  stopId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  scheduledArrival: IsoInstantSchema.optional(),
  scheduledDeparture: IsoInstantSchema,
  /** Timing point stops have higher-confidence schedules; interpolated stops do not. */
  isTimingPoint: z.boolean().default(false),
  pickupAllowed: z.boolean().default(true),
  dropOffAllowed: z.boolean().default(true),
});
export type StopTime = z.infer<typeof StopTimeSchema>;

export const ScheduledJourneyStateSchema = z.enum(["scheduled", "cancelled", "updated", "added"]);
export type ScheduledJourneyState = z.infer<typeof ScheduledJourneyStateSchema>;

export const ScheduledJourneySchema = BaseEntitySchema.extend({
  routePatternId: z.string().uuid(),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tripId: z.string().min(1),
  blockId: z.string().optional(),
  stopTimes: z.array(StopTimeSchema).min(2),
  state: ScheduledJourneyStateSchema.default("scheduled"),
});
export type ScheduledJourney = z.infer<typeof ScheduledJourneySchema>;

export const RoadClassSchema = z.enum([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "local",
  "other",
]);
export type RoadClass = z.infer<typeof RoadClassSchema>;

export const RoadSegmentSchema = BaseEntitySchema.extend({
  /** OSM way reference(s) composing this segment. */
  osmWayIds: z.array(z.string()).min(1),
  shapeRef: z.string().min(1),
  direction: z.enum(["forward", "backward", "bidirectional"]),
  lengthMetres: z.number().positive(),
  roadClass: RoadClassSchema,
  speedLimitMph: z.number().positive().optional(),
  speedLimitProvenance: z.string().optional(),
  /** Corridor/analysis grouping key used to aggregate segments for congestion reporting. */
  corridorId: z.string().min(1),
});
export type RoadSegment = z.infer<typeof RoadSegmentSchema>;
