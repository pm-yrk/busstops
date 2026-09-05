import type { ObjectStore } from "@busstops/pipeline-core";
import { mapWithConcurrency, objectKeyFor } from "@busstops/pipeline-core";
import { journeyTileDataset, TILE_PUBLISH_CONCURRENCY } from "./publish.js";
import type { TileSpill } from "./gtfs-spill.js";

/**
 * Publishing journey tiles from disk rather than from memory.
 *
 * Of everything the network publishes, journeys are the only family whose size scales with every
 * trip in England on every service date: measured at the old 60-dataset cap they were 292 MiB, and
 * lifting that cap multiplies them. Stops, patterns, services and the search index do not scale
 * that way and are still assembled in memory, which is why only this family moved.
 *
 * The spill has already sorted them into tiles, so this reads one tile, writes one object, and
 * forgets it. Peak memory is the largest tile.
 *
 * Like the other shard families it writes objects directly rather than performing a full artifact
 * publish per tile: the edge addresses shards at the version the index names, so a per-shard
 * manifest would be written and never read, and a national build writing thousands of them cost
 * three times the requests against a rate-limited API. Atomicity comes from the index, which is a
 * real publish written last.
 */

export interface SpilledJourneyPublishResult {
  tiles: string[];
  failed: Array<{ dataset: string; reason: string }>;
  /** Records written, so the published total can be compared with what the build emitted. */
  records: number;
  /** The biggest tile, which is the number that says whether the tile size is still right. */
  largest: { dataset: string; records: number; bytes: number } | null;
}

export async function publishSpilledJourneyTiles(
  store: ObjectStore,
  spill: TileSpill,
  options: { version: string },
): Promise<SpilledJourneyPublishResult> {
  // Written before anything is read back, because a buffered tail would otherwise be published
  // as a shorter tile than the build produced — a silent, partial timetable.
  spill.flush();

  const failed: SpilledJourneyPublishResult["failed"] = [];
  let records = 0;
  let largest: SpilledJourneyPublishResult["largest"] = null;

  const outcomes = await mapWithConcurrency(
    spill.tiles(),
    TILE_PUBLISH_CONCURRENCY,
    async (entry) => {
      const dataset = journeyTileDataset(entry.tile);
      try {
        const lines: string[] = [];
        for await (const line of spill.read(entry.tile)) lines.push(line);
        if (lines.length === 0) return { tile: entry.tile, error: null, records: 0, bytes: 0 };

        const body = lines.join("\n");
        await store.put(objectKeyFor(dataset, options.version), body);
        return {
          tile: entry.tile,
          error: null,
          records: lines.length,
          bytes: Buffer.byteLength(body, "utf8"),
        };
      } catch (error) {
        return {
          tile: entry.tile,
          error: error instanceof Error ? error.message : String(error),
          records: 0,
          bytes: 0,
        };
      }
    },
  );

  const tiles: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.error !== null) {
      failed.push({ dataset: journeyTileDataset(outcome.tile), reason: outcome.error });
      continue;
    }
    if (outcome.records === 0) continue;
    tiles.push(outcome.tile);
    records += outcome.records;
    if (largest === null || outcome.bytes > largest.bytes) {
      largest = {
        dataset: journeyTileDataset(outcome.tile),
        records: outcome.records,
        bytes: outcome.bytes,
      };
    }
  }

  return { tiles: tiles.sort(), failed, records, largest };
}
