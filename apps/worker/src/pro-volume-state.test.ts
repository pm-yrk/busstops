import { describe, expect, it } from "vitest";
import { buildHeadlineMetrics } from "./pro-service.js";

/**
 * The state Pro is actually in, and the one most likely to be misread.
 *
 * The batch read 38,840 observations, matched them to road segments and closed 226 measurement
 * windows — then suppressed every one, because 1.7 crossings per five-minute bucket is noise.
 * Suppressing is right. What a reader must not conclude is that something is missing or broken, and
 * "Road segments measured: 0" over a denominator of 385 invites exactly that.
 */
const SUMMARY = {
  generatedAt: "2026-10-12T07:19:00.000Z",
  windowStart: "2026-10-12T06:50:00.000Z",
  windowEnd: "2026-10-12T07:02:00.000Z",
  closedAt: "2026-10-12T07:17:00.000Z",
  bucketSeconds: 300,
  latenessGraceSeconds: 900,
  segmentsMeasured: 0,
  closedBuckets: 226,
  suppressedBuckets: 226,
  sampleCount: 385,
  distinctVehicles: 1284,
  distinctRoutes: 0,
  medianTraversalSeconds: null,
  p90TraversalSeconds: null,
  medianSpeedMetresPerSecond: null,
  meanMatchConfidence: 0.61,
  coverage: 0.9,
};

describe("what Pro says when every window closed and none survived", () => {
  it("explains the suppression as volume over time, not as missing data", () => {
    const headline = buildHeadlineMetrics({
      usingDemo: false,
      window: "last 60 minutes",
      coverage: 0.9,
      incidents: [],
      summary: SUMMARY,
      now: new Date("2026-10-12T07:20:00.000Z"),
    } as never);

    const segments = headline.find((metric) => metric.key === "segments_measured");
    expect(segments, "the segments tile must be present even at zero").toBeTruthy();
    expect(segments!.definition).toContain("226 measurement window(s) have closed");
    expect(segments!.definition).toContain("385 matched crossing(s)");
    // The conclusion a reader must be able to draw, and the one they must not.
    expect(segments!.definition).toContain("accumulates as collection continues");
    expect(segments!.definition).toContain("nothing is missing");
    // And it is still a real figure, not an example.
    expect(segments!.illustrative).toBe(false);
  });

  /*
   * The sentence must not appear once figures exist, or it becomes a permanent disclaimer that
   * teaches a reader to ignore it.
   */
  it("says nothing of the kind once a window has survived", () => {
    const headline = buildHeadlineMetrics({
      usingDemo: false,
      window: "last 60 minutes",
      coverage: 0.9,
      incidents: [],
      summary: {
        ...SUMMARY,
        segmentsMeasured: 214,
        medianTraversalSeconds: 44,
        suppressedBuckets: 12,
      },
      now: new Date("2026-10-12T07:20:00.000Z"),
    } as never);

    const segments = headline.find((metric) => metric.key === "segments_measured");
    expect(segments!.definition).not.toContain("measurement window(s) have closed");
    expect(segments!.value).toBe(214);
  });
});
