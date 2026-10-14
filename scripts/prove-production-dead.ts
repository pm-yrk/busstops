#!/usr/bin/env node
/**
 * Prove, before anything is deleted, exactly what the production bucket holds and who reads it.
 *
 * This writes nothing and deletes nothing. It exists because "old" is not "dead": the production
 * bucket's artifact is from 4 September and its departure horizon expired weeks ago, and neither
 * fact on its own licenses deleting 3.27 GB. What licenses it is the combination of:
 *
 *   1. which manifests exist and which object each one points at;
 *   2. which objects no manifest points at (orphans — including whatever the rebuild that is
 *      guillotined by its own 30-minute cap left behind every day it ran);
 *   3. whether any deployed Worker, Pages project or scheduled workflow reads this bucket at all.
 *
 * The third is the one that cannot be answered from inside the repository. `apps/worker/wrangler.toml`
 * declares a production Worker, `busstops-api`, bound to `busstops-artifacts` — but a declaration is
 * not a deployment, and `deploy.yml` is dispatch-only. So this asks Cloudflare directly which
 * Workers and Pages projects exist, and reports what it finds rather than what the configuration
 * implies.
 *
 *   npx tsx scripts/prove-production-dead.ts                       # inspects busstops-artifacts
 *   npx tsx scripts/prove-production-dead.ts --bucket <name>       # any bucket, read-only
 *
 * The preview bucket is never contacted unless it is named explicitly, and this script has no
 * code path that writes or deletes.
 */

import {
  ArtifactStore,
  annotateReport,
  objectKeyFor,
  r2StoreFromEnv,
  type StoredObject,
} from "@busstops/pipeline-core";

const argv = process.argv.slice(2);
const bucketFlag = argv.indexOf("--bucket");
const BUCKET = bucketFlag >= 0 ? argv[bucketFlag + 1] : "busstops-artifacts";

const report: Record<string, unknown> = { startedAt: new Date().toISOString(), bucket: BUCKET };

