import { z } from "zod";
import type { Coordinate, RoadEvent } from "@busstops/contracts";
import { isPlausibleEnglandCoordinate } from "@busstops/pipeline-core";
import { deterministicUuid } from "./identity.js";

/**
 * National Highways and Street Manager adapters — official road context.
 *
 * Two honesty constraints run through this module:
 *  - National Highways covers the strategic road network only. `coverageCaveat` is attached to
 *    every event so the UI can never imply local-street coverage from motorway data.
 *  - A street works permit is evidence that works are planned or active nearby. It is never
 *    proof that the works caused a delay, so nothing here sets a causal field.
 */

export const NATIONAL_HIGHWAYS_COVERAGE_CAVEAT =
  "Covers the strategic road network (motorways and major A roads) only, not local streets.";

export const NationalHighwaysEventSchema = z.object({
  id: z.string(),
  category: z.string().optional(),
  subCategory: z.string().optional(),
  description: z.string(),
  roadName: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  startDate: z.string(),
  endDate: z.string().nullable().optional(),
  severity: z.string().optional(),
  url: z.string().url().optional(),
});
export type NationalHighwaysEvent = z.infer<typeof NationalHighwaysEventSchema>;

export const StreetManagerPermitSchema = z.object({
  work_reference_number: z.string(),
  permit_reference_number: z.string().optional(),
  street_name: z.string().optional(),
  area_name: z.string().optional(),
  work_category: z.string().optional(),
  activity_type: z.string().optional(),
  proposed_start_date: z.string(),
  proposed_end_date: z.string().optional(),
  actual_start_date_time: z.string().optional(),
  actual_end_date_time: z.string().optional(),
  work_status: z.string().optional(),
  /** Street Manager publishes location as WKT, usually a POINT. */
  activity_location_coordinates: z.string().optional(),
  traffic_management_type: z.string().optional(),
  description_of_work: z.string().optional(),
});
export type StreetManagerPermit = z.infer<typeof StreetManagerPermitSchema>;

/** Parses the WKT geometry Street Manager publishes, in EPSG:27700 or WGS84. */
export function parseWktPoint(wkt: string): { easting: number; northing: number } | null {
  const match = wkt.trim().match(/^POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i);
  if (!match) return null;
  return { easting: Number(match[1]), northing: Number(match[2]) };
}

export interface RoadEventNormalizeOptions {
  retrievedAt: string;
  /** Converts a British National Grid reference when the source publishes one. */
  gridToWgs84?: (easting: number, northing: number) => Coordinate | null;
}

export function normalizeNationalHighwaysEvent(
  payload: unknown,
  options: RoadEventNormalizeOptions,
): (RoadEvent & { coverageCaveat: string }) | null {
  const parsed = NationalHighwaysEventSchema.safeParse(payload);
  if (!parsed.success) return null;
  const event = parsed.data;

  const startedAt = new Date(event.startDate);
  if (Number.isNaN(startedAt.getTime())) return null;

  const coordinate =
    event.latitude !== undefined && event.longitude !== undefined
      ? { lat: event.latitude, lon: event.longitude }
      : undefined;
  if (coordinate && !isPlausibleEnglandCoordinate(coordinate)) return null;

  const category = (event.category ?? "").toLowerCase();
  const type: RoadEvent["type"] = category.includes("closure")
    ? "closure"
    : category.includes("roadwork")
      ? "roadworks"
      : "incident";

  const endedAtRaw = event.endDate ? new Date(event.endDate) : null;

  return {
    id: deterministicUuid("incident", `nh:${event.id}`),
    provenance: {
      source: "national_highways",
      retrievedAt: options.retrievedAt,
      externalIds: [{ source: "national_highways", id: event.id }],
    },
    ingestedAt: options.retrievedAt,
    qualityFlags: [],
    type,
    sourceSystem: "national_highways",
    ...(coordinate === undefined ? {} : { coordinate }),
    startedAt: startedAt.toISOString(),
    endedAt: endedAtRaw && !Number.isNaN(endedAtRaw.getTime()) ? endedAtRaw.toISOString() : null,
    description: [event.roadName, event.description].filter(Boolean).join(": "),
    ...(event.url === undefined ? {} : { officialUrl: event.url }),
    coverageCaveat: NATIONAL_HIGHWAYS_COVERAGE_CAVEAT,
  };
}

