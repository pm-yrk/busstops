import { describe, expect, it } from "vitest";
import type { VehicleObservation } from "@busstops/contracts";
import { ENGLAND_BOUNDS } from "@busstops/contracts";
import { deterministicUuid } from "@busstops/adapters";
import { englandPartitions, partitionForCoordinate, partitionsByPriority } from "./partitions.js";
import { planCollection } from "./cadence.js";
import { applyQualityGates, acceptanceRate } from "./quality.js";
import { RollingObservationWindow } from "./rolling-window.js";
import { runCollection } from "./collect.js";

function observation(overrides: Partial<VehicleObservation> = {}): VehicleObservation {
  const vehicleRef = overrides.vehicleRef ?? "veh-1";
  const observedAt = overrides.observedAt ?? "2026-09-03T08:00:00.000Z";
  return {
    id: deterministicUuid("vehicle", `${vehicleRef}|${observedAt}`),
    provenance: { source: "bods", retrievedAt: observedAt, externalIds: [] },
    ingestedAt: observedAt,
    qualityFlags: ["ok"],
    vehicleRef,
    coordinate: { lat: 53.8, lon: -1.55 },
    observedAt,
    ...overrides,
  };
}

const NOW = new Date("2026-09-03T08:00:30.000Z");

describe("collection partitions", () => {
  it("tiles England completely and without gaps", () => {
    const partitions = englandPartitions();
    expect(partitions).toHaveLength(24);

    const south = Math.min(...partitions.map((p) => p.bbox.south));
    const north = Math.max(...partitions.map((p) => p.bbox.north));
    const west = Math.min(...partitions.map((p) => p.bbox.west));
    const east = Math.max(...partitions.map((p) => p.bbox.east));

    expect(south).toBeCloseTo(ENGLAND_BOUNDS.south, 6);
    expect(north).toBeCloseTo(ENGLAND_BOUNDS.north, 6);
    expect(west).toBeCloseTo(ENGLAND_BOUNDS.west, 6);
    expect(east).toBeCloseTo(ENGLAND_BOUNDS.east, 6);
  });

  it("places London and Leeds inside a partition", () => {
    expect(partitionForCoordinate(51.5074, -0.1278)).not.toBeNull();
    expect(partitionForCoordinate(53.7997, -1.5492)).not.toBeNull();
  });

  it("prioritises denser partitions first, so shedding work sheds the least useful", () => {
    const ordered = partitionsByPriority();
    expect(ordered[0]!.weight).toBeGreaterThanOrEqual(ordered[ordered.length - 1]!.weight);
  });
});

describe("quota-aware cadence", () => {
  const cadence = {
    sourceKey: "bods",
    sourceUpdateIntervalSeconds: 10,
    baseIntervalSeconds: 60,
    maxRequestsPerRun: 12,
    dailyRequestBudget: 100_000,
  };

  it("plans within the per-run cap and reports what it skipped", () => {
    const plan = planCollection(cadence, "green");
    expect(plan.entries).toHaveLength(12);
    expect(plan.skippedPartitions).toHaveLength(12);
    expect(plan.intervalSeconds).toBe(60);
    expect(plan.suspended).toBe(false);
  });

  it("never polls faster than the source itself updates", () => {
    const plan = planCollection(
      { ...cadence, baseIntervalSeconds: 2, sourceUpdateIntervalSeconds: 30 },
      "green",
    );
    expect(plan.intervalSeconds).toBe(30);
    expect(plan.reasons.join(" ")).toMatch(/faster than the source updates/);
  });

  it("widens the interval as the budget state worsens", () => {
    expect(planCollection(cadence, "green").intervalSeconds).toBe(60);
    expect(planCollection(cadence, "amber").intervalSeconds).toBe(120);
    expect(planCollection(cadence, "red").intervalSeconds).toBe(240);
  });

  it("suspends collection entirely in critical state", () => {
    const plan = planCollection(cadence, "critical");
    expect(plan.suspended).toBe(true);
    expect(plan.entries).toHaveLength(0);
    expect(plan.projectedDailyRequests).toBe(0);
  });

  it("widens the interval before dropping partitions when the daily budget is tight", () => {
    const plan = planCollection({ ...cadence, dailyRequestBudget: 3000 }, "green");
    // 12 partitions every 60s would be 17280 requests a day, far over budget.
    expect(plan.intervalSeconds).toBeGreaterThan(60);
    expect(plan.projectedDailyRequests).toBeLessThanOrEqual(3000);
    // A slower national picture is preferred to a fast partial one.
    expect(plan.entries.length).toBe(12);
  });

  it("stays inside a very small budget even if that means fewer partitions", () => {
    const plan = planCollection({ ...cadence, dailyRequestBudget: 100 }, "green");
    expect(plan.projectedDailyRequests).toBeLessThanOrEqual(100);
  });
});

