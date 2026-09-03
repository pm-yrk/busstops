import type {
  Confidence,
  Incident,
  IncidentLifecycle,
  IncidentSeverity,
  IncidentType,
} from "@busstops/contracts";
import { IncidentSchema } from "@busstops/contracts";
import { deterministicUuid } from "@busstops/adapters";
import { toIso } from "@busstops/pipeline-core";

/**
 * Incident lifecycle (docs/06_DATA_MODEL.md "Incident", docs/08_ANALYTICS_ENGINE.md).
 *
 * Detection produces observations; this stage turns a stream of them into entities with a
 * beginning, a middle and an end. The identity is deterministic, derived from type, place and
 * start window, so re-running the batch does not create a second copy of an incident that is
 * already on someone's screen — and a run that is retried after a timeout is safe.
 *
 * Incidents open as `emerging`, not `active`. A single detection is a hypothesis; only one that
 * persists across runs earns a confident presentation. They then decay to `recovering` and
 * `resolved` rather than vanishing, because something that disappears without explanation reads
 * as a bug in the system rather than as a road that cleared.
 */

export interface IncidentObservation {
  type: IncidentType;
  /** Stable natural key for the place: a corridor id, pattern id or stop id. */
  placeKey: string;
  observedAt: string;
  severity: IncidentSeverity;
  confidence: Confidence;
  narrative: string;
  officialStatus: "official" | "derived";
  geometry: Incident["geometry"];
  affectedRouteIds?: string[];
  affectedVehicleRefs?: string[];
  evidence?: Incident["evidence"];
  sourceName: Incident["provenance"]["source"];
}

export interface LifecycleOptions {
  /** Detections needed before an incident is presented as active rather than emerging. */
  confirmationCount?: number;
  /** Time without a detection after which an open incident moves to recovering. */
  recoveringAfterSeconds?: number;
  /** Time without a detection after which it is resolved and closed. */
  resolvedAfterSeconds?: number;
  /** Detections within this window are treated as the same incident, not a new one. */
  continuationWindowSeconds?: number;
}

export const LIFECYCLE_DEFAULTS = {
  confirmationCount: 2,
  recoveringAfterSeconds: 900,
  resolvedAfterSeconds: 1800,
  continuationWindowSeconds: 1800,
} as const;

export interface TrackedIncident {
  incident: Incident;
  /** How many separate detections have supported this incident. */
  detectionCount: number;
  lastDetectedAt: string;
}

export interface ReconcileResult {
  incidents: TrackedIncident[];
  opened: number;
  continued: number;
  closed: number;
  notes: string[];
}

/**
 * Deterministic incident identity. The start window is bucketed so that two detections seconds
 * apart map to the same incident, while a genuinely new event hours later does not.
 */
export function incidentKey(
  type: IncidentType,
  placeKey: string,
  startedAt: string,
  windowSeconds: number = LIFECYCLE_DEFAULTS.continuationWindowSeconds,
): string {
  const bucket = Math.floor(new Date(startedAt).getTime() / (windowSeconds * 1000));
  return `${type}|${placeKey}|${bucket}`;
}

