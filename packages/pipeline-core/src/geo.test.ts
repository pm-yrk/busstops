import { describe, expect, it } from "vitest";
import {
  bearingDegrees,
  bearingDifference,
  boundingBoxAreaSquareDegrees,
  derivedSpeedMetresPerSecond,
  expandBoundingBox,
  haversineMetres,
  isImpossibleJump,
  isPlausibleEnglandCoordinate,
  pathLengthMetres,
  projectOntoPath,
  projectOntoSegment,
  simplifyPath,
  tileKey,
  withinBoundingBox,
} from "./geo.js";

const leedsStation = { lat: 53.7955, lon: -1.5491 };
const leedsBusStation = { lat: 53.7965, lon: -1.5379 };

describe("haversineMetres", () => {
  it("matches a known distance between Leeds rail and bus stations", () => {
    // ~750m apart; assert within 25m of the surveyed distance.
    expect(haversineMetres(leedsStation, leedsBusStation)).toBeGreaterThan(720);
    expect(haversineMetres(leedsStation, leedsBusStation)).toBeLessThan(790);
  });

  it("is zero for identical points and symmetric", () => {
    expect(haversineMetres(leedsStation, leedsStation)).toBe(0);
    expect(haversineMetres(leedsStation, leedsBusStation)).toBeCloseTo(
      haversineMetres(leedsBusStation, leedsStation),
      6,
    );
  });

  it("matches the London-to-Manchester great-circle distance", () => {
    const london = { lat: 51.5074, lon: -0.1278 };
    const manchester = { lat: 53.4808, lon: -2.2426 };
    const km = haversineMetres(london, manchester) / 1000;
    expect(km).toBeGreaterThan(258);
    expect(km).toBeLessThan(266);
  });
});

describe("bearing", () => {
  it("computes cardinal bearings", () => {
    expect(bearingDegrees({ lat: 51, lon: 0 }, { lat: 52, lon: 0 })).toBeCloseTo(0, 1);
    expect(bearingDegrees({ lat: 51, lon: 0 }, { lat: 51, lon: 1 })).toBeCloseTo(89.6, 0);
    expect(bearingDegrees({ lat: 51, lon: 0 }, { lat: 50, lon: 0 })).toBeCloseTo(180, 1);
  });

  it("measures the shortest angular difference across the 0/360 wrap", () => {
    expect(bearingDifference(350, 10)).toBeCloseTo(20, 6);
    expect(bearingDifference(10, 350)).toBeCloseTo(20, 6);
    expect(bearingDifference(0, 180)).toBeCloseTo(180, 6);
  });
});

describe("projection onto a segment", () => {
  it("clamps to the segment start when the point is behind it", () => {
    const result = projectOntoSegment(
      { lat: 51.9, lon: 0 },
      { lat: 52, lon: 0 },
      { lat: 53, lon: 0 },
    );
    expect(result.fraction).toBe(0);
    expect(result.point.lat).toBeCloseTo(52, 6);
  });

  it("clamps to the segment end when the point is beyond it", () => {
    const result = projectOntoSegment(
      { lat: 53.5, lon: 0 },
      { lat: 52, lon: 0 },
      { lat: 53, lon: 0 },
    );
    expect(result.fraction).toBe(1);
  });

  it("projects perpendicular offsets to the midpoint", () => {
    const result = projectOntoSegment(
      { lat: 52.5, lon: 0.01 },
      { lat: 52, lon: 0 },
      { lat: 53, lon: 0 },
    );
    expect(result.fraction).toBeCloseTo(0.5, 2);
    expect(result.distanceMetres).toBeGreaterThan(600);
    expect(result.distanceMetres).toBeLessThan(720);
  });

  it("handles a zero-length segment without dividing by zero", () => {
    const point = { lat: 52, lon: 0 };
    const result = projectOntoSegment({ lat: 52.001, lon: 0 }, point, point);
    expect(result.fraction).toBe(0);
    expect(Number.isFinite(result.distanceMetres)).toBe(true);
  });
});

describe("projection onto a path", () => {
  const path = [
    { lat: 53.79, lon: -1.55 },
    { lat: 53.795, lon: -1.545 },
    { lat: 53.8, lon: -1.54 },
  ];

  it("returns along-path distance so vehicles can be ordered on a route", () => {
    const early = projectOntoPath({ lat: 53.7905, lon: -1.5495 }, path)!;
    const late = projectOntoPath({ lat: 53.7995, lon: -1.5405 }, path)!;
    expect(early.alongPathMetres).toBeLessThan(late.alongPathMetres);
    expect(late.alongPathMetres).toBeLessThanOrEqual(pathLengthMetres(path) + 1);
  });

  it("returns null for an empty path and handles a single point", () => {
    expect(projectOntoPath({ lat: 53, lon: -1 }, [])).toBeNull();
    const single = projectOntoPath({ lat: 53, lon: -1 }, [{ lat: 53.001, lon: -1 }])!;
    expect(single.alongPathMetres).toBe(0);
  });
});

