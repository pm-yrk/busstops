#!/usr/bin/env node
/**
 * Prove the bucketed service family before any reader is pointed at it.
 *
 * The scheme's one load-bearing property is that the pipeline and the Worker agree about where a
 * service lives, and a disagreement is not a slow board — it is a service that exists and cannot
 * be found. Unit tests cover the hash; this covers the *published artifact*, which is a different
 * claim: that every service in `network/services` is in exactly one bucket, in the bucket the
 * reader will look in, at the version that is live.
 *
 * It reads and reports; it changes nothing. Run it against the bucket the deployment serves.
 */

import { ArtifactStore, r2StoreFromEnv, annotateReport } from "@busstops/pipeline-core";
import type { Operator, ServiceRoute } from "@busstops/contracts";
import {
  SERVICE_BUCKETS,
  serviceBucketDataset,
  serviceBucketFor,
} from "../pipelines/static-network/src/service-buckets.js";

const report: Record<string, unknown> = { startedAt: new Date().toISOString() };

async function main(): Promise<number> {
  const storage = r2StoreFromEnv(process.env);
  if (!storage.ok) {
    report.outcome = "not_configured";
    report.missing = storage.missing;
    annotateReport("service buckets", report);
    return 0;
  }
  const artifacts = new ArtifactStore(storage.store);

  const source = await artifacts.readCurrent<ServiceRoute>("network/services");
  report.sourceServices = source.records.length;
  report.sourceVersion = source.manifest?.version ?? null;
  /*
   * The size of the whole object, because that is the old path's measured cost.
   *
   * Every stop board used to fetch and UTF-8 decode this to resolve a handful of ids. Reporting it
   * here, from the bucket the deployment serves, means the before-and-after comparison is two
   * measurements rather than one measurement and one remembered figure.
   */
  report.sourceBytes = source.manifest?.sizeBytes ?? 0;
  if (source.records.length === 0) {
    report.outcome = "no_source";
    annotateReport("service buckets", report);
    return 1;
  }

  /*
   * Read every bucket, not a sample. 256 small objects is a few seconds and the whole point is to
   * be able to say "every service" rather than "the ones I happened to look at".
   */
  const bucketSizes: number[] = [];
  const seen = new Map<string, number>();
  const misplaced: string[] = [];
  let bucketsPresent = 0;
  let bucketBytes = 0;

  for (let bucket = 0; bucket < SERVICE_BUCKETS; bucket += 1) {
    const dataset = serviceBucketDataset(bucket);
    const read = await artifacts.readCurrent<ServiceRoute>(dataset);
    if (read.records.length === 0) continue;
    bucketsPresent += 1;
    bucketSizes.push(read.records.length);
    bucketBytes += read.manifest?.sizeBytes ?? 0;
    for (const service of read.records) {
      seen.set(service.id, (seen.get(service.id) ?? 0) + 1);
      // The claim that matters: this record is in the bucket the Worker will look in.
      if (serviceBucketFor(service.id) !== bucket) {
        if (misplaced.length < 5) misplaced.push(`${service.id} is in ${bucket}`);
      }
    }
  }

  const sourceIds = new Set(source.records.map((service) => service.id));
  const missing = [...sourceIds].filter((id) => !seen.has(id));
  const duplicated = [...seen].filter(([, times]) => times > 1).map(([id]) => id);
  const extra = [...seen.keys()].filter((id) => !sourceIds.has(id));

  /*
   * Named services from several operators, so "coverage is complete" is backed by something a
   * person can recognise rather than only by a count.
   */
  const operators = await artifacts.readCurrent<Operator>("network/operators");
  const operatorName = new Map(operators.records.map((o) => [o.id, o.name]));
  const byOperator = new Map<string, ServiceRoute>();
  for (const service of source.records) {
    if (!byOperator.has(service.operatorId)) byOperator.set(service.operatorId, service);
  }
  const samples: string[] = [];
  for (const service of [...byOperator.values()].slice(0, 8)) {
    const bucket = serviceBucketFor(service.id);
    const read = await artifacts.readCurrent<ServiceRoute>(serviceBucketDataset(bucket));
    const found = read.records.find((candidate) => candidate.id === service.id);
    samples.push(
      `${service.publicName} (${operatorName.get(service.operatorId) ?? "unknown operator"}) ` +
        `→ bucket ${bucket}: ${found ? "found" : "MISSING"}`,
    );
  }

  report.bucketsPresent = bucketsPresent;
  report.bucketsPossible = SERVICE_BUCKETS;
  report.servicesInBuckets = seen.size;
  report.bucketBytes = bucketBytes;
  report.meanBucketBytes = bucketsPresent > 0 ? Math.round(bucketBytes / bucketsPresent) : 0;
  report.largestBucket = bucketSizes.length > 0 ? Math.max(...bucketSizes) : 0;
  report.smallestBucket = bucketSizes.length > 0 ? Math.min(...bucketSizes) : 0;
  report.missing = missing.length;
  report.sampleMissing = missing.slice(0, 5);
  report.duplicated = duplicated.length;
  report.sampleDuplicated = duplicated.slice(0, 5);
  report.extra = extra.length;
  report.misplaced = misplaced.length;
  report.sampleMisplaced = misplaced;
  report.samples = samples;

  const complete =
    missing.length === 0 &&
    duplicated.length === 0 &&
    extra.length === 0 &&
    misplaced.length === 0 &&
    seen.size === sourceIds.size;
  report.outcome = complete ? "complete" : "incomplete";

  console.log(
    `${seen.size} of ${sourceIds.size} service(s) across ${bucketsPresent} bucket(s); ` +
      `${missing.length} missing, ${duplicated.length} duplicated, ${extra.length} unexpected, ` +
      `${misplaced.length} misplaced; mean bucket ${report.meanBucketBytes} bytes.`,
  );
  for (const sample of samples) console.log(`  ${sample}`);

  annotateReport("service buckets", report);
  return complete ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    report.outcome = "threw";
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    annotateReport("service buckets", report);
    console.error(report.error);
    process.exitCode = 1;
  });
