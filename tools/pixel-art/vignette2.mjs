import { Canvas } from "./canvas.mjs";

/**
 * The weather vignette, second generation.
 *
 * The first one was 96 x 72 art pixels: a shelter, a strip of pavement and nothing else. It was
 * the right composition and the wrong resolution — at that size a shelter is a box with three
 * grey panels in it, and every detail that makes a British bus stop recognisable (the timetable
 * case, the perch, the tactile paving, the kerb, the bin) costs more pixels than it had.
 *
 * This is the same idea at 176 x 128, which is the same generational jump the home page hero
 * made. What the extra pixels buy is not decoration: it is the difference between a rectangle
 * that stands for a shelter and a shelter you recognise before you have read the caption.
 *
 * Still deliberately not a landscape. There is one shelter, the frontage behind it, a strip of
 * road, and room above for weather to happen in — because the weather is the only reason the
 * picture exists, and sky is where it happens.
 */

export const V2_W = 176;
export const V2_H = 128;

/** The pavement surface: where a person's feet and a shelter's posts share one ground. */
export const V2_GROUND = 98;

/**
 * The stop page wants the same street at a different shape.
 *
 * The scene was written against three module constants, which was right while there was one
 * composition and wrong the moment there were two: the stop page wants a wide world — sky,
 * skyline, a row of frontage, several people — and the map-sized 176 x 128 portrait is the wrong
 * aspect for it entirely. Rather than a second copy of two hundred lines of drawing code that
 * would immediately start to drift from this one, the geometry is a value the composer sets.
 *
 * Module-scoped mutable state is normally a smell. It is safe here and nowhere else: this module
 * runs only inside `tools/pixel-art/build.mjs`, which is a single-threaded script that draws one
 * canvas at a time and writes PNGs. Nothing imports it at runtime.
 */
export const GEOMETRIES = {
  panel: { w: 176, h: 128, ground: 98 },
  /*
   * The stop page's world. Wide enough for a skyline, a terrace, a shelter and a few people
   * without any of them touching, and tall enough that the sky is a place weather can happen in
   * rather than a strip above the roofline.
   */
  world: { w: 320, h: 104, ground: 78 },
};

function withKerb(g) {
  return { ...g, kerb: g.ground + 10, road: g.ground + 14 };
}

let GEO = withKerb(GEOMETRIES.panel);

/* --------------------------------------------------------------- backdrop */

/**
 * Sky, as three bands rather than a fill.
 *
 * A flat sky behind a dark shelter reads as a cut-out. Lightest at the horizon and cooling
 * upwards is what a British overcast actually does, and it gives the roofline something to sit
 * against.
 */
function sky(c, { night }) {
  if (night) {
    c.rect(0, 0, GEO.w, 30, "a");
    c.rect(0, 30, GEO.w, 22, "f");
    c.rect(0, 52, GEO.w, 22, "g");
    // A few stars, thinned towards the horizon where a town's own light drowns them.
    for (const [x, y] of [
      [14, 8],
      [41, 15],
      [63, 6],
      [92, 12],
      [118, 9],
      [149, 17],
      [166, 7],
      [28, 24],
      [133, 26],
    ]) {
      c.px(x, y, "j");
    }
    return;
  }
  /*
   * Three bands, with the edges broken.
   *
   * A hard line across the whole width reads as a rule someone drew, not as weather. Alternating
   * pixels along each boundary is enough to dissolve it at any scale this is drawn at.
   */
  c.rect(0, 0, GEO.w, 26, "S");
  c.rect(0, 26, GEO.w, 26, "T");
  c.rect(0, 52, GEO.w, 22, "W");
  for (let x = 0; x < GEO.w; x += 2) {
    c.px(x, 26, "S");
    c.px(x + 1, 27, "T");
    c.px(x, 52, "T");
    c.px(x + 1, 53, "W");
  }
}

/**
 * The frontage behind the stop: brick, two windows, a door, a parapet.
 *
 * A stop is in front of something. Without it the shelter floats and the pavement runs to a blank
 * edge; with it the picture has a depth the first version could not afford.
 */
