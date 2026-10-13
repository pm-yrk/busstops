/**
 * Services, partitioned by id so a board can read the handful it needs.
 *
 * ## The cost this removes
 *
 * A stop board resolves two or three service ids — the routes its departures name. It did that by
 * fetching `network/services` and scanning it: 4.7 MiB of text, 13,626 records, fetched and
 * UTF-8 decoded on every board, to build two objects. The scan itself is cheap and deliberately
 * so; the fetch and the decode are not, and they are paid in full every time because a filtered
 * read cannot populate the record cache (an entry holding one request's two services would answer
 * the next request's question with almost nothing). Retaining the text instead was tried and
 * showed no measurable benefit, so the direction is fewer bytes rather than more retained state.
 *
 * Partitioned, the same question costs one object of about 19 KiB.
 *
 * ## Why a hash rather than something readable
 *
 * A service id is a UUID, so there is no prefix to group by that would not leave one bucket
 * holding most of the network. `locatorBucketFor` is the FNV-1a the stop locator already uses for
 * exactly this reason, and reusing it means there is one bucketing rule in the product rather than
 * two that could drift. It is deterministic: the same id lands in the same bucket in the pipeline
 * and in the Worker, which is the only property that matters here and is worth a test of its own.
 *
 * ## Why 256
 *
 * 13,626 services across 256 buckets is about 53 each, which at the measured average record size
 * is roughly 19 KiB — small enough that a board's read is trivial, large enough that the family is
 * 256 objects rather than thousands. The total data is unchanged: this is the same records, split.
 */

import type { ServiceRoute } from "@busstops/contracts";
import { LOCATOR_BUCKETS, locatorBucketFor } from "./shards.js";

/** Deliberately the same count as the stop locator's, for the same reasons. */
export const SERVICE_BUCKETS = LOCATOR_BUCKETS;

/** The dataset name for one bucket. A prefix family, like the stop and search tiles. */
export function serviceBucketDataset(bucket: number): string {
  return `network/services-bucket/${bucket}`;
}

/**
 * Which bucket a service id belongs to.
 *
 * The one function both sides must agree on. The pipeline calls it to decide where to write a
 * record and the Worker calls it to decide where to look, so a disagreement here is a service
 * that exists and cannot be found — which is why the round trip is tested rather than assumed.
 */
export function serviceBucketFor(serviceId: string): number {
  return locatorBucketFor(serviceId, SERVICE_BUCKETS);
}

/**
 * Every service placed in its bucket.
 *
 * Returns only the buckets that have something in them. A network with no service in bucket 7 has
 * no object for bucket 7, and the reader treats an absent bucket as "no service of yours is
 * here" — which is also what makes the rollout safe, since a deployment reading a version that
 * was published before this family existed finds nothing and falls back.
 */
export function bucketServices(services: readonly ServiceRoute[]): Map<string, ServiceRoute[]> {
  const buckets = new Map<string, ServiceRoute[]>();
  for (const service of services) {
    const dataset = serviceBucketDataset(serviceBucketFor(service.id));
    const existing = buckets.get(dataset);
    if (existing) existing.push(service);
    else buckets.set(dataset, [service]);
  }
  return buckets;
}
