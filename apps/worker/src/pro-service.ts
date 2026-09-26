import type {
  AnalyticsResponse,
  CongestionHotspot,
  CongestionResponse,
  ControlTowerResponse,
  Incident,
  LiveOperationsResponse,
  OperatorsResponse,
  PriorityException,
  ProMetric,
  ProProvenance,
  ProScope,
  ReportPeriod,
  ReportResponse,
  RoutesResponse,
  SourceHealth,
  SourceHealthSummary,
} from "@busstops/contracts";
import { ArtifactStore, type ObjectStore } from "@busstops/pipeline-core";
import {
  DEMO_INCIDENTS,
  DEMO_OPERATORS,
  DEMO_ROUTES,
  DEMO_SEGMENTS,
  DEMO_SNAPSHOT_DATE,
  DEMO_SNAPSHOT_NOTICE,
  DEMO_SOURCE_HEALTH,
} from "./pro-demo-snapshot.js";

/**
 * Bus Stops Pro data service (docs/10_BUS_STOPS_PRO.md).
 *
 * Pro is public and has no sign-in wall, so the one thing it must never do is leave a viewer
 * unsure what they are looking at. Every response states its mode: live analytics, a dated
 * demonstration snapshot, or unavailable. There is no fourth state and no blending of the first
 * two — a chart that mixes live figures with an example would be worse than either alone.
 */

export const INTELLIGENCE_INCIDENTS_DATASET = "intelligence/incidents";
export const INTELLIGENCE_SEGMENTS_DATASET = "intelligence/segment-metrics";
/** One record describing the newest closed measurement window. See the pipeline's `summary.ts`. */
export const INTELLIGENCE_SUMMARY_DATASET = "intelligence/network-summary";

/**
 * The national summary as the edge reads it.
 *
 * Declared here rather than imported from the pipeline package: the Worker bundle must not pull
 * the analytics batch in, and this is a wire format between two deployables, so it is written out
 * on both sides and asserted by a contract test.
 */
export interface NetworkSummary {
  /** When the batch wrote this record. Not when anything in it was measured. */
  generatedAt: string;
  windowStart: string;
  /** The last instant the figures describe. */
  windowEnd: string;
  /** When the newest bucket became immutable: `windowEnd` plus the lateness grace. */
  closedAt: string;
  bucketSeconds: number;
  latenessGraceSeconds: number;
  segmentsMeasured: number;
  closedBuckets: number;
  suppressedBuckets: number;
  sampleCount: number;
  distinctVehicles: number;
  distinctRoutes: number;
  /** Line names seen, resolved or not. Optional: added after records were already published. */
  distinctRouteNames?: number;
  vehiclesMappedToRoute?: number;
  medianTraversalSeconds: number | null;
  p90TraversalSeconds: number | null;
  medianSpeedMetresPerSecond: number | null;
  meanMatchConfidence: number | null;
  coverage: number;
}

/**
 * Three clocks, three names, and never one label for all of them.
 *
 * A figure from this pipeline has three distinct ages and the first version of this file printed
 * one number under the word for another. Run 69 published a five-minute window ending 14:25 with
 * a 600-second grace, written by a batch at 16:33, and the verifier reported "closed 129 minutes
 * ago" — which is the age of the window's *end*, described with the word for its *closure*, on a
 * record whose own age was different again. All three are useful and none substitutes for
 * another:
 *
 *  - **measurement age** — how old the thing being described is (`now − windowEnd`). This is what
 *    a reader looking at a number wants: the buses were doing this two hours ago.
 *  - **closure age** — how long the figure has been immutable (`now − closedAt`). This is what
 *    says whether it can still be revised, and it is always the measurement age minus the grace.
 *  - **publication age** — how long ago the batch wrote the record (`now − generatedAt`). This is
 *    the pipeline's own health: a small measurement age with a large publication age is
 *    impossible, and a large one of each means collection has stopped.
 *
 * `windowEnd` is the last instant covered. `closedAt` is `windowEnd` plus the grace. They are ten
 * minutes apart at the current settings and were being reported as the same moment.
 */
/**
 * A summary record as the edge can safely use it, whatever version of the batch wrote it.
 *
 * The two sides deploy independently. `closedAt` was added to the record after artifacts had
 * already been published without it, and the edge read it straight into `new Date(...)` — so the
 * first Pro request after this deploy would have thrown "Invalid time value" and answered 500 on
 * every control-tower call until the next batch ran. A field added to a wire format is a field
 * that will be missing from something already in the bucket.
 *
 * `closedAt` is derivable, so it is derived rather than demanded: window end plus the grace is
 * exactly what the batch computes. A record missing something that cannot be derived is rejected
 * instead, because a figure with no window is not a figure.
 */
export function normaliseSummary(record: Partial<NetworkSummary> | null): NetworkSummary | null {
  if (!record) return null;
  const windowEnd = record.windowEnd;
  const grace = record.latenessGraceSeconds;
  if (
    typeof windowEnd !== "string" ||
    !Number.isFinite(Date.parse(windowEnd)) ||
    typeof record.windowStart !== "string" ||
    typeof record.generatedAt !== "string" ||
    typeof grace !== "number"
  ) {
    return null;
  }
  const closedAt =
    typeof record.closedAt === "string" && Number.isFinite(Date.parse(record.closedAt))
      ? record.closedAt
      : new Date(Date.parse(windowEnd) + grace * 1000).toISOString();
  return { ...(record as NetworkSummary), closedAt };
}

