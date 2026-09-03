import type { Confidence, DailyBriefSnapshot, Incident, SourceHealth } from "@busstops/contracts";
import { DailyBriefSnapshotSchema } from "@busstops/contracts";
import { deterministicUuid } from "@busstops/adapters";

/**
 * The Daily Brief snapshot (docs/12_DAILY_BRIEF.md "Generation").
 *
 * The snapshot is frozen on purpose. The email and the browser view are both rendered from this
 * one object, so a recipient who opens the link an hour after reading the email sees the same
 * numbers. If they did not, they would have no reason to trust either — and "the figures changed
 * while I was looking at them" is the fastest way to lose a professional audience.
 *
 * Everything downstream of here is deterministic: given the same snapshot, the narrative, the HTML
 * and the plain text are byte-identical. No model writes any of it, which is a requirement rather
 * than a preference: a rewriting step cannot be trusted not to change a number or soften a caveat.
 */

export interface BriefInput {
  organisationId: string | null;
  scopeAreaIds: string[];
  localDate: string;
  generatedAt: Date;
  artifactVersion: string;
  yesterday: {
    networkHealth: number | null;
    networkHealthBaseline: number | null;
    punctuality: number | null;
    reliability: number | null;
    medianDelaySeconds: number | null;
    denominator: number;
    topPerformingRouteIds: string[];
    requiresAttentionRouteIds: string[];
    biggestDelayBurdenIncident: Incident | null;
    biggestAbnormalIncident: Incident | null;
    keyEvents: Incident[];
    dataQualityIssues: string[];
  };
  today: {
    riskBand: "low" | "moderate" | "elevated" | "high";
    confidence: Confidence;
    weatherWindowSummary: string;
    activeFloodNoticeIds: string[];
    plannedRoadworksIds: string[];
    highestRiskCorridors: Array<{
      corridorId: string;
      probabilityBand: string;
      expectedAdditionalMinutesLow: number;
      expectedAdditionalMinutesHigh: number;
    }>;
  };
  sourceHealth: readonly SourceHealth[];
  /** 0..1 share of the scope with usable data. */
  coverage: number;
}

/** Below this, the brief is sent clearly labelled as limited-data, or skipped. Never fabricated. */
export const MINIMUM_USEFUL_COVERAGE = 0.4;
export const MINIMUM_USEFUL_DENOMINATOR = 20;

export function buildSnapshot(input: BriefInput): DailyBriefSnapshot {
  const coverageCaveat = buildCoverageCaveat(input);

  const snapshot = {
    id: deterministicUuid(
      "incident",
      `daily-brief|${input.organisationId ?? "public"}|${input.localDate}|${input.artifactVersion}`,
    ),
    provenance: {
      source: "bods" as const,
      retrievedAt: input.generatedAt.toISOString(),
      externalIds: [],
    },
    ingestedAt: input.generatedAt.toISOString(),
    qualityFlags:
      input.coverage < MINIMUM_USEFUL_COVERAGE ? ["low_confidence" as const] : ["ok" as const],
    organisationId: input.organisationId,
    scopeAreaIds: input.scopeAreaIds,
    localDate: input.localDate,
    generatedAt: input.generatedAt.toISOString(),
    artifactVersion: input.artifactVersion,
    coverageCaveat,
    yesterday: {
      networkHealth: input.yesterday.networkHealth,
      networkHealthChangeVsBaseline:
        input.yesterday.networkHealth !== null && input.yesterday.networkHealthBaseline !== null
          ? input.yesterday.networkHealth - input.yesterday.networkHealthBaseline
          : null,
      punctuality: input.yesterday.punctuality,
      reliability: input.yesterday.reliability,
      medianDelaySeconds: input.yesterday.medianDelaySeconds,
      denominator: input.yesterday.denominator,
      // Route rankings are published only where coverage supports comparing them at all.
      topPerformingRouteIds: comparable(input) ? input.yesterday.topPerformingRouteIds : [],
      requiresAttentionRouteIds: comparable(input) ? input.yesterday.requiresAttentionRouteIds : [],
      biggestDelayBurdenIncidentId: input.yesterday.biggestDelayBurdenIncident?.id ?? null,
      biggestAbnormalDisruptionIncidentId: input.yesterday.biggestAbnormalIncident?.id ?? null,
      keyEventIds: input.yesterday.keyEvents.map((incident) => incident.id),
      dataQualityIssues: input.yesterday.dataQualityIssues,
    },
    today: {
      riskBand: input.today.riskBand,
      confidence: input.today.confidence,
      weatherWindowSummary: input.today.weatherWindowSummary,
      activeFloodNoticeIds: input.today.activeFloodNoticeIds,
      plannedRoadworksIds: input.today.plannedRoadworksIds,
      highestRiskCorridors: input.today.highestRiskCorridors,
      investigationPriorities: buildInvestigationPriorities(input),
    },
    narrative: buildNarrative(input, coverageCaveat),
  };

  return DailyBriefSnapshotSchema.parse(snapshot);
}

function comparable(input: BriefInput): boolean {
  return (
    input.coverage >= MINIMUM_USEFUL_COVERAGE &&
    input.yesterday.denominator >= MINIMUM_USEFUL_DENOMINATOR
  );
}

