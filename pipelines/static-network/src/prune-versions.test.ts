import { describe, expect, it } from "vitest";
import type { StoredObject } from "@busstops/pipeline-core";
import { keysToRemove, planNetworkPrune, versionOfObjectKey } from "./prune-versions.js";

const V1 = "2026-09-15T05:00:00.000Z";
const V2 = "2026-09-16T05:00:00.000Z";
const V3 = "2026-09-17T10:36:28.000Z";

function object(key: string, sizeBytes: number): StoredObject {
  return { key, sizeBytes, uploadedAt: "2026-09-17T00:00:00.000Z" };
}

/** A publish, in the shapes a national build actually writes. */
function publish(version: string, bytesEach = 1000): StoredObject[] {
  return [
    object(`data/network/index/${version}.jsonl`, 20_000),
    object(`data/network/stops/${version}.jsonl`, bytesEach),
    object(`data/network/stops-tile/430_-13/${version}.jsonl`, bytesEach),
    // The departure index nests a service date and a bucket inside the dataset name, so the
    // version is not the only date-shaped thing in the key.
    object(`data/network/departures/2026-09-17/125/${version}.jsonl`, bytesEach),
    object(`data/network/pattern-trips/2026-09-17/1/215_-7/${version}.jsonl`, bytesEach),
  ];
}

describe("finding the version in an object key", () => {
  it("reads the version from the last segment, not from a date inside the dataset", () => {
    expect(versionOfObjectKey(`data/network/departures/2026-09-17/125/${V3}.jsonl`)).toBe(V3);
    expect(versionOfObjectKey(`data/network/stops/${V1}.jsonl`)).toBe(V1);
  });

  it("refuses anything that is not a versioned data object", () => {
    // A manifest is the pointer. An orphaned data object is recoverable; a missing pointer is not.
    expect(versionOfObjectKey("manifests/network/index/current.json")).toBeNull();
    expect(versionOfObjectKey("data/network/stops/v1.json")).toBeNull();
    expect(versionOfObjectKey("intelligence/observations/x.jsonl")).toBeNull();
    expect(versionOfObjectKey("data/network/stops/.jsonl")).toBeNull();
  });
});

describe("planning which national publishes to delete", () => {
  it("keeps the live version and the one it replaced, and removes the rest", () => {
    const inventory = [...publish(V1), ...publish(V2), ...publish(V3)];
    const plan = planNetworkPrune(inventory, { liveVersion: V3, previousVersion: V2 });

    expect(plan.keep.map((entry) => entry.version)).toEqual([V2, V3]);
    expect(plan.remove.map((entry) => entry.version)).toEqual([V1]);
    expect(plan.unattributed).toEqual([]);
  });

  /* The mistake that cannot be undone. */
  it("never removes the live version, whatever else it is told", () => {
    const inventory = [...publish(V1), ...publish(V2), ...publish(V3)];
    for (const live of [V1, V2, V3]) {
      const plan = planNetworkPrune(inventory, {
        liveVersion: live,
        previousVersion: null,
        keepVersions: 1,
      });
      expect(plan.remove.map((entry) => entry.version)).not.toContain(live);
      expect(plan.keep.map((entry) => entry.version)).toContain(live);
      expect(keysToRemove(inventory, plan).every((key) => !key.includes(live))).toBe(true);
    }
  });

  it("keeps the rollback target even when it is not the newest after the live one", () => {
    const inventory = [...publish(V1), ...publish(V2), ...publish(V3)];
    // Rolled back: the live publish is the older one and it replaced V1, not V2.
    const plan = planNetworkPrune(inventory, { liveVersion: V2, previousVersion: V1 });
    expect(plan.keep.map((entry) => entry.version).sort()).toEqual([V1, V2]);
    expect(plan.remove.map((entry) => entry.version)).toEqual([V3]);
  });

  it("keeps the live version even when the inventory does not contain it", () => {
    // A bucket in a state nobody expected. The runner refuses on this; the planner must not be
    // the thing that quietly drops it.
    const inventory = [...publish(V1), ...publish(V2)];
    const plan = planNetworkPrune(inventory, { liveVersion: V3, previousVersion: null });
    expect(plan.liveVersion).toBe(V3);
    expect(plan.remove.map((entry) => entry.version)).not.toContain(V3);
  });

  it("never proposes a manifest for deletion", () => {
    const inventory = [
      ...publish(V1),
      ...publish(V3),
      object("manifests/network/index/current.json", 400),
      object("manifests/network/stops/current.json", 400),
    ];
    const plan = planNetworkPrune(inventory, { liveVersion: V3, previousVersion: null });
    expect(plan.unattributed).toEqual([
      "manifests/network/index/current.json",
      "manifests/network/stops/current.json",
    ]);
    expect(keysToRemove(inventory, plan).some((key) => key.startsWith("manifests/"))).toBe(false);
  });

  it("reports the bytes it would reclaim, before and after", () => {
    const inventory = [...publish(V1, 5_000), ...publish(V2, 5_000), ...publish(V3, 5_000)];
    const plan = planNetworkPrune(inventory, { liveVersion: V3, previousVersion: V2 });

    // Each publish: one 20,000-byte index plus four 5,000-byte objects.
    expect(plan.bytesBefore).toBe(3 * (20_000 + 4 * 5_000));
    expect(plan.bytesAfter).toBe(2 * (20_000 + 4 * 5_000));
    expect(plan.objectsBefore).toBe(15);
    expect(plan.objectsAfter).toBe(10);
  });

  it("removes every object of a superseded version and nothing else", () => {
    const inventory = [...publish(V1), ...publish(V2), ...publish(V3)];
    const plan = planNetworkPrune(inventory, { liveVersion: V3, previousVersion: V2 });
    const doomed = keysToRemove(inventory, plan);

    expect(doomed).toHaveLength(5);
    expect(doomed.every((key) => key.includes(V1))).toBe(true);
    expect(doomed.some((key) => key.includes(V2) || key.includes(V3))).toBe(false);
  });

  it("does nothing when only the live publish is there", () => {
    const inventory = publish(V3);
    const plan = planNetworkPrune(inventory, { liveVersion: V3, previousVersion: null });
    expect(plan.remove).toEqual([]);
    expect(plan.bytesAfter).toBe(plan.bytesBefore);
  });

  it("widens the window when asked, newest first", () => {
    const inventory = [...publish(V1), ...publish(V2), ...publish(V3)];
    const plan = planNetworkPrune(inventory, {
      liveVersion: V3,
      previousVersion: null,
      keepVersions: 2,
    });
    // V2 is newer than V1, so it is the one the spare slot goes to.
    expect(plan.keep.map((entry) => entry.version)).toEqual([V2, V3]);
    expect(plan.remove.map((entry) => entry.version)).toEqual([V1]);
  });
});
