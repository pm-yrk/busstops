import { describe, expect, it } from "vitest";
import type { FloodNotice, Incident, RoadEvent, VehicleObservation } from "@busstops/contracts";
import {
  InMemoryObjectStore,
  ArtifactStore,
  RAW_TRACE_MAX_AGE_HOURS,
} from "@busstops/pipeline-core";
import { deterministicUuid } from "@busstops/adapters";
import { StageRunner } from "./stages.js";
import { indexSegments, sampleSegmentsForTrace, type RoadSegment } from "./segments.js";
import { aggregateSegmentSamples, bucketKey, type SegmentIntervalBucket } from "./aggregates.js";
import { rollUpBuckets, planPruning, rollUpChain, type PruneCandidate } from "./rollup.js";
import { takeInventory, projectStorage } from "./inventory.js";
import {
  describeForecast,
  joinFloodNotices,
  joinRoadEvents,
  joinStreetWorks,
  weatherCacheKey,
} from "./enrichment.js";
import {
  incidentKey,
  reconcileIncidents,
  type IncidentObservation,
  type TrackedIncident,
} from "./incidents.js";
import { publishIntelligence, INTELLIGENCE_DATASETS, MAX_PUBLISHED_INCIDENTS } from "./publish.js";
import { runAnalyticsBatch } from "./run.js";

const NOW = new Date("2026-09-03T09:00:00.000Z");

const SEGMENT: RoadSegment = {
  id: "seg-a",
  path: [
    { lat: 53.8, lon: -1.55 },
    { lat: 53.81, lon: -1.55 },
  ],
  lengthMetres: 1112,
  speedLimitMetresPerSecond: 13.4,
  speedLimitSource: "osm",
};

function observation(
  vehicleRef: string,
  lat: number,
  offsetSeconds: number,
  base = "2026-09-03T08:00:00.000Z",
): VehicleObservation {
  const observedAt = new Date(Date.parse(base) + offsetSeconds * 1000).toISOString();
  return {
    id: deterministicUuid("vehicle", `${vehicleRef}|${observedAt}`),
    provenance: { source: "bods", retrievedAt: observedAt, externalIds: [] },
    ingestedAt: observedAt,
    qualityFlags: ["ok"],
    vehicleRef,
    coordinate: { lat, lon: -1.55 },
    observedAt,
  };
}

function traversal(vehicleRef: string, startOffset: number, base?: string) {
  return [
    observation(vehicleRef, 53.801, startOffset, base),
    observation(vehicleRef, 53.804, startOffset + 40, base),
    observation(vehicleRef, 53.807, startOffset + 80, base),
    observation(vehicleRef, 53.809, startOffset + 120, base),
  ];
}

describe("stage runner", () => {
  it("records counts, rejections and timing for every stage", async () => {
    const runner = new StageRunner("run-1", { now: () => NOW });
    const value = await runner.run(
      {
        name: "example",
        run: () => ({ value: 42, metrics: { processed: 10, emitted: 8, rejected: 2 } }),
      },
      null,
    );

    expect(value).toBe(42);
    const report = runner.report(NOW);
    expect(report.stages[0]!.metrics).toMatchObject({ processed: 10, emitted: 8, rejected: 2 });
    expect(report.complete).toBe(true);
  });

  it("skips a dependent stage rather than building on a failure", async () => {
    const runner = new StageRunner("run-2", { now: () => NOW });
    await runner.run(
      {
        name: "first",
        run: () => {
          throw new Error("upstream parse failed");
        },
      },
      null,
    );
    const second = await runner.run(
      { name: "second", dependsOn: ["first"], run: () => ({ value: 1, metrics: {} }) },
      null,
    );

    expect(second).toBeNull();
    const report = runner.report(NOW);
    expect(report.failedStages).toEqual(["first"]);
    expect(report.skippedStages).toEqual(["second"]);
    expect(report.complete).toBe(false);
    // The failure reason is recorded, not swallowed.
    expect(report.stages[0]!.error).toBe("upstream parse failed");
  });

  it("does not re-run a stage that a previous attempt already completed", async () => {
    const first = new StageRunner("run-3", { now: () => NOW });
    await first.run({ name: "expensive", run: () => ({ value: 1, metrics: {} }) }, null);
    const checkpoint = first.report(NOW).checkpoint;

    const resumed = new StageRunner("run-3", { now: () => NOW, resumeFrom: checkpoint });
    expect(resumed.hasCompleted("expensive")).toBe(true);

    let ran = false;
    await resumed.run(
      {
        name: "next",
        dependsOn: ["expensive"],
        run: () => {
          ran = true;
          return { value: 2, metrics: {} };
        },
      },
      null,
    );
    expect(ran).toBe(true);
  });
});

