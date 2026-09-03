import { z } from "zod";

/**
 * Shared primitives used across every entity in the normalized transport model.
 * See docs/06_DATA_MODEL.md for the authoritative spec these mirror.
 */

export const UuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof UuidSchema>;

/** ISO-8601 UTC instant, e.g. "2026-09-02T07:31:00.000Z". Display layer converts to Europe/London. */
export const IsoInstantSchema = z.string().datetime({ offset: true });
export type IsoInstant = z.infer<typeof IsoInstantSchema>;

/** A source-qualified external identifier, e.g. { source: "bods", id: "SVC123" }. */
export const ExternalIdSchema = z.object({
  source: z.string().min(1),
  id: z.string().min(1),
});
export type ExternalId = z.infer<typeof ExternalIdSchema>;

export const DataSourceNameSchema = z.enum([
  "bods",
  "tfl",
  "naptan",
  "nptg",
  "national_highways",
  "webtris",
  "street_manager",
  "osm",
  "open_meteo",
  "environment_agency",
  "derived",
]);
export type DataSourceName = z.infer<typeof DataSourceNameSchema>;

/** Provenance attached to every record so the UI can show where a fact came from. */
export const ProvenanceSchema = z.object({
  source: DataSourceNameSchema,
  sourceVersion: z.string().optional(),
  retrievedAt: IsoInstantSchema,
  externalIds: z.array(ExternalIdSchema).default([]),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const QualityFlagSchema = z.enum([
  "ok",
  "low_confidence",
  "stale",
  "interpolated",
  "conflicting_sources",
  "quarantined",
  "schema_drift",
]);
export type QualityFlag = z.infer<typeof QualityFlagSchema>;

/** WGS84 coordinate. Validated to plausible England bounds by callers where relevant. */
export const CoordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type Coordinate = z.infer<typeof CoordinateSchema>;

/** Bounding box in WGS84, west/south/east/north. */
export const BoundingBoxSchema = z
  .object({
    west: z.number().min(-180).max(180),
    south: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
    north: z.number().min(-90).max(90),
  })
  .refine((b) => b.west <= b.east && b.south <= b.north, {
    message: "bounding box must have west<=east and south<=north",
  });
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

/** England-wide plausibility bounds used to reject impossible coordinates at ingest. */
export const ENGLAND_BOUNDS: BoundingBox = {
  west: -6.5,
  south: 49.8,
  east: 2.1,
  north: 55.9,
};

export const ValidityWindowSchema = z.object({
  validFrom: IsoInstantSchema,
  validTo: IsoInstantSchema.nullable().default(null),
});
export type ValidityWindow = z.infer<typeof ValidityWindowSchema>;

/** Confidence bucket used across analytics/journey/risk outputs, with numeric detail retained separately. */
export const ConfidenceLevelSchema = z.enum(["low", "medium", "high"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const ConfidenceSchema = z.object({
  level: ConfidenceLevelSchema,
  /** 0..1, the weakest essential evidence component per docs/08_ANALYTICS_ENGINE.md. */
  score: z.number().min(0).max(1),
  reasons: z.array(z.string()).default([]),
});
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** Base fields every entity carries: stable UUID, provenance, ingestion time, quality flags. */
export const BaseEntitySchema = z.object({
  id: UuidSchema,
  provenance: ProvenanceSchema,
  ingestedAt: IsoInstantSchema,
  qualityFlags: z.array(QualityFlagSchema).default([]),
});
export type BaseEntity = z.infer<typeof BaseEntitySchema>;

export const ModeSchema = z.enum(["bus", "coach", "tram", "other"]);
export type Mode = z.infer<typeof ModeSchema>;

export const CoverageAreaSchema = z.enum(["london", "non_london", "national"]);
export type CoverageArea = z.infer<typeof CoverageAreaSchema>;
