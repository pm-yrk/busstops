import { describe, expect, it } from "vitest";
import {
  ArtifactStore,
  ArtifactValidationError,
  InMemoryObjectStore,
  contentHash,
  manifestKey,
  objectKeyFor,
} from "./artifacts.js";

interface StopRecord {
  atcoCode: string;
  name: string;
}

function makeRecords(count: number, prefix = "45001"): StopRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    atcoCode: `${prefix}${String(i).padStart(4, "0")}`,
    name: `Stop ${i}`,
  }));
}

async function publishInitial(store: InMemoryObjectStore, count = 100) {
  const artifacts = new ArtifactStore(store);
  await artifacts.publish({
    dataset: "stops",
    version: "v1",
    records: makeRecords(count),
    schemaVersion: "1.0.0",
    sources: ["naptan"],
  });
  return artifacts;
}

describe("contentHash", () => {
  it("is stable and differs for different content", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });
});

describe("publish", () => {
  it("writes the versioned object and swaps the manifest pointer", async () => {
    const store = new InMemoryObjectStore();
    const artifacts = new ArtifactStore(store);

    const manifest = await artifacts.publish({
      dataset: "stops",
      version: "2026-09-02T06:00",
      records: makeRecords(10),
      schemaVersion: "1.0.0",
      sources: ["naptan"],
    });

    expect(manifest.recordCount).toBe(10);
    expect(manifest.previousVersion).toBeNull();
    expect(await store.get(manifestKey("stops"))).toContain("2026-09-02T06:00");
    expect(await store.get(objectKeyFor("stops", "2026-09-02T06:00"))).not.toBeNull();
  });

  it("records the version it replaced so rollback has a target", async () => {
    const store = new InMemoryObjectStore();
    const artifacts = await publishInitial(store);

    const second = await artifacts.publish({
      dataset: "stops",
      version: "v2",
      records: makeRecords(105),
      schemaVersion: "1.0.0",
    });
    expect(second.previousVersion).toBe("v1");
  });

  it("refuses to publish an empty artifact", async () => {
    const artifacts = new ArtifactStore(new InMemoryObjectStore());
    await expect(
      artifacts.publish({ dataset: "stops", version: "v1", records: [], schemaVersion: "1.0.0" }),
    ).rejects.toThrow(ArtifactValidationError);
  });

  it("publishes an empty artifact only when the caller says empty is a real answer", async () => {
    const artifacts = new ArtifactStore(new InMemoryObjectStore());
    const manifest = await artifacts.publish({
      dataset: "intelligence/incidents",
      version: "v1",
      records: [],
      schemaVersion: "1.0.0",
      minimumRecordCount: 0,
      allowEmpty: true,
    });
    expect(manifest.recordCount).toBe(0);
    // And it is genuinely live, so a quiet day replaces yesterday's incidents rather than
    // leaving them on screen.
    expect(await artifacts.readCurrent("intelligence/incidents")).toMatchObject({ records: [] });
  });

  it("refuses to publish below the minimum record count", async () => {
    const artifacts = new ArtifactStore(new InMemoryObjectStore());
    await expect(
      artifacts.publish({
        dataset: "stops",
        version: "v1",
        records: makeRecords(5),
        schemaVersion: "1.0.0",
        minimumRecordCount: 50,
      }),
    ).rejects.toThrow(/below the minimum/);
  });

  it("rejects a build that loses too many records and keeps the previous version live", async () => {
    const store = new InMemoryObjectStore();
    const artifacts = await publishInitial(store, 1000);

    // A broken upstream parse that drops 40% of the national dataset.
    await expect(
      artifacts.publish({
        dataset: "stops",
        version: "v2-broken",
        records: makeRecords(600),
        schemaVersion: "1.0.0",
      }),
    ).rejects.toThrow(/shrank by/);

    const current = await artifacts.readManifest("stops");
    expect(current?.version).toBe("v1");
    expect(current?.recordCount).toBe(1000);
  });

  it("allows a small, plausible decrease", async () => {
    const store = new InMemoryObjectStore();
    const artifacts = await publishInitial(store, 1000);
    const manifest = await artifacts.publish({
      dataset: "stops",
      version: "v2",
      records: makeRecords(950),
      schemaVersion: "1.0.0",
    });
    expect(manifest.version).toBe("v2");
  });

  it("rejects a record that fails validation before anything becomes live", async () => {
    const store = new InMemoryObjectStore();
    const artifacts = new ArtifactStore(store);
    const records = [...makeRecords(5), { atcoCode: "", name: "broken" }];

    await expect(
      artifacts.publish({
        dataset: "stops",
        version: "v1",
        records,
        schemaVersion: "1.0.0",
        validate: (r) => r.atcoCode.length > 0,
      }),
    ).rejects.toThrow(/failed validation/);

    expect(await artifacts.readManifest("stops")).toBeNull();
  });
});

describe("read", () => {
  it("round-trips records through the manifest", async () => {
    const store = new InMemoryObjectStore();
    const artifacts = await publishInitial(store, 20);
    const { manifest, records } = await artifacts.readCurrent<StopRecord>("stops");
    expect(manifest?.recordCount).toBe(20);
    expect(records).toHaveLength(20);
    expect(records[0]?.atcoCode).toBe("450010000");
  });

  it("returns empty state when nothing has been published", async () => {
    const artifacts = new ArtifactStore(new InMemoryObjectStore());
    const { manifest, records } = await artifacts.readCurrent<StopRecord>("stops");
    expect(manifest).toBeNull();
    expect(records).toEqual([]);
  });

  it("refuses to serve an artifact whose checksum does not match the manifest", async () => {
    const store = new InMemoryObjectStore();
    const artifacts = await publishInitial(store, 10);
    const manifest = (await artifacts.readManifest("stops"))!;

    // Simulate corruption or a partial write of the data object.
    await store.put(manifest.objectKey, '{"atcoCode":"tampered","name":"x"}');

    await expect(artifacts.readRecords(manifest)).rejects.toThrow(/Checksum mismatch/);
  });
});

describe("rollback", () => {
  it("points the manifest back at the previous good version", async () => {
    const store = new InMemoryObjectStore();
    const artifacts = await publishInitial(store, 100);
    await artifacts.publish({
      dataset: "stops",
      version: "v2",
      records: makeRecords(110, "45002"),
      schemaVersion: "1.0.0",
    });

    const restored = await artifacts.rollback("stops");
    expect(restored?.version).toBe("v1");

    const { records } = await artifacts.readCurrent<StopRecord>("stops");
    expect(records).toHaveLength(100);
    expect(records[0]?.atcoCode).toBe("450010000");
  });

  it("returns null when there is nothing to roll back to", async () => {
    const store = new InMemoryObjectStore();
    const artifacts = await publishInitial(store, 10);
    expect(await artifacts.rollback("stops")).toBeNull();
  });
});

describe("pruneOldVersions", () => {
  it("never deletes the live or previous-good version", async () => {
    const store = new InMemoryObjectStore();
    const artifacts = new ArtifactStore(store);
    for (const version of ["v1", "v2", "v3", "v4"]) {
      await artifacts.publish({
        dataset: "stops",
        version,
        records: makeRecords(100),
        schemaVersion: "1.0.0",
      });
    }

    await artifacts.pruneOldVersions("stops", 3);
    const remaining = await store.list("data/stops/");
    expect(remaining).toContain(objectKeyFor("stops", "v4"));
    expect(remaining).toContain(objectKeyFor("stops", "v3"));

    // The live version still reads back correctly after pruning.
    const { records } = await artifacts.readCurrent<StopRecord>("stops");
    expect(records).toHaveLength(100);
  });
});
