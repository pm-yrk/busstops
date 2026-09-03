import { describe, expect, it } from "vitest";
import { mapMatch, simplifyForDisplay, type MapMatchCandidateGeometry } from "./map-match.js";

/**
 * The case that matters: two parallel carriageways about 30 metres apart, which is exactly the
 * situation nearest-line matching gets wrong.
 */
const NORTHBOUND: MapMatchCandidateGeometry = {
  id: "carriageway-north",
  path: [
    { lat: 53.8, lon: -1.55 },
    { lat: 53.805, lon: -1.55 },
    { lat: 53.81, lon: -1.55 },
    { lat: 53.815, lon: -1.55 },
  ],
};

const SOUTHBOUND: MapMatchCandidateGeometry = {
  id: "carriageway-south",
  path: [
    { lat: 53.815, lon: -1.5504 },
    { lat: 53.81, lon: -1.5504 },
    { lat: 53.805, lon: -1.5504 },
    { lat: 53.8, lon: -1.5504 },
  ],
};

function trace(points: Array<[number, number]>, bearing?: number) {
  const start = Date.parse("2026-09-03T08:00:00Z");
  return points.map(([lat, lon], index) => ({
    coordinate: { lat, lon },
    observedAt: new Date(start + index * 20_000).toISOString(),
    ...(bearing === undefined ? {} : { bearingDegrees: bearing }),
  }));
}

describe("map matching", () => {
  it("matches a clean run along one geometry without switching", () => {
    const result = mapMatch(
      trace([
        [53.8005, -1.55002],
        [53.803, -1.55001],
        [53.806, -1.55002],
        [53.809, -1.55],
      ]),
      [NORTHBOUND, SOUTHBOUND],
    );

    expect(result.geometryId).toBe("carriageway-north");
    expect(result.switchCount).toBe(0);
    expect(result.unmatchedCount).toBe(0);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("keeps a single noisy fix on the sequence's geometry instead of flipping carriageway", () => {
    // The third point sits closer to the southbound line than the northbound one. Nearest-line
    // matching would snap it across; the sequence decode should not.
    const result = mapMatch(
      trace([
        [53.8005, -1.55],
        [53.803, -1.55],
        [53.806, -1.55035],
        [53.809, -1.55],
        [53.812, -1.55],
      ]),
      [NORTHBOUND, SOUTHBOUND],
    );

    expect(result.geometryId).toBe("carriageway-north");
    expect(result.switchCount).toBe(0);
    expect(result.points.every((point) => point.geometryId === "carriageway-north")).toBe(true);
  });

  it("uses bearing to separate carriageways when distance cannot", () => {
    // Positions exactly between the two lines; only direction of travel distinguishes them.
    const southbound = mapMatch(
      trace(
        [
          [53.814, -1.5502],
          [53.811, -1.5502],
          [53.808, -1.5502],
          [53.805, -1.5502],
        ],
        180,
      ),
      [NORTHBOUND, SOUTHBOUND],
    );

    expect(southbound.geometryId).toBe("carriageway-south");
  });

  it("reports positions that match nothing rather than forcing them onto a geometry", () => {
    const result = mapMatch(
      trace([
        [53.8005, -1.55],
        [53.803, -1.55],
        [53.9, -1.9],
      ]),
      [NORTHBOUND],
    );

    expect(result.unmatchedCount).toBe(1);
    expect(result.points[2]?.geometryId).toBeNull();
    expect(result.reasons.join(" ")).toMatch(/did not match/);
  });

  it("returns zero confidence with no candidate geometries", () => {
    const result = mapMatch(trace([[53.8, -1.55]]), []);
    expect(result.confidence).toBe(0);
    expect(result.geometryId).toBeNull();
    expect(result.reasons).toContain("no candidate geometries");
  });

  it("penalises a decode that cannot settle on one geometry", () => {
    const clean = mapMatch(
      trace([
        [53.8005, -1.55],
        [53.803, -1.55],
        [53.806, -1.55],
      ]),
      [NORTHBOUND, SOUTHBOUND],
    );
    const messy = mapMatch(
      trace([
        [53.8005, -1.55],
        [53.803, -1.5504],
        [53.806, -1.55],
        [53.809, -1.5504],
      ]),
      [NORTHBOUND, SOUTHBOUND],
    );

    expect(messy.confidence).toBeLessThan(clean.confidence);
  });

  it("simplifies display traces separately, keeping the endpoints", () => {
    const path = Array.from({ length: 400 }, (_, index) => ({
      lat: 53.8 + index * 0.0002,
      lon: -1.55 + Math.sin(index / 12) * 0.0002,
    }));

    const display = simplifyForDisplay(path, 15, 50);
    expect(display.length).toBeLessThanOrEqual(50);
    expect(display[0]).toEqual(path[0]);
    expect(display[display.length - 1]).toEqual(path[path.length - 1]);
  });
});