function frontage(c, { night }) {
  /*
   * A low wall at the back of the pavement, not a backdrop.
   *
   * The first pass started this at the shelter's roofline and filled everything behind it, which
   * left four rows of sky — and sky is not empty space in this picture, it is where the rain and
   * the snow and the sun have to happen. A stop is in front of something; that something is a
   * garden wall and the ground floor of a frontage, and it belongs below the shelter's roof.
   */
  const top = 66;
  const bottom = GEO.ground;

  c.rect(0, top, GEO.w, bottom - top, "7");
  /*
   * Courses with perpends, not stripes.
   *
   * Continuous horizontal lines every fourth row read as weatherboarding. A brick bond is a bed
   * joint with vertical joints staggered between courses, and at this size two dark pixels per
   * brick is enough for the eye to finish the job.
   */
  for (let y = top + 4; y < bottom; y += 4) {
    c.hline(0, y, GEO.w, "6");
    const offset = ((y - top) / 4) % 2 === 0 ? 0 : 5;
    for (let x = offset; x < GEO.w; x += 10) c.vline(x, y + 1, 3, "6");
  }
  // A coping course on top, catching the light, which is what gives a wall its edge.
  c.rect(0, top, GEO.w, 2, "9");
  c.hline(0, top + 2, GEO.w, "6");

  /*
   * One window, at the left, where the shelter does not cover it. Two were drawn before and both
   * were hidden — one behind the glass and one behind the bin, which is a lot of pixels spent on
   * nothing.
   */
  const wx = 2;
  const wy = top + 6;
  const ww = 14;
  const wh = 20;
  c.rect(wx - 1, wy - 1, ww + 2, wh + 2, "6");
  c.rect(wx, wy, ww, wh, night ? "z" : "g");
  if (night) {
    c.rect(wx, wy, ww, 7, "Z");
  } else {
    c.rect(wx, wy + wh - 7, ww, 7, "h");
    c.line(wx + 2, wy + wh - 2, wx + ww - 4, wy + 2, "i");
  }
  c.vline(wx + Math.floor(ww / 2), wy, wh, "6");
  c.rect(wx - 2, wy + wh, ww + 4, 2, "9");
}

/**
 * A street tree, near-black so it stays editorial rather than storybook.
 *
 * Reaching in from the right edge, over the frontage, so the composition has something above the
 * roofline that is not weather.
 */
function tree(c, { night }) {
  /*
   * A street tree as a silhouette, built up rather than carved out.
   *
   * Two passes went wrong here for the same reason. The first drew equal discs either side of a
   * middle one, which makes a heart. The second tried to fix the outline by punching a disc of
   * `.` out of it — and `.` is transparent, not sky, so it cut a hole straight through the
   * picture to the page behind. Nothing in this scene may erase; the silhouette has to be right
   * from what is put down.
   */
  const x = 148;
  const foot = GEO.ground;
  const crown = 46;

  // A trunk that tapers, and leans very slightly, because a straight bar reads as a post.
  for (let y = foot; y > crown; y -= 1) {
    const width = y > foot - 24 ? 3 : 2;
    const lean = Math.round((foot - y) / 26);
    c.rect(x - lean, y, width, 1, "2");
    c.px(x - lean + width - 1, y, "1");
  }

  // Two branches into the canopy, which is what decides where the mass goes.
  c.line(x - 1, crown + 8, x - 11, crown - 2, "2");
  c.line(x + 1, crown + 8, x + 8, crown + 1, "2");

  /*
   * The canopy: one heavy mass low and left, a lighter one high and right, and a small one
   * filling the notch between them. Uneven radii and uneven centres, so the outline is a tree
   * rather than a cloud.
   */
  const masses = [
    [x - 7, crown - 6, 12],
    [x + 7, crown - 14, 8],
    [x - 1, crown - 20, 6],
    [x + 12, crown - 3, 5],
  ];
  for (const [cx, cy, r] of masses) c.disc(cx, cy, r, "2");

  // Light from the upper left: a lit flank inside the mass, never on its outline.
  c.disc(x - 10, crown - 11, 6, "3");
  c.disc(x - 12, crown - 15, 3, "4");
  c.disc(x + 4, crown - 19, 3, "3");

  // A pit at the base, so it is planted rather than growing out of a paving slab.
  c.rect(x - 4, foot - 2, 10, 2, "L");
  if (night) c.rect(x - 4, foot - 2, 10, 1, "M");
}