describe("segment sampling", () => {
  it("derives a traversal with its duration and speed", () => {
    const result = sampleSegmentsForTrace(traversal("veh-1", 0), [SEGMENT], "route-1");
    expect(result.samples).toHaveLength(1);
    const sample = result.samples[0]!;
    expect(sample.segmentId).toBe("seg-a");
    expect(sample.traversalSeconds).toBe(120);
    expect(sample.routeId).toBe("route-1");
    expect(sample.meanSpeedMetresPerSecond).toBeGreaterThan(0);
  });

  it("produces no samples at all when the map match is not confident", () => {
    const far = traversal("veh-1", 0).map((o) => ({
      ...o,
      coordinate: { lat: o.coordinate.lat, lon: -1.6 },
    }));
    const result = sampleSegmentsForTrace(far, [SEGMENT], null);
    expect(result.samples).toHaveLength(0);
    expect(result.discardedLowConfidence + result.unmatchedTraces).toBeGreaterThan(0);
  });

  it("discards a stationary run rather than recording a zero-distance traversal", () => {
    const stationary = [
      observation("veh-1", 53.805, 0),
      observation("veh-1", 53.805, 60),
      observation("veh-1", 53.805, 120),
    ];
    const result = sampleSegmentsForTrace(stationary, [SEGMENT], null);
    expect(result.samples).toHaveLength(0);
    expect(result.discardedImplausible).toBe(1);
  });

  /*
   * Locality, which run 45 showed is both the speed problem and the accuracy problem.
   *
   * Every trace was handed all 76,298 segments: 2,927 vehicles took 960 seconds and 2,184 of them
   * were rejected for low confidence. A bus in Leeds offered a road in Bristol has nothing to
   * reason from.
   */
  it("offers a trace the roads near it rather than the roads in the country", () => {
    const elsewhere: RoadSegment = {
      ...SEGMENT,
      id: "seg-far",
      // Cornwall, three hundred miles from the fixture trace.
      path: SEGMENT.path.map((point) => ({ lat: 50.26, lon: point.lon - 5.05 })),
    };
    const index = indexSegments([SEGMENT, elsewhere]);
    const near = index.near(traversal("veh-1", 0));
    expect(near.map((candidate) => candidate.id)).toEqual(["seg-a"]);
    expect(index.size).toBe(2);

    // And the answer through the index is the answer without it.
    const viaIndex = sampleSegmentsForTrace(traversal("veh-1", 0), index, "route-1");
    const viaArray = sampleSegmentsForTrace(traversal("veh-1", 0), [SEGMENT, elsewhere], "route-1");
    expect(viaIndex.samples).toEqual(viaArray.samples);
  });

  it("files a segment under every cell its path crosses, so a road is found from either side", () => {
    // A segment spanning a grid boundary: found whichever side the trace is on.
    const crossing: RoadSegment = {
      ...SEGMENT,
      id: "seg-crossing",
      path: [
        { lat: 53.74, lon: -1.5 },
        { lat: 53.76, lon: -1.5 },
      ],
    };
    const index = indexSegments([crossing]);
    const south = index.near([{ coordinate: { lat: 53.7401, lon: -1.5 } }]);
    const north = index.near([{ coordinate: { lat: 53.7599, lon: -1.5 } }]);
    expect(south.map((candidate) => candidate.id)).toEqual(["seg-crossing"]);
    expect(north.map((candidate) => candidate.id)).toEqual(["seg-crossing"]);
  });

  it("counts a trace with no road near it as unmatched rather than as a bad match", () => {
    const index = indexSegments([SEGMENT]);
    const atSea = [observation("veh-1", 50.0, 0), observation("veh-1", 50.001, 60)].map((o) => ({
      ...o,
      coordinate: { lat: o.coordinate.lat, lon: -8.5 },
    }));
    const result = sampleSegmentsForTrace(atSea, index, null);
    expect(result.unmatchedTraces).toBe(1);
    expect(result.discardedLowConfidence).toBe(0);
  });
});