export function measurementAgeSeconds(summary: NetworkSummary, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(summary.windowEnd)) / 1000);
}

/** How long the newest bucket has been immutable. Measurement age minus the lateness grace. */
export function closureAgeSeconds(summary: NetworkSummary, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(summary.closedAt)) / 1000);
}

/** How long ago the batch wrote this record. The pipeline's age, not the measurement's. */
export function publicationAgeSeconds(summary: NetworkSummary, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(summary.generatedAt)) / 1000);
}

/**
 * How the window is described on a metric, in the window's own terms.
 *
 * Pro used to label every live figure "last 60 minutes", which was the scope the reader had asked
 * for and not the period the number was measured over. This names the period, both of its
 * boundaries, and — separately — how old it is, so no single phrase has to carry two clocks.
 */
export function describeMeasuredWindow(summary: NetworkSummary, now: Date): string {
  const minutes = Math.round(summary.bucketSeconds / 60);
  const ended = new Date(summary.windowEnd).toISOString().slice(11, 16);
  const settled = new Date(summary.closedAt).toISOString().slice(11, 16);
  const ageMinutes = Math.round(measurementAgeSeconds(summary, now) / 60);
  return (
    `${minutes}-minute window ending ${ended} UTC, settled ${settled}` +
    `; measured ${ageMinutes === 0 ? "just now" : `${ageMinutes} minutes ago`}`
  );
}

/** Below this, a metric is published as suppressed with its reason rather than as a figure. */
export const PRO_MINIMUM_DENOMINATOR = 20;

export const DEFAULT_WINDOW_MINUTES = 60;

export interface ProScopeInput {
  areaId?: string | null;
  operatorId?: string | null;
  routeId?: string | null;
  windowMinutes?: number;
}

export function resolveScope(input: ProScopeInput = {}): ProScope {
  return {
    areaId: input.areaId ?? null,
    operatorId: input.operatorId ?? null,
    routeId: input.routeId ?? null,
    windowMinutes: input.windowMinutes ?? DEFAULT_WINDOW_MINUTES,
    boundingBox: null,
  };
}

export function liveProvenance(): ProProvenance {
  return { dataMode: "live", snapshotDate: null, notice: null };
}

export function demoProvenance(): ProProvenance {
  return {
    dataMode: "demo_snapshot",
    snapshotDate: DEMO_SNAPSHOT_DATE,
    notice: DEMO_SNAPSHOT_NOTICE,
  };
}

export interface MetricInput {
  key: string;
  label: string;
  definition: string;
  value: number | null;
  unit: ProMetric["unit"];
  denominator: number;
  window: string;
  freshnessSeconds?: number | null;
  coverage: number;
  confidence?: ProMetric["confidence"];
  baselineValue?: number | null;
  evidence?: string[];
  minimumDenominator?: number;
  /** Overrides the default suppression message where a more specific one helps. */
  suppressionReason?: string;
}

/**
 * Builds a Pro metric, deciding suppression in one place.
 *
 * Suppression is not a display concern that a caller may skip: a punctuality figure from eleven
 * journeys rendered beside one from nine hundred invites a comparison the data cannot support,
 * and the reader has no way to know unless the shape forces it.
 */
export function metric(input: MetricInput): ProMetric {
  const minimum = input.minimumDenominator ?? PRO_MINIMUM_DENOMINATOR;
  const suppressed = input.value === null || input.denominator < minimum;

  return {
    key: input.key,
    label: input.label,
    definition: input.definition,
    value: suppressed ? null : input.value,
    unit: input.unit,
    denominator: input.denominator,
    window: input.window,
    freshnessSeconds: input.freshnessSeconds ?? null,
    coverage: input.coverage,
    confidence: input.confidence ?? null,
    suppressed,
    suppressionReason: suppressed
      ? (input.suppressionReason ??
        (input.value === null
          ? "No observations have been published for this scope and window."
          : `Based on ${input.denominator} observations; ${minimum} are needed before a figure is published.`))
      : null,
    baselineValue: input.baselineValue ?? null,
    evidence: input.evidence ?? [],
  };
}

export function summariseSourceHealth(
  sources: ReadonlyArray<{ source: string; status: string; detail?: string }>,
): SourceHealthSummary {
  const summary: SourceHealthSummary = {
    healthy: 0,
    degraded: 0,
    stale: 0,
    down: 0,
    problems: [],
  };

  for (const entry of sources) {
    if (entry.status === "healthy") summary.healthy += 1;
    else if (entry.status === "degraded") summary.degraded += 1;
    else if (entry.status === "stale") summary.stale += 1;
    else summary.down += 1;

    if (entry.status !== "healthy") {
      summary.problems.push({
        source: entry.source,
        status: entry.status,
        detail: entry.detail ?? "No detail available",
      });
    }
  }

  return summary;
}

export class ProService {
  constructor(private readonly store: ObjectStore | null) {}

