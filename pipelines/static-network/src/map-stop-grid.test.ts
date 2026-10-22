import { describe, expect, it } from "vitest";
import { tileIdFor } from "@busstops/pipeline-core";
import type { Coordinate, Stop } from "@busstops/contracts";
import {
  MAP_STOP_TILE_DEGREES,
  STOP_TILE_DEGREES,
  currentArtifactLayout,
  mapStopTilesForBoundingBox,
  stopTilesForBoundingBox,
  stopTilesForShapes,
  tileForMapStop,
} from "./shards.js";

/**
 * The map projection is filed on its own grid, and a reader has to ask for it on that grid.
 *
 * The record was already as thin as it usefully gets — a published `Stop` carries provenance,
 * quality flags and amenities, and none of them are in the projection — so what was left to
 * reduce was the square. A quarter of a degree is about 28km by 17km here and a city viewport is
 * a tenth of that, which is how a Manchester map came to walk 2.18 MiB of projection to draw four
 * hundred markers.
 *
 * The failure this guards against is not a slow map but an empty one: ask the finer family for a
 * quarter-degree tile id and the object was never written, so the viewport reads no stops at all
 * and says so honestly, which is the worst kind of wrong.
 */

const LEEDS = { west: -1.62, south: 53.75, east: -1.46, north: 53.84 };

function stopAt(coordinate: Coordinate): Stop {
  return { locationCoordinate: coordinate } as unknown as Stop;
}

describe("the grid the map projection is filed on", () => {
  it("is finer than the stop tiles, and says so in the layout", () => {
    expect(MAP_STOP_TILE_DEGREES).toBeLessThan(STOP_TILE_DEGREES);
    /*
     * Declared, so a reader meeting an artifact written on the old grid can tell rather than
     * guess. An artifact that predates the field declares nothing and the reader falls back.
     */
    expect(currentArtifactLayout().mapStopTileDegrees).toBe(MAP_STOP_TILE_DEGREES);
  });

  it("covers a city viewport in a smaller total area", () => {
    const coarse = stopTilesForBoundingBox(LEEDS);
    const fine = mapStopTilesForBoundingBox(LEEDS);
    /*
     * Area, not tile count. A Leeds viewport happens to span two squares on either grid — the
     * count is an accident of where the lines fall — while the area each square covers, and so
     * the text walked to draw the markers in it, is four times smaller. The saving was never in
     * the number of objects.
     */
    const area = (tiles: string[], size: number) => tiles.length * size * size;
    /*
     * Strictly less, and not by a target number. The grid was a sixteenth of a degree first and
     * the national build would not pay for it — write-bound, and 7,400 objects timed the
     * bootstrap out — so the figure is what the build affords rather than what reads best. A test
     * that pinned a ratio would have to be edited every time that trade is remeasured, which
     * makes it a statement about today's constant rather than about the property.
     */
    expect(area(fine, MAP_STOP_TILE_DEGREES)).toBeLessThan(area(coarse, STOP_TILE_DEGREES));
  });

  /*
   * The one that matters: what the reader asks for has to be what the publisher wrote.
   */
  it("asks for the tile the publisher filed each stop in", () => {
    const wanted = new Set(mapStopTilesForBoundingBox(LEEDS));
    for (const lat of [53.76, 53.79, 53.83]) {
      for (const lon of [-1.61, -1.55, -1.47]) {
        const tile = tileForMapStop(stopAt({ lat, lon }));
        expect(
          wanted.has(tile),
          `${lat},${lon} is in the viewport but ${tile} is not asked for`,
        ).toBe(true);
        expect(tile).toBe(tileIdFor({ lat, lon }, MAP_STOP_TILE_DEGREES));
      }
    }
  });

  /*
   * The compatibility case, which is the one that would fail silently.
   *
   * The Worker deploys before the data is rebuilt, so for a while a reader that knows the finer
   * grid is serving an artifact written on the coarser one. `readTiles` keeps only the tiles the
   * index lists, so asking that artifact for a sixteenth-of-a-degree id requests nothing at all
   * and the viewport comes back with no stops on it — an empty map that reports no degradation.
   * The reader takes the grid from the artifact's own declared layout for exactly this reason,
   * and these are the two ids it has to be able to produce.
   */
  it("can name a coarse tile for an artifact written before the finer grid", () => {
    const onTheOldGrid = mapStopTilesForBoundingBox(LEEDS, STOP_TILE_DEGREES);
    expect(onTheOldGrid).toEqual(stopTilesForBoundingBox(LEEDS));
    expect(mapStopTilesForBoundingBox(LEEDS)).not.toEqual(onTheOldGrid);
  });

  /* Route detail reads the projection from the route's shape rather than from a viewport. */
  it("names the same grid when the tiles come from a route's shape", () => {
    const shape = [
      { lat: 53.76, lon: -1.6 },
      { lat: 53.8, lon: -1.52 },
    ];
    const fromShape = new Set(stopTilesForShapes([shape], 0.01, MAP_STOP_TILE_DEGREES));
    for (const point of shape) {
      expect(fromShape.has(tileForMapStop(stopAt(point)))).toBe(true);
    }
    // And the default grid is still the coarse one, for the families that are filed on it.
    expect(stopTilesForShapes([shape])).toEqual(
      stopTilesForShapes([shape], 0.01, STOP_TILE_DEGREES),
    );
  });
});
