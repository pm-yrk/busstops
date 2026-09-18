import { toIso } from "@busstops/pipeline-core";

/**
 * The stage runner (docs/07_DATA_PIPELINES.md "Processing stages").
 *
 * Every stage must be idempotent, checkpointed, bounded, and must emit counts, rejections and
 * timing. That is not bookkeeping for its own sake: a pipeline that can be re-run from its last
 * checkpoint without double-counting is the only kind that can safely be retried on a free tier,
 * where a run may be killed mid-way by a job time limit at any moment.
 *
 * A stage failure does not throw the run away. Later stages that depended on it are skipped and
 * recorded as skipped, so the report says what was produced and what was not — an artifact built
 * on a stage that silently failed is worse than no artifact.
 */

export interface StageMetrics {
  processed: number;
  emitted: number;
  rejected: number;
  [key: string]: number;
}

export interface StageResult<T> {
  value: T;
  metrics: Partial<StageMetrics>;
  notes?: string[];
}

export interface StageRecord {
  name: string;
  status: "completed" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  metrics: StageMetrics;
  notes: string[];
  error?: string;
}

export interface Checkpoint {
  runId: string;
  /** Stages already completed in a previous attempt of this run, and their recorded metrics. */
  completed: Record<string, StageRecord>;
}

export interface StageContext {
  runId: string;
  now: () => Date;
  /**
   * Milliseconds this stage may still spend.
   *
   * The run's remaining budget, or this stage's own share of it where it declares one — whichever
   * is smaller. A stage that watches this stops itself; one that does not is still cut off at the
   * next stage boundary, which is how run 45 ended with a complete first stage and no output.
   */
  remainingMs: () => number;
}

export interface StageDefinition<TIn, TOut> {
  name: string;
  /** Stages that must have completed for this one to run. */
  dependsOn?: readonly string[];
  /**
   * The fraction of the run's budget this stage may spend, when it is one that can stop early.
   *
   * Run 45's `segment_samples` ran for 960 seconds, reported `completed`, and left nothing for
   * `interval_aggregates` or `incident_lifecycle` — so the batch produced no published metrics
   * and Pro fell back to its demo snapshot. A stage that can work on a prefix of its input and
   * still be useful declares a share here; the stages that must see all of their input, like the
   * publish, declare none and get whatever is left.
   */
  budgetShare?: number;
  run: (input: TIn, context: StageContext) => Promise<StageResult<TOut>> | StageResult<TOut>;
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stages: StageRecord[];
  /** True only when every stage completed. */
  complete: boolean;
  /** Stages that failed, whose downstream work was skipped rather than built on a gap. */
  failedStages: string[];
  skippedStages: string[];
  truncated: boolean;
  checkpoint: Checkpoint;
}

const emptyMetrics = (): StageMetrics => ({ processed: 0, emitted: 0, rejected: 0 });

function mergeMetrics(partial: Partial<StageMetrics>): StageMetrics {
  const merged = emptyMetrics();
  for (const [key, value] of Object.entries(partial)) {
    if (typeof value === "number") merged[key] = value;
  }
  return merged;
}

/**
 * Runs a chain of stages, threading each stage's value into the next. Stage values are typed
 * loosely here because the chain is heterogeneous; each stage validates its own input.
 */
export class StageRunner {
  private readonly records: StageRecord[] = [];
  private readonly completed = new Map<string, StageRecord>();
  private truncated = false;

  constructor(
    private readonly runId: string,
    private readonly options: {
      now?: () => Date;
      budgetMs?: number;
      /** Checkpoint from a previous attempt; completed stages are not re-run. */
      resumeFrom?: Checkpoint;
    } = {},
  ) {
    for (const [name, record] of Object.entries(options.resumeFrom?.completed ?? {})) {
      if (record.status === "completed") this.completed.set(name, record);
    }
  }

  private get now(): () => Date {
    return this.options.now ?? (() => new Date());
  }

  hasCompleted(name: string): boolean {
    return this.completed.has(name);
  }

  async run<TIn, TOut>(
    stage: StageDefinition<TIn, TOut>,
    input: TIn,
    startedAt: Date = this.now(),
  ): Promise<TOut | null> {
    const missing = (stage.dependsOn ?? []).filter((dependency) => !this.completed.has(dependency));
    if (missing.length > 0) {
      this.record(stage.name, "skipped", startedAt, startedAt, emptyMetrics(), [
        `skipped because ${missing.join(", ")} did not complete`,
      ]);
      return null;
    }

    const budgetMs = this.options.budgetMs;
    if (budgetMs !== undefined && this.elapsedMs() > budgetMs) {
      this.truncated = true;
      this.record(stage.name, "skipped", startedAt, startedAt, emptyMetrics(), [
        "skipped because the run exhausted its time budget",
      ]);
      return null;
    }

    const beganAt = this.now().getTime();
    const share =
      budgetMs === undefined || stage.budgetShare === undefined
        ? null
        : budgetMs * stage.budgetShare;
    const context: StageContext = {
      runId: this.runId,
      now: this.now,
      remainingMs: () => {
        const runRemaining =
          budgetMs === undefined ? Number.POSITIVE_INFINITY : budgetMs - this.elapsedMs();
        if (share === null) return runRemaining;
        return Math.min(runRemaining, share - (this.now().getTime() - beganAt));
      },
    };

    try {
      const result = await stage.run(input, context);
      const finishedAt = this.now();
      this.record(
        stage.name,
        "completed",
        startedAt,
        finishedAt,
        mergeMetrics(result.metrics),
        result.notes ?? [],
      );
      return result.value;
    } catch (error) {
      const finishedAt = this.now();
      this.record(
        stage.name,
        "failed",
        startedAt,
        finishedAt,
        emptyMetrics(),
        [],
        error instanceof Error ? error.message : "unknown stage failure",
      );
      return null;
    }
  }

  private elapsedMs(): number {
    const first = this.records[0];
    if (!first) return 0;
    return this.now().getTime() - new Date(first.startedAt).getTime();
  }

  private record(
    name: string,
    status: StageRecord["status"],
    startedAt: Date,
    finishedAt: Date,
    metrics: StageMetrics,
    notes: string[],
    error?: string,
  ): void {
    const record: StageRecord = {
      name,
      status,
      startedAt: toIso(startedAt),
      finishedAt: toIso(finishedAt),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      metrics,
      notes,
      ...(error === undefined ? {} : { error }),
    };
    this.records.push(record);
    if (status === "completed") this.completed.set(name, record);
  }

  report(startedAt: Date, finishedAt: Date = this.now()): RunReport {
    const failedStages = this.records.filter((r) => r.status === "failed").map((r) => r.name);
    const skippedStages = this.records.filter((r) => r.status === "skipped").map((r) => r.name);
    return {
      runId: this.runId,
      startedAt: toIso(startedAt),
      finishedAt: toIso(finishedAt),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      stages: [...this.records],
      complete: failedStages.length === 0 && skippedStages.length === 0,
      failedStages,
      skippedStages,
      truncated: this.truncated,
      checkpoint: {
        runId: this.runId,
        completed: Object.fromEntries(this.completed),
      },
    };
  }
}