  /** Live intelligence artifacts, or null when none has been published. */
  private async liveIntelligence(): Promise<{
    incidents: Incident[];
    summary: NetworkSummary | null;
  } | null> {
    if (!this.store) return null;
    const artifacts = new ArtifactStore(this.store);
    try {
      const incidents = await artifacts.readCurrent<Incident>(INTELLIGENCE_INCIDENTS_DATASET);
      /*
       * The segment metrics are asked whether they exist, not what they say.
       *
       * Nothing here has ever read a field off them — the records were fetched so that a manifest
       * could be tested for null — and `readCurrent` pulls the whole national dataset into the
       * isolate to do it. That was harmless while the analytics batch was failing on
       * `no_segments` and the artifact did not exist; it stops being harmless the moment the batch
       * starts working, because this dataset grows with coverage and there is no publish-time
       * ceiling on it. `readManifest` answers the same question for the cost of one small object.
       */
      const segmentsManifest = await artifacts.readManifest(INTELLIGENCE_SEGMENTS_DATASET);
      /*
       * And the national summary, which is one record and therefore safe to read whole.
       *
       * This is where Pro's headline figures come from. Reading it costs one object; reading the
       * segment metrics it was derived from would cost the whole national dataset, which is the
       * reason the summary exists at all.
       */
      const summary = await artifacts
        .readCurrent<Partial<NetworkSummary>>(INTELLIGENCE_SUMMARY_DATASET)
        .catch(() => null);
      // A manifest is the signal that a run happened. Zero incidents with a manifest is a real
      // "nothing to report"; no manifest at all means nothing has ever run.
      if (incidents.manifest === null && segmentsManifest === null) return null;
      // Normalised at the boundary, so nothing downstream has to know which batch wrote it.
      return {
        incidents: incidents.records,
        summary: normaliseSummary(summary?.records[0] ?? null),
      };
    } catch {
      return null;
    }
  }

  async controlTower(
    scope: ProScope,
    sourceHealth: readonly SourceHealth[],
    now: Date,
  ): Promise<ControlTowerResponse> {
    const live = await this.liveIntelligence();
    const usingDemo = live === null;
    const incidents = usingDemo ? DEMO_INCIDENTS : live.incidents;
    const health = usingDemo
      ? DEMO_SOURCE_HEALTH
      : sourceHealth.map((entry) => ({
          source: entry.source,
          status: entry.status,
          detail: entry.message ?? `Last successful fetch ${entry.ageSeconds ?? "unknown"}s ago`,
        }));

    const healthSummary = summariseSourceHealth(health);
    const summary = usingDemo ? null : live.summary;
    const coverage = usingDemo ? 1 : (summary?.coverage ?? coverageFrom(healthSummary));
    /*
     * The window a figure was measured over, not the window the reader asked for.
     *
     * Those are different things and Pro used to print the second over the first. A scope of
     * "last 60 minutes" is a filter; a segment metric is computed from a five-minute bucket that
     * closed a quarter of an hour ago, and labelling it "last 60 minutes" claims a currency the
     * pipeline does not have.
     */
    const window = summary
      ? describeMeasuredWindow(summary, now)
      : `last ${scope.windowMinutes} minutes`;

    const exceptions = incidents.map((incident) => toException(incident, usingDemo, "abnormality"));
    const burden = [...exceptions]
      .filter((exception) => exception.impactVehicleMinutes !== null)
      .sort((a, b) => (b.impactVehicleMinutes ?? 0) - (a.impactVehicleMinutes ?? 0))
      .slice(0, 5)
      .map((exception) => ({ ...exception, surfacedBy: "delay_burden" as const }));
    const abnormal = [...exceptions]
      .sort((a, b) => severityRank(b.incident.severity) - severityRank(a.incident.severity))
      .slice(0, 5);

    const headline = buildHeadlineMetrics({
      usingDemo,
      window,
      coverage,
      incidents,
      summary,
      now,
    });

    return {
      provenance: usingDemo ? demoProvenance() : liveProvenance(),
      scope,
      generatedAt: now.toISOString(),
      headline,
      sourceHealth: healthSummary,
      priorityExceptions: exceptions.slice(0, 8),
      biggestDelayBurden: burden,
      mostAbnormal: abnormal,
      routesRequiringAttention: usingDemo
        ? DEMO_ROUTES.filter((route) => route.punctualityPercent < 0.75).map((route) => ({
            routeId: route.routeId,
            routeName: route.routeName,
            operatorName: route.operatorName,
            reason: `Punctuality is ${(route.punctualityPercent * 100).toFixed(0)}%, worst on ${route.worstCorridor}.`,
            metric: metric({
              key: `route-${route.routeId}-punctuality`,
              label: "Punctuality",
              definition: PUNCTUALITY_DEFINITION,
              value: route.punctualityPercent,
              unit: "percent",
              denominator: route.punctualityDenominator,
              window,
              coverage,
            }),
          }))
        : [],
      outlook: buildOutlook(incidents, healthSummary, usingDemo),
      intelligenceSummary: buildIntelligenceSummary(
        incidents,
        healthSummary,
        coverage,
        summary,
        now,
      ),
      coverageWarning:
        coverage < 0.7
          ? `Only ${(coverage * 100).toFixed(0)}% of live sources are reporting normally. Read every figure below with that in mind: they describe the part of the network we can see, not the whole of it.`
          : null,
    };
  }

