import { describe, expect, it } from "vitest";
import { InMemoryObjectStore } from "@busstops/pipeline-core";
import { buildNetworkSummary, publishIntelligence } from "@busstops/pipeline-analytics-batch";
import {
  INTELLIGENCE_SUMMARY_DATASET,
  ProService,
  resolveScope,
  describeMeasuredWindow,
  measuredFreshnessSeconds,
  type NetworkSummary,
} from "../../apps/worker/src/pro-service.js";

/**
 * The national summary is a wire format between two deployables.
 *
 * The batch writes it in a scheduled GitHub Action; the Worker reads it at the edge, and the
 * Worker bundle must not import the analytics package to do so — so the record's shape is written
 * out on both sides. Two independent declarations of the same format is exactly the arrangement
 * that drifts silently, so this asserts that what the pipeline publishes is what the edge reads,
 * by publishing with one and reading with the other.
 */

const closedBucket = {
  segmentId: "seg-1",
  intervalStart: "2026-09-19T11:55:00.000Z",
  intervalEnd: "2026-09-19T12:00:00.000Z",
  state: "closed" as const,
  version: 1,
  sampleCount: 9,
  distinctVehicles: 5,
  distinctRoutes: 3,
  medianTraversalSeconds: 48,
  p90TraversalSeconds: 96,
  robustSpeedMetresPerSecond: 6.2,
  meanMatchConfidence: 0.72,
  suppressed: false,
  lateArrivals: 0,
};

const sample = {
  segmentId: "seg-1",
  vehicleRef: "veh-1",
  routeId: "route-1",
  enteredAt: "2026-09-19T11:56:00.000Z",
  exitedAt: "2026-09-19T11:56:48.000Z",
  traversalSeconds: 48,
  distanceMetres: 298,
  meanSpeedMetresPerSecond: 6.2,
  matchConfidence: 0.72,
};

describe("the summary the batch publishes is the summary the edge reads", () => {
  it("survives a round trip through the artifact store", async () => {
    const store = new InMemoryObjectStore();
    const result = await publishIntelligence(
      store,
      {
        buckets: [closedBucket, { ...closedBucket, segmentId: "seg-2" }],
        incidents: [],
        samples: [sample, { ...sample, segmentId: "seg-2", vehicleRef: "veh-2" }],
      },
      {
        version: "v1",
        coverage: 0.9,
        sources: ["bods"],
        now: () => new Date("2026-09-19T12:16:00.000Z"),
      },
    );

    expect(result.summary).not.toBeNull();
    expect(
      result.published.map((manifest) => manifest.dataset),
      "the summary must be published alongside the metrics it was derived from",
    ).toContain(INTELLIGENCE_SUMMARY_DATASET);

    const service = new ProService(store);
    const tower = await service.controlTower(
      resolveScope(),
      [],
      new Date("2026-09-19T12:19:00.000Z"),
    );

    const vehicles = tower.headline.find((metric) => metric.key === "active_vehicles");
    // Two distinct buses across two segments, counted once each.
    expect(vehicles?.value).toBe(2);
    expect(vehicles?.suppressed).toBe(false);

    const segments = tower.headline.find((metric) => metric.key === "segments_measured");
    expect(segments?.value).toBe(2);
  });

  it("dates every figure from the window, not from the batch that wrote it", () => {
    /*
     * These are fourteen minutes apart in the fixture, and it is the *window* that a reader is
     * entitled to. A metric labelled with the batch's own timestamp would be three minutes old
     * and describe measurements seventeen minutes old.
     */
    const summary = buildNetworkSummary(
      { buckets: [closedBucket], samples: [sample], coverage: 0.9 },
      new Date("2026-09-19T12:16:00.000Z"),
    );
    const asEdgeReadsIt = summary as unknown as NetworkSummary;
    const now = new Date("2026-09-19T12:14:00.000Z");

    expect(describeMeasuredWindow(asEdgeReadsIt, now)).toBe(
      "5-minute measurement windows ending 12:00 UTC, closed 14 minutes ago",
    );
    expect(measuredFreshnessSeconds(asEdgeReadsIt, now)).toBe(840);
  });

  it("publishes no summary, and says so, when no window has closed", async () => {
    const store = new InMemoryObjectStore();
    const result = await publishIntelligence(
      store,
      {
        buckets: [{ ...closedBucket, state: "open" }],
        incidents: [],
        samples: [sample],
      },
      { version: "v1", coverage: 1, sources: ["bods"], now: () => new Date() },
    );

    expect(result.summary).toBeNull();
    expect(result.notes.join("; ")).toContain("no network summary was published");
  });
});
