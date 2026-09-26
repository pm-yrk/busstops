import { describe, expect, it } from "vitest";
import { InMemoryObjectStore } from "@busstops/pipeline-core";
import { buildNetworkSummary, publishIntelligence } from "@busstops/pipeline-analytics-batch";
import {
  INTELLIGENCE_SUMMARY_DATASET,
  ProService,
  resolveScope,
  closureAgeSeconds,
  describeMeasuredWindow,
  measurementAgeSeconds,
  publicationAgeSeconds,
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

  it("keeps the six timestamps of a figure distinct", () => {
    /*
     * Run 69 reported a five-minute window ending 14:25 as "closed 129 minutes ago", on a record
     * the batch had written at 16:33. Three different clocks under one word, and the one named
     * was not the one measured: a window ending 14:25 with a 600-second grace closes at 14:35,
     * not 129 minutes before 16:34.
     *
     * So every boundary is pinned here against one worked example, in order.
     */
    const summary = buildNetworkSummary(
      { buckets: [closedBucket], samples: [sample], coverage: 0.9 },
      // The batch runs at 12:16 — later than the window it is summarising, as it must be.
      new Date("2026-09-19T12:16:00.000Z"),
    );

    //  1. window start — the first instant any closed bucket covers
    expect(summary?.windowStart).toBe("2026-09-19T11:55:00.000Z");
    //  2. window end — the last instant covered, five minutes later
    expect(summary?.windowEnd).toBe("2026-09-19T12:00:00.000Z");
    //  3. lateness grace — 600 seconds, unchanged
    expect(summary?.latenessGraceSeconds).toBe(600);
    //  4. closedAt — window end plus the grace, so 12:10 and not 12:00
    expect(summary?.closedAt).toBe("2026-09-19T12:10:00.000Z");
    //  5. publication — when the batch wrote the record
    expect(summary?.generatedAt).toBe("2026-09-19T12:16:00.000Z");

    const asEdgeReadsIt = summary as unknown as NetworkSummary;
    const now = new Date("2026-09-19T12:20:00.000Z");

    // The three ages, each measured from its own boundary and never from another's.
    expect(measurementAgeSeconds(asEdgeReadsIt, now), "now − windowEnd").toBe(1200);
    expect(closureAgeSeconds(asEdgeReadsIt, now), "now − closedAt").toBe(600);
    expect(publicationAgeSeconds(asEdgeReadsIt, now), "now − generatedAt").toBe(240);
    // Closure age is always the measurement age minus the grace. That is the identity the old
    // wording broke by naming one and computing the other.
    expect(measurementAgeSeconds(asEdgeReadsIt, now) - closureAgeSeconds(asEdgeReadsIt, now)).toBe(
      asEdgeReadsIt.latenessGraceSeconds,
    );

    //  6. what the UI says — the period, both boundaries, and the age, separately
    expect(describeMeasuredWindow(asEdgeReadsIt, now)).toBe(
      "5-minute window ending 12:00 UTC, settled 12:10; measured 20 minutes ago",
    );
  });

  it("never dates a figure from the batch that wrote it", () => {
    /*
     * The failure this guards is the plausible one: a metric labelled with the record's age
     * rather than the measurement's. In run 69 that would have read as four minutes old while
     * describing buses from two hours earlier.
     */
    const summary = buildNetworkSummary(
      { buckets: [closedBucket], samples: [sample], coverage: 0.9 },
      new Date("2026-09-19T14:30:00.000Z"),
    ) as unknown as NetworkSummary;
    const now = new Date("2026-09-19T14:33:00.000Z");

    expect(publicationAgeSeconds(summary, now)).toBe(180);
    // The measurement is two and a half hours old and must say so, whatever the record's age.
    expect(measurementAgeSeconds(summary, now)).toBe(9180);
    expect(describeMeasuredWindow(summary, now)).toContain("measured 153 minutes ago");
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