describe("a stage that cannot starve the ones after it", () => {
  /*
   * Run 45's `segment_samples` reported `completed` after 960 seconds and both stages after it
   * were skipped for want of time, so the batch published nothing and Pro fell back to its demo
   * snapshot. A complete first stage that leaves the run with no output is not a success.
   */
  it("gives a stage its declared share of the budget, not the whole of it", async () => {
    let clock = 0;
    const runner = new StageRunner("run-share", {
      now: () => new Date(clock),
      budgetMs: 1000,
    });

    let sawAtStart = 0;
    let sawAfterHalf = 0;
    await runner.run(
      {
        name: "greedy",
        budgetShare: 0.5,
        run: (_input, context) => {
          sawAtStart = context.remainingMs();
          clock += 400;
          sawAfterHalf = context.remainingMs();
          return { value: null, metrics: {} };
        },
      },
      null,
    );

    expect(sawAtStart).toBe(500);
    // 500 of its own share minus the 400 it spent, not 600 of the run's.
    expect(sawAfterHalf).toBe(100);
  });

  it("still hands a stage with no declared share whatever the run has left", async () => {
    let clock = 0;
    const runner = new StageRunner("run-rest", { now: () => new Date(clock), budgetMs: 1000 });
    let seen = 0;
    await runner.run(
      {
        name: "first",
        budgetShare: 0.5,
        run: () => {
          clock += 300;
          return { value: null, metrics: {} };
        },
      },
      null,
    );
    await runner.run(
      {
        name: "second",
        run: (_input, context) => {
          seen = context.remainingMs();
          return { value: null, metrics: {} };
        },
      },
      null,
    );
    expect(seen).toBe(700);
  });
});

describe("interval aggregation", () => {
  function sample(vehicleRef: string, exitedAt: string, traversalSeconds: number) {
    return {
      segmentId: "seg-a",
      vehicleRef,
      routeId: "route-1",
      enteredAt: new Date(Date.parse(exitedAt) - traversalSeconds * 1000).toISOString(),
      exitedAt,
      traversalSeconds,
      distanceMetres: 1000,
      meanSpeedMetresPerSecond: 1000 / traversalSeconds,
      matchConfidence: 0.9,
    };
  }

  it("suppresses a headline figure when the bucket is too thin", () => {
    const result = aggregateSegmentSamples(
      [
        sample("v1", "2026-09-03T08:58:00.000Z", 100),
        sample("v2", "2026-09-03T08:58:30.000Z", 110),
      ],
      NOW,
    );
    const bucket = result.buckets[0]!;
    expect(bucket.sampleCount).toBe(2);
    expect(bucket.suppressed).toBe(true);
    expect(bucket.medianTraversalSeconds).toBeNull();
    expect(result.suppressedBuckets).toBe(1);
  });

  it("publishes a figure once there are enough samples", () => {
    const samples = Array.from({ length: 6 }, (_, index) =>
      sample(`v${index}`, "2026-09-03T08:58:00.000Z", 100 + index),
    );
    const bucket = aggregateSegmentSamples(samples, NOW).buckets[0]!;
    expect(bucket.suppressed).toBe(false);
    expect(bucket.medianTraversalSeconds).toBeCloseTo(102.5, 5);
    expect(bucket.distinctVehicles).toBe(6);
  });

  it("keeps a recent bucket open so late observations can still revise it", () => {
    const bucket = aggregateSegmentSamples([sample("v1", "2026-09-03T08:57:00.000Z", 100)], NOW)
      .buckets[0]!;
    expect(bucket.state).toBe("open");
  });

  it("closes a bucket once its grace window has passed", () => {
    const bucket = aggregateSegmentSamples([sample("v1", "2026-09-03T08:30:00.000Z", 100)], NOW)
      .buckets[0]!;
    expect(bucket.state).toBe("closed");
  });

  it("still aggregates a window that ended hours ago, which is the normal batch case", () => {
    const result = aggregateSegmentSamples([sample("v1", "2026-09-03T07:00:00.000Z", 100)], NOW);
    expect(result.droppedTooLate).toBe(0);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]!.state).toBe("closed");
    // First sight of this window, so it is version 1 and not a revision of anything.
    expect(result.buckets[0]!.version).toBe(1);
    expect(result.revised).toHaveLength(0);
  });

  it("drops an observation from beyond the revision horizon rather than rewriting old figures", () => {
    const result = aggregateSegmentSamples([sample("v1", "2026-09-01T07:00:00.000Z", 100)], NOW);
    expect(result.droppedTooLate).toBe(1);
    expect(result.buckets).toHaveLength(0);
  });

  it("republishes a closed bucket as a new version when a late arrival revises it", () => {
    const first = aggregateSegmentSamples([sample("v1", "2026-09-03T08:30:00.000Z", 100)], NOW);
    const existing = new Map<string, SegmentIntervalBucket>(
      first.buckets.map((bucket) => [bucketKey(bucket.segmentId, bucket.intervalStart), bucket]),
    );

    const second = aggregateSegmentSamples(
      [
        sample("v1", "2026-09-03T08:30:00.000Z", 100),
        sample("v2", "2026-09-03T08:31:00.000Z", 120),
      ],
      NOW,
      { existing },
    );

    expect(second.revised).toHaveLength(1);
    expect(second.buckets[0]!.version).toBe(2);
    expect(second.buckets[0]!.lateArrivals).toBe(1);
  });
});

