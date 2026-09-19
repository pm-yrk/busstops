import { describe, expect, it } from "vitest";
import { ArtifactStore, InMemoryObjectStore } from "@busstops/pipeline-core";
import { readClosedWindow, SETTLE_SECONDS } from "./closed-window.js";

/**
 * The gate that made the intelligence pipeline structurally unable to publish.
 *
 * A bucket is five minutes long and stays open for ten more so late data can revise it; only
 * closed buckets are published. The workflow collected four minutes of observations and batched
 * them immediately, so every bucket was open, nothing published, and every run rolled back.
 * These assert the correction: the batch takes the observations whose buckets have settled, and
 * says plainly when none have.
 */

const NOW = new Date("2026-09-19T14:00:00.000Z");

function observation(id: string, observedAt: string) {
  return {
    id,
    vehicleRef: `v-${id}`,
    observedAt,
    coordinate: { lat: 53.8, lon: -1.5 },
  };
}

async function storeWith(versions: Record<string, Array<{ id: string; at: string }>>) {
  const store = new InMemoryObjectStore();
  for (const [version, rows] of Object.entries(versions)) {
    const body = rows.map((r) => JSON.stringify(observation(r.id, r.at))).join("\n");
    await store.put(`data/intelligence/observations/${version}.jsonl`, body);
  }
  return new ArtifactStore(store);
}

describe("the settled window the batch aggregates", () => {
  it("settles fifteen minutes after a bucket starts", () => {
    // Five minutes of bucket plus ten of lateness grace. Both are published defaults.
    expect(SETTLE_SECONDS).toBe(900);
  });

  it("takes observations old enough for their bucket to have closed", async () => {
    const artifacts = await storeWith({
      "2026-09-19T13-30-00-000Z": [
        { id: "old-1", at: "2026-09-19T13:30:00.000Z" },
        { id: "old-2", at: "2026-09-19T13:31:00.000Z" },
      ],
    });

    const window = await readClosedWindow(artifacts, "intelligence/observations", NOW);
    expect(window.recordsInClosedWindow).toBe(2);
    expect(window.earliestObservedAt).toBe("2026-09-19T13:30:00.000Z");
    expect(window.latestObservedAt).toBe("2026-09-19T13:31:00.000Z");
  });

  it("refuses observations whose bucket is still open", async () => {
    // Five minutes old: inside the bucket's own life, let alone its grace.
    const artifacts = await storeWith({
      "2026-09-19T13-55-00-000Z": [{ id: "fresh", at: "2026-09-19T13:55:00.000Z" }],
    });

    const window = await readClosedWindow(artifacts, "intelligence/observations", NOW);
    expect(window.recordsRead).toBe(1);
    expect(window.recordsInClosedWindow).toBe(0);
    expect(window.notes.join(" ")).toMatch(/none is older|newer than the settle horizon/i);
  });

  it("reproduces the run-67 shape: collect now, batch now, publish nothing", async () => {
    /*
     * The workflow's actual sequence — a few minutes of observations, batched seconds later.
     * Every one of them is newer than the horizon, which is exactly why every run rolled back.
     */
    const artifacts = await storeWith({
      "2026-09-19T13-58-00-000Z": [
        { id: "a", at: "2026-09-19T13:56:00.000Z" },
        { id: "b", at: "2026-09-19T13:57:30.000Z" },
        { id: "c", at: "2026-09-19T13:59:00.000Z" },
      ],
    });

    const window = await readClosedWindow(artifacts, "intelligence/observations", NOW);
    expect(window.recordsInClosedWindow).toBe(0);
  });

  it("reaches back through versions, newest first, and reports what it opened", async () => {
    const artifacts = await storeWith({
      "2026-09-19T13-58-00-000Z": [{ id: "fresh", at: "2026-09-19T13:57:00.000Z" }],
      "2026-09-19T13-40-00-000Z": [{ id: "settled-1", at: "2026-09-19T13:39:00.000Z" }],
      "2026-09-19T13-20-00-000Z": [{ id: "settled-2", at: "2026-09-19T13:19:00.000Z" }],
    });

    const window = await readClosedWindow(artifacts, "intelligence/observations", NOW);
    expect(window.versionsAvailable).toBe(3);
    expect(window.versionsRead).toBe(3);
    expect(window.recordsRead).toBe(3);
    // The fresh one is read and discarded; the two settled ones are kept.
    expect(window.recordsInClosedWindow).toBe(2);
  });

  it("stops at the version cap rather than reading two days of traces", async () => {
    const versions: Record<string, Array<{ id: string; at: string }>> = {};
    for (let i = 0; i < 10; i += 1) {
      const minute = String(30 + i).padStart(2, "0");
      versions[`2026-09-19T13-${minute}-00-000Z`] = [
        { id: `x${String(i)}`, at: `2026-09-19T13:${minute}:00.000Z` },
      ];
    }
    const artifacts = await storeWith(versions);

    const window = await readClosedWindow(artifacts, "intelligence/observations", NOW, {
      maxVersions: 3,
    });
    expect(window.versionsRead).toBe(3);
    expect(window.notes.join(" ")).toMatch(/stopped after 3 versions/);
  });

  it("says nothing has settled when the bucket has only ever been collected into once", async () => {
    const artifacts = await storeWith({
      "2026-09-19T13-59-00-000Z": [{ id: "only", at: "2026-09-19T13:59:00.000Z" }],
    });
    const window = await readClosedWindow(artifacts, "intelligence/observations", NOW);
    expect(window.recordsInClosedWindow).toBe(0);
    expect(window.notes.length).toBeGreaterThan(0);
  });
});
