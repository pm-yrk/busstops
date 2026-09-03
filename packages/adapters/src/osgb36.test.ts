import { describe, expect, it } from "vitest";
import { osgb36ToWgs84 } from "./osgb36.js";

describe("osgb36ToWgs84", () => {
  it("matches the Ordnance Survey worked example (Caister water tower)", () => {
    // OS example point TG 51409 13177: E 651409.903, N 313177.270.
    // On the Airy 1830 ellipsoid that is 52.657570 N, 1.717922 E. After the Helmert
    // transformation to WGS84 it is 52.657977 N, 1.716038 E — the datum shift is ~125m of
    // longitude here, which is exactly why the conversion cannot be skipped.
    const result = osgb36ToWgs84(651409.903, 313177.27)!;
    expect(result.lat).toBeCloseTo(52.657977, 4);
    expect(result.lon).toBeCloseTo(1.716038, 4);
  });

  it("converts the National Grid true origin sensibly", () => {
    // E 400000, N -100000 is the true origin: 49°N, 2°W on Airy.
    const result = osgb36ToWgs84(400000, 0)!;
    expect(result.lat).toBeGreaterThan(49.8);
    expect(result.lat).toBeLessThan(50.0);
    expect(result.lon).toBeCloseTo(-2.0, 1);
  });

  it("converts a Leeds city-centre grid reference to the right place", () => {
    // Leeds City Square, approximately SE 29800 33300.
    const result = osgb36ToWgs84(429800, 433300)!;
    expect(result.lat).toBeCloseTo(53.795, 2);
    expect(result.lon).toBeCloseTo(-1.548, 2);
  });

  it("converts a central London grid reference to the right place", () => {
    // Trafalgar Square, approximately TQ 30000 80500.
    const result = osgb36ToWgs84(530000, 180500)!;
    expect(result.lat).toBeCloseTo(51.508, 2);
    expect(result.lon).toBeCloseTo(-0.128, 2);
  });

  it("returns null outside the National Grid rather than inventing a position", () => {
    expect(osgb36ToWgs84(-1, 100000)).toBeNull();
    expect(osgb36ToWgs84(900000, 100000)).toBeNull();
    expect(osgb36ToWgs84(Number.NaN, 100000)).toBeNull();
  });
});
