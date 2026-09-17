import { describe, expect, it } from "vitest";
import { ROAD_AREAS, describeCoverage, segmentsFromOverpass } from "./index.js";

/**
 * The dataset the analytics batch has always read and nothing has ever written.
 *
 * `run-batch.ts` names `network/segments`, reads it, finds nothing and stops — which is why every
 * scheduled intelligence run has failed and why Pro has only ever served its dated demonstration
 * snapshot. What is asserted here is the part a wrong extraction would get wrong quietly: real
 * geometry, stable identifiers, and roads a bus can be delayed on rather than footpaths.
 */

const retrievedAt = "2026-09-17T12:00:00.000Z";

/** A straight run east along one street, at roughly 100 metres a node. */
function way(id: number, tags: Record<string, string>, nodeCount: number, startId = id * 1000) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => startId + i);
  return {
    nodes: nodes.map((nodeId, i) => ({
      type: "node" as const,
      id: nodeId,
      lat: 53.8,
      lon: -1.55 + i * 0.0015,
    })),
    way: { type: "way" as const, id, nodes, tags },
  };
}

function overpass(...ways: ReturnType<typeof way>[]) {
  return {
    version: 0.6,
    elements: [...ways.flatMap((w) => w.nodes), ...ways.map((w) => w.way)],
  };
}

describe("road segments for the analytics batch", () => {
  it("keeps the geometry, which is the part the batch samples traces against", () => {
    const result = segmentsFromOverpass(
      overpass(way(1, { highway: "primary", name: "The Headrow", maxspeed: "30 mph" }, 4)),
      { retrievedAt, areaId: "leeds" },
    );

    expect(result.segments).toHaveLength(1);
    const segment = result.segments[0]!;
    expect(segment.path.length).toBe(4);
    expect(segment.lengthMetres).toBeGreaterThan(0);
    expect(segment.corridorId).toBe("The Headrow");
    // 30 mph is 13.4 m/s. A limit stated in the wrong unit is a wrong congestion baseline.
    expect(segment.speedLimitMetresPerSecond).toBeCloseTo(13.41, 1);
    expect(segment.speedLimitSource).toBe("osm:maxspeed");
  });

  it("says a limit is unknown rather than assuming one", () => {
    const result = segmentsFromOverpass(overpass(way(2, { highway: "residential" }, 3)), {
      retrievedAt,
      areaId: "leeds",
    });
    expect(result.segments[0]!.speedLimitMetresPerSecond).toBeNull();
    expect(result.segments[0]!.speedLimitSource).toBeNull();
  });

  it("drops what a bus cannot be delayed on", () => {
    const result = segmentsFromOverpass(
      overpass(
        way(3, { highway: "footway" }, 3),
        way(4, { highway: "steps" }, 3),
        way(5, { highway: "secondary" }, 3),
      ),
      { retrievedAt, areaId: "leeds" },
    );
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]!.osmWayId).toBe("5");
    expect(result.rejected).toBe(2);
  });

  /*
   * A ten-kilometre way is one traversal sample and says nothing about where the delay was. It is
   * cut at existing nodes — never at an interpolated point, or the geometry stops being geometry
   * the map has and the samples are measured off a road that is not there.
   */
  it("cuts a long road into pieces, always at nodes it was given", () => {
    const long = way(6, { highway: "primary", name: "A64" }, 40);
    const result = segmentsFromOverpass(overpass(long), { retrievedAt, areaId: "leeds" });

    expect(result.split).toBe(1);
    expect(result.segments.length).toBeGreaterThan(1);
    for (const segment of result.segments) {
      expect(segment.lengthMetres).toBeLessThanOrEqual(1_400);
      for (const point of segment.path) {
        expect(long.nodes.some((node) => node.lat === point.lat && node.lon === point.lon)).toBe(
          true,
        );
      }
    }
    // The pieces join: each one starts where the last finished, so the road is not left with gaps.
    for (let i = 1; i < result.segments.length; i += 1) {
      const previous = result.segments[i - 1]!.path.at(-1)!;
      const next = result.segments[i]!.path[0]!;
      expect(next).toEqual(previous);
    }
  });

  /*
   * Interval buckets are aggregated against segment ids over days. An extraction that produced
   * new ids for the same roads would orphan all of it, and Pro's history would silently restart
   * every time this job ran.
   */
  it("gives the same road the same identifier every time it is extracted", () => {
    const payload = overpass(way(7, { highway: "primary", name: "Kirkstall Road" }, 30));
    const first = segmentsFromOverpass(payload, { retrievedAt, areaId: "leeds" });
    const again = segmentsFromOverpass(payload, {
      retrievedAt: "2026-10-01T00:00:00.000Z",
      areaId: "leeds",
    });
    expect(again.segments.map((s) => s.id)).toEqual(first.segments.map((s) => s.id));
    // And distinct pieces of one way are distinct segments, not the same one repeated.
    expect(new Set(first.segments.map((s) => s.id)).size).toBe(first.segments.length);
  });

  it("refuses a payload it cannot read rather than publishing an empty road network", () => {
    expect(segmentsFromOverpass({ nonsense: true }, { retrievedAt, areaId: "leeds" })).toEqual({
      segments: [],
      rejected: 1,
      split: 0,
    });
  });

  it("drops a way whose nodes are not where it says they are", () => {
    const outside = way(8, { highway: "primary" }, 3);
    for (const node of outside.nodes) node.lat = 0;
    const result = segmentsFromOverpass(overpass(outside), { retrievedAt, areaId: "leeds" });
    expect(result.segments).toEqual([]);
    expect(result.rejected).toBe(1);
  });
});

describe("what the road figures cover", () => {
  /*
   * Coverage is stated because it cannot be national. Overpass is a shared volunteer service whose
   * policy asks for targeted queries; a country-sized extract needs the Geofabrik PBF and a parser
   * for it. A bounded coverage said out loud is a fact; a bounded coverage left unsaid is a claim
   * that the quiet roads are clear.
   */
  it("names every area it extracted, so Pro never implies the whole country", () => {
    const sentence = describeCoverage();
    for (const area of ROAD_AREAS) expect(sentence).toContain(area.name);
    expect(sentence).toContain("has not been extracted");
  });

  it("keeps every area inside England and the right way round", () => {
    for (const area of ROAD_AREAS) {
      expect(area.bbox.west).toBeLessThan(area.bbox.east);
      expect(area.bbox.south).toBeLessThan(area.bbox.north);
      expect(area.bbox.south).toBeGreaterThan(49.8);
      expect(area.bbox.north).toBeLessThan(55.9);
      // Small enough that one Overpass query can answer it.
      const squareDegrees = (area.bbox.east - area.bbox.west) * (area.bbox.north - area.bbox.south);
      expect(squareDegrees).toBeLessThan(0.05);
    }
  });
});
