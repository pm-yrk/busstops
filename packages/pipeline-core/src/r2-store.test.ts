import { describe, expect, it } from "vitest";
import { R2ObjectStore } from "./r2-store.js";

/**
 * What the object store treats as final.
 *
 * A national publish writes thousands of objects, and being told to slow down or briefly refused
 * is an expected part of that conversation rather than a failure. A build lost 376 shards and
 * then its own rollback to a run of 503s, having spent three quarters of an hour producing them,
 * because only 429 was retried.
 */

function storeWith(statuses: number[], sleeps: number[] = []) {
  const attempts: string[] = [];
  const remaining = [...statuses];
  const store = new R2ObjectStore({
    accountId: "acct",
    bucket: "bucket",
    apiToken: "token",
    maxRateLimitRetries: 4,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      attempts.push(String(init?.method ?? "GET"));
      const status = remaining.length > 1 ? remaining.shift()! : remaining[0]!;
      void url;
      return new Response(status === 200 ? "{}" : "busy", { status });
    }) as unknown as typeof fetch,
  });
  return { store, attempts, sleeps };
}

describe("R2ObjectStore retries", () => {
  for (const status of [429, 502, 503, 504]) {
    it(`waits out a ${status} rather than giving up on the object`, async () => {
      const { store, attempts } = storeWith([status, status, 200]);
      await store.put("data/network/stops-tile/103_-1/v1.jsonl", "{}");
      expect(attempts.length).toBe(3);
    });
  }

  it("gives up after the configured number of attempts rather than looping", async () => {
    const { store, attempts } = storeWith([503]);
    await expect(store.put("data/x/v1.jsonl", "{}")).rejects.toThrow(/503/);
    // The first try plus the configured retries, and no more.
    expect(attempts.length).toBe(5);
  });

  it("answers a permanent refusal at once", async () => {
    // 413 means the body is too large and will be too large again. Retrying is only slower, and
    // it would hide the real fix, which is to write a smaller shard.
    const { store, attempts } = storeWith([413]);
    await expect(store.put("data/x/v1.jsonl", "{}")).rejects.toThrow(/413/);
    expect(attempts.length).toBe(1);
  });

  it("treats a missing object as absent rather than as an error", async () => {
    const { store } = storeWith([404]);
    expect(await store.get("data/x/v1.jsonl")).toBeNull();
  });
});
