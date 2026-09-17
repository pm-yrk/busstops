import { describe, expect, it } from "vitest";
import { InMemoryObjectStore, objectKeyFor, type ObjectStore } from "@busstops/pipeline-core";
import {
  departureBucketFor,
  departureShardDataset,
  type DepartureRow,
} from "@busstops/pipeline-static-network";
import { DepartureReader } from "./departure-reader.js";

const VERSION = "2026-09-17T05:35:55.601Z";
const SERVICE_DATE = "2026-09-17";
/** Manchester Metropolitan University, one of the stops the deployed probe samples. */
const ATCO = "1800SB04561";

const at = (iso: string) => Date.parse(iso) / 1000;

function row(atcoCode: string, iso: string, route: string): DepartureRow {
  return {
    s: atcoCode,
    t: at(iso),
    r: route,
    d: "Piccadilly Gardens",
    j: `VJ${route}${iso}`,
    p: "00000000-0000-5000-8000-000000000002",
    k: 1,
  };
}

async function publishShard(
  store: ObjectStore,
  window: number,
  rows: DepartureRow[],
  atcoCode = ATCO,
): Promise<string> {
  const dataset = departureShardDataset(SERVICE_DATE, departureBucketFor(atcoCode), window);
  await store.put(objectKeyFor(dataset, VERSION), rows.map((r) => JSON.stringify(r)).join("\n"));
  return dataset;
}

describe("reading the departures due at a stop", () => {
  it("returns this stop's rows in time order and leaves its neighbours alone", async () => {
    const store = new InMemoryObjectStore();
    await publishShard(store, 2, [
      row(ATCO, "2026-09-17T09:12:00Z", "42"),
      // A different stop that hashes into the same bucket is in the same shard by design.
      row("1800SB99999", "2026-09-17T09:05:00Z", "17"),
      row(ATCO, "2026-09-17T09:03:00Z", "142"),
    ]);

    const reader = new DepartureReader(store);
    const result = await reader.forStop(
      ATCO,
      [SERVICE_DATE],
      at("2026-09-17T09:00:00Z"),
      at("2026-09-17T10:30:00Z"),
      VERSION,
    );

    expect(result.rows.map((r) => r.r)).toEqual(["142", "42"]);
    expect(result.failures).toEqual([]);
    expect(result.shardsRead).toBe(1);
  });

  it("reads both shards when the board's window straddles a boundary", async () => {
    const store = new InMemoryObjectStore();
    await publishShard(store, 1, [row(ATCO, "2026-09-17T07:55:00Z", "36")]);
    await publishShard(store, 2, [row(ATCO, "2026-09-17T08:20:00Z", "37")]);

    const reader = new DepartureReader(store);
    const result = await reader.forStop(
      ATCO,
      [SERVICE_DATE],
      at("2026-09-17T07:50:00Z"),
      at("2026-09-17T09:20:00Z"),
      VERSION,
    );
    expect(result.rows.map((r) => r.r)).toEqual(["36", "37"]);
    expect(result.shardsRead).toBe(2);
  });

  /*
   * The two answers that used to be one. Before this, both of these produced an empty array and a
   * response saying `normal`, so a stop with nothing due and a stop whose timetable could not be
   * read were indistinguishable — to a passenger and to every check we had.
   */
  it("treats a shard that was never written as a quiet window, not a failure", async () => {
    const reader = new DepartureReader(new InMemoryObjectStore());
    const result = await reader.forStop(
      ATCO,
      [SERVICE_DATE],
      at("2026-09-17T03:00:00Z"),
      at("2026-09-17T04:30:00Z"),
      VERSION,
    );
    expect(result.rows).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.shardsMissing).toBeGreaterThan(0);
  });

  it("reports a shard it cannot read rather than returning an empty board", async () => {
    const store = new InMemoryObjectStore();
    const dataset = await publishShard(store, 2, [row(ATCO, "2026-09-17T09:12:00Z", "42")]);
    const broken: ObjectStore = {
      get: async (key) =>
        key.startsWith("data/") ? Promise.reject(new Error("R2 is unavailable")) : store.get(key),
      put: (key, value) => store.put(key, value),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
    };

    const reader = new DepartureReader(broken);
    const result = await reader.forStop(
      ATCO,
      [SERVICE_DATE],
      at("2026-09-17T09:00:00Z"),
      at("2026-09-17T10:30:00Z"),
      VERSION,
    );

    expect(result.rows).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.dataset).toBe(dataset);
    expect(result.failures[0]!.reason).toContain("R2 is unavailable");
  });

  it("reports a shard whose contents are not readable rather than skipping it", async () => {
    const store = new InMemoryObjectStore();
    const dataset = departureShardDataset(SERVICE_DATE, departureBucketFor(ATCO), 2);
    await store.put(objectKeyFor(dataset, VERSION), "{ this is not json");

    const reader = new DepartureReader(store);
    const result = await reader.forStop(
      ATCO,
      [SERVICE_DATE],
      at("2026-09-17T09:00:00Z"),
      at("2026-09-17T10:30:00Z"),
      VERSION,
    );
    expect(result.rows).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  /*
   * The measurement that matters. The tile this replaces was 294,922,754 bytes for one viewport;
   * a dense shard is the whole of a bucket's four-hour window and has to stay far inside what a
   * 128 MiB isolate reads comfortably.
   */
  it("reads a realistic dense shard without approaching the isolate's limits", async () => {
    const store = new InMemoryObjectStore();
    // 4,000 rows: a busy bucket-window, at the density England's real archive implies.
    const dense: DepartureRow[] = [];
    for (let index = 0; index < 4000; index += 1) {
      const minute = index % 240;
      dense.push(
        row(
          index % 50 === 0 ? ATCO : `1800SB${String(index).padStart(5, "0")}`,
          `2026-09-17T${String(8 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`,
          String(30 + (index % 90)),
        ),
      );
    }
    await publishShard(store, 2, dense);

    const reader = new DepartureReader(store);
    const result = await reader.forStop(
      ATCO,
      [SERVICE_DATE],
      at("2026-09-17T08:00:00Z"),
      at("2026-09-17T12:00:00Z"),
      VERSION,
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
    // Well under a megabyte for the densest shard in the country.
    expect(reader.cachedChars).toBeLessThan(1_000_000);
  });

  it("holds a bounded working set however many shards are asked for", async () => {
    const store = new InMemoryObjectStore();
    const reader = new DepartureReader(store, 0);
    for (let day = 1; day <= 40; day += 1) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      const dataset = departureShardDataset(date, departureBucketFor(ATCO), 2);
      await store.put(
        objectKeyFor(dataset, VERSION),
        Array.from({ length: 200 }, (_, i) =>
          JSON.stringify(row(ATCO, `2026-09-17T09:${String(i % 60).padStart(2, "0")}:00Z`, "1")),
        ).join("\n"),
      );
      await reader.forStop(ATCO, [date], at(`${date}T09:00:00Z`), at(`${date}T10:00:00Z`), VERSION);
    }
    expect(reader.cachedChars).toBeLessThan(8 * 1024 * 1024);
  });
});
