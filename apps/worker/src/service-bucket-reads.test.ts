import { describe, expect, it } from "vitest";
import { ArtifactStore, InMemoryObjectStore } from "@busstops/pipeline-core";
import type { ServiceRoute } from "@busstops/contracts";
import {
  SHARDED,
  bucketServices,
  serviceBucketDataset,
  serviceBucketFor,
} from "@busstops/pipeline-static-network";
import { NetworkReader } from "./network-reader.js";
import { ReadLedger } from "./read-ledger.js";

/**
 * A board asks for two or three service ids. It used to fetch and UTF-8 decode 4.7 MiB of
 * `network/services` to answer, every time, because a filtered read cannot populate the record
 * cache. These tests are about *which objects the reader opens*, not about how fast it is: the
 * saving is the bytes not fetched, and the keys read are the only honest evidence of that.
 *
 * The fallback matters as much as the fast path. A version published before this family existed
 * has no buckets at all, and the reader has to behave against one exactly as it always did.
 */
function service(id: string, publicName: string): ServiceRoute {
  return {
    id,
    publicName,
    operatorId: "00000000-0000-5000-8000-00000000000a",
    mode: "bus",
    provenance: { source: "bods", retrievedAt: "2026-10-13T00:00:00.000Z", externalIds: [] },
    ingestedAt: "2026-10-13T00:00:00.000Z",
    qualityFlags: [],
  } as unknown as ServiceRoute;
}

const SERVICES = Array.from({ length: 2000 }, (_, i) =>
  service(`00000000-0000-5000-8000-${String(i).padStart(12, "0")}`, `${i}`),
);

function recordingStore() {
  const inner = new InMemoryObjectStore();
  const reads: string[] = [];
  return {
    reads,
    store: {
      async get(key: string) {
        reads.push(key);
        return inner.get(key);
      },
      put: inner.put.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
      listDetailed: inner.listDetailed?.bind(inner),
    },
  };
}

/** The whole services object plus, optionally, the partitioned family beside it. */
async function published(options: { buckets: boolean }) {
  const recording = recordingStore();
  const artifacts = new ArtifactStore(recording.store);
  /*
   * Only the index and the services, because only those are under test. The reader needs the index
   * to know which version to read a bucket at; the rest of a published network is irrelevant here
   * and building it would make the test about the publisher.
   */
  await artifacts.publish({
    dataset: SHARDED.index,
    version: "v1",
    records: [
      {
        version: "v1",
        publishedAt: "2026-10-13T00:00:00.000Z",
        partialCoverage: false,
        stopTiles: [],
        patternTiles: [],
        searchTiles: [],
        searchPrefixes: [],
      },
    ],
    schemaVersion: "1.0.0",
  });
  await artifacts.publish({
    dataset: "network/services",
    version: "v1",
    records: SERVICES,
    schemaVersion: "1.0.0",
  });
  if (options.buckets) {
    for (const [dataset, rows] of bucketServices(SERVICES)) {
      await artifacts.publish({ dataset, version: "v1", records: rows, schemaVersion: "1.0.0" });
    }
  }
  return { reader: new NetworkReader(recording.store), reads: recording.reads };
}

