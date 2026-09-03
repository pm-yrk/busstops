import type { GovernorState, VehicleObservation } from "@busstops/contracts";
import type { ObjectStore } from "@busstops/pipeline-core";
import { toIso } from "@busstops/pipeline-core";
import { activeDegradationSteps, isAtLeast } from "@busstops/governor";
import { StageRunner, type Checkpoint, type RunReport } from "./stages.js";
import { sampleSegmentsForTrace, type RoadSegment, type SegmentSample } from "./segments.js";
import {
  aggregateSegmentSamples,
  type AggregationResult,
  type SegmentIntervalBucket,
} from "./aggregates.js";
import { reconcileIncidents, type IncidentObservation, type TrackedIncident } from "./incidents.js";
import { publishIntelligence, type IntelligencePublishResult } from "./publish.js";

/**
 * The batch orchestrator: the processing stages of docs/07_DATA_PIPELINES.md, in order, each one
 * checkpointed so a run killed by a job time limit resumes rather than restarting.
 *
 * The whole run is bounded by design. Retention and pruning are deliberately not part of this
 * chain — they run on their own schedule precisely so that a failure here can never postpone
 * raw-data expiry, which outranks every analytical output.
 */

export interface BatchInput {
  runId: string;
  /** Traces keyed by opaque vehicle ref, each already in source-time order. */
  traces: ReadonlyMap<string, readonly VehicleObservation[]>;
  /** Route id per vehicle where matching established one; null where it did not. */
  routeByVehicle: ReadonlyMap<string, string | null>;
  segments: readonly RoadSegment[];
  existingBuckets: ReadonlyMap<string, SegmentIntervalBucket>;
  existingIncidents: readonly TrackedIncident[];
  /** Incident observations produced by the analytics detectors for this window. */
  detections: readonly IncidentObservation[];
  /** Collection coverage, carried onto the artifacts rather than assumed complete. */
  coverage: number;
  sources: readonly string[];
  governorState: GovernorState;
}

export interface BatchOptions {
  now?: () => Date;
  budgetMs?: number;
  resumeFrom?: Checkpoint;
  store?: ObjectStore;
  version?: string;
}

export interface BatchResult {
  report: RunReport;
  samples: SegmentSample[];
  aggregation: AggregationResult | null;
  incidents: TrackedIncident[];
  publish: IntelligencePublishResult | null;
  notes: string[];
}

export async function runAnalyticsBatch(
  input: BatchInput,
  options: BatchOptions = {},
): Promise<BatchResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runner = new StageRunner(input.runId, {
    now,
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    ...(options.resumeFrom === undefined ? {} : { resumeFrom: options.resumeFrom }),
  });
  const notes: string[] = [];

  // Under budget pressure the optional enrichment and recalculation stages are the first to go,
  // which is exactly what the degradation ladder specifies.
  const skipOptional = isAtLeast(input.governorState, "red");
  if (skipOptional) {
    notes.push(
      ...activeDegradationSteps(input.governorState).map((step) => `${step.order}. ${step.action}`),
    );
  }

  const samples =
    (await runner.run<BatchInput, SegmentSample[]>(
      {
        name: "segment_samples",
        run: (batch) => {
          const collected: SegmentSample[] = [];
          let lowConfidence = 0;
          let implausible = 0;
          let unmatched = 0;

          for (const [vehicleRef, trace] of batch.traces) {
            const result = sampleSegmentsForTrace(
              trace,
              batch.segments,
              batch.routeByVehicle.get(vehicleRef) ?? null,
            );
            collected.push(...result.samples);
            lowConfidence += result.discardedLowConfidence;
            implausible += result.discardedImplausible;
            unmatched += result.unmatchedTraces;
          }

          return {
            value: collected,
            metrics: {
              processed: batch.traces.size,
              emitted: collected.length,
              rejected: lowConfidence + implausible + unmatched,
              lowConfidenceTraces: lowConfidence,
              implausibleTraversals: implausible,
            },
            notes:
              lowConfidence > 0
                ? [
                    `${lowConfidence} traces produced no samples because their map match was below the confidence floor`,
                  ]
                : [],
          };
        },
      },
      input,
    )) ?? [];

  const aggregation = await runner.run<SegmentSample[], AggregationResult>(
    {
      name: "interval_aggregates",
      dependsOn: ["segment_samples"],
      run: (collected) => {
        const result = aggregateSegmentSamples(collected, now(), {
          existing: input.existingBuckets,
        });
        return {
          value: result,
          metrics: {
            processed: collected.length,
            emitted: result.buckets.length,
            rejected: result.droppedTooLate,
            revisedBuckets: result.revised.length,
            suppressedBuckets: result.suppressedBuckets,
          },
          notes: [
            ...(result.droppedTooLate > 0
              ? [
                  `${result.droppedTooLate} observations arrived after their bucket had closed and were not counted`,
                ]
              : []),
            ...(result.revised.length > 0
              ? [
                  `${result.revised.length} closed buckets were revised by late arrivals and republish as new versions`,
                ]
              : []),
          ],
        };
      },
    },
    samples,
  );

  const incidents =
    (await runner.run<readonly IncidentObservation[], TrackedIncident[]>(
      {
        name: "incident_lifecycle",
        dependsOn: ["interval_aggregates"],
        run: (detections) => {
          const result = reconcileIncidents(input.existingIncidents, detections, now());
          return {
            value: result.incidents,
            metrics: {
              processed: detections.length,
              emitted: result.incidents.length,
              rejected: 0,
              opened: result.opened,
              continued: result.continued,
              closed: result.closed,
            },
            notes: result.notes,
          };
        },
      },
      input.detections,
    )) ?? [];

  let publish: IntelligencePublishResult | null = null;
  if (options.store && aggregation) {
    publish = await runner.run<null, IntelligencePublishResult>(
      {
        name: "atomic_publish",
        dependsOn: ["interval_aggregates", "incident_lifecycle"],
        run: async () => {
          const result = await publishIntelligence(
            options.store!,
            { buckets: aggregation.buckets, incidents },
            {
              version: options.version ?? toIso(startedAt).replace(/[:.]/g, "-"),
              coverage: input.coverage,
              sources: input.sources,
              now,
            },
          );
          return {
            value: result,
            metrics: {
              processed: aggregation.buckets.length + incidents.length,
              emitted: result.published.length,
              rejected: result.failed.length,
            },
            notes: [
              ...result.notes,
              ...result.failed.map((failure) => `${failure.dataset}: ${failure.reason}`),
            ],
          };
        },
      },
      null,
    );
  } else if (!options.store) {
    notes.push("no object store configured, so nothing was published");
  }

  return {
    report: runner.report(startedAt, now()),
    samples,
    aggregation,
    incidents,
    publish,
    notes,
  };
}
