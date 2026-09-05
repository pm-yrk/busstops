import { z } from "zod";
import { IsoInstantSchema } from "./common.js";

/**
 * Accessibility, as a set of sourced facts rather than a verdict.
 *
 * The design rule this exists to enforce: **a missing value is UNKNOWN, never NO**. Almost every
 * dataset in this domain encodes "nobody has recorded this" and "this is not present" the same
 * way — GTFS writes 0 for both, OSM simply omits the tag, NaPTAN leaves the column blank — and
 * collapsing them tells a wheelchair user that a stop has no dropped kerb when the truth is that
 * nobody has been to look. That is worse than saying nothing.
 *
 * The second rule: no single score. "78% accessible" is meaningless to someone who needs to know
 * one specific thing, and a rating that averages a shelter against a step-free approach obscures
 * the fact that decides whether the journey is possible. Facts are listed; they are not summed.
 *
 * The third: stop and vehicle are different questions. A step-free stop served by a bus with no
 * ramp is not an accessible journey, and neither is the reverse. They are modelled apart.
 */

export const AccessibilityStatusSchema = z.enum(["yes", "no", "partial", "unknown"]);
export type AccessibilityStatus = z.infer<typeof AccessibilityStatusSchema>;

/** Where a fact came from. Every fact carries one; nothing here is authored by Bus Stops. */
export const AccessibilitySourceSchema = z.enum([
  "naptan",
  "gtfs_stop",
  "gtfs_trip",
  "osm",
  "tfl",
  "operator",
]);
export type AccessibilitySource = z.infer<typeof AccessibilitySourceSchema>;

/**
 * The facts about a stop that a passenger might need.
 *
 * Named for what they describe rather than for the field any one source happens to use, because
 * three sources describe the same thing under three names and the passenger only cares about the
 * thing.
 */
export const StopAccessibilityFactKeySchema = z.enum([
  "wheelchair_boarding",
  "step_free",
  "tactile_paving",
  "kerb",
  "raised_kerb",
  "surface",
  "shelter",
  "covered",
  "seating",
  "lighting",
  "real_time_display",
  "audible_information",
  "visual_information",
  "assistance_available",
]);
export type StopAccessibilityFactKey = z.infer<typeof StopAccessibilityFactKeySchema>;

/** Facts about the bus, which are a different question from facts about the stop. */
export const ServiceAccessibilityFactKeySchema = z.enum([
  "wheelchair_accessible_service",
  "audible_information",
  "visual_information",
]);
export type ServiceAccessibilityFactKey = z.infer<typeof ServiceAccessibilityFactKeySchema>;

export const AccessibilityFactSchema = z.object({
  key: z.union([StopAccessibilityFactKeySchema, ServiceAccessibilityFactKeySchema]),
  status: AccessibilityStatusSchema,
  /**
   * The publisher's own value, where it is more informative than yes/no — a kerb height, a
   * surface material. Shown alongside the status rather than instead of it.
   */
  detail: z.string().optional(),
  source: AccessibilitySourceSchema,
  /** The field the value came from, so a reader can go and check it. */
  sourceField: z.string(),
  /** When the source last changed this, where the source says. */
  sourceUpdatedAt: IsoInstantSchema.nullable().default(null),
  /** How the value was arrived at, in one plain sentence. */
  provenance: z.string(),
  /**
   * How much weight to give it.
   *
   * "high" is a value the publisher asserted about this exact stop. "medium" is a value derived
   * from something adjacent — an OSM node matched by proximity rather than by identity. There is
   * no "low": a fact we are not reasonably confident in is not published as a fact.
   */
  confidence: z.enum(["high", "medium"]),
});
export type AccessibilityFact = z.infer<typeof AccessibilityFactSchema>;

export const StopAccessibilitySchema = z.object({
  atcoCode: z.string().min(1),
  facts: z.array(AccessibilityFactSchema).default([]),
  /**
   * Which sources were consulted, and whether each had anything to say about this stop.
   *
   * Without this, "we know nothing about this stop" and "we never looked" are the same screen,
   * and only one of them should make a passenger go and check for themselves.
   */
  sourcesConsulted: z
    .array(
      z.object({
        source: AccessibilitySourceSchema,
        outcome: z.enum(["had_data", "no_record", "not_available"]),
      }),
    )
    .default([]),
});
export type StopAccessibility = z.infer<typeof StopAccessibilitySchema>;

/** The facts a source published, before they are merged. */
export const AccessibilityFactSetSchema = z.record(z.string(), AccessibilityFactSchema);

/**
 * Merges facts from several sources into one list, most trustworthy first.
 *
 * Order matters and is not alphabetical: NaPTAN is the national register and an operator's or a
 * mapper's copy does not override it. Within a key, a definite answer beats "unknown" — but an
 * "unknown" from a higher-priority source is still reported, because "the register has no value
 * for this" is itself worth knowing.
 */
export const SOURCE_PRIORITY: readonly AccessibilitySource[] = [
  "naptan",
  "tfl",
  "operator",
  "gtfs_stop",
  "gtfs_trip",
  "osm",
];