describe("resolving a handful of service ids", () => {
  it("reads only the buckets the wanted ids fall in, not the whole object", async () => {
    const { reader, reads } = await published({ buckets: true });
    reads.length = 0;

    const wanted = new Set([SERVICES[7]!.id, SERVICES[900]!.id]);
    const ledger = new ReadLedger(1000);
    const found = await reader.servicesByIds(wanted, ledger);

    expect([...found.keys()].sort()).toEqual([...wanted].sort());
    expect(found.get(SERVICES[7]!.id)!.publicName).toBe("7");

    // The claim: the national object was never opened.
    expect(reads.some((key) => key.includes("network/services/"))).toBe(false);
    const bucketReads = reads.filter((key) => key.includes("network/services-bucket/"));
    expect(bucketReads.length, "one object per distinct bucket").toBeLessThanOrEqual(2);
  });

  it("reads one object when the wanted ids share a bucket", async () => {
    const { reader, reads } = await published({ buckets: true });
    // Two ids known to land together, found rather than assumed.
    const target = serviceBucketFor(SERVICES[0]!.id);
    const sharing = SERVICES.filter((s) => serviceBucketFor(s.id) === target).slice(0, 2);
    expect(sharing.length, "the fixture must contain a shared bucket").toBe(2);

    reads.length = 0;
    const found = await reader.servicesByIds(new Set(sharing.map((s) => s.id)));
    expect(found.size).toBe(2);
    expect(reads.filter((key) => key.includes(serviceBucketDataset(target))).length).toBe(1);
  });

  /*
   * The rollback path, and the reason the old object is left in place. A deployment serving a
   * version published before this family existed must answer exactly as it used to.
   */
  it("falls back to the whole object when the family is not published", async () => {
    const { reader, reads } = await published({ buckets: false });
    reads.length = 0;

    const wanted = new Set([SERVICES[7]!.id, SERVICES[900]!.id]);
    const found = await reader.servicesByIds(wanted);

    expect([...found.keys()].sort()).toEqual([...wanted].sort());
    expect(
      reads.some((key) => key.includes("network/services/")),
      "the object answered",
    ).toBe(true);
  });

  /*
   * An unknown id is ordinary — a pattern naming a service the network no longer publishes — and
   * must not cost a 4.7 MiB read to establish. A present bucket that lacks it is an answer.
   */
  it("does not fall back for an id that is simply not in the network", async () => {
    const { reader, reads } = await published({ buckets: true });
    reads.length = 0;

    const found = await reader.servicesByIds(
      new Set(["ffffffff-0000-4000-8000-ffffffffffff", SERVICES[7]!.id]),
    );

    expect(found.size, "the one that exists comes back").toBe(1);
    expect(reads.some((key) => key.includes("network/services/"))).toBe(false);
  });

  /*
   * The cap, which is a subrequest budget: a request wanting a great many services must not open a
   * great many objects, because an invocation gets fifty subrequests in total. Tombland in Norwich
   * measured at twenty-five services on one board and twenty-six the next run, so the cap is
   * thirty-two and this asks for ids from more buckets than that.
   */
  it("reads the whole object when the wanted ids span more buckets than the cap allows", async () => {
    const { reader, reads } = await published({ buckets: true });
    reads.length = 0;

    // One id from each of forty distinct buckets, chosen deterministically rather than sampled.
    const byBucket = new Map<number, string>();
    for (const service of SERVICES) {
      const bucket = serviceBucketFor(service.id);
      if (!byBucket.has(bucket)) byBucket.set(bucket, service.id);
      if (byBucket.size === 40) break;
    }
    expect(byBucket.size).toBe(40);

    const ledger = new ReadLedger(1000);
    const found = await reader.servicesByIds(new Set(byBucket.values()), ledger);

    expect(found.size, "every one still comes back").toBe(40);
    expect(ledger.toJSON().artifact?.servicesPath).toBe("whole_object");
    expect(reads.some((key) => key.includes("network/services-bucket/"))).toBe(false);
  });

  it("records which representation answered, and what it cost", async () => {
    const { reader } = await published({ buckets: true });
    const ledger = new ReadLedger(1000);
    await reader.servicesByIds(new Set([SERVICES[7]!.id]), ledger);

    const notes = ledger.toJSON().artifact ?? {};
    expect(notes.servicesPath).toBe("buckets");
    expect(notes.servicesWanted).toBe(1);
    expect(notes.servicesFound).toBe(1);
    expect(notes.serviceBucketsRead).toBe(1);
    expect(Number(notes.serviceBucketChars)).toBeGreaterThan(0);
  });

  it("records the whole-object cost on the fallback, so the two are comparable", async () => {
    const { reader } = await published({ buckets: false });
    const ledger = new ReadLedger(1000);
    await reader.servicesByIds(new Set([SERVICES[7]!.id]), ledger);

    const notes = ledger.toJSON().artifact ?? {};
    expect(notes.servicesPath).toBe("whole_object");
    expect(Number(notes.servicesObjectChars)).toBeGreaterThan(100_000);
  });
});
