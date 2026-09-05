import { Canvas } from "./canvas.mjs";

/**
 * The weather vignette's backdrop: one shelter, a strip of pavement, and nothing else.
 *
 * Deliberately not a landscape. The hero on the home page is a street with three planes of depth
 * and a skyline; this is a single object at one stop, sized to sit beside a paragraph of text.
 * Putting a whole street here would compete with the arrival board for the reader's attention and
 * lose — and it would say nothing about the weather, which is the only reason the picture exists.
 *
 * Drawn at 96 x 56 art pixels, so it shows at 3x on a phone and 4x on a desktop card without ever
 * being scaled by a fraction.
 */

export const VIGNETTE_W = 96;
/*
 * 72 rather than 56.
 *
 * The first composition had the ground at 47 and a 44-pixel person, which left six pixels of sky
 * — and an umbrella held over a raised arm went straight off the top of the picture. Sky is not
 * empty space here: it is where the weather happens.
 */
export const VIGNETTE_H = 72;

/** The pavement line, so a person and a shelter share one ground. */
export const VIGNETTE_GROUND = 60;

/**
 * A single shelter, drawn as the object rather than as a box.
 *
 * A UK cantilever shelter is a cranked roof carried on two posts at the back, glazed at the back
 * and one end, open to the road. Everything here follows from that: the roof overhangs the front,
 * the posts are behind the glass, and the glass shows the pavement through it rather than being a
 * flat blue panel.
 */
function shelter(canvas, x, y) {
  const w = 46;
  const roofY = y;
  const glassTop = y + 5;
  const glassBottom = VIGNETTE_GROUND - 1;

  // Rear posts, drawn first so the glass sits in front of them.
  canvas.rect(x + 3, roofY + 3, 2, glassBottom - roofY - 2, "N");
  canvas.rect(x + w - 6, roofY + 3, 2, glassBottom - roofY - 2, "M");

  /*
   * Glass. Three panels with mullions between them, filled with a dark cool grey that gets
   * lighter towards the bottom — glass in front of a shaded pavement, not a blue rectangle.
   */
  for (let panel = 0; panel < 3; panel += 1) {
    const px = x + 4 + panel * 13;
    /*
     * Glass is a gradient, not a fill: darkest at the top where it reflects the shelter's own
     * roof, lightest at the bottom where the pavement shows through it. The first pass painted
     * three identical diagonal stripes in every panel, which read as stripes painted on a board.
     */
    canvas.rect(px, glassTop, 12, glassBottom - glassTop, "g");
    canvas.rect(px, glassTop + 4, 12, glassBottom - glassTop - 4, "h");
    canvas.rect(px, glassBottom - 5, 12, 5, "i");
    canvas.rect(px, glassBottom - 2, 12, 2, "j");
    // One rake per panel, offset panel to panel, because a reflection is not a repeat pattern.
    /*
     * One short rake per panel, in the lower half only and in the *next* tone up rather than the
     * brightest one. Full-height bright diagonals read as venetian blinds, which is what the last
     * pass looked like.
     */
    const rake = panel === 1 ? 5 : panel === 2 ? 2 : 7;
    const rakeTop = glassTop + Math.round((glassBottom - glassTop) * 0.45);
    canvas.line(px + rake, glassBottom - 2, px + rake + 3, rakeTop, "j");
    canvas.px(px + rake + 3, rakeTop, "k");
    if (panel < 2) canvas.vline(px + 12, glassTop, glassBottom - glassTop, "M");
  }
  canvas.frame(x + 3, glassTop, w - 6, glassBottom - glassTop, "M");

  /*
   * The roof: a slab with a lit top edge, a shadowed underside, and a front lip that overhangs
   * the glass. The overhang is what makes it read as a cantilever rather than as a lid.
   */
  canvas.rect(x, roofY, w, 3, "N");
  canvas.hline(x, roofY, w, "P");
  canvas.hline(x + 1, roofY - 1, w - 2, "Q");
  canvas.hline(x, roofY + 3, w, "L");
  canvas.rect(x - 2, roofY + 1, 3, 3, "N");
  canvas.hline(x - 2, roofY + 1, 3, "P");

  // The bench inside: a seat rail and two brackets, seen through the glass.
  canvas.rect(x + 8, glassBottom - 12, 26, 2, "y");
  canvas.hline(x + 8, glassBottom - 12, 26, "z");
  canvas.vline(x + 10, glassBottom - 10, 10, "M");
  canvas.vline(x + 31, glassBottom - 10, 10, "M");

  // A poster case at the far end, lit from inside — the warm note in a cool object.
  canvas.rect(x + w - 5, glassTop + 3, 4, 16, "K");
  canvas.rect(x + w - 4, glassTop + 4, 2, 14, "Z");
  canvas.hline(x + w - 4, glassTop + 4, 2, "W");

  // The shadow the shelter casts onto the pavement, in alpha so it darkens what is beneath.
  canvas.rect(x + 2, VIGNETTE_GROUND, w - 2, 2, "-");
  canvas.rect(x + 6, VIGNETTE_GROUND + 2, w - 10, 1, "=");
}