  async liveOperations(
    scope: ProScope,
    sourceHealth: readonly SourceHealth[],
    now: Date,
  ): Promise<LiveOperationsResponse> {
    const live = await this.liveIntelligence();
    const usingDemo = live === null;
    const incidents = usingDemo ? DEMO_INCIDENTS : live.incidents;
    const health = usingDemo
      ? DEMO_SOURCE_HEALTH
      : sourceHealth.map((entry) => ({
          source: entry.source,
          status: entry.status,
          detail: entry.message ?? "",
        }));

    return {
      provenance: usingDemo ? demoProvenance() : liveProvenance(),
      scope,
      generatedAt: now.toISOString(),
      items: incidents.map((incident) => ({
        incident,
        coordinate: "corridorId" in incident.geometry ? null : incident.geometry,
        affectedRouteNames: routeNamesFor(incident, usingDemo),
        freshnessSeconds: Math.max(
          0,
          (now.getTime() - new Date(incident.ingestedAt).getTime()) / 1000,
        ),
        recoveryTrend: recoveryTrendFor(incident),
      })),
      // A stale or missing feed is itself an operational exception, not a footnote.
      feedProblems: health.filter((entry) => entry.status !== "healthy"),
      availableFilters: {
        operators: usingDemo
          ? DEMO_OPERATORS.map((operator) => ({
              id: operator.operatorId,
              name: operator.operatorName,
            }))
          : [],
        eventTypes: [...new Set(incidents.map((incident) => incident.type))],
        severities: [...new Set(incidents.map((incident) => incident.severity))],
      },
    };
  }

  async routes(scope: ProScope, now: Date): Promise<RoutesResponse> {
    const live = await this.liveIntelligence();
    const usingDemo = live === null;
    const window = `last ${scope.windowMinutes} minutes`;

    return {
      provenance: usingDemo ? demoProvenance() : liveProvenance(),
      scope,
      generatedAt: now.toISOString(),
      rows: usingDemo
        ? DEMO_ROUTES.map((route) => ({
            routeId: route.routeId,
            routeName: route.routeName,
            operatorName: route.operatorName,
            metrics: [
              metric({
                key: "punctuality",
                label: "Punctuality",
                definition: PUNCTUALITY_DEFINITION,
                value: route.punctualityPercent,
                unit: "percent",
                denominator: route.punctualityDenominator,
                window,
                coverage: 1,
              }),
              metric({
                key: "reliability",
                label: "Reliability",
                definition: RELIABILITY_DEFINITION,
                value: route.reliabilityPercent,
                unit: "percent",
                denominator: route.reliabilityDenominator,
                window,
                coverage: 1,
              }),
              metric({
                key: "median_delay",
                label: "Median delay",
                definition:
                  "The middle value of actual minus scheduled time across observed journeys. The median rather than the mean, so one broken-down bus does not move the figure.",
                value: route.medianDelaySeconds,
                unit: "seconds",
                denominator: route.punctualityDenominator,
                window,
                coverage: 1,
              }),
              metric({
                key: "headway_adherence",
                label: "Headway adherence",
                definition: HEADWAY_DEFINITION,
                value: route.headwayAdherencePercent,
                unit: "percent",
                denominator: route.headwayDenominator,
                window,
                coverage: 1,
              }),
            ],
            worstCorridor: route.worstCorridor,
            worstTimeWindow: route.worstTimeWindow,
            weatherSensitivity: route.weatherSensitivity,
          }))
        : [],
      comparabilityWarning: usingDemo
        ? "These routes differ in length, frequency and how much of their run is in the city centre. Compare them as descriptions of each route, not as a ranking of the people running them."
        : null,
    };
  }

  async operators(scope: ProScope, now: Date): Promise<OperatorsResponse> {
    const live = await this.liveIntelligence();
    const usingDemo = live === null;
    const window = `last ${scope.windowMinutes} minutes`;

    return {
      provenance: usingDemo ? demoProvenance() : liveProvenance(),
      scope,
      generatedAt: now.toISOString(),
      scorecards: usingDemo
        ? DEMO_OPERATORS.map((operator) => ({
            operatorId: operator.operatorId,
            operatorName: operator.operatorName,
            raw: [
              metric({
                key: "punctuality_raw",
                label: "Punctuality (as measured)",
                definition: PUNCTUALITY_DEFINITION,
                value: operator.punctualityPercent,
                unit: "percent",
                denominator: operator.denominator,
                window,
                coverage: 1,
              }),
            ],
            contextAdjusted: [
              metric({
                key: "punctuality_adjusted",
                label: "Punctuality (adjusted for where and when they run)",
                definition:
                  "The same measurement, reweighted so operators are compared across a like-for-like mix of corridors and time windows. Adjustment reduces an unfair comparison; it does not make an unfair comparison fair.",
                value: operator.contextAdjustedPercent,
                unit: "percent",
                denominator: operator.denominator,
                window,
                coverage: 1,
              }),
            ],
            contextFactors: operator.contextFactors,
            rankingEligible: operator.rankingEligible,
            rankingIneligibleReason: operator.rankingIneligibleReason,
            coverageCaveats: operator.coverageCaveats,
          }))
        : [],
      comparabilityWarning: usingDemo
        ? "Raw and adjusted figures are shown together on purpose. Either one alone would mislead: the raw figure ignores where an operator runs, and the adjusted figure hides what passengers actually experienced."
        : null,
    };
  }

