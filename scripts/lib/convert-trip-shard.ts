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
  PatternTripShard,
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

/** And back the other way, for the undo. */
export function textKeyOf(binaryKey: string): string {
  return `${binaryKey.slice(0, -".bin".length)}.jsonl`;
}

/** One object as the bucket inventory describes it, which is all the choice below needs. */
export interface ShardInventoryEntry {
  readonly key: string;
  readonly uploadedAt: string;
}

/**
 * The shards a forward migration still has to convert, from the bucket inventory.
 *
 * Two cases, and the second is the one that was missing. A text shard with no binary sibling has
 * never been converted. A text shard *newer* than its binary sibling has been converted and then
 * republished as text over the top — and since every reader prefers the bytes, the bytes beside it
 * are a timetable that will be served in place of the one just published. That is not a
 * hypothetical: the daily refresh writes the live horizon as lines from the default branch, and
 * one of its runs overlapped this migration, so eight Leeds shards ended up holding both forms of
 * 29 October with the older one winning. Skipping those as "already done" would leave the fault
 * in the bucket permanently.
 *
 * A text shard older than its binary sibling is left alone: it is the pre-conversion object, and
 * the publisher that writes bytes now deletes it.
 */
export function pendingTripShards(
  inventory: readonly ShardInventoryEntry[],
  atVersion: (key: string) => boolean,
): ShardInventoryEntry[] {
  const uploadedAt = new Map(inventory.map((object) => [object.key, object.uploadedAt]));
  return inventory.filter((object) => {
    if (!object.key.endsWith(".jsonl") || !atVersion(object.key)) return false;
    const binary = uploadedAt.get(binaryKeyOf(object.key));
    return binary === undefined || object.uploadedAt > binary;
  });
}

/**
 * The text shards a re-run should delete rather than convert.
 *
 * A `.jsonl` whose `.bin` sibling is **newer** is a leftover: the bytes beside it already hold a
 * later version of the same shard, every reader prefers the bytes, and nothing will ever read the
 * text again. The refresh that republishes the live horizon as lines from the default branch
 * leaves 3,137 of them at the live version — the first conversion deleted the text it converted,
 * and these were written after its inventory was taken, by a run that overlapped it.
 *
 * Kept separate from `pendingTripShards` because the two do opposite things to the same object,
 * and which one applies turns entirely on which of the pair is newer. Equal timestamps count as
 * superseded: the bytes are there and hold the rows, which is what a reader needs.
 */
export function supersededTripShards(
  inventory: readonly ShardInventoryEntry[],
  atVersion: (key: string) => boolean,
): ShardInventoryEntry[] {
  const uploadedAt = new Map(inventory.map((object) => [object.key, object.uploadedAt]));
  return inventory.filter((object) => {
    if (!object.key.endsWith(".jsonl") || !atVersion(object.key)) return false;
    const binary = uploadedAt.get(binaryKeyOf(object.key));
    return binary !== undefined && object.uploadedAt <= binary;
  });
}

/**
 * Deletes a text shard whose bytes are already there, after reading those bytes back.
 *
 * Fail closed: the bytes are fetched and opened before anything is removed, and a shard whose
 * bytes cannot be read or hold no trips keeps its text. The timestamp said the bytes were newer;
 * this is the bucket saying they are usable, which is a different claim and the one that matters
 * when the alternative is a shard of England's timetable existing in neither form.
 */
export async function dropSupersededTripShard(
  store: BinaryObjectStore,
  textKey: string,
  options: { apply: boolean },
): Promise<{ outcome: "dropped" | "verified_only" | "kept" | "absent"; reason?: string }> {
  const binaryKey = binaryKeyOf(textKey);
  let bytes: Uint8Array | null;
  try {
    bytes = await store.getBytes(binaryKey);
  } catch (error) {
    return { outcome: "kept", reason: `bytes unreadable: ${String(error).slice(0, 100)}` };
  }
  if (bytes === null) return { outcome: "kept", reason: "no bytes beside it after all" };

  try {
    const shard = new PatternTripShard(bytes);
    if (shard.tripCount === 0) return { outcome: "kept", reason: "the bytes hold no trips" };
  } catch (error) {
    return { outcome: "kept", reason: `bytes will not open: ${String(error).slice(0, 100)}` };
  }

  if (!options.apply) return { outcome: "verified_only" };
  await store.delete(textKey);
  return { outcome: "dropped" };
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

/**
 * And the way back: one shard's bytes written out as JSON lines again.
 *
 * Here because a one-way migration is a worse migration. The binary form holds everything the
 * lines held — that is what `shardHoldsEveryRow` proves on the way in — so the text can be
 * rebuilt from it exactly, and the same rule applies in this direction: the bytes are deleted only
 * after the lines that replace them have been read back out of the store and found to parse into
 * the same rows.
 *
 * Nothing in the serving path needs this. What needs it is the decision to convert at all: an
 * operator who can undo a change in twenty minutes can agree to it on a Tuesday afternoon.
 */
export async function revertTripShard(
  store: BinaryObjectStore,
  textKey: string,
  options: { apply: boolean },
): Promise<ShardConversion> {
  const binaryKey = binaryKeyOf(textKey);
  let bytes: Uint8Array | null;
  try {
    bytes = await store.getBytes(binaryKey);
  } catch (error) {
    return {
      outcome: "unreadable",
      textBytes: 0,
      binaryBytes: 0,
      reason: String(error).slice(0, 120),
    };
  }
  if (bytes === null) return { outcome: "absent", textBytes: 0, binaryBytes: 0 };

  let rows: PatternTripRow[];
  try {
    const shard = new PatternTripShard(bytes);
    rows = [];
    for (let trip = 0; trip < shard.tripCount; trip += 1) rows.push(shard.rowAt(trip));
  } catch (error) {
    return {
      outcome: "unreadable",
      textBytes: 0,
      binaryBytes: bytes.byteLength,
      reason: `bytes: ${String(error).slice(0, 100)}`,
    };
  }

  const text = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  if (!options.apply) {
    return { outcome: "verified_only", textBytes: text.length, binaryBytes: bytes.byteLength };
  }

  await store.put(textKey, text);
  const stored = await store.get(textKey);
  if (stored === null) {
    return {
      outcome: "not_replaced",
      textBytes: text.length,
      binaryBytes: bytes.byteLength,
      reason: "what was written is not there",
    };
  }
  let readBack: PatternTripRow[];
  try {
    readBack = rowsOfShardText(stored);
  } catch (error) {
    return {
      outcome: "not_replaced",
      textBytes: text.length,
      binaryBytes: bytes.byteLength,
      reason: `what came back from the bucket would not parse: ${String(error).slice(0, 80)}`,
    };
  }
  if (JSON.stringify(readBack) !== JSON.stringify(rows)) {
    return {
      outcome: "not_replaced",
      textBytes: text.length,
      binaryBytes: bytes.byteLength,
      reason: "what came back from the bucket was not the shard",
    };
  }

  await store.delete(binaryKey);
  return { outcome: "converted", textBytes: text.length, binaryBytes: bytes.byteLength };
}