describe("ingest quality gates", () => {
  it("accepts a well-formed observation", () => {
    const result = applyQualityGates([observation()], NOW);
    expect(result.accepted).toHaveLength(1);
    expect(acceptanceRate(result)).toBe(1);
  });

  it("rejects rather than clamps a coordinate outside England", () => {
    const result = applyQualityGates([observation({ coordinate: { lat: 0, lon: 0 } })], NOW);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejectionCounts.coordinate_outside_england).toBe(1);
  });

  it("rejects a timestamp from the future beyond clock-skew tolerance", () => {
    const result = applyQualityGates(
      [observation({ observedAt: "2026-09-03T09:00:00.000Z" })],
      NOW,
    );
    expect(result.rejectionCounts.timestamp_in_future).toBe(1);
  });

  it("rejects an observation far older than the live window", () => {
    const result = applyQualityGates(
      [observation({ observedAt: "2026-09-03T05:00:00.000Z" })],
      NOW,
    );
    expect(result.rejectionCounts.timestamp_too_old).toBe(1);
  });

  it("flags an ageing observation stale rather than discarding it", () => {
    const result = applyQualityGates(
      [observation({ observedAt: "2026-09-03T07:50:00.000Z" })],
      NOW,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.qualityFlags).toContain("stale");
    expect(result.accepted[0]!.qualityFlags).not.toContain("ok");
  });

  it("counts schema failures, which is how upstream drift becomes visible", () => {
    const result = applyQualityGates([{ nonsense: true }, observation()], NOW);
    expect(result.rejectionCounts.schema_invalid).toBe(1);
    expect(acceptanceRate(result)).toBe(0.5);
  });
});

describe("rolling observation window", () => {
  it("deduplicates by source timestamp, not receipt time", () => {
    const window = new RollingObservationWindow();
    const first = window.admit([observation(), observation()], NOW);
    expect(first.admitted).toHaveLength(1);
    expect(first.duplicates).toBe(1);

    const second = window.admit([observation()], NOW);
    expect(second.admitted).toHaveLength(0);
    expect(second.duplicates).toBe(1);
    expect(window.size).toBe(1);
  });

  it("refuses a position no bus could have reached", () => {
    const window = new RollingObservationWindow();
    window.admit([observation()], NOW);
    const jump = window.admit(
      [
        observation({
          observedAt: "2026-09-03T08:00:10.000Z",
          coordinate: { lat: 54.5, lon: -1.55 },
        }),
      ],
      NOW,
    );
    expect(jump.implausible).toBe(1);
    expect(jump.admitted).toHaveLength(0);
  });

  it("caps its own age even when configured for longer than the retention ceiling", () => {
    const window = new RollingObservationWindow({ maxAgeHours: 500 });
    const stale = observation({ observedAt: "2026-08-30T08:00:00.000Z" });
    const result = window.admit([stale], NOW);
    expect(result.admitted).toHaveLength(0);
    expect(result.tooOld).toBe(1);
  });

  it("evicts by age on every admission, so the window cannot grow unbounded", () => {
    const window = new RollingObservationWindow({ maxAgeHours: 1 });
    window.admit([observation({ observedAt: "2026-09-03T08:00:00.000Z" })], NOW);
    expect(window.size).toBe(1);

    const later = new Date("2026-09-03T10:00:00.000Z");
    const result = window.admit(
      [observation({ vehicleRef: "veh-2", observedAt: "2026-09-03T09:59:00.000Z" })],
      later,
    );
    expect(result.evicted).toBe(1);
    expect(window.size).toBe(1);
  });

  it("enforces the count ceiling as well as the age ceiling", () => {
    const window = new RollingObservationWindow({ maxObservations: 3 });
    const batch = Array.from({ length: 6 }, (_, index) =>
      observation({
        vehicleRef: `veh-${index}`,
        observedAt: new Date(Date.parse("2026-09-03T08:00:00Z") + index * 1000).toISOString(),
      }),
    );
    window.admit(batch, NOW);
    expect(window.size).toBe(3);
  });

  it("returns a vehicle's trace in source-time order", () => {
    const window = new RollingObservationWindow();
    window.admit(
      [
        observation({
          observedAt: "2026-09-03T08:00:20.000Z",
          coordinate: { lat: 53.802, lon: -1.55 },
        }),
        observation({ observedAt: "2026-09-03T08:00:00.000Z" }),
      ],
      NOW,
    );
    const trace = window.traceFor("veh-1");
    expect(trace.map((o) => o.observedAt)).toEqual([
      "2026-09-03T08:00:00.000Z",
      "2026-09-03T08:00:20.000Z",
    ]);
  });
});