describe("roll-up and pruning", () => {
  function closedBucket(intervalStart: string, sampleCount: number, medianSeconds: number) {
    return {
      segmentId: "seg-a",
      intervalStart,
      intervalEnd: new Date(Date.parse(intervalStart) + 300_000).toISOString(),
      state: "closed" as const,
      version: 1,
      sampleCount,
      distinctVehicles: sampleCount,
      distinctRoutes: 1,
      medianTraversalSeconds: medianSeconds,
      p90TraversalSeconds: medianSeconds * 1.2,
      robustSpeedMetresPerSecond: 1000 / medianSeconds,
      meanMatchConfidence: 0.9,
      suppressed: false,
      lateArrivals: 0,
    };
  }

  it("weights contributing buckets by their sample count", () => {
    const result = rollUpBuckets(
      [
        closedBucket("2026-09-03T08:00:00.000Z", 100, 100),
        closedBucket("2026-09-03T08:05:00.000Z", 1, 900),
      ],
      900,
      NOW,
    );

    expect(result.buckets).toHaveLength(1);
    // A single outlying bucket must not drag the coarse median to the midpoint of 100 and 900.
    expect(result.buckets[0]!.medianTraversalSeconds).toBe(100);
    expect(result.buckets[0]!.sampleCount).toBe(101);
  });

  it("refuses to roll up a bucket that is still open", () => {
    const open = { ...closedBucket("2026-09-03T08:55:00.000Z", 10, 100), state: "open" as const };
    const result = rollUpBuckets([open], 900, NOW);
    expect(result.buckets).toHaveLength(0);
    expect(result.blocked).toBe(1);
    expect(result.notes.join(" ")).toMatch(/still open/);
  });

  it("holds an expired optional record whose roll-up has not been produced", () => {
    const candidates: PruneCandidate[] = [
      {
        key: "data/aggregate-1",
        retentionClassKey: "aggregate_5min",
        timestamp: "2026-07-01T00:00:00.000Z",
        approximateBytes: 1000,
      },
    ];
    const plan = planPruning(candidates, NOW);
    expect(plan.deletions).toHaveLength(0);
    expect(plan.heldForRollUp).toHaveLength(1);
    expect(plan.notes.join(" ")).toMatch(/held because their coarser aggregate/);
  });

  it("deletes it once the roll-up exists", () => {
    const candidates: PruneCandidate[] = [
      {
        key: "data/aggregate-1",
        retentionClassKey: "aggregate_5min",
        timestamp: "2026-07-01T00:00:00.000Z",
        approximateBytes: 1000,
      },
    ];
    const plan = planPruning(candidates, NOW, new Set(["data/aggregate-1"]));
    expect(plan.deletions).toHaveLength(1);
    expect(plan.bytesReclaimed).toBe(1000);
  });

  it("expires a raw trace at the ceiling even when its roll-up is missing", () => {
    const candidates: PruneCandidate[] = [
      {
        key: "data/raw-1",
        retentionClassKey: "raw_trace",
        timestamp: new Date(
          NOW.getTime() - (RAW_TRACE_MAX_AGE_HOURS + 1) * 3_600_000,
        ).toISOString(),
        approximateBytes: 5000,
      },
    ];
    const plan = planPruning(candidates, NOW);
    expect(plan.deletions).toHaveLength(1);
    expect(plan.mandatoryDeletions).toBe(1);
    expect(plan.notes.join(" ")).toMatch(/reached its retention ceiling/);
  });

  it("never deletes a record that has not yet expired", () => {
    const plan = planPruning(
      [
        {
          key: "data/raw-2",
          retentionClassKey: "raw_trace",
          timestamp: new Date(NOW.getTime() - 3_600_000).toISOString(),
          approximateBytes: 5000,
        },
      ],
      NOW,
    );
    expect(plan.deletions).toHaveLength(0);
  });

  it("derives the roll-up chain from the retention classes", () => {
    const chain = rollUpChain();
    expect(chain).toContainEqual({ from: "raw_trace", to: "aggregate_5min" });
    expect(chain).toContainEqual({ from: "aggregate_5min", to: "aggregate_15min" });
  });
});

