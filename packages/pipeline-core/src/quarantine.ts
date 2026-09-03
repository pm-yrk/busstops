import type { z } from "zod";

/**
 * Poison-record quarantine and schema-drift detection (docs/04_ARCHITECTURE.md "Resilience").
 * One malformed record from an upstream feed must never fail a national job; it is set aside
 * with its reason, counted, and surfaced as a data-quality signal.
 */

export interface QuarantinedRecord {
  reason: string;
  /** Truncated so a quarantine store can never become a copy of the feed. */
  sample: string;
  index: number;
}

export interface ParseOutcome<T> {
  accepted: T[];
  quarantined: QuarantinedRecord[];
  /** Fraction of input records rejected, used to detect schema drift. */
  rejectionRate: number;
  schemaDriftSuspected: boolean;
}

const MAX_SAMPLE_LENGTH = 500;
const MAX_QUARANTINE_RECORDS = 100;

export interface ParseOptions {
  /** Above this rejection rate the upstream schema has probably changed. */
  driftThreshold?: number;
  /** Below this many records the rejection rate is too noisy to call drift. */
  minimumRecordsForDrift?: number;
}

export function parseRecords<T>(
  records: readonly unknown[],
  schema: z.ZodType<T>,
  options: ParseOptions = {},
): ParseOutcome<T> {
  const { driftThreshold = 0.2, minimumRecordsForDrift = 20 } = options;
  const accepted: T[] = [];
  const quarantined: QuarantinedRecord[] = [];

  records.forEach((record, index) => {
    const result = schema.safeParse(record);
    if (result.success) {
      accepted.push(result.data);
      return;
    }
    if (quarantined.length < MAX_QUARANTINE_RECORDS) {
      quarantined.push({
        reason: result.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
        sample: JSON.stringify(record).slice(0, MAX_SAMPLE_LENGTH),
        index,
      });
    }
  });

  const rejected = records.length - accepted.length;
  const rejectionRate = records.length === 0 ? 0 : rejected / records.length;

  return {
    accepted,
    quarantined,
    rejectionRate,
    schemaDriftSuspected:
      records.length >= minimumRecordsForDrift && rejectionRate >= driftThreshold,
  };
}

export interface StageCounts {
  stage: string;
  input: number;
  accepted: number;
  rejected: number;
  durationMs: number;
}

/** Every pipeline stage emits counts, rejections and timing (docs/07_DATA_PIPELINES.md). */
export class StageRecorder {
  private readonly stages: StageCounts[] = [];

  record(counts: StageCounts): void {
    this.stages.push(counts);
  }

  async run<T>(
    stage: string,
    input: number,
    fn: () => Promise<{ accepted: T[]; rejected: number }>,
  ) {
    const started = Date.now();
    const result = await fn();
    this.record({
      stage,
      input,
      accepted: result.accepted.length,
      rejected: result.rejected,
      durationMs: Date.now() - started,
    });
    return result.accepted;
  }

  summary(): StageCounts[] {
    return [...this.stages];
  }

  totalRejected(): number {
    return this.stages.reduce((sum, s) => sum + s.rejected, 0);
  }
}
