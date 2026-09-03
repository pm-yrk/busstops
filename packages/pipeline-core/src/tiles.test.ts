import { describe, expect, it } from "vitest";
import {
  JOURNEY_TILE_DEGREES,
  corridorBoundingBox,
  tileIdFor,
  tilesForBoundingBox,
  tilesForCoordinates,
} from "./tiles.js";

const LEEDS = { lat: 53.7997, lon: -1.5492 };
const BRADFORD = { lat: 53.7938, lon: -1.7519 };

describe("spatial tiling", () => {
  it("puts nearby points in the same tile", () => {
    expect(tileIdFor(LEEDS)).toBe(tileIdFor({ lat: 53.81, lon: -1.54 }));
  });

  it("separates points across a tile boundary", () => {
    expect(tileIdFor({ lat: 53.49, lon: -1.5 })).not.toBe(tileIdFor({ lat: 53.51, lon: -1.5 }));
  });

  it("handles negative longitudes without collapsing tiles together", () => {
    // Truncation toward zero would map -0.2 and 0.2 to the same tile; flooring must not.
    expect(tileIdFor({ lat: 51.5, lon: -0.2 })).not.toBe(tileIdFor({ lat: 51.5, lon: 0.2 }));
  });

  it("returns every tile a bounding box touches, including at the edges", () => {
    const tiles = tilesForBoundingBox({ south: 53.4, north: 53.6, west: -1.6, east: -1.4 });
    expect(tiles).toContain(tileIdFor({ lat: 53.45, lon: -1.55 }));
    expect(tiles).toContain(tileIdFor({ lat: 53.55, lon: -1.45 }));
    expect(tiles.length).toBeGreaterThanOrEqual(2);
  });

  it("collects the distinct tiles a route's stops fall in", () => {
    const tiles = tilesForCoordinates([LEEDS, { lat: 53.8, lon: -1.55 }, BRADFORD]);
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(new Set(tiles).size).toBe(tiles.length);
  });

  it("expands the corridor by the walking margin, so a stop just outside stays visible", () => {
    const tight = corridorBoundingBox(LEEDS, LEEDS, 0);
    const margined = corridorBoundingBox(LEEDS, LEEDS, 1200);

    expect(margined.north).toBeGreaterThan(tight.north);
    expect(margined.south).toBeLessThan(tight.south);
    expect(margined.east).toBeGreaterThan(tight.east);
    expect(margined.west).toBeLessThan(tight.west);

    // A kilometre or so, not a degree: the margin must not quietly widen the search area.
    expect(margined.north - LEEDS.lat).toBeLessThan(0.05);
  });

  it("covers both endpoints whichever order they are given in", () => {
    const forward = corridorBoundingBox(LEEDS, BRADFORD, 500);
    const reverse = corridorBoundingBox(BRADFORD, LEEDS, 500);
    expect(forward).toEqual(reverse);
    expect(forward.west).toBeLessThanOrEqual(BRADFORD.lon);
    expect(forward.east).toBeGreaterThanOrEqual(LEEDS.lon);
  });

  it("keeps a local journey inside a small number of tiles", () => {
    const corridor = corridorBoundingBox(LEEDS, BRADFORD, 1200);
    expect(tilesForBoundingBox(corridor).length).toBeLessThanOrEqual(4);
  });

  it("uses a tile size a local journey fits inside", () => {
    expect(JOURNEY_TILE_DEGREES).toBeGreaterThan(0.1);
    expect(JOURNEY_TILE_DEGREES).toBeLessThanOrEqual(1);
  });
});