describe("storage inventory and projection", () => {
  it("projects the date storage fills at the observed growth rate", () => {
    const day = (n: number) =>
      takeInventory(
        [
          {
            retentionClassKey: "raw_trace",
            objectCount: 100 * n,
            bytes: 100_000_000 * n,
            oldestTimestamp: null,
            newestTimestamp: null,
          },
        ],
        new Date(Date.parse("2026-09-01T00:00:00Z") + (n - 1) * 86_400_000),
      );

    const projection = projectStorage(day(3), {
      limitBytes: 1_000_000_000,
      history: [day(1)],
      daysRemainingInPeriod: 10,
    });

    expect(projection.dailyGrowthBytes).toBeCloseTo(100_000_000, 0);
    expect(projection.projectedFullOn).toBe("2026-09-10");
    expect(projection.projectedUtilization).toBeGreaterThan(1);
    expect(projection.state).toBe("critical");
  });

  it("says growth cannot be measured yet rather than projecting from nothing", () => {
    const inventory = takeInventory(
      [
        {
          retentionClassKey: "raw_trace",
          objectCount: 10,
          bytes: 1000,
          oldestTimestamp: null,
          newestTimestamp: null,
        },
      ],
      NOW,
    );
    const projection = projectStorage(inventory, {
      limitBytes: 1_000_000,
      history: [],
      daysRemainingInPeriod: 10,
    });
    expect(projection.dailyGrowthBytes).toBeNull();
    expect(projection.projectedFullOn).toBeNull();
    expect(projection.notes.join(" ")).toMatch(/growth cannot be measured/);
  });

  it("reports storage that has no retention rule, because nothing would ever delete it", () => {
    const inventory = takeInventory(
      [
        {
          retentionClassKey: "mystery_data",
          objectCount: 5,
          bytes: 500,
          oldestTimestamp: null,
          newestTimestamp: null,
        },
      ],
      NOW,
    );
    expect(inventory.unclassifiedKeys).toEqual(["mystery_data"]);
    const projection = projectStorage(inventory, {
      limitBytes: 1_000_000,
      history: [],
      daysRemainingInPeriod: 10,
    });
    expect(projection.notes.join(" ")).toMatch(/no retention rule/);
  });

  it("flags small-file waste, which costs operations rather than bytes", () => {
    const inventory = takeInventory(
      [
        {
          retentionClassKey: "raw_trace",
          objectCount: 50_000,
          bytes: 50_000 * 200,
          oldestTimestamp: null,
          newestTimestamp: null,
        },
      ],
      NOW,
    );
    const projection = projectStorage(inventory, {
      limitBytes: 10_000_000_000,
      history: [],
      daysRemainingInPeriod: 10,
    });
    expect(projection.notes.join(" ")).toMatch(/compaction/);
  });
});