/* ---------------------------------------------------------------- shelter */

/**
 * A UK cantilever shelter, drawn as the object.
 *
 * Cranked roof carried on two rear posts, glazed at the back and at one end, open to the road.
 * Everything follows from that: the roof overhangs the front, the posts are behind the glass, and
 * the glass shows the pavement through it rather than being a flat blue panel.
 */
function shelter(c, { night }) {
  const x = 18;
  const w = 80;
  const roof = 42;
  const glassTop = roof + 7;
  const glassBottom = GEO.ground - 1;

  // Rear posts first, so the glass sits in front of them.
  c.rect(x + 4, roof + 5, 3, glassBottom - roof - 4, "N");
  c.rect(x + w - 8, roof + 5, 3, glassBottom - roof - 4, "M");

  /*
   * Glass: darkest at the top where it reflects the shelter's own roof, lightest at the bottom
   * where the pavement shows through. Four panels, because at this width three would be too wide
   * to read as glazing.
   */
  const panels = 4;
  const panelW = Math.floor((w - 10) / panels);
  for (let p = 0; p < panels; p += 1) {
    const px = x + 5 + p * panelW;
    c.rect(px, glassTop, panelW - 1, glassBottom - glassTop, "g");
    c.rect(px, glassTop + 6, panelW - 1, glassBottom - glassTop - 6, "h");
    c.rect(px, glassBottom - 8, panelW - 1, 8, "i");
    c.rect(px, glassBottom - 3, panelW - 1, 3, "j");
    // One short rake per panel, offset, in the lower half — a reflection, not a repeat pattern.
    const rake = [9, 4, 12, 6][p];
    const rakeTop = glassTop + Math.round((glassBottom - glassTop) * 0.5);
    c.line(px + rake, glassBottom - 3, px + rake + 4, rakeTop, "j");
    c.px(px + rake + 4, rakeTop, "k");
    // Mullion.
    if (p > 0) c.vline(px - 1, glassTop, glassBottom - glassTop, "N");
  }

  /*
   * A perch bench, which is what most modern shelters have instead of a seat: a rail on two
   * brackets, at leaning height rather than sitting height.
   */
  const benchY = glassBottom - 22;
  c.rect(x + 10, benchY, w - 22, 3, "C");
  c.hline(x + 10, benchY, w - 22, "B");
  c.rect(x + 14, benchY + 3, 2, glassBottom - benchY - 3, "N");
  c.rect(x + w - 22, benchY + 3, 2, glassBottom - benchY - 3, "N");

  /*
   * The timetable case: a lit box on the end panel with a paper timetable in it. This is the
   * single detail that says "bus stop" faster than anything else in the picture, and it did not
   * fit at the old resolution.
   */
  /*
   * Landscape and lower, which is how a timetable case is actually mounted: at reading height on
   * the end panel, wider than it is tall. Portrait and full height read as a filing panel.
   */
  const tx = x + w - 26;
  const ty = glassTop + 14;
  c.rect(tx - 1, ty - 1, 24, 20, "N");
  c.rect(tx, ty, 22, 18, night ? "y" : "R");
  // A timetable is a header and columns of times, and at this size that is one dark band and a
  // few rows of ticks. Painted in the paper's own tone rather than in black, or it reads as a
  // barcode rather than as print.
  c.rect(tx + 1, ty + 1, 20, 3, night ? "Z" : "N");
  for (let row = 0; row < 4; row += 1) {
    const ry = ty + 7 + row * 3;
    c.hline(tx + 2, ry, 5, night ? "Z" : "O");
    c.hline(tx + 9, ry, 4, night ? "Z" : "O");
    c.hline(tx + 15, ry, 5, night ? "Z" : "O");
  }
  c.frame(tx, ty, 22, 18, "M");

  /*
   * The roof, last, so it overhangs everything: a deck, a fascia, and a drip edge the rain leaves
   * by. The front edge sits lower than the back, which is the crank.
   */
  /*
   * A deck, a fascia and a drip edge, and the deck a row higher at the back than at the front —
   * which is the crank, and the thing that makes it a shelter roof rather than a dark bar.
   */
  c.rect(x - 4, roof + 1, w + 12, 3, "M");
  c.hline(x - 4, roof + 1, w + 12, "O");
  c.hline(x - 5, roof, w + 6, "N");
  c.rect(x - 4, roof + 4, w + 12, 2, "L");
  c.hline(x - 4, roof + 6, w + 12, "K");
  // Downstand at the open front, so the roof reads as a plane rather than a line.
  c.rect(x + w + 4, roof + 1, 4, 7, "L");
  c.px(x + w + 7, roof + 1, "M");

  if (night) {
    // A light under the roof, and what it lands on. Not a glow: a lit strip and a pool.
    c.rect(x + 12, roof + 7, w - 26, 1, "Z");
    c.rect(x + 8, glassBottom, w - 16, 2, "%");
  }
  return { x, w, roof, glassBottom };
}

