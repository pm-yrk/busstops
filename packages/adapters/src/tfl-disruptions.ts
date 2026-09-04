import { z } from "zod";
import type { DisruptionNotice, DisruptionSeverity } from "@busstops/contracts";

/**
 * London's official disruption notices, from the TfL Unified API.
 *
 * Two feeds, because they answer different questions and a passenger needs both:
 *   /Line/Mode/bus/Status?detail=true — what an operator says about a route right now
 *   /Road/all/Disruption               — road closures and works that buses have to route around
 *
 * The rule is the same as for BODS SIRI-SX: publish what TfL said, and nothing else. A line with
 * "Good Service" is not a notice and is dropped rather than listed as a reassurance, because a
 * disruption list padded with non-disruptions is a list nobody reads.
 */

const TFL_ATTRIBUTION = "Transport for London Unified API, powered by TfL Open Data";

/**
 * TfL's severity scale is a 0–20 integer whose meaning is per-mode. These are the bus values,
 * from the published `/Line/Meta/Severity` table. Anything not listed is treated as unknown
 * rather than guessed at, and 10/18 mean there is nothing wrong.
 */
const BUS_SEVERITY: Record<number, DisruptionSeverity | "none"> = {
  0: "information", // Special Service
  1: "severe", // Closed
  2: "severe", // Suspended
  3: "severe", // Part Suspended
  4: "moderate", // Planned Closure
  5: "moderate", // Part Closure
  6: "severe", // Severe Delays
  7: "moderate", // Reduced Service
  8: "information", // Bus Service
  9: "minor", // Minor Delays
  10: "none", // Good Service
  11: "moderate", // Part Closed
  12: "information", // Exit Only
  13: "information", // No Step Free Access
  14: "moderate", // Change of frequency
  15: "moderate", // Diverted
  16: "severe", // Not Running
  17: "minor", // Issues Reported
  18: "none", // No Issues
  19: "information", // Information
  20: "severe", // Service Closed
};

export const TflValidityPeriodSchema = z.object({
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  isNow: z.boolean().optional(),
});

export const TflLineStatusSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  statusSeverity: z.number(),
  statusSeverityDescription: z.string().optional(),
  reason: z.string().optional(),
  created: z.string().optional(),
  validityPeriods: z.array(TflValidityPeriodSchema).optional().default([]),
  disruption: z
    .object({
      category: z.string().optional(),
      categoryDescription: z.string().optional(),
      description: z.string().optional(),
      closureText: z.string().optional(),
      additionalInfo: z.string().optional(),
    })
    .optional(),
});

export const TflLineSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  modeName: z.string().optional(),
  lineStatuses: z.array(TflLineStatusSchema).optional().default([]),
});

export interface TflNoticeOptions {
  retrievedAt: string;
  /** Cap on notices returned, most severe first. */
  limit?: number;
}

function isoOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const SEVERITY_RANK: DisruptionSeverity[] = [
  "unknown",
  "information",
  "minor",
  "moderate",
  "severe",
];

/**
 * Bus line statuses, as disruption notices.
 *
 * `reason` is TfL's own free-text explanation and is carried only when present — a line running
 * badly for an unstated reason must not acquire one here.
 */
export function normalizeTflLineStatuses(
  payload: unknown,
  options: TflNoticeOptions,
): { notices: DisruptionNotice[]; offered: number; rejected: number } {
  const lines = z.array(TflLineSchema).safeParse(payload);
  if (!lines.success) return { notices: [], offered: 0, rejected: 0 };

  const notices: DisruptionNotice[] = [];
  let rejected = 0;

  for (const line of lines.data) {
    for (const [index, status] of (line.lineStatuses ?? []).entries()) {
      const severity = BUS_SEVERITY[status.statusSeverity];
      if (severity === "none") continue;
      if (severity === undefined) {
        rejected += 1;
        continue;
      }

      const headline = status.statusSeverityDescription?.trim();
      if (!headline) {
        rejected += 1;
        continue;
      }

      const period =
        (status.validityPeriods ?? []).find((candidate) => candidate.isNow) ??
        status.validityPeriods?.[0];
      const description = status.disruption?.description?.trim();
      const additional = status.disruption?.additionalInfo?.trim();
      const reasonText = status.reason?.trim();

      notices.push({
        id: `tfl-status:${line.id}:${status.id ?? index}`,
        source: "tfl_status",
        sourceRef: `${line.id}:${status.id ?? index}`,
        publisher: "Transport for London",
        officialStatus: "official",
        lifecycle: period?.isNow === false ? "planned" : "open",
        severity,
        summary: `${line.name ?? line.id}: ${headline}`,
        // TfL puts the useful prose in `reason` far more often than in `disruption.description`.
        ...((description ?? reasonText) ? { description: description ?? reasonText } : {}),
        ...(additional === undefined || additional.length === 0 ? {} : { advice: additional }),
        // The category is a classification TfL published, so it is a stated reason. `closureText`
        // ("suspended", "planned") is a lifecycle word rather than a cause and is not used here.
        reason:
          status.disruption?.categoryDescription || status.disruption?.category
            ? {
                category: "tflDisruptionCategory",
                value: (status.disruption.categoryDescription ??
                  status.disruption.category) as string,
              }
            : null,
        startsAt: isoOrNull(period?.fromDate) ?? isoOrNull(status.created),
        endsAt: isoOrNull(period?.toDate),
        updatedAt: isoOrNull(status.created),
        affectedRoutes: [
          {
            lineRef: line.id,
            publishedLineName: line.name ?? line.id,
            operatorRef: "TFL",
            operatorName: "Transport for London",
            serviceRouteId: null,
          },
        ],
        affectedStops: [],
        affectedAreas: [],
        infoLinks: [
          {
            url: `https://tfl.gov.uk/bus/route/${encodeURIComponent(line.id)}/`,
            label: `Route ${line.name ?? line.id} on tfl.gov.uk`,
          },
        ],
        attribution: TFL_ATTRIBUTION,
        provenance: {
          source: "tfl",
          retrievedAt: options.retrievedAt,
          externalIds: [{ source: "tfl_line", id: line.id }],
        },
      });
    }
  }

  notices.sort((a, b) => SEVERITY_RANK.indexOf(b.severity) - SEVERITY_RANK.indexOf(a.severity));

  return {
    notices: options.limit === undefined ? notices : notices.slice(0, options.limit),
    offered: lines.data.reduce((total, line) => total + (line.lineStatuses?.length ?? 0), 0),
    rejected,
  };
}

