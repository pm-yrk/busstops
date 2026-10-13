import { median, quantile } from "@busstops/analytics";
import type { SegmentIntervalBucket } from "./aggregates.js";
import { AGGREGATION_DEFAULTS } from "./aggregates.js";
import type { SegmentSample } from "./segments.js";

/**
 * One record describing the newest closed measurement window.
 *
 * Pro's headline figures had nowhere honest to come from. `ProService` read the incidents and
 * asked the segment-metrics manifest only whether it existed — deliberately, because that dataset
 * is national, unbounded and read whole into a 128 MiB isolate, so the edge cannot afford to look
 * inside it. The result was a control tower where five of six figures were hardcoded `null` and
 * the sixth counted incidents.
 *
 * The answer is not to read the big dataset at the edge. It is to compute the national picture
 * once, in the batch that already holds every bucket and every sample, and publish it as a single
 * small record the edge can read for the cost of one object.
 *
 * Everything here is measured. Nothing is estimated, and nothing that this pipeline does not
 * actually compute appears — there is no punctuality or delay figure in this record, because
 * segment traversal times are not schedule adherence and presenting them as such would be the
 * precise failure this project is meant not to have.
 */
export interface NetworkSummaryRecord {
  /** When the batch produced this, which is not when the measurements were taken. */
  generatedAt: string;
  /** The first instant covered by any closed bucket in this summary. */
  windowStart: string;
  /**
   * The last instant covered: the end of the newest bucket in this summary.
   *
   * This is the moment the *figures describe*. It is not when the bucket became immutable and it
   * is not when the batch wrote the record, and the three were being reported as one — a window
   * ending 14:25 was printed as "closed 129 minutes ago" when it had closed at 14:35 and the
   * batch had written it at 16:33. Three different clocks, one label.
   */
  windowEnd: string;
  /**
   * When the newest bucket became immutable: `windowEnd` plus the lateness grace.
   *
   * Stated rather than left to be recomputed. A reader that derives it has to know the grace and
   * has to remember to add it, and the one that did not is why the wording was wrong.
   */
  closedAt: string;
  bucketSeconds: number;
  latenessGraceSeconds: number;
  /** Distinct segments carrying a closed bucket that was not suppressed for want of samples. */
  segmentsMeasured: number;
  closedBuckets: number;
  suppressedBuckets: number;
  sampleCount: number;
  /** Counted across samples, not summed across buckets: a bus crossing four segments is one bus. */
  distinctVehicles: number;
  distinctRoutes: number;
  /**
   * Distinct public line names seen in the observations, resolved to a route id or not.
   *
   * Carried beside `distinctRoutes` because the two answer different questions and run 69 could
   * not tell them apart. `distinctRoutes` counts routes Pro can link to; this counts routes Pro
   * can name. A large gap means the join is failing, not that the buses are not running, and
   * Pro says so rather than presenting an empty route list as "no routes need attention".
   */
  distinctRouteNames: number;
  /** Vehicles whose feed identity resolved all the way to a published route. */
  vehiclesMappedToRoute: number;
  medianTraversalSeconds: number | null;
  p90TraversalSeconds: number | null;
  medianSpeedMetresPerSecond: number | null;
  meanMatchConfidence: number | null;
  /** Share of planned partitions collected, carried through so the edge can qualify the figures. */
  coverage: number;
}

export interface NetworkSummaryInput {
  buckets: readonly SegmentIntervalBucket[];
  samples: readonly SegmentSample[];
  coverage: number;
  /** What the observation→route join managed, so Pro can qualify what it shows. */
  routeJoin?: { distinctRouteNames: number; vehiclesMappedToRouteId: number };
  bucketSeconds?: number;
  latenessGraceSeconds?: number;
}

/**
 * Builds the summary, or null when there is nothing closed to summarise.
 *
 * Null rather than a record of zeroes: "no closed window yet" and "a closed window in which
 * nothing moved" are different statements, and a row of zeroes on the control tower would say
 * the second when the truth is the first.
 */
export function buildNetworkSummary(
  input: NetworkSummaryInput,
  now: Date = new Date(),
): NetworkSummaryRecord | null {
  const closed = input.buckets.filter((bucket) => bucket.state === "closed");
  if (closed.length === 0) return null;

  const measured = closed.filter((bucket) => !bucket.suppressed);
  const windowStart = closed.reduce(
    (earliest, bucket) => (bucket.intervalStart < earliest ? bucket.intervalStart : earliest),
    closed[0]!.intervalStart,
  );
  const windowEnd = closed.reduce(
    (latest, bucket) => (bucket.intervalEnd > latest ? bucket.intervalEnd : latest),
    closed[0]!.intervalEnd,
  );

  /*
   * Samples are filtered to the closed window before anything is counted.
   *
   * The batch's sample list also contains traversals that fall in buckets still open, and
   * counting those here would put observations into a figure labelled as closed and settled —
   * exactly the revision risk the bucket state exists to prevent.
   */
  const inWindow = input.samples.filter(
    (sample) => sample.exitedAt >= windowStart && sample.exitedAt <= windowEnd,
  );

  const traversals = inWindow.map((sample) => sample.traversalSeconds);
  const speeds = inWindow.map((sample) => sample.meanSpeedMetresPerSecond);
  const confidences = measured.map((bucket) => bucket.meanMatchConfidence);

  return {
    generatedAt: now.toISOString(),
    windowStart,
    windowEnd,
    closedAt: new Date(
      Date.parse(windowEnd) +
        (input.latenessGraceSeconds ?? AGGREGATION_DEFAULTS.latenessGraceSeconds) * 1000,
    ).toISOString(),
    bucketSeconds: input.bucketSeconds ?? AGGREGATION_DEFAULTS.bucketSeconds,
    latenessGraceSeconds: input.latenessGraceSeconds ?? AGGREGATION_DEFAULTS.latenessGraceSeconds,
    segmentsMeasured: new Set(measured.map((bucket) => bucket.segmentId)).size,
    closedBuckets: closed.length,
    suppressedBuckets: closed.length - measured.length,
    sampleCount: inWindow.length,
    distinctVehicles: new Set(inWindow.map((sample) => sample.vehicleRef)).size,
    distinctRoutes: new Set(
      inWindow
        .map((sample) => sample.routeId)
        .filter((routeId): routeId is string => routeId !== null),
    ).size,
    distinctRouteNames: input.routeJoin?.distinctRouteNames ?? 0,
    vehiclesMappedToRoute: input.routeJoin?.vehiclesMappedToRouteId ?? 0,
    medianTraversalSeconds: traversals.length > 0 ? median(traversals) : null,
    p90TraversalSeconds: traversals.length > 0 ? quantile(traversals, 0.9) : null,
    medianSpeedMetresPerSecond: speeds.length > 0 ? median(speeds) : null,
    meanMatchConfidence:
      confidences.length > 0
        ? confidences.reduce((total, value) => total + value, 0) / confidences.length
        : null,
    coverage: input.coverage,
  };
}