describe("collection run", () => {
  const cadence = {
    sourceKey: "bods",
    sourceUpdateIntervalSeconds: 10,
    baseIntervalSeconds: 60,
    maxRequestsPerRun: 3,
    dailyRequestBudget: 100_000,
  };

  it("collects the planned partitions and reports full coverage", async () => {
    const report = await runCollection({
      sourceKey: "bods",
      cadence,
      governorState: "green",
      window: new RollingObservationWindow(),
      now: () => NOW,
      fetchPartition: (partition) =>
        Promise.resolve([observation({ vehicleRef: `veh-${partition.key}` })]),
    });

    expect(report.partitions).toHaveLength(3);
    expect(report.coverage).toBe(1);
    expect(report.observations).toHaveLength(3);
    expect(report.totals.accepted).toBe(3);
  });

  it("keeps going when one partition fails, and states the reduced coverage", async () => {
    let call = 0;
    const report = await runCollection({
      sourceKey: "bods",
      cadence,
      governorState: "green",
      window: new RollingObservationWindow(),
      now: () => NOW,
      fetchPartition: (partition) => {
        call += 1;
        if (call === 2) return Promise.reject(new Error("upstream 503"));
        return Promise.resolve([observation({ vehicleRef: `veh-${partition.key}` })]);
      },
    });

    expect(report.coverage).toBeCloseTo(2 / 3, 5);
    expect(report.partitions.filter((p) => !p.ok)).toHaveLength(1);
    expect(report.notes.join(" ")).toMatch(/1 of 3 partition fetches failed/);
    expect(report.observations).toHaveLength(2);
  });

  it("collects nothing at all when the governor is critical", async () => {
    let fetched = 0;
    const report = await runCollection({
      sourceKey: "bods",
      cadence,
      governorState: "critical",
      window: new RollingObservationWindow(),
      now: () => NOW,
      fetchPartition: () => {
        fetched += 1;
        return Promise.resolve([]);
      },
    });

    expect(fetched).toBe(0);
    expect(report.plan.suspended).toBe(true);
    expect(report.observations).toHaveLength(0);
  });

  it("takes repeated snapshots so a vehicle has more than one position to work from", async () => {
    let clock = Date.parse("2026-09-03T08:00:00.000Z");
    const window = new RollingObservationWindow();

    const report = await runCollection({
      sourceKey: "bods",
      cadence: { ...cadence, maxRequestsPerRun: 1 },
      governorState: "green",
      window,
      passes: 3,
      budgetMs: 300_000,
      now: () => new Date(clock),
      // The sleep is simulated, so the test does not actually wait three minutes.
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      fetchPartition: () =>
        Promise.resolve([
          observation({
            observedAt: new Date(clock).toISOString(),
            coordinate: { lat: 53.8 + (clock % 1000) / 1e6, lon: -1.55 },
          }),
        ]),
    });

    expect(report.passesCompleted).toBe(3);
    // Three distinct positions for the same vehicle: enough to derive movement from.
    expect(window.traceFor("veh-1")).toHaveLength(3);
    expect(report.coverage).toBe(1);
  });

  it("stops taking snapshots when another would not fit in the run's time budget", async () => {
    let clock = Date.parse("2026-09-03T08:00:00.000Z");
    const report = await runCollection({
      sourceKey: "bods",
      cadence: { ...cadence, maxRequestsPerRun: 1 },
      governorState: "green",
      window: new RollingObservationWindow(),
      passes: 10,
      budgetMs: 150_000,
      now: () => new Date(clock),
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      fetchPartition: () =>
        Promise.resolve([observation({ observedAt: new Date(clock).toISOString() })]),
    });

    expect(report.passesCompleted).toBeLessThan(10);
    expect(report.truncated).toBe(true);
    expect(report.notes.join(" ")).toMatch(/would not fit in the run's time budget/);
  });

  it("warns when the acceptance rate collapses, which is how schema drift surfaces", async () => {
    const report = await runCollection({
      sourceKey: "bods",
      cadence: { ...cadence, maxRequestsPerRun: 1 },
      governorState: "green",
      window: new RollingObservationWindow(),
      now: () => NOW,
      fetchPartition: () =>
        Promise.resolve([observation(), { broken: true }, { broken: true }, { broken: true }]),
    });

    expect(report.notes.join(" ")).toMatch(/schema drift/);
    expect(report.acceptanceRate).toBeLessThan(0.8);
  });
});