/** Deployed Workers and Pages projects, asked of Cloudflare rather than inferred from config. */
async function readers(accountId: string, apiToken: string): Promise<Record<string, unknown>> {
  const headers = { authorization: `Bearer ${apiToken}` };
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    try {
      const response = await fetch(`${base}${path}`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      return { status: 0, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  const found: Record<string, unknown> = {};

  const scripts = await get("/workers/scripts");
  const scriptList = (scripts.body as { result?: Array<{ id?: string; modified_on?: string }> })
    ?.result;
  found.workersStatus = scripts.status;
  found.workers = Array.isArray(scriptList)
    ? scriptList.map((script) => ({ id: script.id, modifiedOn: script.modified_on }))
    : null;

  /*
   * The binding is the fact that matters, not the name. A Worker called `busstops-api` that no
   * longer binds this bucket does not read it, and one called something else that does, does.
   */
  if (Array.isArray(scriptList)) {
    const bindings: Record<string, unknown> = {};
    for (const script of scriptList) {
      if (!script.id) continue;
      const detail = await get(`/workers/scripts/${script.id}/bindings`);
      const list = (
        detail.body as { result?: Array<{ name?: string; type?: string; bucket_name?: string }> }
      )?.result;
      bindings[script.id] = Array.isArray(list)
        ? list
            .filter((binding) => binding.type === "r2_bucket")
            .map((binding) => `${binding.name} → ${binding.bucket_name}`)
        : `bindings unreadable (HTTP ${detail.status})`;
    }
    found.r2Bindings = bindings;
  }

  const pages = await get("/pages/projects");
  const projectList = (
    pages.body as {
      result?: Array<{
        name?: string;
        subdomain?: string;
        latest_deployment?: { environment?: string; url?: string };
      }>;
    }
  )?.result;
  found.pagesStatus = pages.status;
  found.pages = Array.isArray(projectList)
    ? projectList.map((project) => ({
        name: project.name,
        subdomain: project.subdomain,
        latestEnvironment: project.latest_deployment?.environment,
        latestUrl: project.latest_deployment?.url,
      }))
    : null;

  return found;
}

async function main(): Promise<number> {
  const storage = r2StoreFromEnv({ ...process.env, R2_BUCKET_ARTIFACTS: BUCKET });
  if (!storage.ok) {
    report.outcome = "not_configured";
    report.missing = storage.missing;
    annotateReport("production inventory", report);
    return 1;
  }
  const store = storage.store;
  const artifacts = new ArtifactStore(store);

  /*
   * Everything in the bucket, with sizes. A partial listing would make every number below a lower
   * bound and every "unreferenced" claim a guess, so an incomplete listing is a hard stop.
   */
  let objects: StoredObject[];
  try {
    objects = await store.listDetailed("");
  } catch (error) {
    report.outcome = "listing_failed";
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    annotateReport("production inventory", report);
    return 1;
  }

  const totalBytes = objects.reduce((sum, object) => sum + (object.sizeBytes ?? 0), 0);
  report.inventory = { objects: objects.length, totalBytes };

  /*
   * Every manifest, and what it points at. `manifests/<dataset>/current.json` is the only pointer
   * in this scheme: a dataset's live object is whatever its manifest names, and the version before
   * it is kept so a rollback has somewhere to go.
   */
  const manifestKeys = objects
    .map((object) => object.key)
    .filter((key) => key.startsWith("manifests/") && key.endsWith("/current.json"));

  const referenced = new Set<string>();
  /*
   * The versions any manifest names, which is the set that actually decides reachability.
   *
   * A manifest naming an object key is only half the story, and taking it for the whole story is
   * how this script first reported 4,878 of 5,012 production objects as unreferenced — including
   * the entire live September artifact. Sharded families are not resolved through a manifest per
   * shard: the reader takes the version from the index and composes
   * `data/<dataset>/<version>.jsonl` directly, so **every** object at a version a manifest names
   * is reachable, whether or not anything points at that individual key.
   *
   * So an object is unreachable only when its version appears in no manifest at all. That is
   * conservative — it keeps a shard at a live version belonging to a dataset the index no longer
   * lists — and conservative is the only acceptable direction here.
   */
  const reachableVersions = new Set<string>();
  const pointers: Array<Record<string, unknown>> = [];
  const unreadable: string[] = [];

  for (const key of manifestKeys) {
    const dataset = key.slice("manifests/".length, -"/current.json".length);
    try {
      const manifest = await artifacts.readManifest(dataset);
      if (manifest === null) {
        unreadable.push(`${dataset}: manifest absent when read back`);
        continue;
      }
      referenced.add(key);
      referenced.add(manifest.objectKey);
      reachableVersions.add(manifest.version);
      const rollback =
        manifest.previousVersion === null || manifest.previousVersion === undefined
          ? null
          : objectKeyFor(dataset, manifest.previousVersion);
      if (rollback !== null) {
        referenced.add(rollback);
        reachableVersions.add(manifest.previousVersion!);
      }
      pointers.push({
        dataset,
        version: manifest.version,
        objectKey: manifest.objectKey,
        previousVersion: manifest.previousVersion ?? null,
        records: manifest.recordCount,
        bytes: manifest.sizeBytes,
      });
    } catch (error) {
      unreadable.push(
        `${dataset}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    }
  }

  report.manifests = {
    count: manifestKeys.length,
    readable: pointers.length,
    unreadable: unreadable.slice(0, 10),
    unreadableCount: unreadable.length,
  };

  /*
   * The distinct artifact versions present, by the version string embedded in each data key. A
   * second version with no manifest naming it is exactly what a rebuild killed mid-publish leaves
   * behind, and it is the least ambiguous thing in this bucket to delete.
   */
  const versionsSeen = new Map<string, { objects: number; bytes: number; referenced: number }>();
  for (const object of objects) {
    if (!object.key.startsWith("data/")) continue;
    const match = /^data\/(.+)\/([^/]+)\.jsonl$/.exec(object.key);
    if (!match) continue;
    const version = match[2]!;
    const entry = versionsSeen.get(version) ?? { objects: 0, bytes: 0, referenced: 0 };
    entry.objects += 1;
    entry.bytes += object.sizeBytes ?? 0;
    if (referenced.has(object.key)) entry.referenced += 1;
    versionsSeen.set(version, entry);
  }
  report.versions = [...versionsSeen.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([version, entry]) => ({
      version,
      objects: entry.objects,
      bytes: entry.bytes,
      referencedObjects: entry.referenced,
      pointedAtByAManifest: entry.referenced > 0,
    }));

  /** The version in a data key, or null for anything that is not a versioned data object. */
  const versionOf = (key: string): string | null => {
    const match = /^data\/(.+)\/([^/]+)\.jsonl$/.exec(key);
    return match === null ? null : match[2]!;
  };

  const unreachable = objects.filter((object) => {
    if (object.key.startsWith("manifests/")) return false;
    const version = versionOf(object.key);
    // Anything that is not a versioned data object is left alone: unrecognised is not unreachable.
    if (version === null) return false;
    return !reachableVersions.has(version);
  });
  const unreachableBytes = unreachable.reduce((sum, object) => sum + (object.sizeBytes ?? 0), 0);

  /*
   * And the narrow reading, kept only so the two can be compared. A key no manifest names is
   * *not* evidence of anything on its own, for the reason above.
   */
  const unnamedByAnyManifest = objects.filter(
    (object) => !referenced.has(object.key) && !object.key.startsWith("manifests/"),
  );

  report.reachableVersions = [...reachableVersions].sort();
  report.reachable = {
    objects: objects.length - unreachable.length,
    bytes: totalBytes - unreachableBytes,
  };
  report.unreachable = {
    objects: unreachable.length,
    bytes: unreachableBytes,
    sample: unreachable.slice(0, 8).map((object) => object.key),
  };
  report.notNamedByAnyManifest = {
    objects: unnamedByAnyManifest.length,
    note: "not a deletion basis — sharded families are resolved by version, not by a manifest per shard",
  };

  /* Any manifest keys not matched above — a pointer file that is not a `current.json`. */
  const strayManifests = objects
    .map((object) => object.key)
    .filter((key) => key.startsWith("manifests/") && !key.endsWith("/current.json"));
  report.strayManifestKeys = { count: strayManifests.length, sample: strayManifests.slice(0, 5) };

  /* And who, if anyone, reads this bucket. */
  report.readers = await readers(
    process.env.CLOUDFLARE_ACCOUNT_ID!,
    process.env.CLOUDFLARE_API_TOKEN!,
  );

  /*
   * The departure horizon, because "no useful departures" has to be measured rather than assumed.
   * A dated shard key carries its service date, so the dates present are readable from the keys.
   */
  const datedByDate = new Map<string, { objects: number; bytes: number }>();
  for (const object of objects) {
    const match = /(\d{4}-\d{2}-\d{2})/.exec(object.key);
    if (!match || !object.key.startsWith("data/")) continue;
    const date = match[1]!;
    const entry = datedByDate.get(date) ?? { objects: 0, bytes: 0 };
    entry.objects += 1;
    entry.bytes += object.sizeBytes ?? 0;
    datedByDate.set(date, entry);
  }
  const today = new Date().toISOString().slice(0, 10);
  report.serviceDates = [...datedByDate.entries()].sort().map(([date, entry]) => ({
    date,
    objects: entry.objects,
    bytes: entry.bytes,
    inThePast: date < today,
  }));

  report.outcome = "inventoried";
  console.log(
    `${BUCKET}: ${objects.length} object(s), ${totalBytes} bytes; ` +
      `${pointers.length} readable manifest(s) naming ${reachableVersions.size} version(s); ` +
      `${unreachable.length} object(s) at no named version (${unreachableBytes} bytes).`,
  );
  annotateReport("production inventory", report);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    report.outcome = "threw";
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    annotateReport("production inventory", report);
    process.exit(1);
  });
