/**
 * One published trip shard, in whichever form the bucket holds it.
 *
 * The planner's shards are being converted from JSON lines to the columnar binary form the reader
 * opens through typed arrays, in place, shard by shard. Every script that reads them therefore has
 * to handle a bucket that is part way through — and a script that only knew the old key would
 * report "no trips published for this corridor" the moment a tile was converted, which is the kind
 * of measurement that sends you looking for a bug in the pipeline.
 *
 * `form` says which one answered, so a report can say so rather than quietly meaning something
 * else. `text` is what a text-form measurement needs; for a converted shard it is reconstructed
 * from the rows, which is honest as long as the report says that is what happened — the rows are
 * the same rows, and the whole point of comparing the forms is to compare the work, not the bytes
 * the pipeline happened to write first.
 */

import { objectKeyFor, objectKeyForBytes, type ObjectStore } from "@busstops/pipeline-core";
import { PatternTripShard, type PatternTripRow } from "@busstops/pipeline-static-network";

export interface ReadTripShard {
  form: "lines" | "bytes";
  rows: PatternTripRow[];
  /** The shard as JSON lines: the published object, or rebuilt from a converted one. */
  text: string;
  /** The shard as bytes, when that is what was published. */
  bytes: Uint8Array | null;
}

export async function readTripShard(
  store: ObjectStore,
  dataset: string,
  version: string,
): Promise<ReadTripShard | null> {
  const text = await store.get(objectKeyFor(dataset, version));
  if (text !== null && text.length > 0) {
    const rows: PatternTripRow[] = [];
    for (const line of text.split("\n")) {
      if (line.length > 0) rows.push(JSON.parse(line) as PatternTripRow);
    }
    return { form: "lines", rows, text, bytes: null };
  }

  if (typeof store.getBytes !== "function") return null;
  const bytes = await store.getBytes(objectKeyForBytes(dataset, version));
  if (bytes === null) return null;

  const shard = new PatternTripShard(bytes);
  const rows: PatternTripRow[] = [];
  for (let trip = 0; trip < shard.tripCount; trip += 1) rows.push(shard.rowAt(trip));
  return {
    form: "bytes",
    rows,
    text: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    bytes,
  };
}
