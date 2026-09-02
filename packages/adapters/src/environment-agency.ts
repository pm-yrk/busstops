import { z } from "zod";
import type { FloodNotice, FloodNoticeSeverity } from "@busstops/contracts";
import { deterministicUuid } from "./identity.js";

/**
 * Environment Agency real-time flood-monitoring adapter (docs/05_DATA_SOURCES.md).
 *
 * Only an active EA notice may be called a flood warning. Everything the platform derives
 * itself is worded as elevated risk or rain-associated disruption; `isOfficialWarning` is the
 * single place that distinction is decided, so the wording rule is testable.
 */

export const EA_FLOODS_URL = "https://environment.data.gov.uk/flood-monitoring/id/floods";

export const EaFloodAreaSchema = z.object({
  "@id": z.string().optional(),
  county: z.string().optional(),
  description: z.string().optional(),
  eaAreaName: z.string().optional(),
  fwdCode: z.string().optional(),
  lat: z.number().optional(),
  long: z.number().optional(),
  notation: z.string().optional(),
  polygon: z.string().optional(),
  riverOrSea: z.string().optional(),
});

export const EaFloodItemSchema = z.object({
  "@id": z.string(),
  description: z.string(),
  eaAreaName: z.string().optional(),
  eaRegionName: z.string().optional(),
  floodArea: EaFloodAreaSchema.optional(),
  floodAreaID: z.string(),
  isTidal: z.boolean().optional(),
  message: z.string().optional(),
  severity: z.string(),
  /** 1 = severe flood warning, 2 = flood warning, 3 = flood alert, 4 = no longer in force. */
  severityLevel: z.number(),
  timeMessageChanged: z.string().optional(),
  timeRaised: z.string(),
  timeSeverityChanged: z.string().optional(),
});
export type EaFloodItem = z.infer<typeof EaFloodItemSchema>;

export const EaFloodsResponseSchema = z.object({
  items: z.union([EaFloodItemSchema, z.array(EaFloodItemSchema)]),
});

export function mapSeverityLevel(level: number): FloodNoticeSeverity | null {
  switch (level) {
    case 1:
      return "severe_warning";
    case 2:
      return "warning";
    case 3:
      return "alert";
    default:
      // Level 4 means the notice is no longer in force, so it is not an active notice.
      return null;
  }
}

/**
 * True only for an active, official EA warning. Alerts and withdrawn notices are not warnings,
 * and nothing the platform infers ever passes through here.
 */
export function isOfficialWarning(item: EaFloodItem): boolean {
  return item.severityLevel === 1 || item.severityLevel === 2;
}

export interface FloodNormalizeOptions {
  retrievedAt: string;
}

export interface FloodNormalizeResult {
  notices: FloodNotice[];
  /** Notices the EA has withdrawn, so active state can be cleared rather than left stale. */
  withdrawnFloodAreaIds: string[];
  rejected: number;
}

export function normalizeEaFloods(
  payload: unknown,
  options: FloodNormalizeOptions,
): FloodNormalizeResult {
  const parsed = EaFloodsResponseSchema.safeParse(payload);
  if (!parsed.success) return { notices: [], withdrawnFloodAreaIds: [], rejected: 1 };

  const items = Array.isArray(parsed.data.items) ? parsed.data.items : [parsed.data.items];
  const notices: FloodNotice[] = [];
  const withdrawnFloodAreaIds: string[] = [];
  let rejected = 0;

  for (const item of items) {
    const severity = mapSeverityLevel(item.severityLevel);
    if (severity === null) {
      withdrawnFloodAreaIds.push(item.floodAreaID);
      continue;
    }

    const raisedAt = new Date(item.timeRaised);
    if (Number.isNaN(raisedAt.getTime())) {
      rejected += 1;
      continue;
    }

    notices.push({
      id: deterministicUuid("incident", `ea-flood:${item.floodAreaID}:${item.timeRaised}`),
      provenance: {
        source: "environment_agency",
        retrievedAt: options.retrievedAt,
        externalIds: [{ source: "environment_agency", id: item.floodAreaID }],
      },
      ingestedAt: options.retrievedAt,
      qualityFlags: [],
      eaFloodAreaId: item.floodAreaID,
      severity,
      description: item.description,
      raisedAt: raisedAt.toISOString(),
      // The EA does not publish an expiry; a notice is active until withdrawn.
      activeUntil: null,
      officialUrl: `https://check-for-flooding.service.gov.uk/target-area/${encodeURIComponent(
        item.floodAreaID,
      )}`,
    });
  }

  return { notices, withdrawnFloodAreaIds, rejected };
}

/**
 * Wording gate. The product may only say "flood warning active" when an official warning
 * exists; otherwise it says "elevated flooding risk", per docs/08_ANALYTICS_ENGINE.md.
 */
export function floodWording(
  notices: readonly FloodNotice[],
  derivedRiskElevated: boolean,
): string | null {
  const warning = notices.find((n) => n.severity === "warning" || n.severity === "severe_warning");
  if (warning) {
    return warning.severity === "severe_warning"
      ? "Severe flood warning active"
      : "Flood warning active";
  }
  if (notices.some((n) => n.severity === "alert")) return "Flood alert active";
  if (derivedRiskElevated) return "Elevated flooding risk";
  return null;
}
