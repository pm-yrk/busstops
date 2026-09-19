import type { GovernorState, VehicleObservation } from "@busstops/contracts";
import type { ObjectStore } from "@busstops/pipeline-core";
import { toIso } from "@busstops/pipeline-core";
import { activeDegradationSteps, isAtLeast } from "@busstops/governor";
import { StageRunner, type Checkpoint, type RunReport } from "./stages.js";
import {
  emptySegmentMatchProfile,
  indexSegments,
  sampleSegmentsForTrace,
  summariseSegmentMatchProfile,
  type RoadSegment,
  type SegmentSample,
} from "./segments.js";
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
        /*
         * Half the run, not all of it. Matching is the expensive stage and the only one that can
         * usefully stop part way, so it takes the largest share and leaves the aggregation, the
         * incident reconciliation and the publish the other half.
         */
        budgetShare: 0.5,
        run: (batch, context) => {
          const collected: SegmentSample[] = [];
          let lowConfidence = 0;
          let implausible = 0;
          let unmatched = 0;
          let processed = 0;
          let ranOutOfTime = false;

          /*
           * The index is built once for the whole batch.
           *
           * This loop used to hand every trace the entire segment array, which rebuilt a
           * seventy-six-thousand-entry candidate list per vehicle and matched each bus against
           * every road in the country. Run 45 measured it at 960 seconds for 2,927 traces — the
           * whole run's budget — with 2,184 of them rejected for low confidence, which is what a
           * matcher offered the wrong city returns.
           */
          const index = indexSegments(batch.segments);
          /*
           * The stage measures itself.
           *
           * Run 67 processed a quarter of its traces in a full budget and rejected half of what
           * it did process below the confidence floor. Both numbers are outcomes; neither says
           * where the time went or which of the confidence's three factors did the rejecting,
           * and those have different fixes. The floor stays where it is until this says why the
           * matches are weak.
           */
          const profile = emptySegmentMatchProfile();

          for (const [vehicleRef, trace] of batch.traces) {
            /*
             * And a share of the clock, so this stage cannot starve the ones after it.
             *
             * When it overran, `interval_aggregates` and `incident_lifecycle` were both skipped
             * for want of time and Pro published nothing — so a complete first stage bought a
             * batch with no output at all. A sample is a sample: aggregating the traces that were
             * processed is worth more than processing every trace and aggregating none.
             */
            if (context.remainingMs() <= 0) {
              ranOutOfTime = true;
              break;
            }
            const result = sampleSegmentsForTrace(
              trace,
              index,
              batch.routeByVehicle.get(vehicleRef) ?? null,
              {},
              profile,
            );
            collected.push(...result.samples);
            lowConfidence += result.discardedLowConfidence;
            implausible += result.discardedImplausible;
            unmatched += result.unmatchedTraces;
            processed += 1;
          }

          return {
            value: collected,
            metrics: {
              processed,
              emitted: collected.length,
              rejected: lowConfidence + implausible + unmatched,
              lowConfidenceTraces: lowConfidence,
              implausibleTraversals: implausible,
              segmentsIndexed: index.size,
              ...summariseSegmentMatchProfile(profile),
            },
            notes: [
              /*
               * Said in one line, because the counters answer a question that is asked out loud
               * on every run: are the matches weak because the roads are missing, because the
               * positions are far from them, or because the decode never settled.
               */
              `match profile: ${profile.candidatesMax} candidates at most, ` +
                `${Math.round(profile.candidateSearchMs)}ms finding them and ` +
                `${Math.round(profile.decodeMs)}ms decoding; rejections were ` +
                `${profile.rejectedByCoverage} coverage / ${profile.rejectedByDistance} distance / ` +
                `${profile.rejectedByInstability} instability`,
              ...(lowConfidence > 0
                ? [
                    `${lowConfidence} traces produced no samples because their map match was below the confidence floor`,
                  ]
                : []),
              ...(ranOutOfTime
                ? [
                    `stopped after ${processed} of ${batch.traces.size} traces to leave time for the stages after this one`,
                  ]
                : []),
            ],
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
            { buckets: aggregation.buckets, incidents, samples },
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
