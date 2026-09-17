import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ART } from "./sprites/generated.js";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

/*
 * The hero's buses.
 *
 * The far carriageway was the near carriageway's drawing under `scaleX(-1)`. A transform mirrors
 * the raster, and the raster has a route number painted on it, so the bus coming up the street
 * carried its own number written backwards — along with its destination blind and every other
 * asymmetric detail on that side. The rule this encodes is that a rasterised number, destination,
 * logo or road-side detail is never mirrored: a vehicle that faces the other way is drawn facing
 * the other way.
 */
describe("the hero street's vehicles", () => {
  it("never mirrors a vehicle to make it face the other way", () => {
    const css = read("./PixelStreetScene.css");
    // The comment explaining the absence is allowed to name it; a declaration is not.
    const declarations = css
      .split("\n")
      .filter((line) => /transform\s*:/.test(line))
      .join("\n");
    expect(declarations).not.toMatch(/scaleX\(\s*-/);
  });

  it("ships a distinct drawing for each direction", () => {
    expect(ART.busFar?.src).toBeTruthy();
    expect(ART.busNear?.src).toBeTruthy();
    expect(ART.busFar?.src).not.toBe(ART.busNear?.src);
    expect(ART.busFar?.src).not.toBe(ART.busMid?.src);
  });

  it("leaves the near bus somewhere to stand", () => {
    // The near bus used to be placed at exactly `h - its height`, which put its wheels on the
    // last row of the composition and read as the frame cutting it off rather than as a road.
    const tsx = read("./PixelStreetScene.tsx");
    expect(tsx).toMatch(/NEAR_LANE_INSET/);
    expect(tsx).not.toMatch(/"--art-y": geometry\.h - near\.h\s*\}/);
  });
});
