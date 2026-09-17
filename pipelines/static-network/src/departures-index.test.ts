import { describe, expect, it } from "vitest";
import {
  DEPARTURE_BUCKETS,
  TRIP_WINDOWS,
  decodeDepartureShard,
  decodeDepartureShardForStop,
  departureBucketFor,
  departureShardDataset,
  departureWriteBudget,
  encodeDepartureShard,
  patternTripsDataset,
  tripWindowFor,
  tripWindowsFor,
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

  it("numbers trip windows from the service date and keeps the small hours of the next morning", () => {
    const date = "2026-09-17";
    const at = (iso: string) => Date.parse(iso) / 1000;

    expect(tripWindowFor(at("2026-09-17T00:10:00Z"), date)).toBe(0);
    expect(tripWindowFor(at("2026-09-17T09:00:00Z"), date)).toBe(1);
    expect(tripWindowFor(at("2026-09-17T23:59:00Z"), date)).toBe(2);
    /*
     * A bus leaving at 00:10 on the 18th belongs to the 17th's service day and must not fold back
     * onto window 0 — that would put a Saturday-night bus on Saturday breakfast's board.
     */
    expect(tripWindowFor(at("2026-09-18T00:10:00Z"), date)).toBe(3);
  });

  it("never addresses a trip window that was not written", () => {
    const date = "2026-09-17";
    // Far beyond the 48-hour ingest bound, and far before the service date.
    expect(tripWindowFor(Date.parse("2026-09-30T00:00:00Z") / 1000, date)).toBe(TRIP_WINDOWS - 1);
    expect(tripWindowFor(Date.parse("2026-09-01T00:00:00Z") / 1000, date)).toBe(0);
  });

  it("reads the window before a plan as well, because a bus that left earlier is still running", () => {
    const date = "2026-09-17";
    const from = Date.parse("2026-09-17T09:00:00Z") / 1000;
    const to = Date.parse("2026-09-17T10:30:00Z") / 1000;
    // 09:00 and 10:30 are both window 1, and the trips running through them may have started in 0.
    expect(tripWindowsFor(from, to, date)).toEqual([0, 1]);
  });

  it("names shards the pipeline and the edge can both construct", () => {
    expect(departureShardDataset("2026-09-17", 42)).toBe("network/departures/2026-09-17/42");
    expect(patternTripsDataset("2026-09-17", "430_-13", 2)).toBe(
      "network/pattern-trips/2026-09-17/2/430_-13",
    );
  });
});

/*
 * The shard format. Two claims are being held here and they are different: that a row survives the
 * round trip unchanged, and that reading one stop does not cost the shard.
 */
