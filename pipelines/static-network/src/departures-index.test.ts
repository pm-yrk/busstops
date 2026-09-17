import { describe, expect, it } from "vitest";
import {
  DEPARTURE_BUCKETS,
  DEPARTURE_WINDOWS,
  departureBucketFor,
  departureShardDataset,
  departureWindowFor,
  departureWindowsBetween,
  departureWriteBudget,
  patternTripsDataset,
  type DepartureRow,
} from "./departures-index.js";

/** Real ATCO codes, from the cities the deployed probe samples. */
const REAL_STOPS = [
  "450010001", // Leeds
  "1800SB04561", // Manchester
  "43000217802", // Birmingham
  "0100BRP90092", // Bristol
  "3290YYA00214", // York
  "490000173C", // London
];

describe("the departure index layout", () => {
  it("puts a stop in the same bucket every time, and the bucket is in range", () => {
    for (const atcoCode of REAL_STOPS) {
      const bucket = departureBucketFor(atcoCode);
      expect(bucket).toBe(departureBucketFor(atcoCode));
      expect(Number.isInteger(bucket)).toBe(true);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(DEPARTURE_BUCKETS);
    }
  });

  /*
   * The property the half-degree tile did not have. Density decided tile size before, so the same
   * grid held four villages or the whole of Birmingham; a hash spreads rows evenly whatever the
   * country looks like, which is the only reason a byte budget per shard means anything.
   */
  it("spreads a realistic national stop set evenly across its buckets", () => {
    const counts = new Array<number>(DEPARTURE_BUCKETS).fill(0);
    // ATCO codes are structured — area prefix then a serial — so a hash that only looked at the
    // tail, or only at the head, would clump. These are shaped like the real ones.
    for (let area = 0; area < 40; area += 1) {
      for (let serial = 0; serial < 500; serial += 1) {
        const atcoCode = `${String(1800 + area)}SB${String(serial).padStart(5, "0")}`;
        counts[departureBucketFor(atcoCode)]! += 1;
      }
    }

    const total = counts.reduce((sum, count) => sum + count, 0);
    const mean = total / DEPARTURE_BUCKETS;
    expect(total).toBe(20_000);
    // No bucket may be more than twice the mean: the failure being guarded against is one shard
    // holding a city's worth of rows, not perfect balance.
    expect(Math.max(...counts)).toBeLessThan(mean * 2);
    expect(Math.min(...counts)).toBeGreaterThan(0);
  });

  it("numbers windows from the service date and keeps the small hours of the next morning", () => {
    const date = "2026-09-17";
    const at = (iso: string) => Date.parse(iso) / 1000;

    expect(departureWindowFor(at("2026-09-17T00:10:00Z"), date)).toBe(0);
    expect(departureWindowFor(at("2026-09-17T09:00:00Z"), date)).toBe(2);
    expect(departureWindowFor(at("2026-09-17T23:59:00Z"), date)).toBe(5);
    /*
     * A bus leaving at 00:10 on the 18th belongs to the 17th's service day and must not fold back
     * onto window 0 — that would put a Saturday-night bus on Saturday breakfast's board.
     */
    expect(departureWindowFor(at("2026-09-18T00:10:00Z"), date)).toBe(6);
  });

  it("never addresses a window that was not written", () => {
    const date = "2026-09-17";
    // Far beyond the 48-hour ingest bound, and far before the service date.
    expect(departureWindowFor(Date.parse("2026-09-30T00:00:00Z") / 1000, date)).toBe(
      DEPARTURE_WINDOWS - 1,
    );
    expect(departureWindowFor(Date.parse("2026-09-01T00:00:00Z") / 1000, date)).toBe(0);
  });

  it("reads both shards when a board's window straddles a boundary", () => {
    const date = "2026-09-17";
    const from = Date.parse("2026-09-17T07:50:00Z") / 1000;
    const to = Date.parse("2026-09-17T09:20:00Z") / 1000;
    // 07:50 is window 1, 09:20 is window 2: a 90-minute board at ten to eight needs both.
    expect(departureWindowsBetween(from, to, date)).toEqual([1, 2]);
  });

  it("names shards the pipeline and the edge can both construct", () => {
    expect(departureShardDataset("2026-09-17", 42, 2)).toBe("network/departures/2026-09-17/2/42");
    expect(patternTripsDataset("2026-09-17", "430_-13", 2)).toBe(
      "network/pattern-trips/2026-09-17/2/430_-13",
    );
  });
});

describe("what this layout costs", () => {
  /*
   * Sharding finely is not free: every shard is a Class A operation and R2 gives a million a
   * month. A layout that reads beautifully and cannot be afforded is not a layout.
   */
  it("fits a daily national build inside R2's free write allowance", () => {
    const budget = departureWriteBudget(2);
    expect(budget.objectsPerServiceDate).toBe(DEPARTURE_BUCKETS * DEPARTURE_WINDOWS);
    expect(budget.objectsPerBuild).toBe(7_168);
    expect(budget.classAOperationsPerMonth).toBe(215_040);
    expect(budget.withinAllowance).toBe(true);
  });

  it("says so when a shard count would not fit", () => {
    // Sixteen times the buckets, rebuilt every hour: the shape of a change worth refusing.
    const budget = departureWriteBudget(2, 720, DEPARTURE_BUCKETS * 16);
    expect(budget.withinAllowance).toBe(false);
  });

  /*
   * The size claim the whole redesign rests on. A journey measured 10,313 bytes because it
   * carried 45 calls at 220 bytes each — a UUID and two ISO timestamps per call. A board needs
   * the row for its own stop, which is this.
   */
  it("keeps a departure row small enough that a shard is not a tile", () => {
    const row: DepartureRow = {
      s: "450010001",
      t: 1_789_657_200,
      r: "36",
      d: "Ripon Market Place",
      j: "VJ12345678901234",
      p: "00000000-0000-5000-8000-000000000002",
      k: 1,
    };
    const bytes = JSON.stringify(row).length;
    expect(bytes).toBeLessThan(140);

    /*
     * And the shard it lands in stays far inside what an isolate reads comfortably. 13.6 million
     * calls a day across 512 buckets and 7 windows is about 3,800 rows in a shard; the tile this
     * replaces held 294,922,754 bytes.
     */
    const rowsPerShard = 13_600_000 / (DEPARTURE_BUCKETS * DEPARTURE_WINDOWS);
    expect(rowsPerShard * bytes).toBeLessThan(1_000_000);
  });
});
