import { InMemoryObjectStore } from "@busstops/pipeline-core";
import { describe, expect, it } from "vitest";
import {
  earliestServiceDateToKeep,
  expiredDatedKeys,
  pruneExpiredServiceDates,
  staleVersionDatedKeys,
} from "./prune-service-dates.js";

const V = "2026-09-30T16:56:04.815Z";

describe("pruning service dates that have already happened", () => {
  it("keeps yesterday, because a bus that left at 23:50 is still running", () => {
    expect(earliestServiceDateToKeep(new Date("2026-10-01T09:00:00Z"))).toBe("2026-09-30");
  });

  it("names the dated keys that are now past, and only those", () => {
    const keys = [
      `data/network/departures/2026-09-28/125/${V}.jsonl`,
      `data/network/departures/2026-09-30/125/${V}.jsonl`,
      `data/network/departures/2026-10-01/125/${V}.jsonl`,
      `data/network/pattern-trips/2026-09-28/1/206_-1/${V}.jsonl`,
      `data/network/pattern-trips/2026-10-02/1/206_-1/${V}.jsonl`,
    ];
    expect(expiredDatedKeys(keys, "2026-09-30")).toEqual([
      `data/network/departures/2026-09-28/125/${V}.jsonl`,
      `data/network/pattern-trips/2026-09-28/1/206_-1/${V}.jsonl`,
    ]);
  });

  /*
   * The one outcome worse than keeping an object forever is deleting one because its name was not
   * understood. Nothing outside the two date-keyed families is ever a candidate.
   */
  it("never touches a key it cannot read a service date out of", () => {
    const keys = [
      "data/network/stops-tile/206_-1/" + V + ".jsonl",
      "data/network/index/" + V + ".jsonl",
      "data/network/departures/not-a-date/125/" + V + ".jsonl",
      "manifests/network/index.json",
    ];
    expect(expiredDatedKeys(keys, "2099-01-01")).toEqual([]);
  });

  it("deletes them from the store and reports which dates went", async () => {
    const store = new InMemoryObjectStore();
    await store.put(`data/network/departures/2026-09-28/1/${V}.jsonl`, "old");
    await store.put(`data/network/departures/2026-10-01/1/${V}.jsonl`, "today");
    await store.put(`data/network/pattern-trips/2026-09-28/1/t/${V}.jsonl`, "old");
    await store.put(`data/network/stops-tile/1/${V}.jsonl`, "not dated");

    const result = await pruneExpiredServiceDates(store, { keepFrom: "2026-09-30" });

    expect(result.keysDeleted).toBe(2);
    expect(result.staleVersionKeysDeleted).toBe(0);
    expect(result.datesDeleted).toEqual(["2026-09-28"]);
    expect(result.failed).toEqual([]);
    expect(await store.get(`data/network/departures/2026-10-01/1/${V}.jsonl`)).toBe("today");
    expect(await store.get(`data/network/stops-tile/1/${V}.jsonl`)).toBe("not dated");
    expect(await store.get(`data/network/departures/2026-09-28/1/${V}.jsonl`)).toBeNull();
  });

  it("reports a delete it could not do rather than losing the run over it", async () => {
    const store = new InMemoryObjectStore();
    await store.put(`data/network/departures/2026-09-28/1/${V}.jsonl`, "old");
    const failing = {
      ...store,
      list: (prefix: string) => store.list(prefix),
      get: (key: string) => store.get(key),
      put: (key: string, value: string) => store.put(key, value),
      delete: () => Promise.reject(new Error("storage said no")),
    };

    const result = await pruneExpiredServiceDates(failing, { keepFrom: "2026-09-30" });

    expect(result.keysDeleted).toBe(0);
    expect(result.failed).toEqual([
      { key: `data/network/departures/2026-09-28/1/${V}.jsonl`, reason: "storage said no" },
    ]);
  });
});

/*
 * The second leak, and the quieter one. Dated shards are written as plain objects rather than
 * published artifacts, so `prune-versions` — which works from manifests — has never seen them, and
 * every full rebuild left behind a complete second copy of every date at about 1.27 GB each.
 */
describe("pruning dated objects no version serves any more", () => {
  const OLD = "2026-09-19T03:55:05.251Z";

  it("names the copies left by a version that is gone", () => {
    const keys = [
      `data/network/departures/2026-10-01/125/${V}.jsonl`,
      `data/network/departures/2026-10-01/125/${OLD}.jsonl`,
      `data/network/pattern-trips/2026-10-01/1/t/${OLD}.jsonl`,
      `data/network/stops-tile/206_-1/${OLD}.jsonl`,
    ];
    expect(staleVersionDatedKeys(keys, [V])).toEqual([
      `data/network/departures/2026-10-01/125/${OLD}.jsonl`,
      `data/network/pattern-trips/2026-10-01/1/t/${OLD}.jsonl`,
    ]);
  });

  /*
   * The predecessor stays. It is what a rollback restores, and a rollback to an artifact with a map
   * and no departures is not a rollback.
   */
  it("keeps the version a rollback would restore", () => {
    const keys = [`data/network/departures/2026-10-01/125/${OLD}.jsonl`];
    expect(staleVersionDatedKeys(keys, [V, OLD])).toEqual([]);
  });

  it("deletes them alongside the past dates, and counts them apart", async () => {
    const store = new InMemoryObjectStore();
    await store.put(`data/network/departures/2026-09-28/1/${V}.jsonl`, "past date");
    await store.put(`data/network/departures/2026-10-01/1/${OLD}.jsonl`, "stale version");
    await store.put(`data/network/departures/2026-10-01/1/${V}.jsonl`, "live");

    const result = await pruneExpiredServiceDates(store, {
      keepFrom: "2026-09-30",
      keepVersions: [V],
    });

    expect(result.keysDeleted).toBe(2);
    expect(result.staleVersionKeysDeleted).toBe(1);
    expect(result.datesDeleted).toEqual(["2026-09-28"]);
    expect(await store.get(`data/network/departures/2026-10-01/1/${V}.jsonl`)).toBe("live");
  });

  it("leaves everything alone when it has not been told which versions are live", async () => {
    const store = new InMemoryObjectStore();
    await store.put(`data/network/departures/2026-10-01/1/${OLD}.jsonl`, "stale version");
    const result = await pruneExpiredServiceDates(store, { keepFrom: "2026-09-30" });
    expect(result.keysDeleted).toBe(0);
  });
});
