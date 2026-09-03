import { z } from "zod";
import type {
  Confidence,
  DeparturePrediction,
  Incident,
  Provenance,
  Stop,
} from "@busstops/contracts";
import { isPlausibleEnglandCoordinate } from "@busstops/pipeline-core";
import { deterministicUuid } from "./identity.js";

/**
 * TfL Unified API adapter — London (docs/05_DATA_SOURCES.md).
 *
 * Important honesty constraint: the Unified API publishes arrival *predictions*, not raw
 * vehicle GPS. A prediction names the vehicle and the stop it is approaching, so London
 * vehicle positions are an inference from "vehicle V reaches stop S in N seconds", never an
 * observation. `deriveLondonVehiclePosition` therefore returns a position tagged with
 * low/medium confidence and the UI must present it as inferred. This is why the normalized
 * model separates observed fact from derived inference.
 */

export const TFL_BASE_URL = "https://api.tfl.gov.uk";

export const TflArrivalSchema = z.object({
  id: z.string(),
  operationType: z.number().optional(),
  vehicleId: z.string().optional().default(""),
  naptanId: z.string(),
  stationName: z.string().optional().default(""),
  lineId: z.string(),
  lineName: z.string(),
  platformName: z.string().optional().default(""),
  direction: z.string().optional().default(""),
  destinationNaptanId: z.string().optional().default(""),
  destinationName: z.string().optional().default(""),
  timestamp: z.string(),
  timeToStation: z.number(),
  currentLocation: z.string().optional().default(""),
  towards: z.string().optional().default(""),
  expectedArrival: z.string(),
  modeName: z.string().optional().default("bus"),
  timing: z
    .object({
      countdownServerAdjustment: z.string().optional(),
      source: z.string().optional(),
      insert: z.string().optional(),
      read: z.string().optional(),
      sent: z.string().optional(),
      received: z.string().optional(),
    })
    .optional(),
});
export type TflArrival = z.infer<typeof TflArrivalSchema>;

export const TflStopPointSchema = z.object({
  naptanId: z.string(),
  commonName: z.string(),
  stopLetter: z.string().optional().default(""),
  lat: z.number(),
  lon: z.number(),
  modes: z.array(z.string()).default([]),
  stopType: z.string().optional().default(""),
  status: z.boolean().optional().default(true),
  lines: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .optional()
    .default([]),
});
export type TflStopPoint = z.infer<typeof TflStopPointSchema>;

export const TflRouteSequenceSchema = z.object({
  lineId: z.string(),
  lineName: z.string(),
  direction: z.string(),
  isOutboundOnly: z.boolean().optional().default(false),
  mode: z.string().optional().default("bus"),
  lineStrings: z.array(z.string()).default([]),
  stopPointSequences: z
    .array(
      z.object({
        lineId: z.string().optional().default(""),
        branchId: z.number().optional().default(0),
        direction: z.string().optional().default(""),
        stopPoint: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            lat: z.number(),
            lon: z.number(),
            stopLetter: z.string().optional().default(""),
          }),
        ),
      }),
    )
    .default([]),
});
export type TflRouteSequence = z.infer<typeof TflRouteSequenceSchema>;

export const TflDisruptionSchema = z.object({
  category: z.string().optional().default(""),
  categoryDescription: z.string().optional().default(""),
  description: z.string(),
  affectedRoutes: z.array(z.unknown()).optional().default([]),
  affectedStops: z
    .array(z.object({ id: z.string() }).passthrough())
    .optional()
    .default([]),
  closureText: z.string().optional().default(""),
  created: z.string().optional(),
  lastUpdate: z.string().optional(),
});
export type TflDisruption = z.infer<typeof TflDisruptionSchema>;

function tflProvenance(retrievedAt: string, externalId: string): Provenance {
  return {
    source: "tfl",
    retrievedAt,
    externalIds: [{ source: "tfl", id: externalId }],
  };
}

export interface TflNormalizeOptions {
  retrievedAt: string;
  now: Date;
}

/**
 * Confidence for a TfL arrival. TfL predictions are generally strong close to the stop and
 * weaken further out, so confidence falls with the horizon rather than being asserted flat.
 */
