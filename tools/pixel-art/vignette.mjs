import { Canvas } from "./canvas.mjs";
import { V2_W, V2_H, V2_GROUND, GEOMETRIES, vignette2Scene, farBus } from "./vignette2.mjs";

/**
 * The weather vignette's backdrop and its weather layers.
 *
 * The scene itself moved to `vignette2.mjs` when it was redrawn at 176 x 128 — the same
 * generational jump the home page hero made, and for the same reason: at 96 x 72 a shelter is a
 * box with three grey panels in it and every detail that makes a British bus stop recognisable
 * costs more pixels than there are. This module keeps the size constants and the effects, which
 * are drawn over whatever the scene is and therefore have to follow its size.
 *
 * The effects are the whole reason the picture exists, so they get the sky. Nothing here is
 * decoration: each one is the visible form of a number the caption also states.
 */

export const VIGNETTE_W = V2_W;
export const VIGNETTE_H = V2_H;
export const VIGNETTE_GROUND = V2_GROUND;

export { farBus };

export function vignetteScene(options = {}) {
  return vignette2Scene(options);
}

/**
 * Densities are scaled to the picture, not carried over as counts.
 *
 * Thirty-four raindrops read as rain over 96 x 72 and as a light drizzle over 176 x 128, because
 * the area more than tripled. Every count below is written as a density and multiplied by the
 * area, so a future resize does not silently thin the weather out.
 */
/**
 * The effects follow whichever scene they will be laid over.
 *
 * They are absolutely-positioned layers drawn at the scene's exact size, so a 176 x 128 rain
 * layer over the stop page's 320 x 104 world would either stretch — which is the one thing pixel
 * art must never do — or cover two fifths of it. `setEffectGeometry` switches the size the
 * generators below draw at, and the build emits one set per composition.
 */
let EG = { w: V2_W, h: V2_H };

export function setEffectGeometry(name) {
  const g = GEOMETRIES[name] ?? GEOMETRIES.panel;
  EG = { w: g.w, h: g.h };
}

const scaled = (countAt96x72) => Math.round((countAt96x72 * (EG.w * EG.h)) / (96 * 72));

/** A small deterministic generator, so the same weather draws the same way every build. */
function random(seed) {
  let s = seed * 2654435761;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff);
}

