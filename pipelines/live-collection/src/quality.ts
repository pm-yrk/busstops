import type { QualityFlag, VehicleObservation } from "@busstops/contracts";
import { VehicleObservationSchema } from "@busstops/contracts";
import { isPlausibleEnglandCoordinate } from "@busstops/pipeline-core";

/**
 * Ingest quality gates (docs/07_DATA_PIPELINES.md "Processing stages", stages 2 and 3).
 *
 * Records are rejected or flagged here rather than silently corrected. A position at 0,0, a
 * timestamp from next week, or a bearing of 400 degrees is a symptom of something wrong upstream;
 * quietly clamping it into range would hide a real feed problem and put a fabricated value into
 * every metric downstream. Rejections are counted and reported so the health signal is visible.
 */

export type RejectionReason =
  | "schema_invalid"
  | "coordinate_outside_england"
  | "timestamp_in_future"
  | "timestamp_too_old"
  | "timestamp_unparseable";

export interface QualityConfig {
  /** Clock skew tolerated before a source timestamp is treated as being in the future. */
  futureToleranceSeconds?: number;
  /** Age beyond which an observation is no longer useful for live analysis. */
  maxAgeSeconds?: number;
  /** Age beyond which the record is still admitted but flagged stale. */
  staleAfterSeconds?: number;
}

export const QUALITY_DEFAULTS = {
  futureToleranceSeconds: 120,
  maxAgeSeconds: 3600,
  staleAfterSeconds: 300,
} as const;

export interface QualityResult {
  accepted: VehicleObservation[];
  rejected: Array<{ reason: RejectionReason; detail: string }>;
  rejectionCounts: Record<RejectionReason, number>;
  flagCounts: Partial<Record<QualityFlag, number>>;
}

export function applyQualityGates(
  records: readonly unknown[],
  now: Date,
  config: QualityConfig = {},
): QualityResult {
  const futureTolerance = config.futureToleranceSeconds ?? QUALITY_DEFAULTS.futureToleranceSeconds;
  const maxAge = config.maxAgeSeconds ?? QUALITY_DEFAULTS.maxAgeSeconds;
  const staleAfter = config.staleAfterSeconds ?? QUALITY_DEFAULTS.staleAfterSeconds;

  const accepted: VehicleObservation[] = [];
  const rejected: QualityResult["rejected"] = [];
  const rejectionCounts: Record<RejectionReason, number> = {
    schema_invalid: 0,
    coordinate_outside_england: 0,
    timestamp_in_future: 0,
    timestamp_too_old: 0,
    timestamp_unparseable: 0,
  };
  const flagCounts: Partial<Record<QualityFlag, number>> = {};

  const reject = (reason: RejectionReason, detail: string): void => {
    rejectionCounts[reason] += 1;
    // Detail is bounded and carries no credential material: it names the field, not the payload.
    if (rejected.length < 50) rejected.push({ reason, detail });
  };

  for (const record of records) {
    const parsed = VehicleObservationSchema.safeParse(record);
    if (!parsed.success) {
      reject("schema_invalid", parsed.error.issues[0]?.path.join(".") ?? "unknown field");
      continue;
    }
    const observation = parsed.data;

    if (!isPlausibleEnglandCoordinate(observation.coordinate)) {
      reject("coordinate_outside_england", "coordinate outside the England bounding box");
      continue;
    }

    const observedAtMs = new Date(observation.observedAt).getTime();
    if (!Number.isFinite(observedAtMs)) {
      reject("timestamp_unparseable", "observedAt is not a valid instant");
      continue;
    }

    const ageSeconds = (now.getTime() - observedAtMs) / 1000;
    if (ageSeconds < -futureTolerance) {
      reject("timestamp_in_future", `observedAt is ${Math.round(-ageSeconds)}s ahead of now`);
      continue;
    }
    if (ageSeconds > maxAge) {
      reject("timestamp_too_old", `observedAt is ${Math.round(ageSeconds / 60)} minutes old`);
      continue;
    }

    const flags = new Set<QualityFlag>(observation.qualityFlags);
    if (ageSeconds > staleAfter) flags.add("stale");
    if (flags.size > 1) flags.delete("ok");
    if (flags.size === 0) flags.add("ok");

    for (const flag of flags) flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
    accepted.push({ ...observation, qualityFlags: [...flags] });
  }

  return { accepted, rejected, rejectionCounts, flagCounts };
}

/**
 * Fraction of a batch that survived the gates. A collapse in this ratio is the earliest visible
 * sign of upstream schema drift, so it is reported rather than averaged away.
 */
export function acceptanceRate(result: QualityResult): number | null {
  const total =
    result.accepted.length + Object.values(result.rejectionCounts).reduce((a, b) => a + b, 0);
  return total === 0 ? null : result.accepted.length / total;
}