  async congestion(scope: ProScope, now: Date): Promise<CongestionResponse> {
    const live = await this.liveIntelligence();
    const usingDemo = live === null;

    const hotspots: CongestionHotspot[] = usingDemo
      ? DEMO_SEGMENTS.map((segment) => ({
          segmentId: segment.segmentId,
          name: segment.name,
          coordinate: segment.coordinate,
          direction: segment.direction,
          timeWindow: segment.timeWindow,
          currentSeconds: segment.currentSeconds,
          typicalSeconds: segment.typicalSeconds,
          excessVehicleMinutes: segment.excessVehicleMinutes,
          affectedRouteNames: segment.affectedRouteNames,
          affectedVehicleCount: segment.affectedVehicleCount,
          occurrenceFrequency: segment.occurrenceFrequency,
          occurrenceSample: segment.occurrenceSample,
          confidence: {
            level: segment.affectedRouteNames.length >= 2 ? "high" : "medium",
            score: segment.affectedRouteNames.length >= 2 ? 0.78 : 0.55,
            reasons: [
              `${segment.affectedVehicleCount} traversals across ${segment.affectedRouteNames.length} routes`,
            ],
          },
          corroboration: segment.corroboration,
        }))
      : [];

    return {
      provenance: usingDemo ? demoProvenance() : liveProvenance(),
      scope,
      generatedAt: now.toISOString(),
      biggestDelays: [...hotspots]
        .sort((a, b) => (b.excessVehicleMinutes ?? 0) - (a.excessVehicleMinutes ?? 0))
        .slice(0, 10),
      // Rarity, not size: a road that is always slow at 08:00 is not news, and a road that is
      // rarely slow but is slow today is exactly what an operations team needs to see.
      mostAbnormal: [...hotspots]
        .sort((a, b) => (a.occurrenceFrequency ?? 1) - (b.occurrenceFrequency ?? 1))
        .slice(0, 10),
      causationNotice:
        "Roadworks and incidents shown alongside a hotspot were active nearby at the same time. That is corroboration, not a demonstrated cause of the delay.",
    };
  }

  async analytics(scope: ProScope, now: Date): Promise<AnalyticsResponse> {
    const live = await this.liveIntelligence();
    const usingDemo = live === null;
    const window = `last ${scope.windowMinutes} minutes`;

    return {
      provenance: usingDemo ? demoProvenance() : liveProvenance(),
      scope,
      generatedAt: now.toISOString(),
      sections: usingDemo ? demoAnalyticsSections(window) : [],
      exportNotice:
        "Exports contain derived aggregates only. Raw vehicle positions are never exported: they are held in a bounded window, expire automatically, and are not ours to redistribute.",
    };
  }

  async report(scope: ProScope, period: ReportPeriod, now: Date): Promise<ReportResponse> {
    const live = await this.liveIntelligence();
    const usingDemo = live === null;

    const periodMs =
      period === "daily" ? 86_400_000 : period === "weekly" ? 604_800_000 : 2_592_000_000;
    const periodEnd = new Date(now);
    const periodStart = new Date(now.getTime() - periodMs);
    const window =
      period === "daily" ? "yesterday" : period === "weekly" ? "last 7 days" : "last 30 days";

    return {
      provenance: usingDemo ? demoProvenance() : liveProvenance(),
      scope,
      period,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      generatedAt: now.toISOString(),
      sections: usingDemo
        ? [
            {
              title: "Punctuality",
              metrics: [
                metric({
                  key: "punctuality",
                  label: "Punctuality",
                  definition: PUNCTUALITY_DEFINITION,
                  value: 0.72,
                  unit: "percent",
                  denominator: 1103,
                  window,
                  coverage: 0.86,
                }),
              ],
              narrative:
                "Punctuality was 72% across 1,103 observed journeys, against a comparable-period baseline of 75%. The difference is within the normal range for this period.",
            },
            {
              title: "Congestion",
              metrics: [
                metric({
                  key: "excess_vehicle_minutes",
                  label: "Excess vehicle-minutes",
                  definition: EXCESS_DEFINITION,
                  value: 296.2,
                  unit: "vehicle_minutes",
                  denominator: 100,
                  window,
                  coverage: 0.86,
                }),
              ],
              narrative:
                "296 excess vehicle-minutes were observed, concentrated on the A58 into Leeds between 07:30 and 08:30.",
            },
          ]
        : [],
      coverageCaveats: usingDemo
        ? [
            "86% of scheduled journeys in scope reported a position. The remainder are not counted as late or cancelled; they are simply unmeasured.",
            "London services are covered by TfL arrival predictions rather than vehicle positions, so vehicle-level figures exclude them.",
          ]
        : ["No live analysis has been published for this period."],
    };
  }
}

export const PUNCTUALITY_DEFINITION =
  "The share of observed departures leaving between 1 minute early and 5 minutes late against the timetable. Journeys with no observation are excluded from the denominator rather than counted as late.";

export const RELIABILITY_DEFINITION =
  "The share of scheduled journeys that were observed running. Periods when the data feed itself was down are excluded from the denominator: a feed outage is not a cancelled bus.";

export const HEADWAY_DEFINITION =
  "On frequent services, the share of gaps between buses within half of the scheduled interval of the timetabled gap.";

export const EXCESS_DEFINITION =
  "Total additional vehicle-minutes spent traversing a segment compared with its comparable-period baseline, summed across observed vehicles.";

