import { describe, expect, it } from "vitest";
import { MAX_CACHED_TEXT_CHARS, NetworkReader } from "./network-reader.js";
import type { ObjectStore } from "@busstops/pipeline-core";

/**
 * The reads that filter could not cache their records, so they reused nothing: every dying request
 * in runs 38215204465 and 38245359800 reported `residentChars=0` with every singleton at zero, at
 * request #88 of an isolate, and every board re-fetched and re-decoded 4.7 MiB of services.
 *
 * Caching the *body* is safe where caching the records is not, and these hold both halves of that:
 * the second read of an object costs no round trip, and a second read asking a different question
 * still gets its own answer rather than the first one's.
 */
function countingStore(objects: Record<string, string>): ObjectStore & { gets: string[] } {
  const gets: string[] = [];
  return {
    async get(key: string) {
      gets.push(key);
      return objects[key] ?? null;
    },
    async put() {},
    async list() {
      return [];
    },
    async delete() {},
    gets,
  } as unknown as ObjectStore & { gets: string[] };
}

describe("the text cache behind a filtered read", () => {
  /*
   * The hazard the original comment names: an entry holding one request's hundred stops would
   * answer the next request's question with a tile missing almost all of it. Caching text cannot
   * do that, and this is the test that would catch it if it ever could.
   */
  it("gives a different filter its own answer from the same cached body", async () => {
    const body = [
      JSON.stringify({ id: "a", name: "Alpha" }),
      JSON.stringify({ id: "b", name: "Beta" }),
      JSON.stringify({ id: "c", name: "Gamma" }),
    ].join("\n");
    const store = countingStore({ "data/thing/v1.jsonl": body });
    const reader = new NetworkReader(store);

    const onlyAlpha = await reader.testReadShard<{ id: string }>("thing", "v1", (raw, s, e) =>
      raw.slice(s, e).includes("Alpha"),
    );
    const onlyBeta = await reader.testReadShard<{ id: string }>("thing", "v1", (raw, s, e) =>
      raw.slice(s, e).includes("Beta"),
    );

    expect(onlyAlpha.records.map((r) => r.id)).toEqual(["a"]);
    // Not ["a"]: the second question gets its own answer, not the first one's.
    expect(onlyBeta.records.map((r) => r.id)).toEqual(["b"]);
  });

  it("fetches the object once however many filtered reads ask for it", async () => {
    const body = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ id: `s${i}`, name: `Stop ${i}` }),
    ).join("\n");
    const store = countingStore({ "data/thing/v1.jsonl": body });
    const reader = new NetworkReader(store);

    for (let i = 0; i < 5; i += 1) {
      await reader.testReadShard<{ id: string }>("thing", "v1", (raw, s, e) =>
        raw.slice(s, e).includes(`"s${i}"`),
      );
    }

    expect(store.gets, "five filtered reads of one object are one round trip").toHaveLength(1);
    expect(reader.cachedTextCount).toBe(1);
  });

  /* A cache that grows without bound is the next outage, not a fix for this one. */
  it("stays inside its character budget", async () => {
    const big = `${"x".repeat(5 * 1024 * 1024)}`;
    const objects: Record<string, string> = {};
    for (let i = 0; i < 6; i += 1) {
      objects[`data/thing${i}/v1.jsonl`] = `${JSON.stringify({ id: `i${i}`, pad: big })}`;
    }
    const reader = new NetworkReader(countingStore(objects));

    for (let i = 0; i < 6; i += 1) {
      await reader.testReadShard<{ id: string }>(`thing${i}`, "v1", () => false);
    }

    expect(reader.cachedTextCharCount).toBeLessThanOrEqual(MAX_CACHED_TEXT_CHARS);
    expect(reader.cachedTextCount).toBeLessThan(6);
  });
});
