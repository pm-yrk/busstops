import { describe, expect, it } from "vitest";
import {
  ARTIFACT_FORMAT_VERSION,
  checkArtifactLayout,
  currentArtifactLayout,
  describeLayoutCheck,
  TRIP_TILE_DEGREES,
  type ArtifactLayout,
} from "./shards.js";

/*
 * The failure this exists to prevent, in the words it actually used.
 *
 * The trip grid moved from half a degree to a quarter. The Worker asked for Leeds at `215_-7`,
 * the published artifact held it at `107_-4`, three shards came back absent, and the planner
 * answered "No timetable data is published for this area yet". The data was published, complete,
 * and a quarter of a mile from where the reader was looking.
 */
describe("checking an artifact's layout against the reader", () => {
  it("agrees with itself", () => {
    expect(checkArtifactLayout(currentArtifactLayout())).toEqual({ state: "compatible" });
  });

  /* The real one, reconstructed: the artifact on the half-degree grid, the reader on a quarter. */
  it("catches the grid change that made England look empty", () => {
    const halfDegree: ArtifactLayout = { ...currentArtifactLayout(), tripTileDegrees: 0.5 };
    const check = checkArtifactLayout(halfDegree);

    expect(check.state).toBe("mismatch");
    expect(check.state === "mismatch" && check.differences).toEqual([
      { field: "tripTileDegrees", artifact: 0.5, reader: TRIP_TILE_DEGREES },
    ]);
    expect(describeLayoutCheck(check)).toContain("tripTileDegrees");
  });

  it("catches every parameter a reader computes a key from", () => {
    const fields: Array<keyof ArtifactLayout> = [
      "formatVersion",
      "stopTileDegrees",
      "patternTileDegrees",
      "tripTileDegrees",
      "tripWindowHours",
      "tripWindows",
      "departureBuckets",
      "searchPrefixLength",
      "locatorBuckets",
    ];
    for (const field of fields) {
      const current = currentArtifactLayout();
      const changed: ArtifactLayout = { ...current, [field]: (current[field] as number) + 1 };
      const check = checkArtifactLayout(changed);
      expect(check.state, `${field} must be checked`).toBe("mismatch");
    }
  });

  /*
   * An artifact with no declaration is not compatible; it is unchecked. Calling it compatible
   * would be the same assumption that caused the bug, written down as a pass.
   */
  it("says it cannot check an artifact that does not declare its layout", () => {
    expect(checkArtifactLayout(null)).toEqual({ state: "undeclared" });
    expect(checkArtifactLayout(undefined)).toEqual({ state: "undeclared" });
    expect(describeLayoutCheck({ state: "undeclared" })).toContain("cannot be checked");
  });

  it("declares a format version so a shard shape change is visible too", () => {
    expect(currentArtifactLayout().formatVersion).toBe(ARTIFACT_FORMAT_VERSION);
    expect(ARTIFACT_FORMAT_VERSION).toBeGreaterThan(1);
  });

  /**
   * A layout number the reader *follows* is information, not a mismatch.
   *
   * The check exists for the grids a reader has compiled in and cannot adapt to: ask the trip tiles
   * for a quarter-degree id when they were written on an eighth and every key is one that was never
   * written, so the planner reports England as having no timetable instead of reporting that it
   * cannot read one.
   *
   * The map projection's grid is the opposite. `NetworkReader.mapStopGrid` takes it from the
   * artifact's own declaration, which is what lets a build be asked for a finer square without a
   * deploy — so a reader meeting a grid it was not compiled with is working as designed. Comparing
   * it anyway is how re-filing the projection onto sixteenths made `/v1/journeys` answer
   * `artifact_format_mismatch` and refuse to plan at all: a declaration meant to prevent a silent
   * wrong answer produced a loud one instead.
   */
  describe("a layout the reader follows rather than assumes", () => {
    it("does not call a different map-projection grid a mismatch", () => {
      const finer: ArtifactLayout = {
        ...currentArtifactLayout(),
        mapStopTileDegrees: (currentArtifactLayout().mapStopTileDegrees ?? 0.25) / 4,
      };
      expect(checkArtifactLayout(finer)).toEqual({ state: "compatible" });

      const coarser: ArtifactLayout = { ...currentArtifactLayout(), mapStopTileDegrees: 0.25 };
      expect(checkArtifactLayout(coarser)).toEqual({ state: "compatible" });
    });

    it("still calls a different trip grid a mismatch, which is the case it is for", () => {
      const check = checkArtifactLayout({ ...currentArtifactLayout(), tripTileDegrees: 0.5 });
      expect(check.state).toBe("mismatch");
    });
  });
});
