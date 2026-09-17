import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  manifestKey,
  r2StoreFromEnv,
  type StoredObject,
} from "@busstops/pipeline-core";
import { SHARDED, type NetworkIndexRecord } from "./src/shards.js";
import { keysToRemove, planNetworkPrune } from "./src/prune-versions.js";

/**
 * Deleting superseded national publishes, carefully.
 *
 * A national build writes about six and a half thousand objects and a gigabyte and a half, and
 * nothing removed the publish it replaced: no retention class matched `data/network/...`, so the
 * job that watches the free tier classified the national timetable as "unclassified" and left it.
 * R2 gives 10 GB. A handful of builds is the whole allowance.
 *
 * Everything here is arranged so that the failure mode is "deleted nothing" rather than "deleted
 * the timetable England is being served". It refuses unless it can positively identify the live
 * version from the manifest, it cross-checks that against the index record's own idea of which
 * version its shards are at, it requires a complete listing, and it prints what it would do and
 * stops unless told to go ahead.
 *
 *   npx tsx pipelines/static-network/run-prune.ts            # report only
 *   npx tsx pipelines/static-network/run-prune.ts --apply    # and delete
 */

const APPLY = process.argv.includes("--apply");
const PREFIX = "data/network/";

/** How many published versions to keep, including the live one. */
const KEEP_VERSIONS = Number(process.env.KEEP_NETWORK_VERSIONS ?? "2");

/** R2's free storage allowance, which is the number this exists to stay under. */
const FREE_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;

function report(body: Record<string, unknown>): void {
  body.finishedAt = new Date().toISOString();
  writeFileSync("prune-report.json", JSON.stringify(body, null, 2));
  console.log("--- prune report ---");
  console.log(JSON.stringify(body, null, 2));
  console.log("--- end prune report ---");
}

function gib(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

async function main(): Promise<number> {
  const configured = r2StoreFromEnv(process.env);
  if (!configured.ok) {
    report({ outcome: "not_configured", missing: configured.missing, deleted: 0 });
    console.error(`Object storage is not configured: ${configured.missing.join(", ")}`);
    return 1;
  }
  const store = configured.store;
  const artifacts = new ArtifactStore(store);

  /*
   * The live version, from the pointer rather than from the shape of the keys.
   *
   * Shards carry no manifest of their own; what makes them reachable is that the index names
   * their version. So the index manifest is the only authority on what is being served, and
   * without it this job has no business deleting anything.
   */
  const manifest = await artifacts.readManifest(SHARDED.index);
  if (!manifest) {
    report({ outcome: "no_manifest", deleted: 0 });
    console.error(
      `::error::No manifest at ${manifestKey(SHARDED.index)}. Nothing is known to be live, so ` +
        `nothing is deleted.`,
    );
    return 1;
  }

  /*
   * And a second opinion. The manifest says which version of the index record is current; the
   * record inside it says which version its shards were written at. They are set from the same
   * value at publish time, so if they disagree the assumption this whole job rests on is wrong
   * and the right move is to stop.
   */
  const current = await artifacts.readCurrent<NetworkIndexRecord>(SHARDED.index);
  const indexRecord = current.records[0] ?? null;
  if (!indexRecord) {
    report({ outcome: "no_index_record", liveVersion: manifest.version, deleted: 0 });
    console.error("::error::The index manifest points at an object with no record in it.");
    return 1;
  }
  if (indexRecord.version !== manifest.version) {
    report({
      outcome: "version_mismatch",
      manifestVersion: manifest.version,
      indexRecordVersion: indexRecord.version,
      deleted: 0,
    });
    console.error(
      `::error::The manifest says ${manifest.version} and the index record says ` +
        `${indexRecord.version}. Shards are addressed by the record's version, so this is not a ` +
        `bucket to delete from until that is understood.`,
    );
    return 1;
  }

  /*
   * A complete inventory or none. `listDetailed` follows the cursor and throws rather than
   * returning a short list — it used to ask for one page of a thousand and return it as the
   * answer, which would make a live version look absent.
   */
  let inventory: StoredObject[];
  try {
    inventory = await store.listDetailed!(PREFIX);
  } catch (error) {
    report({
      outcome: "inventory_incomplete",
      reason: error instanceof Error ? error.message : String(error),
      deleted: 0,
    });
    console.error("::error::The bucket could not be listed completely, so nothing is deleted.");
    return 1;
  }

  const plan = planNetworkPrune(inventory, {
    liveVersion: manifest.version,
    previousVersion: manifest.previousVersion ?? null,
    keepVersions: KEEP_VERSIONS,
  });

  const liveIsPresent = plan.keep.some((entry) => entry.version === manifest.version);
  if (!liveIsPresent) {
    report({ outcome: "live_version_absent", liveVersion: manifest.version, deleted: 0 });
    console.error(
      `::error::No object under ${PREFIX} belongs to the live version ${manifest.version}. ` +
        `That is not a bucket to delete from.`,
    );
    return 1;
  }

  const doomed = keysToRemove(inventory, plan);
  const summary = {
    outcome: APPLY ? "pruned" : "dry_run",
    liveVersion: manifest.version,
    previousVersion: manifest.previousVersion ?? null,
    keepVersions: KEEP_VERSIONS,
    keep: plan.keep,
    remove: plan.remove,
    unattributed: plan.unattributed.length,
    unattributedSample: plan.unattributed.slice(0, 5),
    objectsBefore: plan.objectsBefore,
    objectsAfter: plan.objectsAfter,
    bytesBefore: plan.bytesBefore,
    bytesAfter: plan.bytesAfter,
    freeStorageBytes: FREE_STORAGE_BYTES,
    withinFreeStorageBefore: plan.bytesBefore <= FREE_STORAGE_BYTES,
    withinFreeStorageAfter: plan.bytesAfter <= FREE_STORAGE_BYTES,
    deleted: 0,
    deletionFailures: [] as string[],
  };

  console.log(
    `${PREFIX}: ${plan.objectsBefore} objects, ${gib(plan.bytesBefore)}. ` +
      `Live ${manifest.version}; keeping ${plan.keep.length} version(s), ` +
      `removing ${plan.remove.length} (${gib(plan.bytesBefore - plan.bytesAfter)}). ` +
      `After: ${gib(plan.bytesAfter)} of ${gib(FREE_STORAGE_BYTES)} free allowance.`,
  );

  if (!APPLY) {
    console.log(`${doomed.length} object(s) would be deleted. Re-run with --apply to do it.`);
    report(summary);
    return 0;
  }

  let deleted = 0;
  const failures: string[] = [];
  for (const key of doomed) {
    try {
      await store.delete(key);
      deleted += 1;
    } catch (error) {
      failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  summary.deleted = deleted;
  summary.deletionFailures = failures.slice(0, 10);

  console.log(`Deleted ${deleted} of ${doomed.length} object(s); ${failures.length} failed.`);
  report(summary);
  return failures.length > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Prune job failed:", error);
    process.exitCode = 1;
  });
