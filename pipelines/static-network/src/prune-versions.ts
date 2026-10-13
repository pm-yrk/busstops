import type { StoredObject } from "@busstops/pipeline-core";

/**
 * Deleting superseded network artifacts, without ever deleting the one being served.
 *
 * A national publish writes about six and a half thousand objects and a gigabyte and a half, and
 * nothing removed the publish it replaced. No retention class matched `data/network/...`, so the
 * one job watching the free tier classified the whole national timetable as "unclassified" and
 * left it alone. R2 gives 10 GB; a few builds is the whole allowance.
 *
 * The danger is obvious and the reason this is a pure function over an inventory, with the
 * deleting kept in the runner: getting it wrong deletes the timetable England is currently being
 * served. So the rules are narrow and every one of them is a test.
 *
 * ## What makes a version live
 *
 * Shards are not artifacts. They are written as bare objects with no manifest of their own —
 * a per-shard manifest would be written and never read, and a national build writing thousands of
 * them cost three times the requests against a rate-limited API. What makes a shard reachable is
 * that the network index names its version, and the index *is* a published artifact:
 * `manifests/network/index/current.json` holds the version, and every object of that publish is
 * at `data/<dataset>/<version>.jsonl`.
 *
 * So there is exactly one live version across the whole family, and it is the index manifest's.
 * The manifest also records the version it replaced, which is the rollback target and is kept.
 *
 * ## What this refuses to do
 *
 * It never deletes a manifest — a manifest is the pointer, and an orphaned data object is
 * recoverable while a missing pointer is not. It never deletes a version it was not told to keep
 * *and* could not positively identify as superseded; anything whose key does not parse into a
 * version is reported and left alone. And the caller must hand it a complete inventory: a
 * truncated listing would make a live version look absent, which is the one mistake that cannot
 * be undone.
 */

/** Everything published under one version, as bytes on the shelf. */
export interface VersionInventory {
  version: string;
  objects: number;
  bytes: number;
}

export interface PrunePlan {
  /** The version being served. Never in `remove`. */
  liveVersion: string;
  /** Versions kept: the live one, the rollback target, and any extra window asked for. */
  keep: VersionInventory[];
  remove: VersionInventory[];
  /**
   * Keys that could not be attributed to a version, and are therefore left alone. Non-empty means
   * the layout has changed and this plan should be read before it is trusted.
   */
  unattributed: string[];
  bytesBefore: number;
  bytesAfter: number;
  objectsBefore: number;
  objectsAfter: number;
}

/** `data/<dataset>/<version>.jsonl` — the version is the last path segment, minus the suffix. */
export function versionOfObjectKey(key: string): string | null {
  if (!key.startsWith("data/")) return null;
  if (!key.endsWith(".jsonl")) return null;
  const lastSlash = key.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const version = key.slice(lastSlash + 1, -".jsonl".length);
  return version.length > 0 ? version : null;
}

export interface PruneOptions {
  /** The version the index manifest points at. Never removed. */
  liveVersion: string;
  /** The version it replaced, if any. Kept so a rollback has somewhere to go. */
  previousVersion: string | null;
  /**
   * How many versions to keep in total, including the live one.
   *
   * Two is the sensible default and is what the manifest itself supports: it records one previous
   * version, so a third is storage with nothing pointing at it.
   */
  keepVersions?: number;
}

/**
 * What to delete, given everything under `data/network/` and which version is live.
 *
 * The inventory must be complete. This function cannot tell a truncated listing from a small
 * bucket, so the caller checks that and fails closed; `R2ObjectStore.listDetailed` now throws
 * rather than returning a short list, which is what makes that check possible at all.
 */
export function planNetworkPrune(
  inventory: readonly StoredObject[],
  options: PruneOptions,
): PrunePlan {
  const keepVersions = options.keepVersions ?? 2;

  const byVersion = new Map<string, VersionInventory>();
  const unattributed: string[] = [];
  for (const object of inventory) {
    const version = versionOfObjectKey(object.key);
    if (version === null) {
      unattributed.push(object.key);
      continue;
    }
    const entry = byVersion.get(version) ?? { version, objects: 0, bytes: 0 };
    entry.objects += 1;
    entry.bytes += object.sizeBytes;
    byVersion.set(version, entry);
  }

  /*
   * The live version is kept whether or not it appears in the inventory. If it does not, that is
   * a bucket in a state nobody expected, and the runner refuses on it — but this function must
   * not be the thing that quietly drops it from the keep list.
   */
  const keepNames = new Set<string>([options.liveVersion]);
  if (options.previousVersion !== null) keepNames.add(options.previousVersion);

  /*
   * Any remaining room in the window goes to the newest versions by name. Versions are ISO
   * timestamps, so lexical order is chronological — and a version that does not sort that way is
   * still handled deterministically rather than arbitrarily.
   */
  const rest = [...byVersion.keys()].filter((version) => !keepNames.has(version)).sort();
  while (keepNames.size < keepVersions && rest.length > 0) {
    keepNames.add(rest.pop()!);
  }

  const keep: VersionInventory[] = [];
  const remove: VersionInventory[] = [];
  for (const entry of [...byVersion.values()].sort((a, b) => a.version.localeCompare(b.version))) {
    (keepNames.has(entry.version) ? keep : remove).push(entry);
  }

  const bytesBefore = [...byVersion.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const objectsBefore = [...byVersion.values()].reduce((sum, entry) => sum + entry.objects, 0);
  const removedBytes = remove.reduce((sum, entry) => sum + entry.bytes, 0);
  const removedObjects = remove.reduce((sum, entry) => sum + entry.objects, 0);

  return {
    liveVersion: options.liveVersion,
    keep,
    remove,
    unattributed,
    bytesBefore,
    bytesAfter: bytesBefore - removedBytes,
    objectsBefore,
    objectsAfter: objectsBefore - removedObjects,
  };
}

/** The keys a plan would delete, in the order they would go. */
export function keysToRemove(inventory: readonly StoredObject[], plan: PrunePlan): string[] {
  const order = new Map(plan.remove.map((entry, index) => [entry.version, index]));

  const matching: Array<{ key: string; rank: number }> = [];
  for (const object of inventory) {
    const version = versionOfObjectKey(object.key);
    if (version === null) continue;
    const rank = order.get(version);
    if (rank === undefined) continue;
    matching.push({ key: object.key, rank });
  }

  /*
   * Oldest version first, rather than whatever order the bucket listed in.
   *
   * A run that deletes tens of thousands of objects may not finish inside a job, so it is capped
   * and resumed. In listing order a capped run half-empties several versions at once and leaves
   * the bucket in a state no report describes; in this order it clears whole versions and the
   * remainder is still a clean set of them, which is what makes resuming meaningful.
   */
  matching.sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return matching.map((entry) => entry.key);
}