/** The stop flag: pole, cantilevered arm, and the flag itself with its bus mark. */
function stopFlag(c, { night }) {
  const x = 118;
  const top = 50;
  c.rect(x, top, 3, GEO.ground - top, "N");
  c.vline(x + 2, top, GEO.ground - top, "M");
  c.rect(x - 2, GEO.ground - 3, 7, 3, "M");

  // The flag, red, reading away from the shelter.
  c.rect(x + 3, top, 26, 16, "s");
  c.rect(x + 3, top, 26, 2, "t");
  c.hline(x + 3, top + 15, 26, "q");
  // A bus mark on it: a body, two windows, two wheels. Three pixels tall is enough at this size.
  c.rect(x + 8, top + 5, 16, 7, "W");
  c.rect(x + 10, top + 6, 4, 3, night ? "j" : "g");
  c.rect(x + 15, top + 6, 4, 3, night ? "j" : "g");
  c.px(x + 10, top + 12, "K");
  c.px(x + 21, top + 12, "K");
}

/** A litter bin, because every stop has one and its absence is noticeable. */
function bin(c) {
  const x = 150;
  const top = GEO.ground - 20;
  c.rect(x, top + 2, 13, 18, "N");
  c.rect(x + 1, top + 3, 11, 16, "M");
  c.rect(x - 1, top, 15, 3, "O");
  c.rect(x + 3, top + 1, 7, 2, "K");
  // Banding, so it is a bin and not a post.
  c.hline(x + 1, top + 9, 11, "O");
  c.hline(x + 1, top + 14, 11, "O");
}

/* -------------------------------------------------------------- the ground */

/**
 * Pavement, tactile paving, kerb and a strip of road.
 *
 * The first version had a pavement line and nothing under it. This is the part of a British
 * street that is most recognisable at a glance and it is almost all in the last thirty rows.
 */