export const TflRoadDisruptionSchema = z.object({
  id: z.string().optional(),
  category: z.string().optional(),
  subCategory: z.string().optional(),
  comments: z.string().optional(),
  currentUpdate: z.string().optional(),
  severity: z.string().optional(),
  location: z.string().optional(),
  startDateTime: z.string().optional(),
  endDateTime: z.string().optional(),
  lastModifiedTime: z.string().optional(),
  status: z.string().optional(),
  url: z.string().optional(),
});

/** TfL's road severity is a word rather than a number here. */
const ROAD_SEVERITY: Record<string, DisruptionSeverity> = {
  Severe: "severe",
  Serious: "moderate",
  Moderate: "moderate",
  Minimal: "minor",
  Minor: "minor",
  Low: "minor",
  Information: "information",
};

/** Road closures and works, which are what a diverted London bus is usually diverted around. */
export function normalizeTflRoadDisruptions(
  payload: unknown,
  options: TflNoticeOptions,
): { notices: DisruptionNotice[]; offered: number; rejected: number } {
  const parsed = z.array(TflRoadDisruptionSchema).safeParse(payload);
  if (!parsed.success) return { notices: [], offered: 0, rejected: 0 };

  const notices: DisruptionNotice[] = [];
  let rejected = 0;

  for (const [index, disruption] of parsed.data.entries()) {
    const headline = (disruption.location ?? disruption.comments ?? "").trim();
    if (headline.length === 0) {
      rejected += 1;
      continue;
    }
    const sourceRef = disruption.id ?? `road-${index}`;
    const severity =
      disruption.severity === undefined
        ? "unknown"
        : (ROAD_SEVERITY[disruption.severity] ?? "unknown");

    notices.push({
      id: `tfl-road:${sourceRef}`,
      source: "tfl_disruption",
      sourceRef,
      publisher: "Transport for London",
      officialStatus: "official",
      lifecycle: disruption.status?.toLowerCase() === "active" ? "open" : "unknown",
      severity,
      summary: headline.slice(0, 200),
      ...(disruption.comments === undefined ? {} : { description: disruption.comments }),
      ...(disruption.currentUpdate === undefined ? {} : { advice: disruption.currentUpdate }),
      reason:
        (disruption.subCategory ?? disruption.category)
          ? {
              category: "tflRoadCategory",
              value: (disruption.subCategory ?? disruption.category) as string,
            }
          : null,
      startsAt: isoOrNull(disruption.startDateTime),
      endsAt: isoOrNull(disruption.endDateTime),
      updatedAt: isoOrNull(disruption.lastModifiedTime),
      affectedRoutes: [],
      affectedStops: [],
      affectedAreas: disruption.location === undefined ? [] : [disruption.location],
      infoLinks:
        disruption.url !== undefined && /^https?:\/\//i.test(disruption.url)
          ? [{ url: disruption.url, label: "TfL road status" }]
          : [],
      attribution: TFL_ATTRIBUTION,
      provenance: {
        source: "tfl",
        retrievedAt: options.retrievedAt,
        externalIds: [{ source: "tfl_road_disruption", id: sourceRef }],
      },
    });
  }

  notices.sort((a, b) => SEVERITY_RANK.indexOf(b.severity) - SEVERITY_RANK.indexOf(a.severity));

  return {
    notices: options.limit === undefined ? notices : notices.slice(0, options.limit),
    offered: parsed.data.length,
    rejected,
  };
}
