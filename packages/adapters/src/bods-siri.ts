import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { BoundingBox, VehicleObservation } from "@busstops/contracts";
import { isPlausibleEnglandCoordinate } from "@busstops/pipeline-core";
import { deterministicUuid, opaqueVehicleRef } from "./identity.js";
import { child, dig, many, text, type XmlValue } from "./xml.js";

/**
 * BODS SIRI-VM adapter — live vehicle positions for England outside London.
 *
 * The BODS datafeed endpoint accepts a bounding box, which is what makes a viewport-scoped
 * live map possible without ever fetching a national feed per browser
 * (docs/13_FREE_TIER_RULES.md "Required controls").
 *
 * Vehicle references are hashed with a rotating daily salt before they leave this adapter:
 * operator vehicle codes are stable for months, and republishing them would let anyone follow
 * an individual vehicle across days.
 */

export const BODS_DATAFEED_URL = "https://data.bus-data.dft.gov.uk/api/v1/datafeed/";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  // Namespace prefixes vary between producers; strip them so one parser handles all feeds.
  removeNSPrefix: true,
});

export const SiriVehicleLocationSchema = z.object({
  Longitude: z.string(),
  Latitude: z.string(),
});

export const MonitoredVehicleJourneySchema = z.object({
  LineRef: z.union([z.string(), z.number()]).optional(),
  DirectionRef: z.union([z.string(), z.number()]).optional(),
  PublishedLineName: z.union([z.string(), z.number()]).optional(),
  OperatorRef: z.union([z.string(), z.number()]).optional(),
  OriginRef: z.union([z.string(), z.number()]).optional(),
  OriginName: z.union([z.string(), z.number()]).optional(),
  DestinationRef: z.union([z.string(), z.number()]).optional(),
  DestinationName: z.union([z.string(), z.number()]).optional(),
  OriginAimedDepartureTime: z.string().optional(),
  VehicleLocation: SiriVehicleLocationSchema,
  Bearing: z.union([z.string(), z.number()]).optional(),
  BlockRef: z.union([z.string(), z.number()]).optional(),
  VehicleRef: z.union([z.string(), z.number()]),
  FramedVehicleJourneyRef: z
    .object({
      DataFrameRef: z.union([z.string(), z.number()]).optional(),
      DatedVehicleJourneyRef: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});
export type MonitoredVehicleJourney = z.infer<typeof MonitoredVehicleJourneySchema>;

export const VehicleActivitySchema = z.object({
  RecordedAtTime: z.string(),
  ItemIdentifier: z.string().optional(),
  ValidUntilTime: z.string().optional(),
  MonitoredVehicleJourney: MonitoredVehicleJourneySchema,
});
export type VehicleActivity = z.infer<typeof VehicleActivitySchema>;

function asString(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  return text.length === 0 ? undefined : text;
}

export interface SiriParseResult {
  activities: VehicleActivity[];
  responseTimestamp: string | null;
  rejected: Array<{ reason: string; index: number }>;
}

/** Extracts vehicle activities from a SIRI-VM document, tolerating producer variations. */
export function parseSiriVm(xml: string): SiriParseResult {
  let document: XmlValue;
  try {
    document = parser.parse(xml) as XmlValue;
  } catch {
    return {
      activities: [],
      responseTimestamp: null,
      rejected: [{ reason: "unparseable XML", index: -1 }],
    };
  }

  const root = dig(document, "Siri", "ServiceDelivery");
  if (root === undefined) {
    return {
      activities: [],
      responseTimestamp: null,
      rejected: [{ reason: "no ServiceDelivery", index: -1 }],
    };
  }

  const responseTimestamp = text(child(root, "ResponseTimestamp")) ?? null;

  const rawActivities = many(child(root, "VehicleMonitoringDelivery")).flatMap((delivery) =>
    many(child(delivery, "VehicleActivity")),
  );

  const activities: VehicleActivity[] = [];
  const rejected: Array<{ reason: string; index: number }> = [];

  rawActivities.forEach((raw, index) => {
    const parsed = VehicleActivitySchema.safeParse(raw);
    if (parsed.success) {
      activities.push(parsed.data);
    } else {
      rejected.push({
        reason: parsed.error.issues
          .slice(0, 2)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
        index,
      });
    }
  });

  return { activities, responseTimestamp, rejected };
}

export interface SiriNormalizeOptions {
  retrievedAt: string;
  /** Rotating salt so public vehicle references cannot be correlated across service days. */
  vehicleSalt: string;
  /** Discard observations older than this; a stale position is worse than none. */
  maxAgeSeconds?: number;
  now?: Date;
}

export interface SiriNormalizeResult {
  observations: VehicleObservation[];
  journeyContext: Map<
    string,
    {
      lineRef: string | undefined;
      publishedLineName: string | undefined;
      directionRef: string | undefined;
      operatorRef: string | undefined;
      destinationName: string | undefined;
      originName: string | undefined;
      datedVehicleJourneyRef: string | undefined;
      blockRef: string | undefined;
    }
  >;
  rejected: Array<{ reason: string; vehicleRef?: string }>;
  /**
   * Age in seconds of every record the feed offered, accepted or not.
   *
   * A viewport with no buses because the feed was empty and one with no buses because every
   * record was twenty minutes old are different faults, and only the ages tell them apart.
   */
  recordAgeSeconds: number[];
}

export function normalizeSiriVm(xml: string, options: SiriNormalizeOptions): SiriNormalizeResult {
  const { activities, rejected: parseRejected } = parseSiriVm(xml);
  const now = options.now ?? new Date(options.retrievedAt);
  const maxAgeSeconds = options.maxAgeSeconds ?? 600;

  const observations: VehicleObservation[] = [];
  const journeyContext: SiriNormalizeResult["journeyContext"] = new Map();
  const rejected: SiriNormalizeResult["rejected"] = parseRejected.map((r) => ({
    reason: r.reason,
  }));
  const recordAgeSeconds: number[] = [];

  for (const activity of activities) {
    const journey = activity.MonitoredVehicleJourney;
    const sourceVehicleRef = asString(journey.VehicleRef);
    if (!sourceVehicleRef) {
      rejected.push({ reason: "missing VehicleRef" });
      continue;
    }

    const lat = Number(journey.VehicleLocation.Latitude);
    const lon = Number(journey.VehicleLocation.Longitude);
    const coordinate = { lat, lon };
    if (!isPlausibleEnglandCoordinate(coordinate)) {
      rejected.push({ reason: "implausible coordinate", vehicleRef: sourceVehicleRef });
      continue;
    }

    const observedAt = new Date(activity.RecordedAtTime);
    if (Number.isNaN(observedAt.getTime())) {
      rejected.push({ reason: "unparseable RecordedAtTime", vehicleRef: sourceVehicleRef });
      continue;
    }

    const ageSeconds = (now.getTime() - observedAt.getTime()) / 1000;
    recordAgeSeconds.push(Math.round(ageSeconds));
    if (ageSeconds > maxAgeSeconds) {
      rejected.push({
        reason: `observation ${Math.round(ageSeconds)}s old`,
        vehicleRef: sourceVehicleRef,
      });
      continue;
    }
    // A timestamp meaningfully in the future indicates a broken producer clock.
    if (ageSeconds < -120) {
      rejected.push({
        reason: "observation timestamp in the future",
        vehicleRef: sourceVehicleRef,
      });
      continue;
    }

    const vehicleRef = opaqueVehicleRef(sourceVehicleRef, options.vehicleSalt);
    const bearingRaw = Number(asString(journey.Bearing) ?? Number.NaN);
    const bearing =
      Number.isFinite(bearingRaw) && bearingRaw >= 0 && bearingRaw < 360
        ? Math.round(bearingRaw)
        : undefined;

    const datedVehicleJourneyRef = asString(
      journey.FramedVehicleJourneyRef?.DatedVehicleJourneyRef,
    );

    /*
     * Read once and used twice: on the observation that gets published, and in the journey
     * context the edge uses in-process. `PublishedLineName` falls back to `LineRef` because many
     * publishers give only the latter and a passenger-facing name is better than nothing.
     */
    const lineRef = asString(journey.LineRef);
    const publishedLineName = asString(journey.PublishedLineName) ?? lineRef;
    const operatorRef = asString(journey.OperatorRef);

    observations.push({
      id: deterministicUuid("vehicle", `${vehicleRef}:${observedAt.getTime()}`),
      provenance: {
        source: "bods",
        retrievedAt: options.retrievedAt,
        // The source vehicle code is deliberately not republished as an external id.
        externalIds: datedVehicleJourneyRef
          ? [{ source: "bods_journey", id: datedVehicleJourneyRef }]
          : [],
      },
      ingestedAt: options.retrievedAt,
      qualityFlags: ageSeconds > 120 ? ["stale"] : [],
      vehicleRef,
      ...(datedVehicleJourneyRef === undefined ? {} : { journeyRef: datedVehicleJourneyRef }),
      coordinate,
      ...(bearing === undefined ? {} : { bearingDegrees: bearing }),
      observedAt: observedAt.toISOString(),
      /*
       * The route the publisher said this vehicle was working.
       *
       * These went only into `journeyContext` below, which the live collector discarded — it
       * returned `normalized.observations` and nothing else — so the identity was extracted here
       * and lost one call later. Everything downstream saw a position with no line on it.
       *
       * `journeyContext` is kept as well, because the edge uses it for the live map where the
       * whole parse is in hand. This is the copy that survives being published.
       */
      ...(lineRef === undefined ? {} : { lineRef }),
      ...(publishedLineName === undefined ? {} : { publishedLineName }),
      ...(operatorRef === undefined ? {} : { operatorRef }),
    });

    journeyContext.set(vehicleRef, {
      lineRef,
      publishedLineName,
      directionRef: asString(journey.DirectionRef),
      operatorRef,
      destinationName: asString(journey.DestinationName),
      originName: asString(journey.OriginName),
      datedVehicleJourneyRef,
      blockRef: asString(journey.BlockRef),
    });
  }

  return { observations, journeyContext, rejected, recordAgeSeconds };
}

/**
 * BODS datafeed URL for a viewport. The bounding box is clamped to the caller's cap before it
 * reaches here; this function only formats it.
 */
export function bodsDatafeedUrl(bbox: BoundingBox, apiKey: string | undefined): string {
  const url = new URL(BODS_DATAFEED_URL);
  url.searchParams.set(
    "boundingBox",
    [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(5)).join(","),
  );
  if (apiKey) url.searchParams.set("api_key", apiKey);
  return url.toString();
}
