import { describe, expect, it } from "vitest";
import { buildNetworkSummary } from "./summary.js";
import type { SegmentIntervalBucket } from "./aggregates.js";
import type { SegmentSample } from "./segments.js";

function bucket(over: Partial<SegmentIntervalBucket> = {}): SegmentIntervalBucket {
  return {
    segmentId: "seg-1",
    intervalStart: "2026-09-19T12:00:00.000Z",
    intervalEnd: "2026-09-19T12:05:00.000Z",
    state: "closed",
    version: 1,
    sampleCount: 8,
    distinctVehicles: 4,
    distinctRoutes: 2,
    medianTraversalSeconds: 40,
    p90TraversalSeconds: 60,
    robustSpeedMetresPerSecond: 7,
    meanMatchConfidence: 0.8,
    suppressed: false,
    lateArrivals: 0,
    ...over,
  };
}

function sample(over: Partial<SegmentSample> = {}): SegmentSample {
  return {
    segmentId: "seg-1",
    vehicleRef: "veh-1",
    routeId: "route-1",
    enteredAt: "2026-09-19T12:01:00.000Z",
    exitedAt: "2026-09-19T12:01:40.000Z",
    traversalSeconds: 40,
    distanceMetres: 280,
    meanSpeedMetresPerSecond: 7,
    matchConfidence: 0.8,
    ...over,
  };
}

describe("the national summary the edge reads", () => {
  it("says nothing rather than zero when no window has closed", () => {
    const summary = buildNetworkSummary({
      buckets: [bucket({ state: "open" }), bucket({ segmentId: "seg-2", state: "open" })],
      samples: [sample()],
      coverage: 1,
    });
    /*
     * A row of zeroes would read as "a closed window in which nothing moved", which is a
     * different and much stronger claim than "no window has closed yet". This is the run-67
     * shape: samples exist, every bucket is still open, and the honest answer is silence.
     */
    expect(summary).toBeNull();
  });

  it("counts a bus once however many segments it crossed", () => {
    const summary = buildNetworkSummary({
      buckets: [bucket(), bucket({ segmentId: "seg-2" }), bucket({ segmentId: "seg-3" })],
      samples: [
        sample({ segmentId: "seg-1" }),
        sample({ segmentId: "seg-2" }),
        sample({ segmentId: "seg-3" }),
        sample({ segmentId: "seg-1", vehicleRef: "veh-2", routeId: "route-2" }),
      ],
      coverage: 1,
    });
    // Summing `distinctVehicles` across the three buckets would say twelve.
    expect(summary?.distinctVehicles).toBe(2);
    expect(summary?.distinctRoutes).toBe(2);
    expect(summary?.segmentsMeasured).toBe(3);
    expect(summary?.sampleCount).toBe(4);
  });

  it("leaves samples from a still-open bucket out of a closed figure", () => {
    const summary = buildNetworkSummary({
      buckets: [
        bucket(),
        bucket({
          intervalStart: "2026-09-19T12:05:00.000Z",
          intervalEnd: "2026-09-19T12:10:00.000Z",
          state: "open",
        }),
      ],
      samples: [
        sample({ traversalSeconds: 40 }),
        // Inside the open bucket, therefore still subject to revision.
        sample({ exitedAt: "2026-09-19T12:07:00.000Z", traversalSeconds: 400 }),
      ],
      coverage: 1,
    });
    expect(summary?.windowEnd).toBe("2026-09-19T12:05:00.000Z");
    expect(summary?.sampleCount).toBe(1);
    expect(summary?.medianTraversalSeconds).toBe(40);
  });

  it("does not count a suppressed bucket as a measured segment", () => {
    const summary = buildNetworkSummary({
      buckets: [bucket(), bucket({ segmentId: "seg-2", suppressed: true, sampleCount: 2 })],
      samples: [sample()],
      coverage: 0.5,
    });
    expect(summary?.closedBuckets).toBe(2);
    expect(summary?.segmentsMeasured).toBe(1);
    expect(summary?.suppressedBuckets).toBe(1);
    // Carried through so the edge can qualify every figure it prints from this record.
    expect(summary?.coverage).toBe(0.5);
  });

  it("describes the window it measured, not the moment it was built", () => {
    const summary = buildNetworkSummary(
      {
        buckets: [
          bucket(),
          bucket({
            intervalStart: "2026-09-19T11:55:00.000Z",
            intervalEnd: "2026-09-19T12:00:00.000Z",
          }),
        ],
        samples: [sample()],
        coverage: 1,
      },
      new Date("2026-09-19T12:19:00.000Z"),
    );
    expect(summary?.windowStart).toBe("2026-09-19T11:55:00.000Z");
    expect(summary?.windowEnd).toBe("2026-09-19T12:05:00.000Z");
    expect(summary?.generatedAt).toBe("2026-09-19T12:19:00.000Z");
  });
});