/** The stop flag, on its own pole beside the shelter. */
function flag(canvas, x, y) {
  canvas.vline(x, y, VIGNETTE_GROUND - y, "O");
  canvas.vline(x + 1, y, VIGNETTE_GROUND - y, "N");
  canvas.rect(x - 4, y, 11, 9, "s");
  canvas.hline(x - 4, y, 11, "t");
  canvas.hline(x - 4, y + 8, 11, "r");
  // The bus mark on the flag: a body, a window band and two wheels, at four pixels tall.
  canvas.rect(x - 2, y + 2, 7, 4, "W");
  canvas.hline(x - 1, y + 3, 5, "h");
  canvas.px(x - 1, y + 6, "K");
  canvas.px(x + 3, y + 6, "K");
  canvas.rect(x + 2, VIGNETTE_GROUND, 2, 1, "-");
}

/** Kerb, pavement slabs and the edge of the carriageway. */
function ground(canvas) {
  // Pavement.
  canvas.rect(0, VIGNETTE_GROUND, VIGNETTE_W, 4, "Q");
  canvas.hline(0, VIGNETTE_GROUND, VIGNETTE_W, "R");
  // Slab joints, in two offset courses so the paving reads as laid rather than printed.
  for (let x = 3; x < VIGNETTE_W; x += 11) canvas.vline(x, VIGNETTE_GROUND + 1, 2, "P");
  for (let x = 8; x < VIGNETTE_W; x += 11) canvas.vline(x, VIGNETTE_GROUND + 3, 1, "P");
  // Kerb, then the gutter's shadow and the tarmac.
  canvas.hline(0, VIGNETTE_GROUND + 4, VIGNETTE_W, "P");
  canvas.hline(0, VIGNETTE_GROUND + 5, VIGNETTE_W, "O");
  canvas.rect(0, VIGNETTE_GROUND + 6, VIGNETTE_W, VIGNETTE_H - VIGNETTE_GROUND - 6, "M");
  canvas.hline(0, VIGNETTE_GROUND + 6, VIGNETTE_W, "N");
}

/**
 * The backdrop, in one of two lights.
 *
 * `night` is not a colour filter over the day scene: the sky darkens, the glass loses its
 * highlight, and the poster case and the shelter's interior become the brightest things in the
 * picture, which is what a bus shelter actually looks like after dark.
 */
export function vignetteScene({ night = false } = {}) {
  const canvas = new Canvas(VIGNETTE_W, VIGNETTE_H, night ? "f" : "S");

  if (night) {
    // A gradient with a dithered seam: two butted rectangles drew a visible horizon line across
    // the sky at the exact height nothing is happening.
    canvas.rect(0, 0, VIGNETTE_W, 18, "a");
    for (let x = 0; x < VIGNETTE_W; x += 1) {
      if (x % 2 === 0) canvas.px(x, 18, "a");
      if (x % 3 === 0) canvas.px(x, 19, "a");
    }
    canvas.rect(0, 20, VIGNETTE_W, 18, "f");
  } else {
    canvas.rect(0, 0, VIGNETTE_W, 20, "T");
  }

  ground(canvas);
  shelter(canvas, 26, 24);
  flag(canvas, 18, 28);

  if (night) {
    // Warm light spilling out of the shelter onto the pavement in front of it.
    canvas.rect(28, VIGNETTE_GROUND, 42, 2, "%");
  }

  return canvas;
}

/**
 * Weather effects, as their own transparent layers.
 *
 * Kept out of the backdrop so the same shelter serves every condition, and so a layer can be
 * animated — or, under `prefers-reduced-motion`, simply held still — without touching the scene.
 */