function coverageFrom(summary: SourceHealthSummary): number {
  const total = summary.healthy + summary.degraded + summary.stale + summary.down;
  if (total === 0) return 0;
  return (summary.healthy + summary.degraded * 0.5) / total;
}

function severityRank(severity: Incident["severity"]): number {
  return { typical: 0, elevated: 1, abnormal: 2, highly_abnormal: 3 }[severity];
}

function toException(
  incident: Incident,
  usingDemo: boolean,
  surfacedBy: PriorityException["surfacedBy"],
): PriorityException {
  const segment = usingDemo
    ? DEMO_SEGMENTS.find(
        (candidate) =>
          "corridorId" in incident.geometry &&
          candidate.segmentId.includes(incident.geometry.corridorId.split("-")[1] ?? "@@"),
      )
    : undefined;

  return {
    incident,
    surfacedBy,
    impactVehicleMinutes: segment?.excessVehicleMinutes ?? null,
    abnormalityPercentile: segment ? 1 - segment.occurrenceFrequency : null,
    affectedRouteNames: routeNamesFor(incident, usingDemo),
    recoveryTrend: recoveryTrendFor(incident),
  };
}

function routeNamesFor(incident: Incident, usingDemo: boolean): string[] {
  if (!usingDemo) return [];
  const segment = DEMO_SEGMENTS.find(
    (candidate) =>
      "corridorId" in incident.geometry &&
      candidate.segmentId.includes(incident.geometry.corridorId.split("-")[1] ?? "@@"),
  );
  return segment?.affectedRouteNames ?? [];
}

/**
 * Recovery trend from the incident's own lifecycle. Deliberately conservative: "unknown" is a
 * legitimate answer, and claiming a trend from a single detection would be an invention.
 */
function recoveryTrendFor(incident: Incident): PriorityException["recoveryTrend"] {
  if (incident.lifecycle === "recovering") return "improving";
  if (incident.lifecycle === "resolved") return "improving";
  if (incident.lifecycle === "emerging") return "unknown";
  return incident.severity === "highly_abnormal" ? "worsening" : "steady";
}

/** The outlook is assembled from the figures, with no free text and no model. */
function buildOutlook(
  incidents: readonly Incident[],
  health: SourceHealthSummary,
  usingDemo: boolean,
): string {
  const abnormal = incidents.filter(
    (incident) => incident.severity === "abnormal" || incident.severity === "highly_abnormal",
  ).length;
  const official = incidents.filter((incident) => incident.officialStatus === "official").length;

  const parts: string[] = [];
  parts.push(
    abnormal === 0
      ? "Nothing unusual is showing across the network right now."
      : `${abnormal} ${abnormal === 1 ? "situation is" : "situations are"} outside the normal range for this time and place.`,
  );
  if (official > 0) {
    parts.push(
      `${official} of these ${official === 1 ? "is" : "are"} corroborated by an official notice.`,
    );
  }
  if (health.stale + health.down > 0) {
    parts.push(
      `${health.stale + health.down} ${health.stale + health.down === 1 ? "source is" : "sources are"} stale or down, so parts of the network are unmeasured rather than clear.`,
    );
  }
  if (usingDemo) {
    parts.push(`This outlook describes the ${DEMO_SNAPSHOT_DATE} demonstration snapshot.`);
  }
  return parts.join(" ");
}

function buildIntelligenceSummary(
  incidents: readonly Incident[],
  health: SourceHealthSummary,
  coverage: number,
  /** The newest closed window, when one has been published. */
  measured: NetworkSummary | null,
  now: Date,
): string[] {
  const summary: string[] = [];
  const byType = new Map<string, number>();
  for (const incident of incidents) {
    byType.set(incident.type, (byType.get(incident.type) ?? 0) + 1);
  }
  for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    summary.push(
      `${count} ${type.replace(/_/g, " ")} ${count === 1 ? "situation" : "situations"} active.`,
    );
  }
  summary.push(`Live source coverage is ${(coverage * 100).toFixed(0)}%.`);
  for (const problem of health.problems.slice(0, 3)) {
    summary.push(`${problem.source} is ${problem.status}: ${problem.detail}.`);
  }

  /*
   * The pipeline's own age, said separately from the measurement's.
   *
   * These two answer different questions and a reader needs both. A measurement two hours old
   * with a batch that ran three minutes ago means collection has a gap; a measurement twenty
   * minutes old with a batch that ran two hours ago means the batch has stopped. Reporting one
   * number for both makes those indistinguishable, which is exactly what happened in run 69.
   */
  /*
   * Why there is no route intelligence, when there is none.
   *
   * Run 69 mapped no vehicle to a published route, so Pro's route list was empty — and an empty
   * list reads as "no route needs attention", which is the opposite of what was true. A count of
   * zero mapped routes beside a positive count of named ones is a broken join, and saying so is
   * the difference between an honest gap and a false all-clear.
   */
  if (measured && (measured.distinctRouteNames ?? 0) > 0 && measured.distinctRoutes === 0) {
    summary.push(
      `No route-level intelligence: ${measured.distinctRouteNames} line name(s) were observed ` +
        "but none resolved to a published route, so route and operator figures are withheld " +
        "rather than shown as empty.",
    );
  }

  if (measured) {
    const measuredMin = Math.round(measurementAgeSeconds(measured, now) / 60);
    const publishedMin = Math.round(publicationAgeSeconds(measured, now) / 60);
    summary.push(
      `The newest settled measurement covers up to ${new Date(measured.windowEnd)
        .toISOString()
        .slice(11, 16)} UTC, ${measuredMin} minute(s) ago; the batch that published it ran ` +
        `${publishedMin} minute(s) ago.`,
    );
    if (measuredMin - publishedMin > 30) {
      summary.push(
        "The gap between those two is collection, not analysis: the batch ran recently and " +
          "found nothing newer that had settled.",
      );
    }
  }
  return summary;
}

