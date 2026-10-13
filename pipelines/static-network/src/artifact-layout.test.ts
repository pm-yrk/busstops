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
});