describe("the shard format", () => {
  const SERVICE_DATE = "2026-09-17";
  const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  const rows: DepartureRow[] = [
    {
      s: "450010001",
      t: at("2026-09-17T08:05:00Z"),
      r: "36",
      d: "Ripon Market Place",
      j: "VJ0001",
      p: "00000000-0000-5000-8000-000000000002",
      k: 1,
    },
    {
      s: "450010001",
      t: at("2026-09-17T08:20:00Z"),
      r: "36",
      d: "Ripon Market Place",
      j: "VJ0002",
      p: "00000000-0000-5000-8000-000000000002",
    },
    {
      s: "3290YYA00214",
      t: at("2026-09-18T00:40:00Z"),
      r: "X84",
      d: "York Rail Station",
      j: "VJ0003",
      p: "00000000-0000-5000-8000-000000000009",
      k: 1,
    },
  ];

  it("returns every row exactly as it was written, including past midnight", () => {
    const decoded = decodeDepartureShard(encodeDepartureShard(SERVICE_DATE, rows));
    // Times are stored as offsets from the service date, so a call after midnight is the case
    // that would break if the offset were ever folded back into a single day.
    expect(decoded).toHaveLength(3);
    expect([...decoded].sort((a, b) => a.j.localeCompare(b.j))).toEqual(
      [...rows].sort((a, b) => a.j.localeCompare(b.j)),
    );
  });

  it("gives a stop its own calls without parsing anyone else's", () => {
    const shard = encodeDepartureShard(SERVICE_DATE, rows);
    const leeds = decodeDepartureShardForStop(shard, "450010001");
    expect(leeds?.map((row) => row.j)).toEqual(["VJ0001", "VJ0002"]);
    // In time order, because a board renders them in the order it is given.
    expect(leeds?.[0]!.t).toBeLessThan(leeds![1]!.t);
    expect(leeds?.[0]!.k).toBe(1);
    expect(leeds?.[1]!.k).toBeUndefined();
  });

  /*
   * A bucket holds every stop whose code hashes into it, and plenty of them have nothing on a
   * given date. That is not the same answer as the shard being absent, and neither is the same as
   * it being unreadable — the reader keeps all three apart and this is the first of them.
   */
  it("says nothing rather than something when a stop is not in the shard", () => {
    const shard = encodeDepartureShard(SERVICE_DATE, rows);
    expect(decodeDepartureShardForStop(shard, "1800SB04561")).toBeNull();
  });

  /*
   * The prefix scan must not match a longer code that starts with the one asked for. ATCO codes
   * genuinely nest like this — a stop area and the stops in it share a prefix.
   */
  it("does not hand one stop the rows of a stop whose code merely starts the same", () => {
    const shard = encodeDepartureShard(SERVICE_DATE, [
      { ...rows[0]!, s: "4500100011" },
      { ...rows[1]!, s: "450010001" },
    ]);
    expect(decodeDepartureShardForStop(shard, "450010001")?.map((row) => row.j)).toEqual([
      "VJ0002",
    ]);
    expect(decodeDepartureShardForStop(shard, "4500100011")?.map((row) => row.j)).toEqual([
      "VJ0001",
    ]);
  });

  it("refuses a shard written in a format it does not speak", () => {
    const shard = encodeDepartureShard(SERVICE_DATE, rows);
    const wrongVersion = shard.replace('"v":1', '"v":99');
    expect(() => decodeDepartureShardForStop(wrongVersion, "450010001")).toThrow(/format 99/);
  });

  /*
   * The size claim the redesign rests on. A row carried a 36-character pattern UUID, a route name
   * and a destination on every one of 29.4 million calls; interning them and grouping by stop is
   * what takes a national publish from three gigabytes to a little over one.
   */
  it("costs far less per call than a row that repeats what it shares", () => {
    const many: DepartureRow[] = [];
    for (let stop = 0; stop < 40; stop += 1) {
      for (let call = 0; call < 60; call += 1) {
        many.push({
          s: `1800SB${String(stop).padStart(5, "0")}`,
          t: at("2026-09-17T06:00:00Z") + call * 600,
          r: String(30 + (call % 12)),
          d: "Manchester Piccadilly Gardens",
          j: `VJ${String(stop * 60 + call).padStart(14, "0")}`,
          p: `00000000-0000-5000-8000-${String(call % 12).padStart(12, "0")}`,
          ...(call % 3 === 0 ? { k: 1 as const } : {}),
        });
      }
    }

    const encoded = encodeDepartureShard(SERVICE_DATE, many);
    const naive = many.map((row) => JSON.stringify(row)).join("\n");
    const perCall = Buffer.byteLength(encoded, "utf8") / many.length;

    expect(perCall).toBeLessThan(45);
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(Buffer.byteLength(naive, "utf8") / 2.5);
    // And it is still the same data.
    expect(decodeDepartureShard(encoded)).toHaveLength(many.length);
  });
});

describe("what this layout costs", () => {
  /*
   * Sharding finely is not free and it is not free in two currencies. Every shard is a Class A
   * operation and R2 gives a million a month; every shard is also a request against an API that
   * answered 4.35 a second on the first national run, and a build that cannot finish inside its
   * job is as useless as one that cannot be afforded.
   */
  it("fits a daily national build inside R2's free write allowance", () => {
    const budget = departureWriteBudget(2);
    expect(budget.objectsPerServiceDate).toBe(DEPARTURE_BUCKETS);
    expect(budget.objectsPerBuild).toBe(1_024);
    expect(budget.classAOperationsPerMonth).toBe(30_720);
    expect(budget.withinAllowance).toBe(true);
  });

  /*
   * The constraint that actually killed a run. The previous layout's 7,168 objects were 27.5
   * minutes of a 70-minute job before the planner's trips had been written at all.
   */
  it("writes the whole departure index in minutes, not in most of the job", () => {
    const budget = departureWriteBudget(2);
    expect(budget.publishSeconds).toBeLessThan(5 * 60);

    const previous = departureWriteBudget(2, 30, DEPARTURE_BUCKETS * 7);
    expect(previous.publishSeconds).toBeGreaterThan(25 * 60);
  });

  it("says so when a shard count would not fit", () => {
    // Sixteen times the buckets, rebuilt every hour: the shape of a change worth refusing.
    const budget = departureWriteBudget(2, 720, DEPARTURE_BUCKETS * 16);
    expect(budget.withinAllowance).toBe(false);
  });
});