describe("England plausibility", () => {
  it("accepts real England coordinates", () => {
    expect(isPlausibleEnglandCoordinate(leedsStation)).toBe(true);
    expect(isPlausibleEnglandCoordinate({ lat: 50.12, lon: -5.54 })).toBe(true);
  });

  it("rejects null island, NaN and out-of-country coordinates", () => {
    expect(isPlausibleEnglandCoordinate({ lat: 0, lon: 0 })).toBe(false);
    expect(isPlausibleEnglandCoordinate({ lat: Number.NaN, lon: -1 })).toBe(false);
    expect(isPlausibleEnglandCoordinate({ lat: 48.85, lon: 2.35 })).toBe(false);
  });
});

describe("bounding boxes", () => {
  const bbox = { west: -1.6, south: 53.7, east: -1.5, north: 53.85 };

  it("tests containment", () => {
    expect(withinBoundingBox(leedsStation, bbox)).toBe(true);
    expect(withinBoundingBox({ lat: 51.5, lon: -0.12 }, bbox)).toBe(false);
  });

  it("expands by a metre distance in both axes", () => {
    const expanded = expandBoundingBox(bbox, 1000);
    expect(expanded.north).toBeGreaterThan(bbox.north);
    expect(expanded.west).toBeLessThan(bbox.west);
    expect(boundingBoxAreaSquareDegrees(expanded)).toBeGreaterThan(
      boundingBoxAreaSquareDegrees(bbox),
    );
  });
});

describe("simplifyPath", () => {
  it("removes collinear intermediate points", () => {
    const straight = [
      { lat: 53.0, lon: -1.0 },
      { lat: 53.1, lon: -1.0 },
      { lat: 53.2, lon: -1.0 },
      { lat: 53.3, lon: -1.0 },
    ];
    expect(simplifyPath(straight, 10)).toHaveLength(2);
  });

  it("preserves a genuine corner", () => {
    const corner = [
      { lat: 53.0, lon: -1.0 },
      { lat: 53.1, lon: -1.0 },
      { lat: 53.1, lon: -0.9 },
    ];
    expect(simplifyPath(corner, 10)).toHaveLength(3);
  });

  it("returns short paths unchanged", () => {
    const two = [
      { lat: 53, lon: -1 },
      { lat: 54, lon: -1 },
    ];
    expect(simplifyPath(two, 10)).toEqual(two);
  });
});

describe("speed derivation", () => {
  it("returns null when the time gap is too small to be meaningful", () => {
    const speed = derivedSpeedMetresPerSecond(
      { coordinate: leedsStation, observedAt: "2026-09-02T08:00:00.000Z" },
      { coordinate: leedsBusStation, observedAt: "2026-09-02T08:00:02.000Z" },
    );
    expect(speed).toBeNull();
  });

  it("computes a plausible urban bus speed", () => {
    const speed = derivedSpeedMetresPerSecond(
      { coordinate: leedsStation, observedAt: "2026-09-02T08:00:00.000Z" },
      { coordinate: leedsBusStation, observedAt: "2026-09-02T08:01:40.000Z" },
    )!;
    expect(speed).toBeGreaterThan(6);
    expect(speed).toBeLessThan(9);
  });

  it("flags an impossible jump so bad GPS is quarantined, not ingested", () => {
    expect(
      isImpossibleJump(
        { coordinate: { lat: 53.8, lon: -1.55 }, observedAt: "2026-09-02T08:00:00.000Z" },
        { coordinate: { lat: 51.5, lon: -0.12 }, observedAt: "2026-09-02T08:00:30.000Z" },
      ),
    ).toBe(true);
  });

  it("does not flag normal motorway travel as impossible", () => {
    expect(
      isImpossibleJump(
        { coordinate: { lat: 53.8, lon: -1.55 }, observedAt: "2026-09-02T08:00:00.000Z" },
        { coordinate: { lat: 53.81, lon: -1.55 }, observedAt: "2026-09-02T08:01:00.000Z" },
      ),
    ).toBe(false);
  });
});

describe("tileKey", () => {
  it("groups nearby coordinates into the same partition", () => {
    expect(tileKey({ lat: 53.801, lon: -1.541 })).toBe(tileKey({ lat: 53.809, lon: -1.549 }));
    expect(tileKey({ lat: 53.801, lon: -1.541 })).not.toBe(tileKey({ lat: 51.5, lon: -0.12 }));
  });
});