export function arrivalConfidence(timeToStationSeconds: number, ageSeconds: number): Confidence {
  const reasons: string[] = [];
  let score = 0.9;

  if (timeToStationSeconds > 1800) {
    score -= 0.35;
    reasons.push("prediction horizon beyond 30 minutes");
  } else if (timeToStationSeconds > 900) {
    score -= 0.2;
    reasons.push("prediction horizon beyond 15 minutes");
  }

  if (ageSeconds > 120) {
    score -= 0.3;
    reasons.push(`prediction is ${Math.round(ageSeconds)}s old`);
  } else if (ageSeconds > 60) {
    score -= 0.1;
    reasons.push("prediction is over a minute old");
  }

  score = Math.max(0.05, Math.min(1, score));
  const level = score >= 0.75 ? "high" : score >= 0.45 ? "medium" : "low";
  return { level, score, reasons };
}

/** Uncertainty widens with the prediction horizon; a 30-minute prediction is not ±30 seconds. */
export function arrivalUncertaintySeconds(timeToStationSeconds: number): number {
  if (timeToStationSeconds <= 120) return 30;
  if (timeToStationSeconds <= 600) return 60;
  if (timeToStationSeconds <= 1800) return 180;
  return 300;
}

export function normalizeTflArrival(
  arrival: TflArrival,
  options: TflNormalizeOptions,
): DeparturePrediction {
  const expected = new Date(arrival.expectedArrival);
  const ageSeconds = Math.max(
    0,
    (options.now.getTime() - new Date(arrival.timestamp).getTime()) / 1000,
  );

  return {
    id: deterministicUuid("journey", `tfl:${arrival.id}:${arrival.expectedArrival}`),
    provenance: tflProvenance(options.retrievedAt, arrival.id),
    ingestedAt: options.retrievedAt,
    qualityFlags: ageSeconds > 180 ? ["stale"] : [],
    stopId: deterministicUuid("stop", arrival.naptanId),
    scheduledJourneyId: null,
    routePatternId: null,
    serviceRoutePublicName: arrival.lineName,
    destinationName: arrival.destinationName || arrival.towards || "Unknown destination",
    // TfL publishes a prediction, not a timetable time, on this endpoint.
    scheduledTime: null,
    expectedTime: expected.toISOString(),
    liveState: "live",
    uncertaintySeconds: arrivalUncertaintySeconds(arrival.timeToStation),
    confidence: arrivalConfidence(arrival.timeToStation, ageSeconds),
  };
}

export function normalizeTflArrivals(
  payload: unknown,
  options: TflNormalizeOptions,
): { departures: DeparturePrediction[]; rejected: number } {
  const array = Array.isArray(payload) ? payload : [];
  const departures: DeparturePrediction[] = [];
  let rejected = 0;

  for (const item of array) {
    const parsed = TflArrivalSchema.safeParse(item);
    if (!parsed.success) {
      rejected += 1;
      continue;
    }
    departures.push(normalizeTflArrival(parsed.data, options));
  }

  departures.sort((a, b) => (a.expectedTime ?? "").localeCompare(b.expectedTime ?? ""));
  return { departures, rejected };
}

export function normalizeTflStopPoint(point: TflStopPoint, retrievedAt: string): Stop | null {
  const coordinate = { lat: point.lat, lon: point.lon };
  if (!isPlausibleEnglandCoordinate(coordinate)) return null;

  return {
    id: deterministicUuid("stop", point.naptanId),
    provenance: tflProvenance(retrievedAt, point.naptanId),
    ingestedAt: retrievedAt,
    qualityFlags: [],
    atcoCode: point.naptanId,
    name: point.commonName,
    ...(point.stopLetter.length > 0 ? { indicator: point.stopLetter } : {}),
    locationCoordinate: coordinate,
    stopType: "on_street_bus",
    localityId: null,
    amenities: [],
    active: point.status,
    naptanStatus: point.status ? "active" : "deleted",
    supersededByStopId: null,
  };
}

export interface TflRoutePatternResult {
  lineId: string;
  lineName: string;
  direction: "outbound" | "inbound";
  stopAtcoCodes: string[];
  shape: Array<{ lat: number; lon: number }>;
}

