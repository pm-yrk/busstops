import { describe, expect, it } from "vitest";
import type { ServiceRoute } from "@busstops/contracts";
import {
  SERVICE_BUCKETS,
  bucketServices,
  serviceBucketDataset,
  serviceBucketFor,
} from "./service-buckets.js";

/**
 * The property the whole scheme rests on is that the pipeline and the Worker agree about where a
 * service lives. A disagreement is not a slow board, it is a service that exists and cannot be
 * found, so the round trip is tested rather than assumed — and so is the distribution, because a
 * hash that piled most of the network into one bucket would reintroduce the cost being removed.
 */
function service(id: string, publicName: string): ServiceRoute {
  return {
    id,
    publicName,
    operatorId: "00000000-0000-5000-8000-00000000000a",
    mode: "bus",
  } as unknown as ServiceRoute;
}

/** Deterministic ids, so the distribution assertions are about the hash and not about chance. */
function manyServices(count: number): ServiceRoute[] {
  return Array.from({ length: count }, (_, i) =>
    service(`00000000-0000-5000-8000-${String(i).padStart(12, "0")}`, `${i}`),
  );
}

describe("bucketing services by id", () => {
  it("puts a service where the reader will look for it", () => {
    const id = "7f3a1c2e-0000-4000-8000-000000000001";
    const placed = bucketServices([service(id, "36")]);

    const expected = serviceBucketDataset(serviceBucketFor(id));
    expect([...placed.keys()]).toEqual([expected]);
    expect(placed.get(expected)!.map((s) => s.id)).toEqual([id]);
  });

  it("is deterministic, which is the only property both sides must share", () => {
    const id = "7f3a1c2e-0000-4000-8000-000000000001";
    expect(serviceBucketFor(id)).toBe(serviceBucketFor(id));
    expect(serviceBucketFor(id)).toBeGreaterThanOrEqual(0);
    expect(serviceBucketFor(id)).toBeLessThan(SERVICE_BUCKETS);
  });

  /*
   * Every service exactly once. A record written to two buckets would be read twice and a record
   * written to none would be invisible, and the second is the failure that matters.
   */
  it("places every service exactly once, with no duplicate and none lost", () => {
    const services = manyServices(5000);
    const placed = bucketServices(services);

    const seen = new Map<string, number>();
    for (const records of placed.values()) {
      for (const record of records) seen.set(record.id, (seen.get(record.id) ?? 0) + 1);
    }

    expect(seen.size, "every service is somewhere").toBe(services.length);
    expect(
      [...seen.values()].every((times) => times === 1),
      "and in exactly one bucket",
    ).toBe(true);
  });

  /*
   * A hash that leaves one bucket holding most of the network puts the 4.7 MiB back. 5,000
   * services over 256 buckets averages 20; a worst bucket beyond about four times that would mean
   * the scheme is not doing its job.
   */
  it("spreads the network rather than piling it into one bucket", () => {
    const placed = bucketServices(manyServices(5000));
    const sizes = [...placed.values()].map((records) => records.length);

    expect(placed.size, "most buckets are used").toBeGreaterThan(SERVICE_BUCKETS * 0.9);
    expect(Math.max(...sizes), "no bucket holds a disproportionate share").toBeLessThan(80);
  });

  it("writes no object for a bucket with nothing in it", () => {
    const placed = bucketServices([service("7f3a1c2e-0000-4000-8000-000000000001", "36")]);
    expect(placed.size).toBe(1);
  });

  it("names a bucket under its own family, so retention and reads can find it", () => {
    expect(serviceBucketDataset(0)).toBe("network/services-bucket/0");
    expect(serviceBucketDataset(255)).toBe("network/services-bucket/255");
  });
});
