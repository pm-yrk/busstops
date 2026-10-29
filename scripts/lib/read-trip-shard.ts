/**
 * One published trip shard, in whichever form the bucket holds it.
 *
 * The planner's shards are published as the columnar binary form the reader opens through typed
 * arrays. They were converted in place from JSON lines, and the bucket can still hold both forms
 * of the same shard — the daily refresh republishes the live horizon as lines from the default
 * branch, and one of its runs overlapped the migration. So every script that reads them has to
 * handle both, and has to read them in the same order the deployed reader does.
 *
 * Bytes first, therefore. A measurement harness that preferred the text found eight Leeds shards
 * as lines and reported the trip-preparation stage at 30 ms — the cost of the path the Worker no
 * longer takes. `form` says which one answered, and `bothForms` says the shard had both, which is
 * a fault in the bucket rather than in the reader.
 *
 * `text` is what a text-form measurement needs; for a shard that answered as bytes it is
 * reconstructed from the rows, which is honest as long as the report says so — the rows are the
 * same rows, and comparing the forms is comparing the work, not the bytes the pipeline wrote
 * first.
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
  /** Both forms are in the bucket for this key, which means a reader has to choose. */
  bothForms: boolean;
}

function linesOf(text: string): PatternTripRow[] {
  const rows: PatternTripRow[] = [];
  for (const line of text.split("\n")) {
    if (line.length > 0) rows.push(JSON.parse(line) as PatternTripRow);
  }
  return rows;
}

export async function readTripShard(
  store: ObjectStore,
  dataset: string,
  version: string,
): Promise<ReadTripShard | null> {
  const bytes =
    typeof store.getBytes === "function"
      ? await store.getBytes(objectKeyForBytes(dataset, version))
      : null;

  if (bytes !== null) {
    const shard = new PatternTripShard(bytes);
    const rows: PatternTripRow[] = [];
    for (let trip = 0; trip < shard.tripCount; trip += 1) rows.push(shard.rowAt(trip));
    /*
     * Asked for only to report it. A shard with both forms is one whose reader may be answering
     * from the older of two timetables, and a harness that never looks cannot say so.
     */
    const alsoText = await store.get(objectKeyFor(dataset, version));
    return {
      form: "bytes",
      rows,
      text: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      bytes,
      bothForms: alsoText !== null && alsoText.length > 0,
    };
  }

  const text = await store.get(objectKeyFor(dataset, version));
  if (text === null || text.length === 0) return null;
  return { form: "lines", rows: linesOf(text), text, bytes: null, bothForms: false };
}