describe("enrichment joins", () => {
  const point = { lat: 53.8, lon: -1.55 };
  const start = new Date("2026-09-03T08:00:00.000Z");
  const end = new Date("2026-09-03T08:30:00.000Z");

  function roadEvent(overrides: Partial<RoadEvent> = {}): RoadEvent {
    return {
      id: deterministicUuid("incident", "road-1"),
      provenance: { source: "national_highways", retrievedAt: NOW.toISOString(), externalIds: [] },
      ingestedAt: NOW.toISOString(),
      qualityFlags: ["ok"],
      type: "incident",
      sourceSystem: "national_highways",
      coordinate: { lat: 53.8005, lon: -1.55 },
      startedAt: "2026-09-03T07:50:00.000Z",
      endedAt: null,
      description: "Lane closure",
      ...overrides,
    };
  }

  it("states the distance and window it matched on", () => {
    const result = joinRoadEvents(point, start, end, [roadEvent()], {
      onStrategicRoadNetwork: true,
    });
    expect(result.corroborations).toHaveLength(1);
    expect(result.corroborations[0]!.basis).toMatch(/\d+m away/);
    expect(result.corroborations[0]!.matchConfidence).toBeGreaterThan(0);
  });

  it("says a local street is outside National Highways coverage, not that it is clear", () => {
    const result = joinRoadEvents(point, start, end, [roadEvent()], {
      onStrategicRoadNetwork: false,
    });
    expect(result.covered).toBe(false);
    expect(result.corroborations).toHaveLength(0);
    expect(result.coverageNote).toMatch(/not on the strategic road network/);
    expect(result.coverageNote).not.toMatch(/no incidents|clear/i);
  });

  it("distinguishes no events found from no coverage", () => {
    const result = joinRoadEvents(point, start, end, [], { onStrategicRoadNetwork: true });
    expect(result.covered).toBe(true);
    expect(result.coverageNote).toMatch(/No road events were reported/);
  });

  it("treats street works as context, never as a demonstrated cause", () => {
    const result = joinStreetWorks(point, start, end, [
      roadEvent({ sourceSystem: "street_manager", type: "roadworks" }),
    ]);
    expect(result.corroborations).toHaveLength(1);
    expect(result.statement).toMatch(/not a demonstrated cause/);
    expect(result.statement).not.toMatch(/caused|because of/i);
  });

  it("joins flood notices by licensed area membership rather than an invented radius", () => {
    const notice: FloodNotice = {
      id: deterministicUuid("incident", "flood-1"),
      provenance: { source: "environment_agency", retrievedAt: NOW.toISOString(), externalIds: [] },
      ingestedAt: NOW.toISOString(),
      qualityFlags: ["ok"],
      eaFloodAreaId: "area-123",
      severity: "warning",
      description: "River Aire",
      raisedAt: "2026-09-03T06:00:00.000Z",
      activeUntil: null,
      officialUrl: "https://check-for-flooding.service.gov.uk/warnings",
    };

    expect(joinFloodNotices(["area-123"], NOW, [notice]).officialNoticeActive).toBe(true);
    expect(joinFloodNotices(["area-999"], NOW, [notice]).officialNoticeActive).toBe(false);
    expect(joinFloodNotices(["area-123"], NOW, [notice]).highestSeverity).toBe("warning");
  });

  it("caches weather on a coarse grid so nearby places share one request", () => {
    const leeds = weatherCacheKey({ lat: 53.7997, lon: -1.5492 }, NOW);
    const nearby = weatherCacheKey({ lat: 53.81, lon: -1.54 }, NOW);
    expect(leeds.gridKey).toBe(nearby.gridKey);
    expect(leeds.hourKey).toBe("2026-09-03T09:00:00.000Z");
  });

  it("lowers forecast confidence as lead time grows", () => {
    const near = describeForecast("2026-09-03T06:00:00.000Z", NOW);
    const far = describeForecast("2026-09-01T00:00:00.000Z", NOW);
    expect(near.confidence.score).toBeGreaterThan(far.confidence.score);
    expect(far.confidence.level).toBe("low");
  });
});

