import type { ObjectStore } from "@busstops/pipeline-core";
import { mapWithConcurrency, objectKeyFor } from "@busstops/pipeline-core";
import { journeyTileDataset, TILE_PUBLISH_CONCURRENCY } from "./publish.js";
// The same byte budget the in-memory shard families already publish against, for the same two
// measured reasons: R2 refuses a larger body with 413, and the runtime refuses to build the
// string at all past a point. A second number would be a second thing to keep in step.
import { MAX_SHARD_BYTES } from "./shards.js";
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
  /**
   * Shards refused for being too large to serve, with the size that refused them.
   *
   * Reported separately from `failed` because it is a different problem with a different fix: a
   * failure is something that went wrong, this is a shard key that is too coarse for the data it
   * has to hold. Under the old layout this was discovered by R2 answering 413 and by Node
   * refusing to build the string at all — both after the work had been done, and neither saying
   * which part of the country had lost its timetable.
   */
  oversized: Array<{ dataset: string; records: number; bytes: number }>;
  /**
   * What the publish actually achieved, per family.
   *
   * The first national run of the departure index published 7,168 objects in 1,647 seconds and
   * was then killed by the job's time limit. 4.35 writes a second at a concurrency of eight is a
   * ceiling rather than a pace, and the same figure reads equally as a request limit or as 1.8
   * MB/s of bandwidth — one run cannot tell those apart. So every publish now reports both, and
   * the next one says which number the layout is really up against.
   */
  throughput: { objects: number; bytes: number; seconds: number; objectsPerSecond: number };
}

export async function publishSpilledJourneyTiles(
  store: ObjectStore,
  spill: TileSpill,
  options: {
    version: string;
    /**
     * How a spill key becomes a dataset name. Journey tiles are keyed by tile and named from it;
     * the departure index spills under its own dataset name already, so it passes identity.
     */
    datasetFor?: (tile: string) => string;
    maxBytes?: number;
    /**
     * How a tile's spilled lines become the object's body.
     *
     * The default writes the lines as they were spilled. The departure index encodes instead: its
     * rows intern everything that repeats and group by stop, which is a transform that needs the
     * whole tile in hand and so belongs here rather than at the point each row is emitted.
     */
    encode?: (lines: string[], dataset: string) => string;
  },
): Promise<SpilledJourneyPublishResult> {
  const datasetFor = options.datasetFor ?? journeyTileDataset;
  const maxBytes = options.maxBytes ?? MAX_SHARD_BYTES;
  const encode = options.encode ?? ((lines: string[]) => lines.join("\n"));
  const startedAt = Date.now();
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
      const dataset = datasetFor(entry.tile);
      try {
        const lines: string[] = [];
        for await (const line of spill.read(entry.tile)) lines.push(line);
        if (lines.length === 0) {
          return { tile: entry.tile, error: null, records: 0, bytes: 0, oversized: false };
        }

        const body = encode(lines, dataset);
        const bytes = Buffer.byteLength(body, "utf8");
        /*
         * Measured before the put, not discovered by it. R2 answering 413 tells you afterwards
         * and tells you nothing about which shard key was wrong; this refuses the write, names
         * the shard and lets the build report it as a layout problem.
         */
        if (bytes > maxBytes) {
          return { tile: entry.tile, error: null, records: lines.length, bytes, oversized: true };
        }
        await store.put(objectKeyFor(dataset, options.version), body);
        return {
          tile: entry.tile,
          error: null,
          oversized: false,
          records: lines.length,
          bytes,
        };
      } catch (error) {
        return {
          tile: entry.tile,
          error: error instanceof Error ? error.message : String(error),
          records: 0,
          bytes: 0,
          oversized: false,
        };
      }
    },
  );

  const tiles: string[] = [];
  const oversized: SpilledJourneyPublishResult["oversized"] = [];
  for (const outcome of outcomes) {
    if (outcome.error !== null) {
      failed.push({ dataset: datasetFor(outcome.tile), reason: outcome.error });
      continue;
    }
    if (outcome.oversized) {
      oversized.push({
        dataset: datasetFor(outcome.tile),
        records: outcome.records,
        bytes: outcome.bytes,
      });
      continue;
    }
    if (outcome.records === 0) continue;
    tiles.push(outcome.tile);
    records += outcome.records;
    if (largest === null || outcome.bytes > largest.bytes) {
      largest = {
        dataset: datasetFor(outcome.tile),
        records: outcome.records,
        bytes: outcome.bytes,
      };
    }
  }

  const seconds = (Date.now() - startedAt) / 1000;
  let bytesWritten = 0;
  for (const outcome of outcomes) if (!outcome.oversized) bytesWritten += outcome.bytes;

  return {
    tiles: tiles.sort(),
    failed,
    records,
    largest,
    oversized,
    throughput: {
      objects: tiles.length,
      bytes: bytesWritten,
      seconds,
      objectsPerSecond: seconds > 0 ? tiles.length / seconds : 0,
    },
  };
}
