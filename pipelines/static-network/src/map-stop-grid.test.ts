import { describe, expect, it } from "vitest";
import { tileIdFor } from "@busstops/pipeline-core";
import type { Coordinate, Stop } from "@busstops/contracts";
import {
  MAP_STOP_TILE_DEGREES,
  STOP_TILE_DEGREES,
  mapStopTileDegreesFromEnv,
  currentArtifactLayout,
  mapStopTilesForBoundingBox,
  stopTilesForBoundingBox,
  stopTilesForShapes,
  tileForMapStop,
} from "./shards.js";

/**
 * The map projection is filed on its own named grid, and a reader has to ask for it on the grid
 * the artifact was written on rather than on the one the reader was compiled with.
 *
 * The grid is currently the same size as the stop tiles. Finer squares are the only lever left on
 * a viewport that walks 2.18 MiB of projection to draw four hundred markers — the records are
 * already as thin as they usefully get — but the national publish is write-bound and both a
 * sixteenth and an eighth of a degree timed the bootstrap out with nothing published at all, so
 * the constant is back where the build can afford it. What these tests protect is the machinery
 * that makes changing it a one-line change, and the compatibility rule that makes it safe.
 *
 * The failure guarded against is not a slow map but an empty one: ask a family for a tile id on
 * the wrong grid and the object was never written, so the viewport reads no stops at all and
 * reports no degradation while doing it, which is the worst kind of wrong.
 */

const LEEDS = { west: -1.62, south: 53.75, east: -1.46, north: 53.84 };

function stopAt(coordinate: Coordinate): Stop {
  return { locationCoordinate: coordinate } as unknown as Stop;
}

describe("the grid the map projection is filed on", () => {
  it("is never coarser than the stop tiles, and says so in the layout", () => {
    expect(MAP_STOP_TILE_DEGREES).toBeLessThanOrEqual(STOP_TILE_DEGREES);
    /*
     * Declared, so a reader meeting an artifact written on another grid can tell rather than
     * guess. An artifact that predates the field declares nothing and the reader falls back to
     * the stop grid, which is what every artifact published so far was written on.
     */
    expect(currentArtifactLayout().mapStopTileDegrees).toBe(MAP_STOP_TILE_DEGREES);
  });

  it("covers a city viewport in no more area than the full stop records do", () => {
    const coarse = stopTilesForBoundingBox(LEEDS);
    const fine = mapStopTilesForBoundingBox(LEEDS);
    /*
     * Area, not tile count. A Leeds viewport spans two squares on the quarter-degree grid and
     * four on an eighth — the count is an accident of where the lines fall — while the area each
     * square covers, and so the text walked to draw the markers in it, is what the saving is
     * made of. The two are equal today and the inequality is the direction of travel: whatever
     * this constant is set to, the projection must never be filed on squares bigger than the
     * family it exists to avoid reading.
     */
    const area = (tiles: string[], size: number) => tiles.length * size * size;
    expect(area(fine, MAP_STOP_TILE_DEGREES)).toBeLessThanOrEqual(area(coarse, STOP_TILE_DEGREES));
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
   * The Worker deploys before the data is rebuilt, so for a while a reader that knows a new grid
   * is serving an artifact written on the old one. `readTiles` keeps only the tiles the index
   * lists, so asking that artifact for an id on the reader's grid requests nothing at all and the
   * viewport comes back with no stops on it. The reader takes the grid from the artifact's own
   * declared layout for exactly this reason, which only works if the tile namer can be asked for
   * a grid it was not compiled with — including the quarter-degree grid every published artifact
   * so far was written on.
   */
  it("can name tiles on whichever grid the artifact declares, not just its own", () => {
    expect(mapStopTilesForBoundingBox(LEEDS, STOP_TILE_DEGREES)).toEqual(
      stopTilesForBoundingBox(LEEDS),
    );
    const finer = mapStopTilesForBoundingBox(LEEDS, STOP_TILE_DEGREES / 4);
    expect(finer).not.toEqual(mapStopTilesForBoundingBox(LEEDS, STOP_TILE_DEGREES));
    expect(finer.length).toBeGreaterThan(1);
  });

  /*
   * The grid is a number the build is given, and a build given nonsense must not invent a grid.
   *
   * Only squares that nest inside a stop tile are accepted. A grid that does not divide the
   * quarter degree files a stop in a tile that no bounding-box walk names, and the symptom is a
   * viewport returning fewer markers than it should while reporting no degradation — which is
   * exactly the silent failure the declared-layout machinery exists to prevent. So an
   * unrecognised value falls back to the grid every published artifact was written on, rather
   * than to the nearest thing that looks like it.
   */
  describe("the grid a build is asked for", () => {
    it("takes the nesting squares and nothing else", () => {
      expect(mapStopTileDegreesFromEnv("0.25")).toBe(STOP_TILE_DEGREES);
      expect(mapStopTileDegreesFromEnv("0.125")).toBe(STOP_TILE_DEGREES / 2);
      expect(mapStopTileDegreesFromEnv("0.0625")).toBe(STOP_TILE_DEGREES / 4);
    });

    it("falls back to the stop grid rather than approximating an odd one", () => {
      // Absent, blank, nonsense, and numbers that do not divide a stop tile.
      for (const asked of [undefined, "", "   ", "fine", "0", "-0.125", "0.1", "0.2", "0.03125"]) {
        expect(mapStopTileDegreesFromEnv(asked)).toBe(STOP_TILE_DEGREES);
      }
    });

    it("is what the compiled constant and the declared layout both report", () => {
      expect(MAP_STOP_TILE_DEGREES).toBe(
        mapStopTileDegreesFromEnv(process.env.MAP_STOP_TILE_DEGREES),
      );
      expect(currentArtifactLayout().mapStopTileDegrees).toBe(MAP_STOP_TILE_DEGREES);
    });
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