export const EFFECTS = {
  /** Rain: short diagonal strokes at one angle, in two densities for parallax. */
  rainNear(seed = 1) {
    const canvas = new Canvas(VIGNETTE_W, VIGNETTE_H);
    let s = seed * 2654435761;
    const next = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff);
    for (let i = 0; i < 34; i += 1) {
      const x = Math.floor(next() * VIGNETTE_W);
      const y = Math.floor(next() * VIGNETTE_H);
      canvas.line(x, y, x - 2, y + 5, "j");
    }
    return canvas;
  },
  rainFar(seed = 2) {
    const canvas = new Canvas(VIGNETTE_W, VIGNETTE_H);
    let s = seed * 2654435761;
    const next = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff);
    for (let i = 0; i < 26; i += 1) {
      const x = Math.floor(next() * VIGNETTE_W);
      const y = Math.floor(next() * VIGNETTE_H);
      canvas.line(x, y, x - 1, y + 3, "i");
    }
    return canvas;
  },
  /** Snow: single pixels and a few two-pixel flakes, no diagonals. */
  snow(seed = 3) {
    const canvas = new Canvas(VIGNETTE_W, VIGNETTE_H);
    let s = seed * 2654435761;
    const next = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff);
    for (let i = 0; i < 40; i += 1) {
      const x = Math.floor(next() * VIGNETTE_W);
      const y = Math.floor(next() * VIGNETTE_H);
      canvas.px(x, y, "W");
      if (next() > 0.7) canvas.px(x + 1, y, "R");
    }
    return canvas;
  },
  /** Sun: a disc with a soft corona, for the clear and high-UV scenes. */
  sun() {
    const canvas = new Canvas(28, 28);
    canvas.disc(13, 13, 7, "Z");
    canvas.disc(13, 13, 6, "z");
    canvas.ring(13, 13, 9, "%");
    canvas.ring(13, 13, 11, "%");
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
    const canvas = new Canvas(VIGNETTE_W, VIGNETTE_H);
    let seed = 7;
    const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);

    for (let y = 14; y < VIGNETTE_H; y += 1) {
      const depth = (y - 14) / (VIGNETTE_H - 14);
      // Runs get longer and more frequent towards the ground, which is where mist collects.
      // Two runs at most: the previous pass drew five and buried the shelter it was meant to
      // be drifting past.
      const runs = depth > 0.35 ? 2 : 1;
      for (let i = 0; i < runs; i += 1) {
        if (next() > 0.35 + depth * 0.45) continue;
        const x = Math.floor(next() * VIGNETTE_W);
        const len = Math.round(4 + next() * 12 * (0.4 + depth));
        canvas.hline(x, y, len, depth > 0.6 ? "W" : "R");
      }
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
    const canvas = new Canvas(VIGNETTE_W, VIGNETTE_H);
    const streak = (x, y, len, lift) => {
      canvas.hline(x, y, len, "R");
      canvas.hline(x + len, y - lift, 3, "Q");
      canvas.px(x + len + 3, y - lift - 1, "Q");
    };
    streak(2, 8, 20, 1);
    streak(30, 14, 26, 1);
    streak(10, 22, 16, 2);
    streak(52, 30, 22, 1);
    streak(6, 38, 14, 1);

    // A leaf, tumbling, and a scrap of paper below it: the storytelling that says "windy".
    canvas.px(64, 12, "4");
    canvas.px(65, 11, "3");
    canvas.px(66, 12, "4");
    canvas.px(65, 13, "2");
    canvas.rect(38, 41, 3, 2, "W");
    canvas.px(41, 40, "R");
    return canvas;
  },
  /** Heat: a shimmer above the tarmac, drawn as broken horizontal dashes. */
  heat() {
    /*
     * A shimmer over the tarmac, so it is the full scene height with everything above the road
     * left empty — the first pass drew it as a short strip that the composition then placed in
     * the sky, where hot air does not shimmer.
     */
    const canvas = new Canvas(VIGNETTE_W, VIGNETTE_H);
    /*
     * Long broken bands that step by a pixel along their length, which is what makes them read as
     * air moving rather than as a row of dashes. Only over the tarmac, where heat actually rises.
     */
    // Two bands, not three, and shorter runs: the last pass drew a bright dashed stripe across
    // the road that read as road markings rather than as hot air.
    for (let band = 0; band < 2; band += 1) {
      const y = VIGNETTE_GROUND + 5 + band * 3;
      for (let x = band * 7; x < VIGNETTE_W; x += 23) {
        canvas.hline(x, y, 5, "%");
        canvas.hline(x + 5, y - 1, 4, "%");
      }
    }
    return canvas;
  },
};
