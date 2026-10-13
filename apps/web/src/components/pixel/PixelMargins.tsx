import type { CSSProperties } from "react";
import { ART } from "./sprites/generated.js";
import "./PixelMargins.css";

/**
 * Two quiet walls, one either side of a page's reading column.
 *
 * The approved direction asks for restrained decoration at the edges: the column should sit in a
 * street rather than on a white field. This is that and no more — a pale brick wall with a
 * downpipe and a bit of ivy on it, at the outside of the content, doing nothing and saying
 * nothing.
 *
 * It is a background image on a fixed-width element rather than an `<img>`, because it is
 * decoration in the strictest sense: there is nothing here for a screen reader to be told, and a
 * page whose margins were announced would be worse for it. `repeat-y` is what lets one 240-pixel
 * strip dress a column of any height; the brick courses divide that height exactly, so the tile
 * joins without a seam.
 *
 * Both sides are drawn rather than one being mirrored. A CSS flip would put the downpipe and the
 * shadow on the wrong face, which on a wall is the difference between light coming off the street
 * and light coming out of the page.
 */

export type MarginFeature = "ivy" | "lantern";

const MARGINS = {
  ivy: { left: ART.marginIvyLeft!, right: ART.marginIvyRight! },
  lantern: { left: ART.marginLanternLeft!, right: ART.marginLanternRight! },
} as const;

export interface PixelMarginsProps {
  /** What the walls carry. Defaults to ivy, which is the quietest of them. */
  feature?: MarginFeature;
}

export function PixelMargins({ feature = "ivy" }: PixelMarginsProps) {
  const art = MARGINS[feature];
  /*
   * The tile's own size travels with it.
   *
   * The stylesheet used to name 28 by 240, which was true of the ivy strip and stopped being
   * true the moment the lantern one was drawn at twice the height so its lamp would appear once
   * a screen rather than three times. A `background-size` that disagrees with the image scales
   * the art — the one thing this whole system exists to prevent.
   */
  const box = (side: "left" | "right"): CSSProperties =>
    ({
      backgroundImage: `url(${art[side].src})`,
      "--art-w": art[side].w,
      "--art-h": art[side].h,
    }) as CSSProperties;

  return (
    <div className="pixel-margins" aria-hidden="true">
      <span className="pixel-margins__wall pixel-margins__wall--left" style={box("left")} />
      <span className="pixel-margins__wall pixel-margins__wall--right" style={box("right")} />
    </div>
  );
}