function ground(c, { night }) {
  // Pavement.
  c.rect(0, GEO.ground, GEO.w, GEO.kerb - GEO.ground, "P");
  c.hline(0, GEO.ground, GEO.w, "Q");
  // Paving joints, so the slabs read as slabs rather than as a band of grey.
  for (let x = 6; x < GEO.w; x += 22) c.vline(x, GEO.ground + 1, GEO.kerb - GEO.ground - 1, "O");
  c.hline(0, GEO.ground + 5, GEO.w, "O");

  // Tactile paving at the kerb edge: buff, with its blisters.
  c.rect(0, GEO.kerb - 4, GEO.w, 4, "8");
  for (let x = 2; x < GEO.w; x += 4) {
    c.px(x, GEO.kerb - 3, "9");
    c.px(x, GEO.kerb - 1, "7");
  }

  // Kerb: a face and a top, with the top catching the light.
  c.rect(0, GEO.kerb, GEO.w, GEO.road - GEO.kerb, "O");
  c.hline(0, GEO.kerb, GEO.w, "Q");
  c.hline(0, GEO.road - 1, GEO.w, "N");

  /*
   * Road. Mid-grey rather than near-black: the first pass painted it "M" with a dense two-tone
   * speckle and the bottom fifth of the picture turned into a band of static that outweighed
   * everything above it. Asphalt in daylight is grey, and its texture is sparse.
   */
  c.rect(0, GEO.road, GEO.w, GEO.h - GEO.road, "N");
  for (let y = GEO.road + 2; y < GEO.h; y += 3) {
    for (let x = (y * 7) % 13; x < GEO.w; x += 13) c.px(x, y, "M");
  }

  // Double yellow lines, breaking for the stop cage, in the paint tone rather than a wash.
  for (const y of [GEO.road + 2, GEO.road + 4]) {
    for (let x = 0; x < GEO.w; x += 1) {
      if (x > 26 && x < 132) continue;
      c.px(x, y, "z");
    }
  }
  /*
   * The clearway marking, and not a red slab.
   *
   * A wash was painted here in the 32%-alpha red — and `px` replaces a pixel rather than
   * compositing onto it, so the asphalt underneath was destroyed and a translucent red over the
   * page came back as pale pink. Exactly the bug the hero's bus bay had, made twice.
   *
   * A UK bus stop clearway is marked with a single thick yellow line where the double yellows
   * break, which is both the truth and the thing that reads at this size.
   */
  c.rect(26, GEO.road + 2, 106, 3, "z");
  c.hline(26, GEO.road + 2, 106, "Z");

  // A gully at the kerb, because water has to go somewhere and it is a stop's own landmark.
  c.rect(138, GEO.road + 1, 11, 5, "M");
  for (let i = 1; i < 5; i += 2) c.hline(139, GEO.road + 1 + i, 9, "K");

  if (night) {
    // Under lamplight the kerb catches a line and the road stays dark.
    c.rect(0, GEO.road, GEO.w, GEO.h - GEO.road, "M");
    c.hline(0, GEO.kerb, GEO.w, "P");
  }
}

/** The shelter's shadow on the pavement, which is what stops it floating. */
function shelterShadow(c, s) {
  c.rect(s.x - 2, GEO.ground, s.w + 10, 2, "-");
  c.rect(s.x + 2, GEO.ground + 2, s.w + 2, 1, "=");
}

/* ------------------------------------------------------------------ scene */

/**
 * What the wide composition has room for and the panel does not.
 *
 * The panel is a portrait of one shelter. The world is a stretch of street, and a stretch of
 * street that is a shelter with a hundred and fifty empty pixels beside it is worse than the
 * portrait, not better. These are the things that turn the extra width into somewhere: a skyline
 * so the sky has a horizon, clouds so it has weather, and along the right-hand pavement the
 * ordinary furniture of a British street — lamp, railings, bench, a second tree.
 *
 * Everything here is scenery. Nothing in it states a fact about the stop.
 */