/**
 * What this pipeline measures and what it does not.
 *
 * Punctuality, reliability and delay are all comparisons against a schedule. The intelligence
 * batch matches vehicle traces to road segments and times the traversals; it never reads a
 * timetable, so it cannot produce any of the three. They stayed on this page as permanently null
 * tiles whose suppression text read "No observations have been published for this scope and
 * window" — which is false, and worse than false: it tells the reader that more data would fill
 * the tile, when what is missing is a stage of the pipeline.
 *
 * They keep their place, because a control tower that quietly drops the figures it cannot produce
 * is how a reader comes to believe the ones it shows are the whole picture. But they say what is
 * actually true about them.
 */
const NOT_YET_MEASURED =
  "Not measured yet. This figure compares actual against scheduled time, and the intelligence " +
  "pipeline currently measures road-segment traversals only — it does not read the timetable. " +
  "No amount of further observation will populate it until that stage exists.";

function buildHeadlineMetrics(input: {
  usingDemo: boolean;
  window: string;
  coverage: number;
  incidents: readonly Incident[];
  summary?: NetworkSummary | null;
  now: Date;
}): ProMetric[] {
  const { usingDemo, window, coverage, incidents, now } = input;
  const summary = input.summary ?? null;
  // The age of the measurement, not of the record that carries it. See the three clocks above.
  const freshness = summary ? measurementAgeSeconds(summary, now) : null;

  const abnormalCount = incidents.filter(
    (incident) => incident.severity === "abnormal" || incident.severity === "highly_abnormal",
  ).length;

  /*
   * Two figures the pipeline genuinely produces, published only on the live path.
   *
   * Both come from the closed-window summary, so both describe a settled measurement rather than
   * a bucket still open to revision, and both carry the age of that window rather than the age of
   * the batch that wrote it.
   */
  const measured: ProMetric[] = summary
    ? [
        metric({
          key: "segments_measured",
          label: "Road segments measured",
          definition:
            "Distinct road segments with at least one closed, unsuppressed measurement window. " +
            "A segment appears once it has carried enough matched traversals to publish a figure.",
          value: summary.segmentsMeasured,
          unit: "count",
          denominator: summary.sampleCount,
          window,
          coverage,
          freshnessSeconds: freshness,
          minimumDenominator: 1,
          evidence: ["segment_metrics"],
        }),
        metric({
          key: "median_segment_traversal",
          label: "Median segment time",
          definition:
            "The middle traversal time across every matched segment crossing in the window. It " +
            "describes how long a segment takes to drive, not whether a bus was on time.",
          value: summary.medianTraversalSeconds,
          unit: "seconds",
          denominator: summary.sampleCount,
          window,
          coverage,
          freshnessSeconds: freshness,
          minimumDenominator: 1,
          evidence: ["segment_metrics"],
        }),
      ]
    : [];

  return [
    metric({
      key: "network_health",
      label: "Network health",
      definition:
        "A weighted composite of punctuality, reliability, excess delay, headway adherence, incidents and coverage, scored out of 100. Its confidence can never exceed the coverage it was computed from.",
      value: usingDemo ? 71 : null,
      unit: "points",
      denominator: usingDemo ? 1103 : 0,
      window,
      coverage,
      confidence: usingDemo
        ? { level: "medium", score: 0.66, reasons: ["capped by 86% source coverage"] }
        : null,
      baselineValue: usingDemo ? 76 : null,
      evidence: ["punctuality", "reliability", "excess_delay", "coverage"],
      // A composite of four figures, three of which this pipeline does not yet produce.
      ...(usingDemo ? {} : { suppressionReason: NOT_YET_MEASURED }),
    }),
    metric({
      key: "active_vehicles",
      label: "Buses observed",
      definition:
        "Distinct vehicles that reported a usable position in the window. Not the number running: buses whose operator does not publish positions are invisible here.",
      // Counted across samples rather than summed across buckets, so a bus crossing four
      // segments is one bus. See the pipeline's `summary.ts`.
      value: usingDemo ? 1642 : (summary?.distinctVehicles ?? null),
      unit: "count",
      denominator: usingDemo ? 1642 : (summary?.sampleCount ?? 0),
      window,
      coverage,
      freshnessSeconds: usingDemo ? null : freshness,
      minimumDenominator: 1,
      evidence: usingDemo ? [] : ["segment_metrics"],
    }),
    metric({
      key: "punctuality",
      label: "Punctuality",
      definition: PUNCTUALITY_DEFINITION,
      value: usingDemo ? 0.72 : null,
      unit: "percent",
      denominator: usingDemo ? 1103 : 0,
      window,
      coverage,
      baselineValue: usingDemo ? 0.75 : null,
      ...(usingDemo ? {} : { suppressionReason: NOT_YET_MEASURED }),
    }),
    metric({
      key: "reliability",
      label: "Reliability",
      definition: RELIABILITY_DEFINITION,
      value: usingDemo ? 0.93 : null,
      unit: "percent",
      denominator: usingDemo ? 1189 : 0,
      window,
      coverage,
      baselineValue: usingDemo ? 0.95 : null,
      ...(usingDemo ? {} : { suppressionReason: NOT_YET_MEASURED }),
    }),
    metric({
      key: "median_delay",
      label: "Median delay",
      definition:
        "The middle value of actual minus scheduled time across observed departures. The median rather than the mean, so one very late bus does not move the figure.",
      value: usingDemo ? 168 : null,
      unit: "seconds",
      denominator: usingDemo ? 1103 : 0,
      window,
      coverage,
      baselineValue: usingDemo ? 132 : null,
      ...(usingDemo ? {} : { suppressionReason: NOT_YET_MEASURED }),
    }),
    ...measured,
    metric({
      key: "abnormal_disruptions",
      label: "Abnormal disruptions",
      definition:
        "Situations whose conditions are outside the normal range for this time and place, after materiality and persistence gates.",
      value: abnormalCount,
      unit: "count",
      denominator: incidents.length,
      window,
      coverage,
      minimumDenominator: 0,
    }),
  ];
}

