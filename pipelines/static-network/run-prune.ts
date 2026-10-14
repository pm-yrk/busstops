import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  manifestKey,
  mapWithConcurrency,
  r2StoreFromEnv,
  type StoredObject,
  positiveNumberFromEnv,
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

/**
 * Retiring a bucket's *live* version — a different and more serious act than pruning.
 *
 * Everything else in this file keeps the live version by construction, because the usual job is
 * "delete what has been superseded". This mode exists for the one case that is not that: a bucket
 * whose live artifact nothing reads. Production held a 4 September artifact of 1.87 GB whose
 * departure horizon expired weeks ago, and Cloudflare's own answer was that exactly one Worker
 * exists — `busstops-api-preview`, bound only to the preview bucket — with the `busstops` Pages
 * project's latest deployment in the preview environment. `wrangler.toml` declares a production
 * Worker; it has never been deployed. So the data was reachable by manifest and unread by
 * anything, and R2's 10 GB allowance is account-wide.
 *
 * Four guards, because the usual invariant is deliberately inverted here:
 *
 *   1. the version must be named on the command line and must equal the live manifest's version,
 *      so this cannot retire "whatever happens to be live";
 *   2. the bucket name must not look like a preview bucket, refused unconditionally and first;
 *   3. no deployed Worker may bind the bucket — asked of Cloudflare at run time, so the claim the
 *      whole act rests on is enforced by the code rather than by a human having checked earlier;
 *   4. `--apply` as well, as everywhere else here.
 *
 * Manifests pointing at the retired version go too. Leaving them would leave pointers to objects
 * that no longer exist, and an absent manifest is a state every reader here already handles.
 */
const RETIRE_FLAG = "--retire-live-version";
const RETIRE_VERSION = (() => {
  const at = process.argv.indexOf(RETIRE_FLAG);
  return at >= 0 ? process.argv[at + 1] : undefined;
})();

/** How many published versions to keep, including the live one. */
const KEEP_VERSIONS = positiveNumberFromEnv(process.env.KEEP_NETWORK_VERSIONS, 2);

/** R2's free storage allowance, which is the number this exists to stay under. */
const FREE_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * Deletes in flight at once, and how many one run will do.
 *
 * The first dry-run found 35,837 removable objects. Deleted one at a time, awaited in turn, that
 * is one HTTP round trip each — hours of wall clock inside a job capped at 150 minutes, which
 * would have hung the run rather than pruning anything. A pool fixes the round trips.
 *
 * The cap is the other half, and it is there because the account's write ceiling is not a number
 * this code gets to choose: a national publish measured about 4.35 objects a second whatever
 * concurrency it used. If that also bounds deletes then no amount of pooling finishes 35,837 in
 * one job, so a run does what it can, says what is left, and the next run continues. Deleting
 * oldest version first is what makes that safe to interrupt.
 */
const DELETE_CONCURRENCY = positiveNumberFromEnv(process.env.PRUNE_DELETE_CONCURRENCY, 16);
const MAX_DELETES_PER_RUN = positiveNumberFromEnv(process.env.PRUNE_MAX_DELETES, 20000);

/**
 * How long a run will spend deleting before it stops and writes its report.
 *
 * The count cap alone was not enough. The step carries a wall-clock limit as well, and a step
 * killed by that limit is killed in the middle of the loop — so the run that did the most work
 * would be the one that reported none of it, which is the same "evidence that technically exists"
 * problem as a report printed where the log cannot reach. A deadline the script owns lets it stop
 * on its own terms and say what it did.
 *
 * Under the step's 45 minutes, so the script always wins the race.
 */
// Same shape as the retention limit: a blank variable must not become a zero-millisecond budget.
const TIME_BUDGET_MS = positiveNumberFromEnv(process.env.PRUNE_TIME_BUDGET_MS, 35 * 60 * 1000);

function report(body: Record<string, unknown>): void {
  body.finishedAt = new Date().toISOString();
  writeFileSync("prune-report.json", JSON.stringify(body, null, 2));
  console.log("--- prune report ---");
  console.log(JSON.stringify(body, null, 2));
  console.log("--- end prune report ---");
  /*
   * And as an annotation. Retention is the one job whose report decides whether the bucket is
   * inside R2's free allowance, and the only copies of it were the job log and an uploaded
   * artifact — both served from a host this project's container cannot reach. A number that
   * cannot be read is a number that gets estimated again.
   */
  if (process.env.GITHUB_ACTIONS) {
    const outcome = String((body as { outcome?: unknown }).outcome ?? "unknown");
    const text = JSON.stringify(body, null, 2)
      .replace(/%/g, "%25")
      .replace(/\r/g, "%0D")
      .replace(/\n/g, "%0A")
      .replace(/::/g, "%3A%3A");
    console.log(`::notice title=artifact retention (${outcome})::${text}`);
  }
}

