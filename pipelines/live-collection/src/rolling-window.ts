import type { VehicleObservation } from "@busstops/contracts";
import { RAW_TRACE_MAX_AGE_HOURS, isImpossibleJump, tileKey } from "@busstops/pipeline-core";

/**
 * The rolling observation window (docs/07_DATA_PIPELINES.md, docs/06_DATA_MODEL.md retention).
 *
 * This is the only place raw positions live, and it is bounded twice over: by age, hard-capped
 * at the retention ceiling, and by count, so a runaway feed cannot exhaust memory or storage
 * before the age sweep next runs. There is deliberately no unbounded archive and no Replay path.
 *
 * Deduplication uses the source's own timestamp, not receipt time, as the specification
 * requires. The same observation arriving twice — from an overlapping partition, a retry, or a
 * feed that republishes unchanged records — must not be counted as two pieces of evidence, or
 * every metric built on top of it is inflated by however often the collector happened to run.
 */

export interface WindowOptions {
  maxAgeHours?: number;
  maxObservations?: number;
}

export interface AdmissionResult {
  admitted: VehicleObservation[];
  duplicates: number;
  tooOld: number;
  implausible: number;
  evicted: number;
}

const DEFAULTS = {
  maxAgeHours: 24,
  maxObservations: 500_000,
} as const;

/** Identity of an observation for deduplication: the same vehicle at the same source instant. */
export function observationKey(observation: VehicleObservation): string {
  return `${observation.provenance.source}|${observation.vehicleRef}|${observation.observedAt}`;
}

export class RollingObservationWindow {
  private readonly byKey = new Map<string, VehicleObservation>();
  private readonly latestByVehicle = new Map<string, VehicleObservation>();
  private readonly maxAgeHours: number;
  private readonly maxObservations: number;

  constructor(options: WindowOptions = {}) {
    const requested = options.maxAgeHours ?? DEFAULTS.maxAgeHours;
    // The retention ceiling is not negotiable by configuration.
    this.maxAgeHours = Math.min(requested, RAW_TRACE_MAX_AGE_HOURS);
    this.maxObservations = options.maxObservations ?? DEFAULTS.maxObservations;
  }

  get size(): number {
    return this.byKey.size;
  }

  admit(observations: readonly VehicleObservation[], now: Date): AdmissionResult {
    const admitted: VehicleObservation[] = [];
    let duplicates = 0;
    let tooOld = 0;
    let implausible = 0;

    for (const observation of observations) {
      const key = observationKey(observation);
      if (this.byKey.has(key)) {
        duplicates += 1;
        continue;
      }

      const ageHours = (now.getTime() - new Date(observation.observedAt).getTime()) / 3_600_000;
      if (!Number.isFinite(ageHours) || ageHours > this.maxAgeHours) {
        tooOld += 1;
        continue;
      }

      // A position that could only be reached by teleporting is a feed error, not a fast bus.
      const previous = this.latestByVehicle.get(observation.vehicleRef);
      if (
        previous &&
        isImpossibleJump(
          { coordinate: previous.coordinate, observedAt: previous.observedAt },
          { coordinate: observation.coordinate, observedAt: observation.observedAt },
        )
      ) {
        implausible += 1;
        continue;
      }

      this.byKey.set(key, observation);
      if (!previous || previous.observedAt < observation.observedAt) {
        this.latestByVehicle.set(observation.vehicleRef, observation);
      }
      admitted.push(observation);
    }

    const evicted = this.prune(now);
    return { admitted, duplicates, tooOld, implausible, evicted };
  }

  /** Age sweep plus the count ceiling. Runs on every admission, not on a separate schedule. */
  prune(now: Date): number {
    let evicted = 0;
    const cutoff = now.getTime() - this.maxAgeHours * 3_600_000;

    for (const [key, observation] of this.byKey) {
      if (new Date(observation.observedAt).getTime() < cutoff) {
        this.byKey.delete(key);
        evicted += 1;
      }
    }

    if (this.byKey.size > this.maxObservations) {
      const sorted = [...this.byKey.entries()].sort((a, b) =>
        a[1].observedAt.localeCompare(b[1].observedAt),
      );
      const excess = this.byKey.size - this.maxObservations;
      for (let i = 0; i < excess; i += 1) {
        const entry = sorted[i];
        if (!entry) break;
        this.byKey.delete(entry[0]);
        evicted += 1;
      }
    }

    if (evicted > 0) {
      for (const [vehicleRef, observation] of this.latestByVehicle) {
        if (!this.byKey.has(observationKey(observation))) this.latestByVehicle.delete(vehicleRef);
      }
    }

    return evicted;
  }

  all(): VehicleObservation[] {
    return [...this.byKey.values()];
  }

  /** Observations for one vehicle in source-time order: the input to trace derivation. */
  traceFor(vehicleRef: string): VehicleObservation[] {
    return this.all()
      .filter((observation) => observation.vehicleRef === vehicleRef)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  }

  vehicleRefs(): string[] {
    return [...new Set(this.all().map((observation) => observation.vehicleRef))];
  }

  /** Coarse spatial index used to bound per-tile work in later stages. */
  countByTile(precisionDegrees = 0.05): Map<string, number> {
    const counts = new Map<string, number>();
    for (const observation of this.all()) {
      const key = tileKey(observation.coordinate, precisionDegrees);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }
}
