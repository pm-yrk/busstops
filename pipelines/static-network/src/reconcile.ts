import type { Operator, RoutePattern, ServiceRoute, Stop } from "@busstops/contracts";
import { haversineMetres } from "@busstops/pipeline-core";
import { reconcileStops, type StopReconciliation } from "@busstops/adapters";

/**
 * Weekly full England reconciliation (docs/07_DATA_PIPELINES.md).
 *
 * Runs regardless of change hints, because a source can republish the same fingerprint while
 * its content has drifted. Produces a compact Network Changes report so a bad upstream release
 * is visible as a number rather than as a silent gap in the map.
 */

export interface NetworkChangesReport {
  generatedAt: string;
  stops: StopReconciliation;
  operators: {
    added: Operator[];
    removed: Operator[];
    renamed: Array<{ previous: Operator; current: Operator }>;
  };
  services: {
    added: ServiceRoute[];
    removed: ServiceRoute[];
    renamed: Array<{ previous: ServiceRoute; current: ServiceRoute }>;
  };
  patterns: {
    added: RoutePattern[];
    removed: RoutePattern[];
    stopSequenceChanged: Array<{
      patternId: string;
      previousLength: number;
      currentLength: number;
    }>;
  };
  /** Set when the scale of change suggests a broken upstream release rather than real edits. */
  anomalies: string[];
}

export interface ReconcileOptions {
  generatedAt: string;
  movedThresholdMetres?: number;
  /** Above this fraction of removals, the change is treated as suspicious. */
  suspiciousRemovalFraction?: number;
}

export function reconcileNetwork(
  previous: {
    stops: readonly Stop[];
    operators: readonly Operator[];
    services: readonly ServiceRoute[];
    patterns: readonly RoutePattern[];
  },
  current: {
    stops: readonly Stop[];
    operators: readonly Operator[];
    services: readonly ServiceRoute[];
    patterns: readonly RoutePattern[];
  },
  options: ReconcileOptions,
): NetworkChangesReport {
  const movedThresholdMetres = options.movedThresholdMetres ?? 25;
  const suspiciousRemovalFraction = options.suspiciousRemovalFraction ?? 0.1;

  const stops = reconcileStops(
    previous.stops,
    current.stops,
    movedThresholdMetres,
    haversineMetres,
  );

  const operators = diffById(previous.operators, current.operators, (o) => o.name);
  const services = diffById(previous.services, current.services, (s) => s.publicName);

  const previousPatterns = new Map(previous.patterns.map((p) => [p.id, p]));
  const currentPatterns = new Map(current.patterns.map((p) => [p.id, p]));

  const patternsAdded = current.patterns.filter((p) => !previousPatterns.has(p.id));
  const patternsRemoved = previous.patterns.filter((p) => !currentPatterns.has(p.id));
  const stopSequenceChanged: NetworkChangesReport["patterns"]["stopSequenceChanged"] = [];

  for (const pattern of current.patterns) {
    const before = previousPatterns.get(pattern.id);
    if (!before) continue;
    if (
      before.stopSequence.length !== pattern.stopSequence.length ||
      before.stopSequence.some((id, index) => id !== pattern.stopSequence[index])
    ) {
      stopSequenceChanged.push({
        patternId: pattern.id,
        previousLength: before.stopSequence.length,
        currentLength: pattern.stopSequence.length,
      });
    }
  }

  const anomalies: string[] = [];
  const flagRemoval = (label: string, removed: number, total: number) => {
    if (total === 0) return;
    const fraction = removed / total;
    if (fraction > suspiciousRemovalFraction) {
      anomalies.push(
        `${(fraction * 100).toFixed(1)}% of ${label} disappeared (${removed} of ${total}); ` +
          `likely a partial or broken upstream release rather than real withdrawals`,
      );
    }
  };

  flagRemoval("stops", stops.removed.length, previous.stops.length);
  flagRemoval("services", services.removed.length, previous.services.length);
  flagRemoval("patterns", patternsRemoved.length, previous.patterns.length);

  return {
    generatedAt: options.generatedAt,
    stops,
    operators,
    services,
    patterns: { added: patternsAdded, removed: patternsRemoved, stopSequenceChanged },
    anomalies,
  };
}

function diffById<T extends { id: string }>(
  previous: readonly T[],
  current: readonly T[],
  nameOf: (item: T) => string,
): { added: T[]; removed: T[]; renamed: Array<{ previous: T; current: T }> } {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const currentById = new Map(current.map((item) => [item.id, item]));

  const added = current.filter((item) => !previousById.has(item.id));
  const removed = previous.filter((item) => !currentById.has(item.id));
  const renamed: Array<{ previous: T; current: T }> = [];

  for (const item of current) {
    const before = previousById.get(item.id);
    if (before && nameOf(before) !== nameOf(item))
      renamed.push({ previous: before, current: item });
  }

  return { added, removed, renamed };
}

/** Compact human-readable summary for the Network Changes report and job logs. */
export function summariseNetworkChanges(report: NetworkChangesReport): string {
  const lines = [
    `Network changes at ${report.generatedAt}`,
    `Stops: +${report.stops.added.length} -${report.stops.removed.length} ` +
      `moved ${report.stops.moved.length} renamed ${report.stops.renamed.length}`,
    `Operators: +${report.operators.added.length} -${report.operators.removed.length} ` +
      `renamed ${report.operators.renamed.length}`,
    `Services: +${report.services.added.length} -${report.services.removed.length} ` +
      `renamed ${report.services.renamed.length}`,
    `Patterns: +${report.patterns.added.length} -${report.patterns.removed.length} ` +
      `resequenced ${report.patterns.stopSequenceChanged.length}`,
  ];
  if (report.anomalies.length > 0) {
    lines.push("Anomalies:");
    for (const anomaly of report.anomalies) lines.push(`  - ${anomaly}`);
  }
  return lines.join("\n");
}