function gib(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * Which deployed Workers bind this bucket, asked of Cloudflare. Null when the question could not
 * be answered, which is treated as a refusal rather than as a "no".
 */
async function workersBindingBucket(bucket: string): Promise<string[] | null> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return null;
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const headers = { authorization: `Bearer ${apiToken}` };

  try {
    const listed = await fetch(`${base}/workers/scripts`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!listed.ok) return null;
    const scripts = ((await listed.json()) as { result?: Array<{ id?: string }> }).result;
    if (!Array.isArray(scripts)) return null;

    const binding: string[] = [];
    for (const script of scripts) {
      if (!script.id) continue;
      const detail = await fetch(`${base}/workers/scripts/${script.id}/bindings`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!detail.ok) return null;
      const bindings = (
        (await detail.json()) as {
          result?: Array<{ type?: string; bucket_name?: string }>;
        }
      ).result;
      if (!Array.isArray(bindings)) return null;
      if (bindings.some((b) => b.type === "r2_bucket" && b.bucket_name === bucket)) {
        binding.push(script.id);
      }
    }
    return binding;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  /*
   * The clock starts here, not after the inventory.
   *
   * The budget was measured from the start of the *delete loop*, and the listing that precedes it
   * is unbounded: `listDetailed` follows the cursor over every object under the prefix, which
   * after a national rebuild is tens of thousands across dozens of paginated calls. So the step's
   * wall time is the listing plus the budget rather than the budget — which in run 45 was heading
   * for the workflow's own forty-five minute cap instead of stopping at thirty-five, and being
   * killed by that cap is the failure this budget exists to replace.
   */
  const startedAt = Date.now();
  const deadline = startedAt + TIME_BUDGET_MS;
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
   * The retire path. Everything above it still applies: the manifest and the index record must
   * agree, or this job has no business deleting anything from this bucket.
   */
  if (RETIRE_VERSION !== undefined) {
    const bucket = process.env.R2_BUCKET_ARTIFACTS ?? "";

    /* Guard 2 first, because it is the one that must never depend on anything else being right. */
    if (/preview/i.test(bucket)) {
      report({ outcome: "refused_preview_bucket", bucket, deleted: 0 });
      console.error(
        `::error::Refusing to retire a live version from ${bucket}: the name looks like a preview ` +
          `bucket, and this mode exists only for a bucket nothing reads.`,
      );
      return 1;
    }

    /* Guard 1: the caller must name the version, and it must be the one that is actually live. */
    if (RETIRE_VERSION !== manifest.version) {
      report({
        outcome: "refused_version_mismatch",
        bucket,
        askedToRetire: RETIRE_VERSION,
        liveVersion: manifest.version,
        deleted: 0,
      });
      console.error(
        `::error::Asked to retire ${RETIRE_VERSION} but the live version is ${manifest.version}. ` +
          `Name the live version explicitly or do nothing.`,
      );
      return 1;
    }

    /*
     * Guard 3: no deployed Worker may bind this bucket. Asked of Cloudflare now rather than
     * trusted from earlier, because "nothing reads it" is the entire justification for this mode
     * and a deployment could have happened since anybody last looked.
     */
    const readers = await workersBindingBucket(bucket);
    if (readers === null) {
      report({ outcome: "refused_readers_unknown", bucket, deleted: 0 });
      console.error(
        `::error::Could not ask Cloudflare which Workers bind ${bucket}. Without that answer this ` +
          `mode has no justification, so nothing is deleted.`,
      );
      return 1;
    }
    if (readers.length > 0) {
      report({ outcome: "refused_bucket_has_readers", bucket, readers, deleted: 0 });
      console.error(
        `::error::${readers.join(", ")} bind ${bucket}. A bucket with a deployed reader is not a ` +
          `bucket to retire a live version from.`,
      );
      return 1;
    }

    let all: StoredObject[];
    try {
      all = await store.listDetailed!("");
    } catch (error) {
      report({
        outcome: "inventory_incomplete",
        reason: error instanceof Error ? error.message : String(error),
        deleted: 0,
      });
      console.error("::error::The bucket could not be listed completely, so nothing is deleted.");
      return 1;
    }

    const atVersion = all.filter(
      (object) => object.key.startsWith("data/") && object.key.endsWith(`/${RETIRE_VERSION}.jsonl`),
    );
    /*
     * And the pointers at it, so nothing is left naming an object that has gone. Read rather than
     * assumed: a manifest for a different version must survive.
     */
    const artifactsStore = new ArtifactStore(store);
    const danglingManifests: string[] = [];
    for (const object of all) {
      if (!object.key.startsWith("manifests/") || !object.key.endsWith("/current.json")) continue;
      const dataset = object.key.slice("manifests/".length, -"/current.json".length);
      const pointer = await artifactsStore.readManifest(dataset);
      if (pointer?.version === RETIRE_VERSION) danglingManifests.push(object.key);
    }

    const doomedKeys = [...atVersion.map((object) => object.key), ...danglingManifests];
    const bytesBefore = all.reduce((sum, object) => sum + object.sizeBytes, 0);
    const bytesRetired = atVersion.reduce((sum, object) => sum + object.sizeBytes, 0);

    const retireSummary: Record<string, unknown> = {
      outcome: APPLY ? "retired" : "retire_dry_run",
      bucket,
      retiredVersion: RETIRE_VERSION,
      readersBindingBucket: readers,
      objectsBefore: all.length,
      objectsToDelete: doomedKeys.length,
      dataObjects: atVersion.length,
      manifestsRemoved: danglingManifests.length,
      bytesBefore,
      bytesRetired,
      bytesAfter: bytesBefore - bytesRetired,
      freeStorageBytes: FREE_STORAGE_BYTES,
      deleted: 0,
      deletionFailures: [] as string[],
    };

    console.log(
      `${bucket}: retiring ${RETIRE_VERSION} — ${atVersion.length} data object(s) and ` +
        `${danglingManifests.length} manifest(s), ${gib(bytesRetired)} of ${gib(bytesBefore)}.`,
    );

    if (!APPLY) {
      console.log(`${doomedKeys.length} object(s) would be deleted. Re-run with --apply to do it.`);
      report(retireSummary);
      return 0;
    }

    const retireFailures: string[] = [];
    let retired = 0;
    await mapWithConcurrency(doomedKeys, DELETE_CONCURRENCY, async (key) => {
      try {
        await store.delete(key);
        retired += 1;
      } catch (error) {
        retireFailures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    retireSummary.deleted = retired;
    retireSummary.deletionFailures = retireFailures.slice(0, 10);
    retireSummary.deletionFailureCount = retireFailures.length;
    retireSummary.objectsAfter = all.length - retired;
    report(retireSummary);
    console.log(`Retired ${retired} of ${doomedKeys.length} object(s).`);
    return retireFailures.length === 0 ? 0 : 1;
  }

  /*
   * A complete inventory or none. `listDetailed` follows the cursor and throws rather than
   * returning a short list — it used to ask for one page of a thousand and return it as the
   * answer, which would make a live version look absent.
   */
  let inventory: StoredObject[];
  const listBegan = Date.now();
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

  const listMs = Date.now() - listBegan;

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
    /** How long the inventory took, which is the phase the budget used not to cover. */
    listMs,
    withinFreeStorageBefore: plan.bytesBefore <= FREE_STORAGE_BYTES,
    withinFreeStorageAfter: plan.bytesAfter <= FREE_STORAGE_BYTES,
    deleted: 0,
    deletionFailures: [] as string[],
    removableObjects: 0,
    remainingAfterRun: 0,
    deletesPerSecond: 0,
    complete: true,
    stoppedBecause: "nothing to remove",
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

  /*
   * If the listing took the whole budget, the plan is reported and nothing is deleted.
   *
   * Housekeeping must never be the reason a deploy run has no verification, so this exits zero:
   * the next pass resumes from the oldest version left, and the report says where the time went
   * rather than leaving a step that was killed mid-loop with nothing to show for it.
   */
  if (Date.now() >= deadline) {
    summary.outcome = "time_spent_listing";
    summary.deleted = 0;
    summary.removableObjects = doomed.length;
    summary.remainingAfterRun = doomed.length;
    console.error(
      `::warning::Listing ${inventory.length} object(s) took ${Math.round(listMs / 1000)}s of a ` +
        `${Math.round(TIME_BUDGET_MS / 1000)}s budget, so nothing was deleted this pass.`,
    );
    report(summary);
    return 0;
  }

  const batch = doomed.slice(0, MAX_DELETES_PER_RUN);
  const failures: string[] = [];
  let deleted = 0;
  const deletingFrom = Date.now();
  let ranOutOfTime = false;

  await mapWithConcurrency(batch, DELETE_CONCURRENCY, async (key) => {
    if (Date.now() >= deadline) {
      ranOutOfTime = true;
      return;
    }
    try {
      await store.delete(key);
      deleted += 1;
    } catch (error) {
      failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const seconds = Math.max(0.001, (Date.now() - deletingFrom) / 1000);
  summary.deleted = deleted;
  summary.deletionFailures = failures.slice(0, 10);
  summary.removableObjects = doomed.length;
  summary.remainingAfterRun = doomed.length - deleted;
  summary.deletesPerSecond = Number((deleted / seconds).toFixed(2));
  summary.complete = summary.remainingAfterRun === 0;
  summary.stoppedBecause = summary.complete
    ? "nothing left to remove"
    : ranOutOfTime
      ? "time budget spent"
      : "per-run cap reached";

  console.log(
    `Deleted ${deleted} of ${batch.length} attempted (${doomed.length} removable); ` +
      `${failures.length} failed; ${summary.deletesPerSecond}/s over ${seconds.toFixed(0)}s.`,
  );
  if (!summary.complete) {
    console.log(
      `${summary.remainingAfterRun} object(s) still removable (${summary.stoppedBecause}). Run ` +
        `the retention job again to continue; it resumes from the oldest version that is left.`,
    );
  }
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
