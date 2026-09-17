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

/*
 * Listing the whole bucket, which is what the retention job believes it is doing.
 *
 * It asked for one page of a thousand and returned it as the answer. A national publish writes
 * several thousand objects, so the one job whose purpose is to keep storage inside the free tier
 * was pruning and reporting an inventory from the first thousand keys — and a short list looks
 * exactly like a complete one.
 */
describe("R2ObjectStore listing", () => {
  /** A bucket of `total` objects, served a page at a time with a cursor, counting the requests. */
  function bucketOf(total: number, options: { truncatedFlag?: boolean } = {}) {
    const urls: string[] = [];
    const store = new R2ObjectStore({
      accountId: "acct",
      bucket: "bucket",
      apiToken: "token",
      sleep: async () => {},
      fetchImpl: (async (url: string | URL) => {
        const parsed = new URL(String(url));
        urls.push(String(url));
        const from = Number(parsed.searchParams.get("cursor") ?? "0");
        const perPage = Number(parsed.searchParams.get("per_page") ?? "1000");
        const to = Math.min(total, from + perPage);
        const result = [];
        for (let index = from; index < to; index += 1) {
          result.push({
            key: `data/network/departures/${String(index).padStart(6, "0")}.jsonl`,
            size: 1000,
            uploaded: "2026-09-17T00:00:00.000Z",
          });
        }
        const more = to < total;
        return new Response(
          JSON.stringify({
            result,
            result_info: {
              cursor: more ? String(to) : "",
              ...(options.truncatedFlag === true ? { is_truncated: more } : {}),
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    return { store, urls };
  }

  it("returns every object in a bucket larger than one page", async () => {
    // 3,618 is the object count a real national publish reported; the page is a thousand.
    const { store, urls } = bucketOf(3_618);
    const objects = await store.listDetailed("data/");
    expect(objects).toHaveLength(3_618);
    expect(urls).toHaveLength(4);
    // In key order, and every one of them distinct: a repeated page would also reach the count.
    expect(new Set(objects.map((object) => object.key)).size).toBe(3_618);
    expect(objects[0]!.key).toContain("000000");
    expect(objects[3_617]!.key).toContain("003617");
  });

  it("stops at the end rather than following an empty cursor forever", async () => {
    const { store, urls } = bucketOf(500);
    expect(await store.listDetailed("data/")).toHaveLength(500);
    expect(urls).toHaveLength(1);
  });

  it("honours is_truncated where the API gives it", async () => {
    const { store } = bucketOf(2_500, { truncatedFlag: true });
    expect(await store.listDetailed("data/")).toHaveLength(2_500);
  });

  /*
   * A cursor that never ends must not spin, and must not quietly return what it has. A caller
   * that asked for the whole bucket and is handed part of it is the bug this replaces.
   */
  it("refuses rather than returning a partial listing when the cursor never ends", async () => {
    const store = new R2ObjectStore({
      accountId: "acct",
      bucket: "bucket",
      apiToken: "token",
      sleep: async () => {},
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            result: [{ key: "data/x.jsonl", size: 1, uploaded: "2026-09-17T00:00:00.000Z" }],
            result_info: { cursor: "always-more" },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    await expect(store.listDetailed("data/")).rejects.toThrow(/did not end after/);
  });

  it("carries the failure rather than an empty bucket when a page cannot be read", async () => {
    const store = new R2ObjectStore({
      accountId: "acct",
      bucket: "bucket",
      apiToken: "token",
      maxRateLimitRetries: 0,
      sleep: async () => {},
      fetchImpl: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
    });
    await expect(store.listDetailed("data/")).rejects.toThrow(/R2 list failed/);
  });
});
