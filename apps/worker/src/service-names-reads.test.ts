import { describe, expect, it } from "vitest";
import { ArtifactStore, InMemoryObjectStore } from "@busstops/pipeline-core";
import type { ServiceRoute } from "@busstops/contracts";
import { SERVICE_NAMES_DATASET, serviceNames } from "@busstops/pipeline-static-network";
import { NetworkReader } from "./network-reader.js";
import { ReadLedger } from "./read-ledger.js";

/**
 * The map wants every service's number, not every service.
 *
 * Buckets answer "these three ids"; they cannot answer "all of them", because a city viewport
 * names a few hundred distinct services that hash across nearly every bucket and an invocation
 * gets fifty subrequests. So that path read the whole national object, which the bucket proof
 * measures at 4,669,134 bytes.
 *
 * These tests are about which object the reader opens and what it hands back — the saving is bytes
 * not fetched, and the keys read are the only honest evidence of it. The absent case matters as
 * much as the present one: a version published before this family existed must behave as it did.
 */
function service(id: string, publicName: string): ServiceRoute {
  return {
    id,
    publicName,
    operatorId: "00000000-0000-5000-8000-00000000000a",
    mode: "bus",
    description: "a description long enough to be worth not reading",
    provenance: { source: "bods", retrievedAt: "2026-10-13T00:00:00.000Z", externalIds: [] },
    ingestedAt: "2026-10-13T00:00:00.000Z",
    qualityFlags: [],
  } as unknown as ServiceRoute;
}

const SERVICES = Array.from({ length: 500 }, (_, i) =>
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

async function published(options: { names: boolean }) {
  const recording = recordingStore();
  const artifacts = new ArtifactStore(recording.store);
  await artifacts.publish({
    dataset: "network/services",
    version: "v1",
    records: SERVICES,
    schemaVersion: "1.0.0",
  });
  if (options.names) {
    await artifacts.publish({
      dataset: SERVICE_NAMES_DATASET,
      version: "v1",
      records: serviceNames(SERVICES),
      schemaVersion: "1.0.0",
    });
  }
  return { reader: new NetworkReader(recording.store), reads: recording.reads };
}

describe("reading every service's name", () => {
  it("gives the same name for every service as the services themselves do", async () => {
    const { reader } = await published({ names: true });
    const names = await reader.serviceNames();

    expect(names).not.toBeNull();
    expect(names!.size).toBe(SERVICES.length);
    // Every one, not a sample: a projection that drops records is the fault worth catching.
    for (const service of SERVICES) {
      expect(names!.get(service.id), service.id).toBe(service.publicName);
    }
  });

  it("opens the projection and never the national object", async () => {
    const { reader, reads } = await published({ names: true });
    reads.length = 0;

    await reader.serviceNames();

    expect(reads.some((key) => key.includes(SERVICE_NAMES_DATASET))).toBe(true);
    expect(
      reads.some((key) => /network\/services\//.test(key)),
      "the whole services object was opened anyway",
    ).toBe(false);
  });

  /*
   * The point of the exercise, asserted as bytes rather than as an intention. Both objects are
   * built from the same records here, so the ratio is a property of the projection and not of the
   * fixture's size.
   */
  it("is a fraction of the object it replaces", async () => {
    const recording = recordingStore();
    const artifacts = new ArtifactStore(recording.store);
    const whole = await artifacts.publish({
      dataset: "network/services",
      version: "v1",
      records: SERVICES,
      schemaVersion: "1.0.0",
    });
    const projection = await artifacts.publish({
      dataset: SERVICE_NAMES_DATASET,
      version: "v1",
      records: serviceNames(SERVICES),
      schemaVersion: "1.0.0",
    });

    expect(projection.recordCount).toBe(whole.recordCount);
    expect(projection.sizeBytes).toBeLessThan(whole.sizeBytes / 3);
  });

  it("reads the object once per reader, however many callers ask", async () => {
    const { reader, reads } = await published({ names: true });
    reads.length = 0;

    await reader.serviceNames();
    await reader.serviceNames();
    await reader.serviceNames();

    /*
     * Two reads in total for three calls — the manifest and the object, both on the first — and
     * the data object opened exactly once. The second and third calls touch R2 not at all.
     */
    expect(reads.filter((key) => key.startsWith("data/")).length).toBe(1);
    expect(reads.length).toBe(2);
  });

  it("records what it cost, so a deployed request can be read back", async () => {
    const { reader } = await published({ names: true });
    const ledger = new ReadLedger(1000);

    await reader.serviceNames(ledger);

    const note = ledger.toJSON().artifact as Record<string, number> | undefined;
    expect(note?.serviceNamesRecords).toBe(SERVICES.length);
    expect(note?.serviceNamesChars).toBeGreaterThan(0);
  });

  it("answers null when the family is not published, so the caller can fall back", async () => {
    const { reader, reads } = await published({ names: false });
    reads.length = 0;

    expect(await reader.serviceNames()).toBeNull();
    // And it did not go looking through the national object to discover that.
    expect(reads.some((key) => /network\/services\//.test(key))).toBe(false);
  });
});