function worldBackdrop(c, { night }) {
  const wallTop = 66;

  /*
   * A skyline, drawn in sky tones rather than in masonry ones.
   *
   * Distance in this palette is a matter of contrast, not of blur: the further a block is, the
   * closer its colour sits to the sky it stands against. Two ranks, the back one paler, is enough
   * to read as a city rather than as a row of boxes.
   */
  /*
   * Back rank paler and taller, front rank darker and lower.
   *
   * The first attempt had it the other way round and the result was a row of dark pillars in
   * front of a pale one — tombstones, not a city. Distance in this palette is contrast: the
   * further away a block is, the closer its colour sits to the sky behind it, and the front rank
   * has to stay low or it fills the sky the weather needs.
   */
  const ranks = night
    ? [
        { tone: "a", top: 26, seed: 11, min: 12, span: 20 },
        { tone: "f", top: 40, seed: 3, min: 16, span: 14 },
      ]
    : [
        { tone: "Q", top: 26, seed: 11, min: 12, span: 20 },
        { tone: "P", top: 40, seed: 3, min: 16, span: 14 },
      ];
  for (const rank of ranks) {
    let x = -4;
    let n = rank.seed;
    while (x < GEO.w) {
      n = (n * 1103515245 + 12345) & 0x7fffffff;
      const w = rank.min + (n % rank.span);
      n = (n * 1103515245 + 12345) & 0x7fffffff;
      const top = rank.top + (n % 12);
      c.rect(x, top, w, wallTop - top, rank.tone);
      // A parapet line, and a hint of a lift shaft on the taller ones.
      c.hline(x, top, w, night ? "g" : "O");
      if (w > 16) c.rect(x + 3, top - 4, 4, 4, rank.tone);
      // Lit windows at night: a few, never a grid.
      if (night) {
        for (let wy = top + 4; wy < wallTop - 3; wy += 6)
          for (let wx = x + 2; wx < x + w - 2; wx += 5)
            if (((wx * 37 + wy * 101) ^ (wx * wy)) % 9 < 2) c.px(wx, wy, "z");
      }
      x += w + 1 + (n % 3);
    }
  }

  /* Clouds: blocky, flat-bottomed, and only in the top band where there is room for them. */
  if (!night) {
    for (const [cx, cy, scale] of [
      [34, 9, 1],
      [128, 5, 0],
      [196, 12, 1],
      [268, 7, 0],
    ]) {
      const w = 18 + scale * 8;
      c.rect(cx, cy + 3, w, 4, "W");
      c.rect(cx + 4, cy, w - 10, 4, "W");
      c.rect(cx + 2, cy + 1, 5, 3, "X");
      c.hline(cx, cy + 6, w, "R");
    }
  }
}

/**
 * The pavement furniture, drawn after the ground rather than before it.
 *
 * This was one pass with the skyline, which put the bench and the foot of the lamp post
 * underneath the garden wall and the kerb — the wall is drawn later and is opaque, so a bench
 * thirty pixels tall simply vanished and a lamp post appeared to be growing out of the brickwork.
 * Anything standing *on* the pavement has to be laid down after the pavement is.
 */
function worldStreet(c, { night }) {
  const wallTop = 66;
  /*
   * The right-hand pavement.
   *
   * Placed from the right edge inwards so the composition still works if the canvas is widened
   * again, and spaced so no two objects touch — a lamp post growing out of a bench is the thing
   * that makes a pixel scene look assembled rather than drawn.
   */
  const ground = GEO.ground;

  // Railings along the back of the pavement, behind everything else on it.
  for (let x = 196; x < GEO.w - 4; x += 5) {
    c.vline(x, wallTop - 11, 11, night ? "L" : "M");
  }
  c.hline(196, wallTop - 10, GEO.w - 200, night ? "L" : "M");
  c.hline(196, wallTop - 4, GEO.w - 200, night ? "L" : "M");

  // A lamp post: column, ladder bar, lantern. Lit at night, and it lights the pavement.
  const lampX = 214;
  c.rect(lampX, ground - 46, 3, 46, night ? "L" : "M");
  c.vline(lampX, ground - 46, 46, night ? "M" : "N");
  c.rect(lampX - 2, ground - 2, 7, 2, "M");
  c.rect(lampX - 3, ground - 52, 9, 4, "M");
  c.rect(lampX - 2, ground - 51, 7, 2, night ? "Z" : "P");
  c.rect(lampX - 4, ground - 48, 11, 1, "L");
  if (night) {
    // A pool of light, as alpha over whatever is beneath rather than as a pale disc.
    c.rect(lampX - 10, ground - 3, 24, 3, "%");
    c.rect(lampX - 6, ground - 6, 16, 3, "%");
  }

  // A bench, facing the road.
  const benchX = 238;
  c.rect(benchX, ground - 11, 30, 3, night ? "M" : "6");
  c.hline(benchX, ground - 11, 30, night ? "N" : "7");
  c.rect(benchX, ground - 16, 30, 2, night ? "M" : "6");
  for (const lx of [benchX + 2, benchX + 25]) {
    c.vline(lx, ground - 16, 16, "M");
    c.vline(lx + 1, ground - 8, 8, "M");
  }
  c.rect(benchX - 1, ground, 32, 1, "=");

  // A second tree, further along and a shade cooler, so the two do not read as a copy.
  const treeX = 288;
  const canopy = night ? "1" : "3";
  const canopyLight = night ? "2" : "4";
  c.rect(treeX, ground - 20, 3, 20, night ? "L" : "M");
  c.disc(treeX + 1, ground - 28, 9, canopy);
  c.disc(treeX - 4, ground - 24, 6, canopy);
  c.disc(treeX + 6, ground - 25, 6, canopy);
  c.disc(treeX - 2, ground - 32, 5, canopyLight);
  c.disc(treeX + 4, ground - 30, 4, canopyLight);
  if (!night) c.disc(treeX - 1, ground - 34, 2, "5");
  c.rect(treeX - 6, ground, 15, 1, "=");

  // A pigeon on the railing, because a street with nothing alive on it is a diagram.
  const pigeonX = 202;
  c.rect(pigeonX, wallTop - 15, 5, 3, night ? "M" : "N");
  c.px(pigeonX + 5, wallTop - 16, night ? "M" : "O");
  c.px(pigeonX + 6, wallTop - 15, "y");
  c.px(pigeonX - 1, wallTop - 14, night ? "L" : "M");
}

