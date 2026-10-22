#!/usr/bin/env node
/**
 * Builds `network/stop-serving-routes` from what is already published, and measures it first.
 *
 * ## The defect
 *
 * `stop-services` answers "which services call at this stop" from one hashed bucket, which removed
 * a geographic pattern scan that cost 2.03 MiB on a Manchester board. It leaves the board holding
 * service ids, and every id lives in its own hashed service bucket — so a city interchange asked
 * for upwards of thirty-two objects, each one a subrequest against the fifty an invocation gets in
 * total for its index, its departure shards, its operators, its live feed and everything else.
 * Deployed, that took Leeds City Bus Station from four of four samples answering with three routes
 * to four of four answering 1102, and Norwich Tombland and Birmingham Coach Station with it.
 *
 * The fix belongs in the artifact: carry the route's name and its operator beside the id, and the
 * question costs one object however many routes call there.
 *
 * ## Why this is not a job for the national build
 *
 * Every input is already published. The id index says which services call where, the service
 * buckets say what each is called and who runs it, and the operators object says their names — so
 * the enriched family is a join over published data, with no GTFS archive, no NaPTAN parse and no
 * million journeys. The national build takes between 99 and 165 minutes and has been killed at its
 * step limit more than once; this is minutes, and it risks one family instead of the artifact.
 *
 * ## What it refuses
 *
 * Measurement is the default and writes nothing: a serving projection duplicates names, and
 * whether that is tens of megabytes or hundreds is a question to answer before publishing rather
 * than after. With `--apply` it writes the new family, verifies every object from a listing, and
 * only then adds it to the index — so until that one write the artifact is exactly as it was. The
 * id index is left in place, which is what makes the deploy order safe in both directions and a
 * rollback one index write.
 *
 *   npx tsx pipelines/static-network/run-enrich-stop-services.ts            # measure only
 *   npx tsx pipelines/static-network/run-enrich-stop-services.ts --apply    # and publish
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  manifestKey,
  mapWithConcurrency,
  objectKeyFor,
  r2StoreFromEnv,
} from "@busstops/pipeline-core";
import type { Operator, ServiceRoute } from "@busstops/contracts";
import {
  MAX_SHARD_BYTES,
  SHARDED,
  STOP_SERVING_ROUTES_BUCKETS,
  STOP_SERVING_ROUTES_PREFIX,
  stopServicesDataset,
  stopServingRoutesDataset,
  stopServingRoutesShardLines,
  type NetworkIndexRecord,
  type StopServingOperator,
  type StopServingRoutesRow,
} from "./src/shards.js";
import { DATASETS, NETWORK_SCHEMA_VERSION } from "./src/publish.js";

const APPLY = process.argv.includes("--apply");
const JSON_OUT = (() => {
  const index = process.argv.indexOf("--json");
  return index === -1 ? undefined : process.argv[index + 1];
})();

/** Eight at a time, the same as the publisher: quick enough, below what earns a 429. */
const CONCURRENCY = 8;

const encoder = new TextEncoder();
function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function report(body: Record<string, unknown>): void {
  console.log("--- enrich report ---");
  console.log(JSON.stringify(body, null, 2));
  console.log("--- end enrich report ---");
  annotateReport("stop serving routes", body);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(body, null, 1));
}

/** Percentiles of a distribution, which is what says whether a mean is hiding anything. */
function spread(values: number[]): Record<string, number> {
  if (values.length === 0) return { n: 0 };
  const ordered = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    ordered[Math.min(ordered.length - 1, Math.floor(fraction * ordered.length))]!;
  return {
    n: ordered.length,
    min: ordered[0]!,
    median: at(0.5),
    p95: at(0.95),
    max: ordered[ordered.length - 1]!,
    mean: Math.round(ordered.reduce((a, b) => a + b, 0) / ordered.length),
  };
}

