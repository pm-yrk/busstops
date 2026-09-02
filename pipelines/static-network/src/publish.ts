import { ArtifactStore, type ArtifactManifest, type ObjectStore } from "@busstops/pipeline-core";
import type { BuiltNetwork } from "./build-network.js";
import { buildSearchIndex } from "./search-index.js";

/**
 * Publishes a built network as versioned artifacts with atomic manifest swaps.
 *
 * Datasets are published in dependency order and validated individually. If any publish fails
 * validation, the ones already published keep their new version and the rest keep the previous
 * good one — so the caller is told exactly which datasets advanced, rather than the system
 * silently ending up half-updated with no record of it.
 */

export const NETWORK_SCHEMA_VERSION = "1.0.0";

export const DATASETS = {
  stops: "network/stops",
  operators: "network/operators",
  services: "network/services",
  patterns: "network/patterns",
  journeys: "network/journeys",
  shapes: "network/shapes",
  searchIndex: "network/search-index",
} as const;

export interface PublishResult {
  published: ArtifactManifest[];
  failed: Array<{ dataset: string; reason: string }>;
  /** True when every dataset advanced, which is the only fully consistent outcome. */
  complete: boolean;
}

export interface PublishOptions {
  version: string;
  now?: () => Date;
  /** Guards against a broken upstream parse publishing a near-empty national dataset. */
  minimumStops?: number;
  minimumJourneys?: number;
}

export async function publishNetwork(
  store: ObjectStore,
  network: BuiltNetwork,
  options: PublishOptions,
): Promise<PublishResult> {
  const artifacts = new ArtifactStore(store);
  const published: ArtifactManifest[] = [];
  const failed: PublishResult["failed"] = [];
  const now = options.now ?? (() => new Date());

  const partialCoverage =
    network.counts.danglingStopReferences > 0 || network.counts.parseErrors > 0;

  const attempts: Array<{
    dataset: string;
    records: readonly unknown[];
    minimumRecordCount: number;
  }> = [
    {
      dataset: DATASETS.stops,
      records: network.stops,
      minimumRecordCount: options.minimumStops ?? 1,
    },
    { dataset: DATASETS.operators, records: network.operators, minimumRecordCount: 1 },
    { dataset: DATASETS.services, records: network.services, minimumRecordCount: 1 },
    { dataset: DATASETS.patterns, records: network.patterns, minimumRecordCount: 1 },
    {
      dataset: DATASETS.journeys,
      records: network.journeys,
      minimumRecordCount: options.minimumJourneys ?? 1,
    },
    {
      dataset: DATASETS.shapes,
      records: [...network.shapes.entries()].map(([shapeRef, points]) => ({ shapeRef, points })),
      minimumRecordCount: 1,
    },
    {
      dataset: DATASETS.searchIndex,
      records: buildSearchIndex(network, { builtAt: now().toISOString() }).entries,
      minimumRecordCount: 1,
    },
  ];

  for (const attempt of attempts) {
    if (attempt.records.length === 0) {
      failed.push({ dataset: attempt.dataset, reason: "no records produced" });
      continue;
    }
    try {
      const manifest = await artifacts.publish({
        dataset: attempt.dataset,
        version: options.version,
        records: attempt.records,
        schemaVersion: NETWORK_SCHEMA_VERSION,
        sources: ["naptan", "bods"],
        partialCoverage,
        minimumRecordCount: attempt.minimumRecordCount,
        now,
        ...(network.warnings.length > 0
          ? { notes: `${network.warnings.length} build warning(s)` }
          : {}),
      });
      published.push(manifest);
    } catch (error) {
      failed.push({
        dataset: attempt.dataset,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { published, failed, complete: failed.length === 0 };
}

/** Rolls every network dataset back to its previous good version after a bad publish. */
export async function rollbackNetwork(store: ObjectStore): Promise<string[]> {
  const artifacts = new ArtifactStore(store);
  const rolledBack: string[] = [];
  for (const dataset of Object.values(DATASETS)) {
    const manifest = await artifacts.rollback(dataset);
    if (manifest) rolledBack.push(`${dataset}@${manifest.version}`);
  }
  return rolledBack;
}