export function vignette2Scene({ night = false, geometry = "panel" } = {}) {
  GEO = withKerb(GEOMETRIES[geometry] ?? GEOMETRIES.panel);
  const c = new Canvas(GEO.w, GEO.h, ".");
  sky(c, { night });
  const wide = GEO.w >= GEOMETRIES.world.w;
  if (wide) worldBackdrop(c, { night });
  frontage(c, { night });
  tree(c, { night });
  ground(c, { night });
  if (wide) worldStreet(c, { night });
  const s = shelter(c, { night });
  shelterShadow(c, s);
  stopFlag(c, { night });
  bin(c);
  return c;
}

/**
 * A bus approaching, small and in the distance, drawn only when one truthfully is.
 *
 * Separate from the backdrop because it is conditional: the caller knows whether a departure is
 * due, and a bus painted into a scene where none is coming would be the picture telling a lie the
 * rest of the product is careful not to.
 */
export const FAR_BUS_W = 46;
export const FAR_BUS_H = 22;

export function farBus({ night = false } = {}) {
  const c = new Canvas(FAR_BUS_W, FAR_BUS_H, ".");
  const bodyTop = 2;
  const floor = FAR_BUS_H - 4;

  // Body, with the front chamfered rather than square.
  c.rect(1, bodyTop + 2, FAR_BUS_W - 2, floor - bodyTop - 2, "s");
  c.rect(3, bodyTop, FAR_BUS_W - 6, 3, "s");
  c.rect(1, bodyTop + 2, FAR_BUS_W - 2, 2, "t");
  c.rect(1, floor - 4, FAR_BUS_W - 2, 4, "q");
  c.px(FAR_BUS_W - 2, bodyTop + 2, "q");

  // Windows: a strip with mullions, darker at this distance than a near bus.
  for (let i = 0; i < 6; i += 1) {
    // At night a bus is mostly dark with a few lit panes, not a row of identical lamps.
    const lit = night && (i === 1 || i === 3 || i === 4);
    c.rect(4 + i * 7, bodyTop + 4, 5, 6, lit ? "z" : night ? "f" : "g");
  }
  // Destination blind, amber, because that is what you see first down a street.
  c.rect(4, bodyTop + 1, 14, 3, night ? "Z" : "z");

  /*
   * Skirt, then wheels, then the shadow. A solid black bar under the body read as a plinth and
   * hid the wheels inside it, which is the one thing that tells you it is a vehicle.
   */
  c.rect(1, floor - 1, FAR_BUS_W - 2, 1, "L");
  c.disc(9, floor, 2, "K");
  c.disc(FAR_BUS_W - 11, floor, 2, "K");
  c.px(9, floor, "N");
  c.px(FAR_BUS_W - 11, floor, "N");
  c.rect(3, floor + 2, FAR_BUS_W - 6, 1, "-");

  if (night) {
    // Headlights and a tail light, which is most of what a bus is after dark.
    c.px(FAR_BUS_W - 2, floor - 6, "Z");
    c.px(FAR_BUS_W - 2, floor - 5, "Z");
    c.px(1, floor - 6, "t");
  }
  return c;
}