describe("incident lifecycle", () => {
  function detection(overrides: Partial<IncidentObservation> = {}): IncidentObservation {
    return {
      type: "congestion",
      placeKey: "corridor-1",
      observedAt: "2026-09-03T08:00:00.000Z",
      severity: "elevated",
      confidence: { level: "medium", score: 0.6, reasons: [] },
      narrative: "Traffic appears slower than usual here.",
      officialStatus: "derived",
      geometry: { corridorId: "corridor-1" },
      sourceName: "bods",
      ...overrides,
    };
  }

  it("opens an incident as emerging, not active, on a single detection", () => {
    const result = reconcileIncidents([], [detection()], new Date("2026-09-03T08:01:00.000Z"));
    expect(result.opened).toBe(1);
    expect(result.incidents[0]!.incident.lifecycle).toBe("emerging");
    expect(result.notes.join(" ")).toMatch(/still emerging/);
  });

  it("promotes it to active once a second detection confirms it", () => {
    const first = reconcileIncidents([], [detection()], new Date("2026-09-03T08:01:00.000Z"));
    const second = reconcileIncidents(
      first.incidents,
      [detection({ observedAt: "2026-09-03T08:05:00.000Z" })],
      new Date("2026-09-03T08:06:00.000Z"),
    );
    expect(second.continued).toBe(1);
    expect(second.opened).toBe(0);
    expect(second.incidents[0]!.incident.lifecycle).toBe("active");
  });

  it("gives the same incident the same id when the batch is re-run", () => {
    const a = incidentKey("congestion", "corridor-1", "2026-09-03T08:00:00.000Z");
    const b = incidentKey("congestion", "corridor-1", "2026-09-03T08:00:30.000Z");
    expect(a).toBe(b);

    const first = reconcileIncidents([], [detection()], new Date("2026-09-03T08:01:00.000Z"));
    const rerun = reconcileIncidents([], [detection()], new Date("2026-09-03T08:01:00.000Z"));
    expect(rerun.incidents[0]!.incident.id).toBe(first.incidents[0]!.incident.id);
  });

  it("moves a quiet incident to recovering, then resolves it with an end time", () => {
    const opened = reconcileIncidents([], [detection()], new Date("2026-09-03T08:01:00.000Z"));

    const recovering = reconcileIncidents(
      opened.incidents,
      [],
      new Date("2026-09-03T08:20:00.000Z"),
    );
    expect(recovering.incidents[0]!.incident.lifecycle).toBe("recovering");
    expect(recovering.incidents[0]!.incident.endedAt).toBeNull();

    const resolved = reconcileIncidents(
      recovering.incidents,
      [],
      new Date("2026-09-03T08:40:00.000Z"),
    );
    expect(resolved.incidents[0]!.incident.lifecycle).toBe("resolved");
    expect(resolved.incidents[0]!.incident.endedAt).toBe("2026-09-03T08:00:00.000Z");
    expect(resolved.closed).toBe(1);
  });

  it("keeps the worst severity seen rather than the most recent", () => {
    const first = reconcileIncidents(
      [],
      [detection({ severity: "abnormal" })],
      new Date("2026-09-03T08:01:00.000Z"),
    );
    const second = reconcileIncidents(
      first.incidents,
      [detection({ severity: "elevated", observedAt: "2026-09-03T08:05:00.000Z" })],
      new Date("2026-09-03T08:06:00.000Z"),
    );
    expect(second.incidents[0]!.incident.severity).toBe("abnormal");
  });

  it("flags a low-confidence incident so it cannot be presented as solid", () => {
    const result = reconcileIncidents(
      [],
      [detection({ confidence: { level: "low", score: 0.2, reasons: ["thin evidence"] } })],
      new Date("2026-09-03T08:01:00.000Z"),
    );
    expect(result.incidents[0]!.incident.qualityFlags).toContain("low_confidence");
  });
});

