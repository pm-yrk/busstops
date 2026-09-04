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

  it("retries a request that never answered at all", async () => {
    /*
     * A timeout throws rather than returning a status, so it used to skip the retry entirely and
     * be final on the first attempt — while a 503 was patiently retried. A publish of 3,618
     * objects lost ten of them to "This operation was aborted", each on a small object, half an
     * hour into the run.
     */
    let attempts = 0;
    const store = new R2ObjectStore({
      accountId: "acct",
      bucket: "bucket",
      apiToken: "token",
      maxRateLimitRetries: 3,
      sleep: async () => {},
      fetchImpl: (async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("This operation was aborted");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await store.put("data/x/v1.jsonl", "{}");
    expect(attempts).toBe(3);
  });

  it("reports the reason when a request never answers at all", async () => {
    // Nothing to report a status for, so the error itself has to survive to the caller.
    let attempts = 0;
    const store = new R2ObjectStore({
      accountId: "acct",
      bucket: "bucket",
      apiToken: "token",
      maxRateLimitRetries: 2,
      sleep: async () => {},
      fetchImpl: (async () => {
        attempts += 1;
        throw new Error("This operation was aborted");
      }) as unknown as typeof fetch,
    });

    await expect(store.put("data/x/v1.jsonl", "{}")).rejects.toThrow(/aborted/);
    expect(attempts).toBe(3);
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