export const EFFECTS = {
  /** Rain: short diagonal strokes at one angle, in two densities for parallax. */
  rainNear(seed = 1) {
    const canvas = new Canvas(EG.w, EG.h);
    const next = random(seed);
    for (let i = 0; i < scaled(34); i += 1) {
      const x = Math.floor(next() * EG.w);
      const y = Math.floor(next() * EG.h);
      canvas.line(x, y, x - 3, y + 7, "j");
    }
    return canvas;
  },
  rainFar(seed = 2) {
    const canvas = new Canvas(EG.w, EG.h);
    const next = random(seed);
    for (let i = 0; i < scaled(26); i += 1) {
      const x = Math.floor(next() * EG.w);
      const y = Math.floor(next() * EG.h);
      canvas.line(x, y, x - 1, y + 4, "i");
    }
    return canvas;
  },
  /**
   * What the rain lands on.
   *
   * New at this resolution, and the thing that makes rain read as rain rather than as strokes
   * over a dry street: bright dashes lying flat on the pavement and the road, and a few splashes
   * standing up off them. There was nowhere to put this before — the old picture had no road.
   */
  rainReflections(seed = 11) {
    const canvas = new Canvas(EG.w, EG.h);
    const next = random(seed);
    for (let i = 0; i < scaled(14); i += 1) {
      const x = Math.floor(next() * EG.w);
      const y = VIGNETTE_GROUND + 2 + Math.floor(next() * (EG.h - VIGNETTE_GROUND - 4));
      canvas.hline(x, y, 2 + Math.floor(next() * 4), next() > 0.5 ? "k" : "j");
    }
    // Splashes: a pixel up off the wet surface, which is what says the drops are still falling.
    for (let i = 0; i < scaled(6); i += 1) {
      const x = Math.floor(next() * EG.w);
      const y = VIGNETTE_GROUND + 3 + Math.floor(next() * 10);
      canvas.px(x, y, "k");
      canvas.px(x + 2, y - 1, "j");
    }
    return canvas;
  },
  /** Snow: single pixels and a few two-pixel flakes, no diagonals. */
  snow(seed = 3) {
    const canvas = new Canvas(EG.w, EG.h);
    const next = random(seed);
    for (let i = 0; i < scaled(40); i += 1) {
      const x = Math.floor(next() * EG.w);
      const y = Math.floor(next() * EG.h);
      canvas.px(x, y, "W");
      if (next() > 0.7) canvas.px(x + 1, y, "R");
    }
    // Settled snow along the kerb and the shelter roof, because snow that never lands is rain.
    for (let x = 0; x < EG.w; x += 1) {
      if (next() > 0.25) canvas.px(x, VIGNETTE_GROUND - 1, "W");
    }
    return canvas;
  },
  /** Sun: a disc with a soft corona, for the clear and high-UV scenes. */
  sun() {
    const canvas = new Canvas(36, 36);
    canvas.disc(17, 17, 9, "Z");
    canvas.disc(17, 17, 8, "z");
    canvas.ring(17, 17, 12, "%");
    canvas.ring(17, 17, 15, "%");
    return canvas;
  },
  /** Fog: horizontal bands, densest low, which is how fog actually sits. */
  fog() {
    /*
     * Fog, third attempt. The first drew a rectangle of dither across the middle; the second
     * faded in but still read as a visible moire pattern laid over the picture.
     *
     * What actually reads as fog at this size is horizontal banding — mist sits in layers — with
     * the density varying along each band rather than pixel by pixel. So this draws soft
     * horizontal runs of varying length, thickest low down, and leaves the top third alone.
     */
    const canvas = new Canvas(EG.w, EG.h);
    const next = random(7);
    const from = Math.round(EG.h * 0.2);

    /*
     * Fourth attempt, and the failure this time was density rather than shape.
     *
     * The bands were right and there were far too many of them: three runs on most rows over a
     * picture with three times the area of the one they were tuned for buried the shelter under a
     * white blizzard. Fog is something you see the street *through*. Every other row, one run,
     * and only where mist actually collects.
     */
    for (let y = from; y < EG.h; y += 2) {
      const depth = (y - from) / (EG.h - from);
      if (next() > 0.18 + depth * 0.4) continue;
      const x = Math.floor(next() * EG.w);
      const len = Math.round(8 + next() * 28 * (0.4 + depth));
      canvas.hline(x, y, len, depth > 0.65 ? "W" : "R");
    }
    return canvas;
  },
  /** Wind: streaks that curl, plus something actually being blown along. */
  wind() {
    /*
     * The first pass drew three straight lines in the sky, which read as scratches on the image.
     * Wind is legible when something is being carried by it and when the streaks bend, so these
     * taper and lift at their trailing end, and there is a leaf and a scrap of paper in them.
     */
    const canvas = new Canvas(EG.w, EG.h);
    const streak = (x, y, len, lift) => {
      canvas.hline(x, y, len, "R");
      canvas.hline(x + len, y - lift, 4, "Q");
      canvas.px(x + len + 4, y - lift - 1, "Q");
    };
    // Placed against the sky this composition actually has, rather than carried over from one a
    // third the size — the old coordinates all landed in the top-left corner.
    streak(4, 12, 34, 1);
    streak(52, 20, 44, 2);
    streak(18, 30, 28, 2);
    streak(88, 38, 38, 1);
    streak(10, 48, 24, 1);
    streak(104, 8, 30, 1);

    // A leaf, tumbling, and a scrap of paper below it: the storytelling that says "windy".
    canvas.px(118, 18, "4");
    canvas.px(119, 17, "3");
    canvas.px(120, 18, "4");
    canvas.px(119, 19, "2");
    canvas.rect(64, 54, 4, 2, "W");
    canvas.px(68, 53, "R");
    return canvas;
  },
  /** Heat: a shimmer above the tarmac, drawn as broken horizontal dashes. */
  heat() {
    /*
     * A shimmer over the tarmac, so it is the full scene height with everything above the road
     * left empty — the first pass drew it as a short strip that the composition then placed in
     * the sky, where hot air does not shimmer.
     */
    const canvas = new Canvas(EG.w, EG.h);
    for (let band = 0; band < 3; band += 1) {
      const y = VIGNETTE_GROUND + 12 + band * 4;
      for (let x = band * 9; x < EG.w; x += 29) {
        canvas.hline(x, y, 7, "%");
        canvas.hline(x + 7, y - 1, 5, "%");
      }
    }
    return canvas;
  },
};