describe("atomic publication", () => {
  const bucket: SegmentIntervalBucket = {
    segmentId: "seg-a",
    intervalStart: "2026-09-03T08:00:00.000Z",
    intervalEnd: "2026-09-03T08:05:00.000Z",
    state: "closed",
    version: 1,
    sampleCount: 10,
    distinctVehicles: 8,
    distinctRoutes: 2,
    medianTraversalSeconds: 120,
    p90TraversalSeconds: 160,
    robustSpeedMetresPerSecond: 8,
    meanMatchConfidence: 0.9,
    suppressed: false,
    lateArrivals: 0,
  };

  it("publishes settled buckets and marks partial coverage on the artifact", async () => {
    const store = new InMemoryObjectStore(() => NOW);
    const result = await publishIntelligence(
      store,
      { buckets: [bucket], incidents: [] },
      { version: "v1", coverage: 0.6, sources: ["bods"], now: () => NOW },
    );

    expect(result.complete).toBe(true);
    expect(result.notes.join(" ")).toMatch(/60% partition coverage/);

    const artifacts = new ArtifactStore(store);
    const manifest = await artifacts.readManifest(INTELLIGENCE_DATASETS.segmentMetrics);
    expect(manifest?.partialCoverage).toBe(true);
    expect(manifest?.recordCount).toBe(1);
  });

  it("does not publish an open bucket, whose figure is still going to change", async () => {
    const store = new InMemoryObjectStore(() => NOW);
    const result = await publishIntelligence(
      store,
      { buckets: [{ ...bucket, state: "open" }], incidents: [] },
      { version: "v1", coverage: 1, sources: ["bods"], now: () => NOW },
    );
    expect(result.complete).toBe(false);
    expect(result.notes.join(" ")).toMatch(/still open/);
  });

  it("accepts a genuinely empty incident set instead of keeping yesterday's on screen", async () => {
    const store = new InMemoryObjectStore(() => NOW);
    const result = await publishIntelligence(
      store,
      { buckets: [bucket], incidents: [] },
      { version: "v1", coverage: 1, sources: ["bods"], now: () => NOW },
    );
    expect(result.failed).toEqual([]);
    expect(result.published.map((m) => m.dataset)).toContain(INTELLIGENCE_DATASETS.incidents);
  });

  /*
   * The edge reads this dataset whole to build the control tower, and how many incidents there
   * are is a property of how disrupted England is rather than of this pipeline. Without a ceiling
   * here the isolate has one nobody chose — the same shape as the disruption notices, which are
   * capped at publish for exactly this reason.
   */
  it("caps what it publishes and drops the mildest first, not an arbitrary slice", async () => {
    const store = new InMemoryObjectStore(() => NOW);
    const tracked = (index: number, severity: Incident["severity"]): TrackedIncident => ({
      incident: {
        id: deterministicUuid("incident", `cap-${index}`),
        provenance: { source: "derived", retrievedAt: NOW.toISOString(), externalIds: [] },
        ingestedAt: NOW.toISOString(),
        qualityFlags: ["ok"],
        type: "congestion",
        startedAt: NOW.toISOString(),
        endedAt: null,
        geometry: { corridorId: `corridor-${index}` },
        affectedRouteIds: [],
        affectedVehicleRefs: [],
        severity,
        confidence: { level: "medium", score: 0.6, reasons: ["test"] },
        evidence: [],
        officialStatus: "derived",
        lifecycle: "active",
        narrative: `incident ${index}`,
      },
      detectionCount: 1,
      lastDetectedAt: NOW.toISOString(),
    });

    // One severe incident buried at the end of a list longer than the cap.
    const many = [
      ...Array.from({ length: MAX_PUBLISHED_INCIDENTS + 40 }, (_, i) => tracked(i, "typical")),
      tracked(9999, "highly_abnormal"),
    ];

    const result = await publishIntelligence(
      store,
      { buckets: [bucket], incidents: many },
      { version: "v1", coverage: 1, sources: ["bods"], now: () => NOW },
    );

    const artifacts = new ArtifactStore(store);
    const manifest = await artifacts.readManifest(INTELLIGENCE_DATASETS.incidents);
    expect(manifest?.recordCount).toBe(MAX_PUBLISHED_INCIDENTS);
    expect(result.notes.join(" ")).toMatch(/41 of 1541 incidents were not published/);

    // And the one that mattered survived the cut.
    const published = await artifacts.readRecords<Incident>(manifest!);
    expect(published.some((incident) => incident.severity === "highly_abnormal")).toBe(true);
  });
});

describe("batch orchestration", () => {
  it("runs the stages in order and publishes the result", async () => {
    const store = new InMemoryObjectStore(() => NOW);
    const traces = new Map<string, VehicleObservation[]>();
    for (let index = 0; index < 8; index += 1) {
      traces.set(`veh-${index}`, traversal(`veh-${index}`, index * 5, "2026-09-03T08:30:00.000Z"));
    }

    const result = await runAnalyticsBatch(
      {
        runId: "run-1",
        traces,
        routeByVehicle: new Map([...traces.keys()].map((key) => [key, "route-1"])),
        segments: [SEGMENT],
        existingBuckets: new Map(),
        existingIncidents: [],
        detections: [],
        coverage: 1,
        sources: ["bods"],
        governorState: "green",
      },
      { store, now: () => NOW, version: "v1" },
    );

    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.report.stages.map((stage) => stage.name)).toEqual([
      "segment_samples",
      "interval_aggregates",
      "incident_lifecycle",
      "atomic_publish",
    ]);
    expect(result.report.complete).toBe(true);
    expect(result.publish?.complete).toBe(true);
  });

  it("reports the degradation steps in force rather than silently doing less", async () => {
    const result = await runAnalyticsBatch(
      {
        runId: "run-2",
        traces: new Map(),
        routeByVehicle: new Map(),
        segments: [SEGMENT],
        existingBuckets: new Map(),
        existingIncidents: [],
        detections: [],
        coverage: 1,
        sources: ["bods"],
        governorState: "red",
      },
      { now: () => NOW },
    );

    expect(result.notes.join(" ")).toMatch(/Pause lower-priority historical enrichment/);
    expect(result.notes.join(" ")).toMatch(/no object store configured/);
  });
});