function demoAnalyticsSections(window: string): AnalyticsResponse["sections"] {
  return [
    {
      key: "delay_origin",
      title: "Where delay starts",
      description:
        "Locates the point along a corridor where journey time first departs from its baseline. It identifies where delay appears, which is not always where it is caused.",
      metrics: [],
      columns: ["Corridor", "Delay appears near", "Excess", "Competing explanation"],
      rows: [
        {
          label: "A58 into Leeds",
          values: [
            "A58 into Leeds",
            "Regent Street / Skinner Lane",
            "9.2 minutes",
            "Street works 180m away were active during the same period",
          ],
        },
        {
          label: "A647 Bradford Road",
          values: [
            "A647 Bradford Road",
            "Armley Road junction",
            "3.1 minutes",
            "No corroborating road event; this is what the buses show and nothing more",
          ],
        },
      ],
      requiredWording:
        "Delay appearing at a point does not mean it was caused there. Traffic queues backwards, so the cause is often further along the road.",
    },
    {
      key: "weather_sensitivity",
      title: "Weather sensitivity",
      description:
        "Compares journey times in wet and dry conditions within matched day types and hours, so rush hour is not mistaken for rain.",
      metrics: [
        metric({
          key: "wet_dry_difference",
          label: "Wet versus dry difference",
          definition:
            "Relative difference in median journey time between wet and dry conditions, within matched strata of day type and hour.",
          value: 0.08,
          unit: "percent",
          denominator: 412,
          window: "same weekday and hour, last 8 weeks",
          coverage: 0.86,
          confidence: { level: "medium", score: 0.61, reasons: ["412 matched observations"] },
        }),
      ],
      columns: [],
      rows: [],
      requiredWording:
        "This is an association, not a demonstrated cause. Buses are also slower in the dark, in winter, and at rush hour.",
    },
    {
      key: "flood_susceptibility",
      title: "Flood susceptibility",
      description:
        "Corridors with a historic association between rainfall and disruption, combined with mapped flood areas and forecast rainfall.",
      metrics: [],
      columns: ["Corridor", "Assessment", "Basis"],
      rows: [
        {
          label: "Kirkstall Road",
          values: [
            "Kirkstall Road",
            "Elevated flooding risk",
            "Historic rain-associated disruption; corridor lies within a mapped flood area",
          ],
        },
      ],
      requiredWording:
        "Only the Environment Agency issues flood alerts and warnings. Anything we derive ourselves is described as elevated risk and never as a warning.",
    },
    {
      key: "speed_anomalies",
      title: "Speed anomalies",
      description:
        "Segments where observed speeds sit well above what the segment's own history shows, based on sourced speed limits and confident position matches.",
      metrics: [],
      columns: ["Segment", "Observed", "Segment history", "Note"],
      rows: [
        {
          label: "A65 Kirkstall",
          values: [
            "A65 Kirkstall",
            "13.9 m/s",
            "9.4 m/s typical",
            "Derived from position sampling, which cannot measure instantaneous speed",
          ],
        },
      ],
      requiredWording:
        "These are properties of a road segment and a data feed, not statements about any driver. Positions are sampled seconds apart and cannot show what a speedometer would.",
    },
    {
      key: "data_quality",
      title: "Data quality",
      description:
        "How much of the network is actually measured, and how much of what arrives is usable.",
      metrics: [
        metric({
          key: "position_coverage",
          label: "Scheduled journeys reporting a position",
          definition:
            "Share of scheduled journeys in scope for which at least one usable vehicle position was received.",
          value: 0.86,
          unit: "percent",
          denominator: 1284,
          window,
          coverage: 1,
        }),
        metric({
          key: "acceptance_rate",
          label: "Records passing ingest quality gates",
          definition:
            "Share of received records that passed schema, coordinate and timestamp validation. A fall here is the earliest sign of upstream schema drift.",
          value: 0.991,
          unit: "percent",
          denominator: 84_221,
          window,
          coverage: 1,
        }),
      ],
      columns: [],
      rows: [],
      requiredWording: null,
    },
  ];
}
