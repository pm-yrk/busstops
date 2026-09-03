import {
  ArtifactStore,
  mapWithConcurrency,
  tilesForCoordinates,
  type ArtifactManifest,
  type ObjectStore,
} from "@busstops/pipeline-core";
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

/**
 * How many journey tiles are published at once. Chosen to keep a national build's wall clock
 * reasonable without flooding object storage; the writes are independent, so the only reason for
 * a bound is politeness to the other end and to the runner's sockets.
 */
export const TILE_PUBLISH_CONCURRENCY = 12;

export const DATASETS = {
  stops: "network/stops",
  operators: "network/operators",
  services: "network/services",
  patterns: "network/patterns",
  journeys: "network/journeys",
  /** Prefix; the real datasets are `network/journeys-tile/<tile>`. See journeyTileDataset. */
  journeyTiles: "network/journeys-tile",
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

/**
 * Journeys are additionally published one object per spatial tile.
 *
 * The national journeys dataset is far too large to load in a Worker isolate, but a journey plan
 * only ever needs the corridor between two points. Publishing per tile lets the edge fetch the
 * two or three objects a request actually spans. The national dataset is still published, because
 * the batch pipelines do want the whole thing.
 */
export function journeyTileDataset(tile: string): string {
  return `${DATASETS.journeyTiles}/${tile}`;
}

export interface JourneyTilePublishResult {
  tiles: string[];
  failed: Array<{ dataset: string; reason: string }>;
  journeysWithoutGeometry: number;
}

export async function publishJourneyTiles(
  store: ObjectStore,
  network: BuiltNetwork,
  options: PublishOptions,
): Promise<JourneyTilePublishResult> {
  const artifacts = new ArtifactStore(store);
  const now = options.now ?? (() => new Date());
  const failed: JourneyTilePublishResult["failed"] = [];
  let journeysWithoutGeometry = 0;

  const stopsById = new Map(network.stops.map((stop) => [stop.id, stop]));
  const byTile = new Map<string, typeof network.journeys>();

  for (const journey of network.journeys) {
    const coordinates = journey.stopTimes
      .map((stopTime) => stopsById.get(stopTime.stopId)?.locationCoordinate)
      .filter(
        (coordinate): coordinate is NonNullable<typeof coordinate> => coordinate !== undefined,
      );

    if (coordinates.length === 0) {
      // A journey whose stops we cannot locate cannot be placed in a tile, and silently binning
      // it would make it invisible to planning with no record. Counted and reported instead.
      journeysWithoutGeometry += 1;
      continue;
    }

    // A journey spanning tiles is written to each, so a plan that touches only one end still
    // finds it. The duplication is bounded by the number of tiles a single route crosses.
    for (const tile of tilesForCoordinates(coordinates)) {
      const existing = byTile.get(tile);
      if (existing) existing.push(journey);
      else byTile.set(tile, [journey]);
    }
  }

  // Each tile costs three round trips to object storage and there are thousands of them, so
  // publishing them one at a time makes the job's wall clock the sum of the network latency
  // rather than the sum of the work. They are independent of each other, so a bounded pool is
  // safe; the bound is what stops a national build opening thousands of sockets at once.
  const entries = [...byTile];
  const outcomes = await mapWithConcurrency(entries, TILE_PUBLISH_CONCURRENCY, async (entry) => {
    const [tile, journeys] = entry;
    const dataset = journeyTileDataset(tile);
    try {
      await artifacts.publish({
        dataset,
        version: options.version,
        records: journeys,
        schemaVersion: NETWORK_SCHEMA_VERSION,
        sources: ["bods"],
        minimumRecordCount: 1,
        // A tile's journey count moves a great deal between timetable changes: a school route
        // ending for the summer is a real change, not a broken parse.
        maximumShrinkFraction: 0.9,
        now,
      });
      return { tile, error: null };
    } catch (error) {
      return { tile, error: error instanceof Error ? error.message : String(error) };
    }
  });

  const tiles: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.error === null) tiles.push(outcome.tile);
    else failed.push({ dataset: journeyTileDataset(outcome.tile), reason: outcome.error });
  }

  return { tiles, failed, journeysWithoutGeometry };
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