/** TfL lineStrings are JSON-encoded GeoJSON coordinate arrays in [lon, lat] order. */
export function parseTflLineString(raw: string): Array<{ lat: number; lon: number }> {
  try {
    const parsed: unknown = JSON.parse(raw);
    const coordinates = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed[0] : parsed;
    if (!Array.isArray(coordinates)) return [];
    return coordinates
      .filter((pair): pair is [number, number] => Array.isArray(pair) && pair.length >= 2)
      .map(([lon, lat]) => ({ lat, lon }))
      .filter((c) => isPlausibleEnglandCoordinate(c));
  } catch {
    return [];
  }
}

export function normalizeTflRouteSequence(payload: unknown): TflRoutePatternResult | null {
  const parsed = TflRouteSequenceSchema.safeParse(payload);
  if (!parsed.success) return null;
  const sequence = parsed.data;

  const stopAtcoCodes: string[] = [];
  for (const branch of sequence.stopPointSequences) {
    for (const stop of branch.stopPoint) {
      if (!stopAtcoCodes.includes(stop.id)) stopAtcoCodes.push(stop.id);
    }
  }

  const shape = sequence.lineStrings.flatMap(parseTflLineString);

  return {
    lineId: sequence.lineId,
    lineName: sequence.lineName,
    direction: sequence.direction === "inbound" ? "inbound" : "outbound",
    stopAtcoCodes,
    shape,
  };
}

export function normalizeTflDisruption(
  payload: unknown,
  options: TflNormalizeOptions,
): Incident | null {
  const parsed = TflDisruptionSchema.safeParse(payload);
  if (!parsed.success) return null;
  const disruption = parsed.data;

  const startedAt = disruption.created ?? options.retrievedAt;
  return {
    id: deterministicUuid("incident", `tfl:${disruption.description}:${startedAt}`),
    provenance: tflProvenance(options.retrievedAt, "disruption"),
    ingestedAt: options.retrievedAt,
    qualityFlags: [],
    type: "road_closure",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: null,
    geometry: { corridorId: "tfl-disruption" },
    affectedRouteIds: [],
    affectedVehicleRefs: [],
    severity: "elevated",
    // An operator-published disruption is an official fact, not a derived inference.
    confidence: { level: "high", score: 0.9, reasons: ["published by the operator"] },
    evidence: [
      {
        kind: "official_source",
        refId: "tfl",
        description: disruption.categoryDescription || disruption.category || "TfL disruption",
      },
    ],
    officialStatus: "official",
    lifecycle: "active",
    narrative: disruption.description,
  };
}

export interface InferredVehiclePosition {
  vehicleRef: string;
  /** The stop the vehicle is approaching; the inferred position is at or before it. */
  approachingStopAtcoCode: string;
  secondsToStop: number;
  confidence: Confidence;
  /** Always true for London: the Unified API does not publish raw vehicle GPS. */
  inferred: true;
}

/**
 * Derives what can honestly be said about a London vehicle's position from arrival
 * predictions. It deliberately returns the stop being approached and a time, not a fabricated
 * coordinate: the product may interpolate along the route shape for display, but must label
 * that as inferred and never present it as an observation.
 */
export function deriveLondonVehiclePosition(
  arrivals: readonly TflArrival[],
): InferredVehiclePosition | null {
  const withVehicle = arrivals.filter((a) => a.vehicleId.length > 0);
  if (withVehicle.length === 0) return null;

  const next = withVehicle.reduce((earliest, candidate) =>
    candidate.timeToStation < earliest.timeToStation ? candidate : earliest,
  );

  const score = next.timeToStation <= 120 ? 0.7 : next.timeToStation <= 600 ? 0.5 : 0.3;
  return {
    vehicleRef: next.vehicleId,
    approachingStopAtcoCode: next.naptanId,
    secondsToStop: next.timeToStation,
    confidence: {
      level: score >= 0.7 ? "medium" : "low",
      score,
      reasons: [
        "position inferred from arrival predictions; TfL does not publish raw vehicle positions",
      ],
    },
    inferred: true,
  };
}

/** Builds a request URL with the app key attached only server-side. */
export function tflUrl(
  path: string,
  appKey: string | undefined,
  params: Record<string, string> = {},
): string {
  const url = new URL(path.startsWith("http") ? path : `${TFL_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  if (appKey) url.searchParams.set("app_key", appKey);
  return url.toString();
}