export function normalizeStreetManagerPermit(
  payload: unknown,
  options: RoadEventNormalizeOptions,
): RoadEvent | null {
  const parsed = StreetManagerPermitSchema.safeParse(payload);
  if (!parsed.success) return null;
  const permit = parsed.data;

  const startedAt = new Date(permit.actual_start_date_time ?? permit.proposed_start_date);
  if (Number.isNaN(startedAt.getTime())) return null;

  const endRaw = permit.actual_end_date_time ?? permit.proposed_end_date;
  const endedAt = endRaw ? new Date(endRaw) : null;

  let coordinate: Coordinate | undefined;
  if (permit.activity_location_coordinates) {
    const point = parseWktPoint(permit.activity_location_coordinates);
    if (point) {
      // Values in the hundreds of thousands are a National Grid reference, not lat/lon.
      const looksLikeGrid = Math.abs(point.easting) > 180 || Math.abs(point.northing) > 90;
      const candidate = looksLikeGrid
        ? (options.gridToWgs84?.(point.easting, point.northing) ?? null)
        : { lat: point.northing, lon: point.easting };
      if (candidate && isPlausibleEnglandCoordinate(candidate)) coordinate = candidate;
    }
  }

  return {
    id: deterministicUuid("incident", `sm:${permit.work_reference_number}`),
    provenance: {
      source: "street_manager",
      retrievedAt: options.retrievedAt,
      externalIds: [{ source: "street_manager", id: permit.work_reference_number }],
    },
    ingestedAt: options.retrievedAt,
    qualityFlags: [],
    type: "roadworks",
    sourceSystem: "street_manager",
    ...(coordinate === undefined ? {} : { coordinate }),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt && !Number.isNaN(endedAt.getTime()) ? endedAt.toISOString() : null,
    description: [permit.street_name, permit.description_of_work ?? permit.activity_type]
      .filter(Boolean)
      .join(": "),
  };
}

export interface CorroborationMatch {
  event: RoadEvent;
  distanceMetres: number;
  /** How well the event's time window overlaps the observed disruption. */
  temporalOverlap: boolean;
  confidence: "low" | "medium" | "high";
  /** Always phrased as corroboration, never causation. */
  wording: string;
}

/**
 * Matches an observed disruption to official road events by distance and time window.
 * Deliberately returns corroboration wording, not a cause: a permit near a delay is evidence
 * worth showing, not proof of what happened.
 */
export function corroborateWithRoadEvents(
  disruption: { coordinate: Coordinate; startedAt: string; endedAt: string | null },
  events: readonly RoadEvent[],
  distance: (a: Coordinate, b: Coordinate) => number,
  maxDistanceMetres = 250,
): CorroborationMatch[] {
  const disruptionStart = new Date(disruption.startedAt).getTime();
  const disruptionEnd = disruption.endedAt ? new Date(disruption.endedAt).getTime() : Date.now();

  const matches: CorroborationMatch[] = [];

  for (const event of events) {
    if (!event.coordinate) continue;
    const distanceMetres = distance(disruption.coordinate, event.coordinate);
    if (distanceMetres > maxDistanceMetres) continue;

    const eventStart = new Date(event.startedAt).getTime();
    const eventEnd = event.endedAt ? new Date(event.endedAt).getTime() : Number.POSITIVE_INFINITY;
    const temporalOverlap = eventStart <= disruptionEnd && eventEnd >= disruptionStart;
    if (!temporalOverlap) continue;

    const confidence = distanceMetres < 75 ? "high" : distanceMetres < 150 ? "medium" : "low";

    matches.push({
      event,
      distanceMetres,
      temporalOverlap,
      confidence,
      wording:
        `${event.type === "roadworks" ? "Roadworks" : "A road event"} recorded ` +
        `${Math.round(distanceMetres)}m away over the same period`,
    });
  }

  return matches.sort((a, b) => a.distanceMetres - b.distanceMetres);
}