async function main(): Promise<number> {
  const configured = r2StoreFromEnv(process.env);
  if (!configured.ok) {
    report({ outcome: "not_configured", missing: configured.missing });
    console.error(`Object storage is not configured: ${configured.missing.join(", ")}`);
    return 1;
  }
  const store = configured.store;
  const artifacts = new ArtifactStore(store);

  const manifest = await artifacts.readManifest(SHARDED.index);
  if (!manifest) {
    report({ outcome: "no_manifest" });
    console.error(`::error::No manifest at ${manifestKey(SHARDED.index)}; nothing is live.`);
    return 1;
  }
  const current = await artifacts.readCurrent<NetworkIndexRecord>(SHARDED.index);
  const record = current.records[0];
  if (!record) {
    report({ outcome: "no_index_record", version: manifest.version });
    console.error("::error::The index manifest names a version with no record in it.");
    return 1;
  }
  if (record.version !== manifest.version) {
    report({
      outcome: "version_disagreement",
      manifestVersion: manifest.version,
      recordVersion: record.version,
    });
    console.error(
      `::error::The manifest says ${manifest.version} and the index record says ` +
        `${record.version}. They are set from one value at publish time, so this job stops.`,
    );
    return 1;
  }

  const idBuckets = record.stopServicesShards ?? [];
  if ((record.stopServicesBuckets ?? 0) <= 0 || idBuckets.length === 0) {
    report({ outcome: "no_id_index", version: record.version });
    console.error(
      "::error::This artifact carries no stop-services index to enrich. Publish a full build " +
        "first, which writes one.",
    );
    return 1;
  }

  console.log(
    `Artifact ${record.version}: ${String(idBuckets.length)} stop-services bucket(s) to enrich.`,
  );

  /*
   * The names, read once from the national objects rather than per service from its bucket.
   *
   * This is a build-time job on a runner with the whole file to itself, which is exactly the
   * situation the Worker is not in — and the reason the Worker must not do this join per request
   * is the reason for doing it once here.
   */
  const services = new Map<string, ServiceRoute>();
  for (const service of await artifacts.readVersionRecords<ServiceRoute>(
    DATASETS.services,
    record.version,
  )) {
    services.set(service.id, service);
  }
  const operatorNames = new Map<string, string>();
  for (const operator of await artifacts.readVersionRecords<Operator>(
    DATASETS.operators,
    record.version,
  )) {
    operatorNames.set(operator.id, operator.name);
  }
  console.log(
    `${String(services.size)} service(s) and ${String(operatorNames.size)} operator(s) read.`,
  );
  if (services.size === 0) {
    report({ outcome: "no_services", version: record.version });
    console.error("::error::No services published at this version; there is nothing to name.");
    return 1;
  }

  /* Every id bucket, re-expressed. Absent or unparseable is a refusal: see the retiler. */
  let absent = 0;
  let unparseable = 0;
  let unresolvedServices = 0;
  const idBytesTotal: number[] = [];
  const enriched: Array<{
    bucket: number;
    rows: StopServingRoutesRow[];
    operators: StopServingOperator[];
    bytes: number;
    lines: string[];
  }> = [];
  let stops = 0;
  let entries = 0;

  const built = await mapWithConcurrency(idBuckets, CONCURRENCY, async (bucket) => {
    const body = await store.get(objectKeyFor(stopServicesDataset(bucket), record.version));
    if (body === null) {
      absent += 1;
      return null;
    }
    const rows: StopServingRoutesRow[] = [];
    const operators: StopServingOperator[] = [];
    const operatorIndex = new Map<string, number>();

    for (const line of body.split("\n")) {
      if (line.length === 0) continue;
      /* The header, which carries a version and a count and no stop. */
      if (!line.startsWith("[")) continue;
      let parsed: [string, string[]];
      try {
        parsed = JSON.parse(line) as [string, string[]];
      } catch {
        unparseable += 1;
        continue;
      }
      const [stopId, serviceIds] = parsed;
      if (typeof stopId !== "string" || !Array.isArray(serviceIds)) {
        unparseable += 1;
        continue;
      }
      const routes = [];
      for (const serviceId of serviceIds) {
        const service = services.get(serviceId);
        /*
         * A service the id index names and this version does not publish. Counted rather than
         * guessed at: a route with no name is not something a board can render, and the board's
         * own `routesFromServiceIds` already drops it today — so this changes nothing about what a
         * passenger sees, and a large count would mean the two families disagree.
         */
        if (!service) {
          unresolvedServices += 1;
          continue;
        }
        let index = operatorIndex.get(service.operatorId);
        if (index === undefined) {
          index = operators.length;
          operatorIndex.set(service.operatorId, index);
          operators.push([
            service.operatorId,
            operatorNames.get(service.operatorId) ?? "Unknown operator",
          ]);
        }
        routes.push({ id: service.id, name: service.publicName, o: index });
      }
      if (routes.length === 0) continue;
      routes.sort((a, b) => (a.id < b.id ? -1 : 1));
      rows.push({ s: stopId, r: routes });
    }

    rows.sort((a, b) => (a.s < b.s ? -1 : 1));
    const lines = stopServingRoutesShardLines(rows, operators);
    const bytes = lines.reduce((total, line) => total + utf8Bytes(line), 0) + lines.length - 1;
    return { bucket, rows, operators, bytes, lines, idBytes: utf8Bytes(body) };
  });

  for (const entry of built) {
    if (entry === null) continue;
    idBytesTotal.push(entry.idBytes);
    stops += entry.rows.length;
    for (const row of entry.rows) entries += row.r.length;
    enriched.push(entry);
  }

  if (absent > 0 || unparseable > 0) {
    report({
      outcome: "source_incomplete",
      version: record.version,
      idBuckets: idBuckets.length,
      absent,
      unparseable,
    });
    console.error(
      `::error::${String(absent)} bucket(s) absent and ${String(unparseable)} line(s) ` +
        `unparseable. Enriching would lose them, so nothing is written.`,
    );
    return 1;
  }

  const bytes = enriched.reduce((total, entry) => total + entry.bytes, 0);
  const idBytes = idBytesTotal.reduce((total, size) => total + size, 0);
  const oversized = enriched.filter((entry) => entry.bytes > MAX_SHARD_BYTES);
  const busiest = enriched
    .flatMap((entry) => entry.rows.map((row) => ({ stop: row.s, routes: row.r.length })))
    .sort((a, b) => b.routes - a.routes)
    .slice(0, 5);

  const plan = {
    version: record.version,
    stops,
    entries,
    buckets: enriched.length,
    idIndexBytes: idBytes,
    enrichedBytes: bytes,
    storageIncreaseBytes: bytes,
    bytesPerEntry: entries === 0 ? 0 : Math.round(bytes / entries),
    bucketBytes: spread(enriched.map((entry) => entry.bytes)),
    operatorsPerBucket: spread(enriched.map((entry) => entry.operators.length)),
    routesPerStop: spread(enriched.flatMap((entry) => entry.rows.map((row) => row.r.length))),
    /* What a board will read: one bucket. These two are the serving numbers that matter. */
    typicalStopReadBytes: spread(enriched.map((entry) => entry.bytes)).median,
    busiestInterchangeReadBytes: Math.max(0, ...enriched.map((entry) => entry.bytes)),
    busiestStops: busiest,
    unresolvedServices,
  };

  console.log("");
  console.log(
    `stops ${String(stops)}  entries ${String(entries)}  buckets ${String(enriched.length)}`,
  );
  console.log(
    `id index ${(idBytes / 1024 / 1024).toFixed(1)} MiB  enriched ` +
      `${(bytes / 1024 / 1024).toFixed(1)} MiB  (${String(plan.bytesPerEntry)} bytes an entry)`,
  );
  console.log(
    `bucket bytes: median ${String(plan.bucketBytes.median)}  p95 ` +
      `${String(plan.bucketBytes.p95)}  max ${String(plan.bucketBytes.max)}`,
  );
  console.log(
    `routes at a stop: median ${String(plan.routesPerStop.median)}  max ` +
      `${String(plan.routesPerStop.max)}; operators in a bucket: median ` +
      `${String(plan.operatorsPerBucket.median)}  max ${String(plan.operatorsPerBucket.max)}`,
  );
  if (unresolvedServices > 0) {
    console.log(
      `::warning title=stop serving routes::${String(unresolvedServices)} service id(s) in the ` +
        `id index are not published at this version and are left out, exactly as the board's own ` +
        `name lookup leaves them out today.`,
    );
  }

  if (oversized.length > 0) {
    report({
      outcome: "output_over_cap",
      ...plan,
      oversized: oversized
        .slice(0, 5)
        .map((entry) => ({ bucket: entry.bucket, bytes: entry.bytes })),
    });
    console.error(
      `::error::${String(oversized.length)} bucket(s) exceed the publisher's byte cap. Its answer ` +
        `to that is truncation, and truncation here is routes missing from a board.`,
    );
    return 1;
  }

  if (!APPLY) {
    report({ outcome: "reported", applied: false, ...plan });
    console.log("");
    console.log("Report only. Pass --apply to write the family and declare it in the index.");
    return 0;
  }

  /* Resumable, for the reason the retiler is: this account writes at about four objects a second. */
  const before = store.listDetailed
    ? await store.listDetailed(`data/${STOP_SERVING_ROUTES_PREFIX}/`)
    : null;
  const present = new Map((before ?? []).map((object) => [object.key, object.sizeBytes]));
  const toWrite = enriched.filter(
    (entry) =>
      present.get(objectKeyFor(stopServingRoutesDataset(entry.bucket), record.version)) !==
      entry.bytes,
  );
  if (toWrite.length < enriched.length) {
    console.log(
      `${String(enriched.length - toWrite.length)} bucket(s) already written at the right ` +
        `length; ${String(toWrite.length)} to go.`,
    );
  }

  const failures: Array<{ bucket: number; reason: string }> = [];
  const writeBegan = Date.now();
  await mapWithConcurrency(toWrite, CONCURRENCY, async (entry) => {
    try {
      await store.put(
        objectKeyFor(stopServingRoutesDataset(entry.bucket), record.version),
        entry.lines.join("\n"),
      );
    } catch (error) {
      failures.push({
        bucket: entry.bucket,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
  const writeMs = Date.now() - writeBegan;

  if (failures.length > 0) {
    report({ outcome: "writes_failed", ...plan, writeMs, failures: failures.slice(0, 5) });
    console.error(
      `::error::${String(failures.length)} bucket(s) could not be written. The index was not ` +
        `touched, so no reader will look for this family.`,
    );
    return 1;
  }

  /* Verified from one listing, by exact byte length: see the retiler for why that is enough. */
  const after = store.listDetailed
    ? await store.listDetailed(`data/${STOP_SERVING_ROUTES_PREFIX}/`)
    : null;
  const verifyFailures: Array<{ bucket: number; expected: number; found: number | null }> = [];
  if (after) {
    const sizes = new Map(after.map((object) => [object.key, object.sizeBytes]));
    for (const entry of enriched) {
      const found =
        sizes.get(objectKeyFor(stopServingRoutesDataset(entry.bucket), record.version)) ?? null;
      if (found !== entry.bytes) {
        verifyFailures.push({ bucket: entry.bucket, expected: entry.bytes, found });
      }
    }
  } else {
    await mapWithConcurrency(enriched, CONCURRENCY, async (entry) => {
      const body = await store.get(
        objectKeyFor(stopServingRoutesDataset(entry.bucket), record.version),
      );
      const found = body === null ? null : utf8Bytes(body);
      if (found !== entry.bytes) {
        verifyFailures.push({ bucket: entry.bucket, expected: entry.bytes, found });
      }
    });
  }

  if (verifyFailures.length > 0) {
    report({
      outcome: "verification_failed",
      ...plan,
      writeMs,
      failures: verifyFailures.slice(0, 5),
      failureCount: verifyFailures.length,
    });
    console.error(
      `::error::${String(verifyFailures.length)} bucket(s) are absent or not the length they were ` +
        `written at. The index was not touched.`,
    );
    return 1;
  }

  /*
   * One write, and it is the whole change: until the index names these buckets, no reader looks
   * for them. The id index is left exactly as it is, so a reader that prefers it — or an older
   * Worker that has never heard of this family — carries on unaffected, and a rollback is this
   * same write without the two fields.
   */
  const declared: NetworkIndexRecord = {
    ...record,
    stopServingRoutesBuckets: STOP_SERVING_ROUTES_BUCKETS,
    stopServingRoutesShards: enriched.map((entry) => entry.bucket).sort((a, b) => a - b),
  };
  try {
    await artifacts.publish({
      dataset: SHARDED.index,
      version: record.version,
      records: [declared],
      schemaVersion: NETWORK_SCHEMA_VERSION,
      sources: ["naptan", "bods"],
      minimumRecordCount: 1,
    });
  } catch (error) {
    report({
      outcome: "index_declaration_failed",
      ...plan,
      writeMs,
      reason: error instanceof Error ? error.message : String(error),
    });
    console.error(
      "::error::The buckets are written and verified but the index could not be republished, so " +
        "no reader will use them. Re-running is safe: the writes are skipped and only the " +
        "declaration is retried.",
    );
    return 1;
  }

  report({
    outcome: "applied",
    applied: true,
    ...plan,
    writeMs,
    written: toWrite.length,
    alreadyPresent: enriched.length - toWrite.length,
  });
  console.log("");
  console.log(
    `Published: ${String(enriched.length)} serving-route bucket(s), ` +
      `${(bytes / 1024 / 1024).toFixed(1)} MiB, written in ${(writeMs / 1000).toFixed(0)}s and ` +
      `declared in the index. The id index is untouched, so a rollback is one write.`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Enriching the stop index failed:", error);
    process.exitCode = 1;
  });