export function buildCoverageCaveat(input: BriefInput): string | null {
  const problems = input.sourceHealth.filter((source) => source.status !== "healthy");
  const parts: string[] = [];

  if (input.coverage < 1) {
    parts.push(
      `${(input.coverage * 100).toFixed(0)}% of this scope reported usable data. The rest is unmeasured, not necessarily running well.`,
    );
  }
  if (input.yesterday.denominator < MINIMUM_USEFUL_DENOMINATOR) {
    parts.push(
      `Only ${input.yesterday.denominator} observations contributed, which is too few for route-level comparison.`,
    );
  }
  for (const problem of problems.slice(0, 3)) {
    parts.push(`${problem.source} was ${problem.status}.`);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Investigation priorities, phrased as suggestions.
 *
 * The specification is explicit that these are not operational commands, and the wording carries
 * that: "worth looking at", never "reallocate a vehicle". Bus Stops can see that a corridor is
 * slow; it cannot see the driver rota, the depot, or the reason, and an instruction phrased as
 * though it could would be acted on by someone who assumed we knew more than we do.
 */
export function buildInvestigationPriorities(input: BriefInput): string[] {
  const priorities: string[] = [];

  for (const corridor of input.today.highestRiskCorridors.slice(0, 3)) {
    priorities.push(
      `${corridor.corridorId} is worth looking at first: ${corridor.probabilityBand} chance of delay, expected to add roughly ${corridor.expectedAdditionalMinutesLow}–${corridor.expectedAdditionalMinutesHigh} minutes.`,
    );
  }

  if (input.yesterday.requiresAttentionRouteIds.length > 0 && comparable(input)) {
    priorities.push(
      `${input.yesterday.requiresAttentionRouteIds.length} routes fell below their comparable baseline yesterday and may be worth reviewing.`,
    );
  }

  if (input.yesterday.dataQualityIssues.length > 0) {
    priorities.push(
      `Data quality: ${input.yesterday.dataQualityIssues[0]}. Figures for the affected services describe less of the network than usual.`,
    );
  }

  if (priorities.length === 0) {
    priorities.push("Nothing stands out as needing attention from the data available today.");
  }

  return priorities;
}

/** The narrative, assembled from ranked facts by a fixed template. No model, ever. */
export function buildNarrative(input: BriefInput, coverageCaveat: string | null): string {
  const sentences: string[] = [];
  const { yesterday, today } = input;

  if (yesterday.networkHealth === null || !comparable(input)) {
    sentences.push(
      `There was not enough data yesterday to describe how the network performed across this scope.`,
    );
  } else {
    const change =
      yesterday.networkHealthBaseline === null
        ? null
        : yesterday.networkHealth - yesterday.networkHealthBaseline;
    sentences.push(
      `Network health was ${Math.round(yesterday.networkHealth)} out of 100 yesterday` +
        (change === null
          ? "."
          : change === 0
            ? ", the same as its 30-day comparable baseline."
            : `, ${Math.abs(Math.round(change))} ${Math.abs(change) === 1 ? "point" : "points"} ${change > 0 ? "above" : "below"} its 30-day comparable baseline.`),
    );

    if (yesterday.punctuality !== null) {
      sentences.push(
        `Punctuality was ${(yesterday.punctuality * 100).toFixed(0)}% across ${yesterday.denominator.toLocaleString("en-GB")} observed departures.`,
      );
    }
    if (yesterday.reliability !== null) {
      sentences.push(`Reliability was ${(yesterday.reliability * 100).toFixed(0)}%.`);
    }
  }

  if (yesterday.biggestDelayBurdenIncident) {
    sentences.push(`Most time was lost to: ${yesterday.biggestDelayBurdenIncident.narrative}`);
  }
  if (
    yesterday.biggestAbnormalIncident &&
    yesterday.biggestAbnormalIncident.id !== yesterday.biggestDelayBurdenIncident?.id
  ) {
    sentences.push(
      `The most unusual conditions were: ${yesterday.biggestAbnormalIncident.narrative}`,
    );
  }

  sentences.push(
    `Today's outlook is ${today.riskBand} risk, at ${today.confidence.level} confidence. ${today.weatherWindowSummary}`,
  );

  if (today.activeFloodNoticeIds.length > 0) {
    sentences.push(
      `${today.activeFloodNoticeIds.length} official Environment Agency flood ${today.activeFloodNoticeIds.length === 1 ? "notice is" : "notices are"} active in this scope.`,
    );
  }

  if (coverageCaveat) sentences.push(coverageCaveat);

  return sentences.join(" ");
}

export interface BriefDecision {
  action: "send" | "send_limited" | "skip";
  reason: string;
}

/**
 * Whether this snapshot is worth sending.
 *
 * A brief built on almost no data is not a smaller brief, it is a misleading one: the recipient
 * reads "punctuality 100%" without registering that it came from four journeys. So a thin snapshot
 * is either sent under a clear limited-data label or skipped, according to preference — and never
 * quietly padded out.
 */
export function decideSend(
  snapshot: DailyBriefSnapshot,
  coverage: number,
  preference: "send_limited" | "skip_when_limited",
): BriefDecision {
  const thin =
    coverage < MINIMUM_USEFUL_COVERAGE ||
    snapshot.yesterday.denominator < MINIMUM_USEFUL_DENOMINATOR;

  if (!thin) return { action: "send", reason: "Coverage is adequate for a full brief." };

  return preference === "skip_when_limited"
    ? {
        action: "skip",
        reason: `Coverage was ${(coverage * 100).toFixed(0)}% with ${snapshot.yesterday.denominator} observations, below the useful threshold, and this recipient asked to skip limited-data briefs.`,
      }
    : {
        action: "send_limited",
        reason: `Coverage was ${(coverage * 100).toFixed(0)}% with ${snapshot.yesterday.denominator} observations. The brief will be sent clearly labelled as limited-data.`,
      };
}