export function reconcileIncidents(
  existing: readonly TrackedIncident[],
  observations: readonly IncidentObservation[],
  now: Date,
  options: LifecycleOptions = {},
): ReconcileResult {
  const config = { ...LIFECYCLE_DEFAULTS, ...options };
  const notes: string[] = [];

  const tracked = new Map<string, TrackedIncident>();
  for (const entry of existing) {
    tracked.set(
      incidentKey(
        entry.incident.type,
        placeKeyOf(entry.incident),
        entry.incident.startedAt,
        config.continuationWindowSeconds,
      ),
      { ...entry, incident: { ...entry.incident } },
    );
  }

  let opened = 0;
  let continued = 0;

  for (const observation of observations) {
    // Continue an open incident of the same type in the same place, rather than opening a
    // second one: two overlapping "bunching on route 42" cards would be the same fact twice.
    const openMatch = [...tracked.values()].find(
      (entry) =>
        entry.incident.type === observation.type &&
        placeKeyOf(entry.incident) === observation.placeKey &&
        entry.incident.endedAt === null &&
        (new Date(observation.observedAt).getTime() - new Date(entry.lastDetectedAt).getTime()) /
          1000 <=
          config.continuationWindowSeconds,
    );

    if (openMatch) {
      const detectionCount = openMatch.detectionCount + 1;
      openMatch.detectionCount = detectionCount;
      openMatch.lastDetectedAt = observation.observedAt;
      openMatch.incident = {
        ...openMatch.incident,
        // Severity tracks the worst seen; a burst that eased still happened.
        severity: worstSeverity(openMatch.incident.severity, observation.severity),
        confidence: observation.confidence,
        narrative: observation.narrative,
        lifecycle: detectionCount >= config.confirmationCount ? "active" : "emerging",
        evidence: mergeEvidence(openMatch.incident.evidence, observation.evidence ?? []),
        affectedVehicleRefs: [
          ...new Set([
            ...openMatch.incident.affectedVehicleRefs,
            ...(observation.affectedVehicleRefs ?? []),
          ]),
        ],
        affectedRouteIds: [
          ...new Set([
            ...openMatch.incident.affectedRouteIds,
            ...(observation.affectedRouteIds ?? []),
          ]),
        ],
      };
      continued += 1;
      continue;
    }

    const key = incidentKey(
      observation.type,
      observation.placeKey,
      observation.observedAt,
      config.continuationWindowSeconds,
    );
    const incident: Incident = IncidentSchema.parse({
      id: deterministicUuid("incident", key),
      provenance: {
        source: observation.sourceName,
        retrievedAt: toIso(now),
        externalIds: [],
      },
      ingestedAt: toIso(now),
      qualityFlags: observation.confidence.score < 0.45 ? ["low_confidence"] : ["ok"],
      type: observation.type,
      startedAt: observation.observedAt,
      endedAt: null,
      geometry: observation.geometry,
      affectedRouteIds: observation.affectedRouteIds ?? [],
      affectedVehicleRefs: observation.affectedVehicleRefs ?? [],
      severity: observation.severity,
      confidence: observation.confidence,
      evidence: observation.evidence ?? [],
      officialStatus: observation.officialStatus,
      // A single detection is a hypothesis, never yet an active incident.
      lifecycle: "emerging" as IncidentLifecycle,
      narrative: observation.narrative,
    });

    tracked.set(key, {
      incident,
      detectionCount: 1,
      lastDetectedAt: observation.observedAt,
    });
    opened += 1;
  }

  // Age out anything not re-detected this run.
  let closed = 0;
  for (const entry of tracked.values()) {
    if (entry.incident.endedAt !== null) continue;
    const silenceSeconds = (now.getTime() - new Date(entry.lastDetectedAt).getTime()) / 1000;

    if (silenceSeconds >= config.resolvedAfterSeconds) {
      entry.incident = {
        ...entry.incident,
        lifecycle: "resolved",
        endedAt: entry.lastDetectedAt,
      };
      closed += 1;
    } else if (silenceSeconds >= config.recoveringAfterSeconds) {
      entry.incident = { ...entry.incident, lifecycle: "recovering" };
    }
  }

  const emerging = [...tracked.values()].filter(
    (entry) => entry.incident.lifecycle === "emerging",
  ).length;
  if (emerging > 0) {
    notes.push(
      `${emerging} incidents are still emerging and need a further detection before they are presented as active`,
    );
  }

  return {
    incidents: [...tracked.values()].sort((a, b) =>
      a.incident.startedAt.localeCompare(b.incident.startedAt),
    ),
    opened,
    continued,
    closed,
    notes,
  };
}

function placeKeyOf(incident: Incident): string {
  return "corridorId" in incident.geometry
    ? incident.geometry.corridorId
    : `${incident.geometry.lat.toFixed(5)},${incident.geometry.lon.toFixed(5)}`;
}

const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  typical: 0,
  elevated: 1,
  abnormal: 2,
  highly_abnormal: 3,
};

function worstSeverity(a: IncidentSeverity, b: IncidentSeverity): IncidentSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function mergeEvidence(
  existing: Incident["evidence"],
  incoming: Incident["evidence"],
): Incident["evidence"] {
  const seen = new Set(existing.map((ref) => `${ref.kind}|${ref.refId}`));
  const merged = [...existing];
  for (const ref of incoming) {
    const key = `${ref.kind}|${ref.refId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  // Evidence is bounded: an incident carrying thousands of refs is a storage problem, and the
  // strongest few are what anyone actually reads.
  return merged.slice(0, 20);
}
