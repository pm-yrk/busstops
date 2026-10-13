import { describe, expect, it } from "vitest";
import { InMemoryObjectStore, objectKeyFor, type ObjectStore } from "@busstops/pipeline-core";
import {
  departureBucketFor,
  departureShardDataset,
  encodeDepartureShard,
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

/** Publishes exactly as the pipeline does: one object per bucket per service date, encoded. */
async function publishShard(
  store: ObjectStore,
  rows: DepartureRow[],
  serviceDate = SERVICE_DATE,
  atcoCode = ATCO,
): Promise<string> {
  const dataset = departureShardDataset(serviceDate, departureBucketFor(atcoCode));
  await store.put(objectKeyFor(dataset, VERSION), encodeDepartureShard(serviceDate, rows));
  return dataset;
}

describe("reading the departures due at a stop", () => {
  it("returns this stop's rows in time order and leaves its neighbours alone", async () => {
    const store = new InMemoryObjectStore();
    await publishShard(store, [
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

  /*
   * A board is not a day. A journey that began at 23:40 yesterday and calls here at 00:20 is
   * published under yesterday's service date, so a board just after midnight has to read both —
   * which is now two objects rather than two windows of one.
   */
  it("reads both service dates when a board sits either side of midnight", async () => {
    const store = new InMemoryObjectStore();
    await publishShard(store, [row(ATCO, "2026-09-18T00:20:00Z", "36")], "2026-09-17");
    await publishShard(store, [row(ATCO, "2026-09-18T00:40:00Z", "37")], "2026-09-18");

    const reader = new DepartureReader(store);
    const result = await reader.forStop(
      ATCO,
      ["2026-09-17", "2026-09-18"],
      at("2026-09-18T00:00:00Z"),
      at("2026-09-18T01:30:00Z"),
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
  it("treats a shard that was never written as nothing scheduled, not a failure", async () => {
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
    expect(result.shardsMissing).toBe(1);
  });

  /** And a stop that is in no shard is the same ordinary answer, not a missing object. */
  it("treats a stop absent from a shard that exists as nothing scheduled", async () => {
    const store = new InMemoryObjectStore();
    await publishShard(store, [row("1800SB99999", "2026-09-17T09:05:00Z", "17")]);

    const reader = new DepartureReader(store);
    const result = await reader.forStop(
      ATCO,
      [SERVICE_DATE],
      at("2026-09-17T09:00:00Z"),
      at("2026-09-17T10:30:00Z"),
      VERSION,
    );
    expect(result.rows).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.shardsRead).toBe(1);
  });

  it("reports a shard it cannot read rather than returning an empty board", async () => {
    const store = new InMemoryObjectStore();
    const dataset = await publishShard(store, [row(ATCO, "2026-09-17T09:12:00Z", "42")]);
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
    const dataset = departureShardDataset(SERVICE_DATE, departureBucketFor(ATCO));
    await store.put(objectKeyFor(dataset, VERSION), "{ this is not json\n[]");

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
   * The measurement that matters, and the reason the shard is grouped by stop.
   *
   * A bucket now holds a whole service date — about 28,700 calls at England's real density, where
   * the tile this replaces was 294,922,754 bytes for one viewport. The shard stays close to a
   * megabyte, and a board pays for the line its own stop is on rather than for the shard.
   */
  it("reads a realistic dense shard without approaching the isolate's limits", async () => {
    const store = new InMemoryObjectStore();
    const dense: DepartureRow[] = [];
    for (let index = 0; index < 28_700; index += 1) {
      const minute = index % 900;
      dense.push(
        row(
          index % 300 === 0 ? ATCO : `1800SB${String(index % 640).padStart(5, "0")}`,
          `2026-09-17T${String(6 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`,
          String(30 + (index % 90)),
        ),
      );
    }
    await publishShard(store, dense);

    const reader = new DepartureReader(store);
    const result = await reader.forStop(
      ATCO,
      [SERVICE_DATE],
      at("2026-09-17T06:00:00Z"),
      at("2026-09-17T21:00:00Z"),
      VERSION,
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
    // A whole service date for a bucket, at national density, in a little over a megabyte.
    expect(reader.cachedChars).toBeLessThan(2_000_000);
  });

  /*
   * And the claim that goes with it: reading one stop reads one line. Another stop's line being
   * unparseable cannot affect this board, because this board never looks at it — which is exactly
   * what "does not JSON.parse the shard" means in behaviour rather than in timing.
   */
  it("parses the line its own stop is on and not the rest of the shard", async () => {
    const store = new InMemoryObjectStore();
    const dataset = departureShardDataset(SERVICE_DATE, departureBucketFor(ATCO));
    const shard = encodeDepartureShard(SERVICE_DATE, [
      row(ATCO, "2026-09-17T09:12:00Z", "42"),
      row("1800SB99999", "2026-09-17T09:05:00Z", "17"),
    ]);
    const corrupted = shard.replace(/\n\["1800SB99999",.*/, '\n["1800SB99999",{ not json');
    expect(corrupted).not.toBe(shard);
    await store.put(objectKeyFor(dataset, VERSION), corrupted);

    const reader = new DepartureReader(store);
    const result = await reader.forStop(
      ATCO,
      [SERVICE_DATE],
      at("2026-09-17T09:00:00Z"),
      at("2026-09-17T10:30:00Z"),
      VERSION,
    );
    expect(result.rows.map((r) => r.r)).toEqual(["42"]);
    expect(result.failures).toEqual([]);
  });

  it("holds a bounded working set however many shards are asked for", async () => {
    const store = new InMemoryObjectStore();
    const reader = new DepartureReader(store, 0);
    for (let day = 1; day <= 40; day += 1) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      await publishShard(
        store,
        Array.from({ length: 2_000 }, (_, i) =>
          row(ATCO, `${date}T09:${String(i % 60).padStart(2, "0")}:00Z`, String(i % 90)),
        ),
        date,
      );
      await reader.forStop(ATCO, [date], at(`${date}T09:00:00Z`), at(`${date}T10:00:00Z`), VERSION);
    }
    expect(reader.cachedChars).toBeLessThan(6 * 1024 * 1024);
  });
});
