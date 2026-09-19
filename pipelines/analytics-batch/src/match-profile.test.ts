import { describe, expect, it } from "vitest";
import type { Coordinate, VehicleObservation } from "@busstops/contracts";
import { deterministicUuid } from "@busstops/adapters";
import {
  emptySegmentMatchProfile,
  indexSegments,
  sampleSegmentsForTrace,
  summariseSegmentMatchProfile,
  type RoadSegment,
} from "./segments.js";

/**
 * The matching stage has to be able to say why it is slow and why its matches are weak.
 *
 * Run 67 processed 4,265 of 17,270 traces inside a full five-minute budget and rejected 2,178 of
 * those below the confidence floor. Both are outcomes. The instruction was explicit: understand
 * why the matches are weak before touching the floor, which means the batch has to distinguish
 * "the roads are not there" from "the positions are far from them" from "the decode never
 * settled" — three problems with three different remedies that a single rejected count conflates.
 */

/** A straight road running east along a line of latitude, as a chain of coordinates. */
function road(id: string, lat: number, fromLon: number, toLon: number): RoadSegment {
  const path: Coordinate[] = [];
  const steps = 20;
  for (let step = 0; step <= steps; step += 1) {
    path.push({ lat, lon: fromLon + ((toLon - fromLon) * step) / steps });
  }
  return {
    id,
    path,
    lengthMetres: 1000,
    speedLimitMetresPerSecond: null,
    speedLimitSource: null,
  };
}

function trace(lat: number, fromLon: number, toLon: number, points = 8): VehicleObservation[] {
  const observations: VehicleObservation[] = [];
  for (let step = 0; step < points; step += 1) {
    const observedAt = new Date(
      Date.parse("2026-09-19T12:00:00.000Z") + step * 20_000,
    ).toISOString();
    observations.push({
      id: deterministicUuid("vehicle", `veh-1|${observedAt}`),
      provenance: { source: "bods", retrievedAt: observedAt, externalIds: [] },
      ingestedAt: observedAt,
      qualityFlags: ["ok"],
      vehicleRef: "veh-1",
      observedAt,
      coordinate: { lat, lon: fromLon + ((toLon - fromLon) * step) / (points - 1) },
      bearingDegrees: 90,
    });
  }
  return observations;
}

describe("what the matching stage can say about itself", () => {
  it("separates finding candidates from deciding between them", () => {
    const index = indexSegments([
      road("a", 53.8, -1.56, -1.54),
      road("b", 53.9, -1.56, -1.54),
      road("c", 51.5, -0.12, -0.1),
    ]);
    const profile = emptySegmentMatchProfile();
    sampleSegmentsForTrace(trace(53.8, -1.56, -1.54), index, "route-1", {}, profile);

    expect(profile.traces).toBe(1);
    // Both stages are measured, and the decode is the one that touches every vertex.
    expect(profile.candidateSearchMs).toBeGreaterThanOrEqual(0);
    expect(profile.decodeMs).toBeGreaterThanOrEqual(0);
    // London is more than a cell away from Leeds, so the grid must not offer it.
    expect(profile.candidatesMax).toBeLessThan(3);
  });

  it("counts the projections the precomputed extents removed", () => {
    /*
     * The bounding boxes are computed once per segment when the index is built, and the matcher
     * uses them to skip projecting a point onto a road it cannot be near. This is the measurement
     * that says whether that precomputation is worth anything: a high skip share means the grid
     * hands the decode candidates it cannot use, which is a fact about the grid's size.
     */
    const index = indexSegments([
      road("near", 53.8, -1.56, -1.54),
      // Same grid cell, therefore offered, but far enough that no point can snap to it.
      road("far", 53.95, -1.56, -1.54),
    ]);
    const profile = emptySegmentMatchProfile();
    sampleSegmentsForTrace(trace(53.8, -1.56, -1.54), index, null, {}, profile);

    expect(profile.matcher.projectionsSkippedByBounds).toBeGreaterThan(0);
    expect(profile.matcher.candidatesWithoutBounds).toBe(0);
    expect(summariseSegmentMatchProfile(profile).boundsSkipShare).toBeGreaterThan(0);
  });

  it("skips only projections that could not have matched", () => {
    /*
     * The optimisation must be invisible in the result. A bounding-box test that excluded a road
     * a bus was actually on would turn a cost saving into a wrong answer, which is the one thing
     * a matcher must not do quietly.
     */
    const segments = [road("near", 53.8, -1.56, -1.54), road("far", 53.95, -1.56, -1.54)];
    const withBounds = indexSegments(segments);
    const observations = trace(53.8, -1.56, -1.54);

    const indexed = sampleSegmentsForTrace(observations, withBounds, "route-1");
    // The plain-array path builds candidates with no bounds, so nothing is skipped there.
    const plain = sampleSegmentsForTrace(observations, segments, "route-1");

    expect(indexed.samples.map((sample) => sample.segmentId)).toEqual(
      plain.samples.map((sample) => sample.segmentId),
    );
    expect(indexed.samples.map((sample) => sample.matchConfidence)).toEqual(
      plain.samples.map((sample) => sample.matchConfidence),
    );
  });

  it("says a trace with no road near it is a coverage gap, not a weak match", () => {
    const index = indexSegments([road("elsewhere", 51.5, -0.12, -0.1)]);
    const profile = emptySegmentMatchProfile();
    const result = sampleSegmentsForTrace(trace(53.8, -1.56, -1.54), index, null, {}, profile);

    expect(result.unmatchedTraces).toBe(1);
    expect(profile.tracesWithNoCandidates).toBe(1);
    // Blaming the matcher for a road that was never extracted is how a coverage problem gets
    // mistaken for a threshold problem.
    expect(profile.rejectedByCoverage + profile.rejectedByDistance).toBe(0);
  });

  it("attributes a rejection to the weakest of the three confidence factors", () => {
    /*
     * A trace fifty metres to the side of the only road near it. Every point still snaps — the
     * cap is sixty metres — so coverage is whole and the decode is stable; what is weak is how
     * far the positions sit from the centreline. Recording that as "distance" rather than as a
     * bare rejection is the difference between "these buses are not where the roads are" and
     * "the floor is too high".
     */
    const index = indexSegments([road("beside", 53.8005, -1.56, -1.54)]);
    const profile = emptySegmentMatchProfile();
    const result = sampleSegmentsForTrace(
      trace(53.8, -1.56, -1.54),
      index,
      null,
      { minimumMatchConfidence: 0.9 },
      profile,
    );

    expect(result.discardedLowConfidence).toBe(1);
    expect(profile.rejectedByDistance).toBe(1);
    expect(profile.rejectedByCoverage).toBe(0);
    expect(summariseSegmentMatchProfile(profile).meanRejectedConfidence).toBeGreaterThan(0);
  });
});
