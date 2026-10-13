import { z } from "zod";
import { CoordinateSchema, IsoInstantSchema, ProvenanceSchema } from "./common.js";

/**
 * Official disruption notices, as published.
 *
 * Deliberately separate from `Incident` in derived.ts. That one is what Bus Stops *inferred* from
 * watching buses: a confidence, an evidence list, a cautiously-worded narrative. This one is what
 * an operator or authority actually *said*, and the difference matters to a passenger standing at
 * a stop. Merging them would mean either dressing an observation up as an announcement or burying
 * an announcement in analytics, and both are worse than carrying two shapes.
 *
 * Everything here is either published by the source or absent. In particular `reason` is null
 * unless the publisher stated one — a bus that is late for an unstated reason must not acquire a
 * cause on the way through this model.
 */

export const DisruptionSourceSchema = z.enum([
  /** BODS SIRI-SX situations: operators' own notices for England outside London. */
  "bods_situations",
  /** BODS cancellations feed. */
  "bods_cancellations",
  /** TfL line status, which carries London's bus disruption reasons. */
  "tfl_status",
  /** TfL's road/street disruption feed. */
  "tfl_disruption",
]);
export type DisruptionSource = z.infer<typeof DisruptionSourceSchema>;

/**
 * Severity, normalised across publishers.
 *
 * SIRI's enumeration is finer than this (verySlight … verySevere) and TfL's is a 0–20 integer
 * scale. Both are collapsed rather than invented: `unknown` is a real and common answer, and is
 * shown as such rather than defaulted to "minor".
 */
export const DisruptionSeveritySchema = z.enum([
  "unknown",
  "information",
  "minor",
  "moderate",
  "severe",
]);
export type DisruptionSeverity = z.infer<typeof DisruptionSeveritySchema>;

/** Where the notice is in its life, using the publisher's own word for it. */
export const DisruptionLifecycleSchema = z.enum(["planned", "open", "closed", "unknown"]);
export type DisruptionLifecycle = z.infer<typeof DisruptionLifecycleSchema>;

export const DisruptionReasonSchema = z.object({
  /** Which SIRI reason element carried it, or the publisher's own category name. */
  category: z.string().min(1),
  /** The published value, e.g. "roadworks", "vandalism", "congestion". */
  value: z.string().min(1),
});
export type DisruptionReason = z.infer<typeof DisruptionReasonSchema>;

export const AffectedRouteSchema = z.object({
  lineRef: z.string().optional(),
  publishedLineName: z.string().optional(),
  operatorRef: z.string().optional(),
  operatorName: z.string().optional(),
  /** Resolved against the published network where a match was found; null when it was not. */
  serviceRouteId: z.string().uuid().nullable().default(null),
});
export type AffectedRoute = z.infer<typeof AffectedRouteSchema>;

export const AffectedStopSchema = z.object({
  atcoCode: z.string().min(1),
  name: z.string().optional(),
  coordinate: CoordinateSchema.optional(),
});
export type AffectedStop = z.infer<typeof AffectedStopSchema>;

export const DisruptionNoticeSchema = z.object({
  /** Stable within a source: derived from the publisher's own situation number. */
  id: z.string().min(1),
  source: DisruptionSourceSchema,
  /** The publisher's identifier, kept so a passenger can be pointed at the original. */
  sourceRef: z.string().min(1),
  /** Who published it, as they name themselves. */
  publisher: z.string().optional(),

  /**
   * Whether this is an announcement or something Bus Stops worked out.
   *
   * Only ever "official" in this model today — "observed" exists so the two layers the passenger
   * sees can share one list shape without the observed half having to pretend to be a notice.
   */
  officialStatus: z.enum(["official", "observed"]),
  lifecycle: DisruptionLifecycleSchema,
  severity: DisruptionSeveritySchema,

  summary: z.string().min(1),
  description: z.string().optional(),
  /** Advice to travellers, where the publisher gave any. */
  advice: z.string().optional(),
  /** Null unless the publisher stated a cause. Never inferred. */
  reason: DisruptionReasonSchema.nullable().default(null),

  startsAt: IsoInstantSchema.nullable().default(null),
  endsAt: IsoInstantSchema.nullable().default(null),
  /** When the publisher last changed it, which is what "updated" should mean to a reader. */
  updatedAt: IsoInstantSchema.nullable().default(null),

  affectedRoutes: z.array(AffectedRouteSchema).default([]),
  affectedStops: z.array(AffectedStopSchema).default([]),
  /** Free-text areas the publisher named, e.g. "Leeds city centre". */
  affectedAreas: z.array(z.string()).default([]),

  /** Where to read the publisher's own page, when one was given. */
  infoLinks: z.array(z.object({ url: z.string().url(), label: z.string().optional() })).default([]),
  attribution: z.string().min(1),
  provenance: ProvenanceSchema,
});
export type DisruptionNotice = z.infer<typeof DisruptionNoticeSchema>;

/**
 * What the passenger disruption surface returns.
 *
 * The two layers are named separately rather than merged and sorted, because "an operator says
 * this route is diverted" and "we have seen these buses running slowly" are different kinds of
 * claim and a reader is entitled to know which they are looking at.
 */
export const DisruptionBoardSchema = z.object({
  official: z.array(DisruptionNoticeSchema).default([]),
  /**
   * Sources that were asked, and what came back — so "nothing here" can be told apart from
   * "nobody asked". A feed that legitimately has no notices right now says so.
   */
  sourcesQueried: z
    .array(
      z.object({
        source: DisruptionSourceSchema,
        outcome: z.enum(["ok", "empty", "failed", "not_configured"]),
        records: z.number().int().nonnegative(),
        queriedAt: IsoInstantSchema,
        /** A short failure class; never a URL and never a credential. */
        error: z.string().optional(),
      }),
    )
    .default([]),
});
export type DisruptionBoard = z.infer<typeof DisruptionBoardSchema>;
