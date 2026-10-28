/**
 * Converting one published trip shard from JSON lines into the form a request can read.
 *
 * Extracted from the migration script because of what it does: it deletes published timetable.
 * The sequence — encode, verify, write, read back out of the bucket, verify again, and only then
 * delete — is the whole safety of the operation, and glue that destructive deserves a test rather
 * than a careful reading.
 *
 * The one rule that cannot bend: the text form is deleted only after the bytes that replace it
 * have been read back *from the store* and found to hold every row. An upload that answered 200
 * and stored something else is exactly the failure this cannot survive, and it is not a
 * hypothetical — this project has already lost 376 shards of a national publish to a run of 503s.
 */

import type { BinaryObjectStore } from "@busstops/pipeline-core";
import {
  encodePatternTripShard,
  shardHoldsEveryRow,
  type PatternTripRow,
} from "@busstops/pipeline-static-network";

export interface ShardConversion {
  outcome: "converted" | "verified_only" | "absent" | "unreadable" | "not_replaced";
  textBytes: number;
  binaryBytes: number;
  /** Why it was not converted, when it was not. */
  reason?: string;
}

/** Every row the text shard held, in order. */
export function rowsOfShardText(text: string): PatternTripRow[] {
  const rows: PatternTripRow[] = [];
  for (const line of text.split("\n")) {
    if (line.length > 0) rows.push(JSON.parse(line) as PatternTripRow);
  }
  return rows;
}

/** The binary sibling of a text shard's key. */
export function binaryKeyOf(textKey: string): string {
  return `${textKey.slice(0, -".jsonl".length)}.bin`;
}

export async function convertTripShard(
  store: BinaryObjectStore,
  textKey: string,
  options: { apply: boolean },
): Promise<ShardConversion> {
  let text: string | null;
  try {
    text = await store.get(textKey);
  } catch (error) {
    return {
      outcome: "unreadable",
      textBytes: 0,
      binaryBytes: 0,
      reason: String(error).slice(0, 120),
    };
  }
  if (text === null || text.length === 0) {
    return { outcome: "absent", textBytes: 0, binaryBytes: 0 };
  }

  let rows: PatternTripRow[];
  try {
    rows = rowsOfShardText(text);
  } catch (error) {
    return {
      outcome: "unreadable",
      textBytes: text.length,
      binaryBytes: 0,
      reason: `lines: ${String(error).slice(0, 100)}`,
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = encodePatternTripShard(rows).bytes;
  } catch (error) {
    return {
      outcome: "unreadable",
      textBytes: text.length,
      binaryBytes: 0,
      reason: `encode: ${String(error).slice(0, 100)}`,
    };
  }

  const encoded = shardHoldsEveryRow(bytes, rows);
  if (!encoded.ok) {
    return {
      outcome: "not_replaced",
      textBytes: text.length,
      binaryBytes: bytes.byteLength,
      reason: encoded.reason,
    };
  }
  if (!options.apply) {
    return { outcome: "verified_only", textBytes: text.length, binaryBytes: bytes.byteLength };
  }

  const binaryKey = binaryKeyOf(textKey);
  await store.putBytes(binaryKey, bytes);
  const stored = await store.getBytes(binaryKey);
  if (stored === null) {
    return {
      outcome: "not_replaced",
      textBytes: text.length,
      binaryBytes: bytes.byteLength,
      reason: "what was written is not there",
    };
  }
  const readBack = shardHoldsEveryRow(stored, rows);
  if (!readBack.ok) {
    return {
      outcome: "not_replaced",
      textBytes: text.length,
      binaryBytes: bytes.byteLength,
      reason: `what came back from the bucket was not the shard: ${readBack.reason}`,
    };
  }

  await store.delete(textKey);
  return { outcome: "converted", textBytes: text.length, binaryBytes: bytes.byteLength };
}
