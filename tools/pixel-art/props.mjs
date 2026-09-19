import { Canvas } from "./canvas.mjs";
import { text, textWidth } from "./font.mjs";

/**
 * Street furniture and interior props, at the same resolution as the rest of the artwork.
 *
 * The rule these all follow is the one the bus and the cast already follow: a prop is drawn at a
 * size where its identifying details fit, and is then scaled by whole numbers. A traffic cone is
 * a cone because it has a white band and a square base, not because it is an orange triangle; a
 * monitor is a monitor because it has a bezel, a stand and something on the screen. Anything that
 * needs to be smaller than its details allow belongs in the 16-unit icon set instead.
 *
 * Light falls from the upper left throughout, and every free-standing object gets a short
 * contact shadow, because a sprite with no shadow floats.
 */

/* ------------------------------------------------------------ roadworks */

/** A cone: orange body, white band, square base, and a highlight down the lit side. */
export function cone({ h = 22 } = {}) {
  const w = Math.round(h * 0.8);
  const c = new Canvas(w, h);
  const baseH = Math.max(2, Math.round(h * 0.12));
  const tipW = 2;
  // Body, widening evenly from tip to base so the taper lands on whole pixels.
  for (let i = 0; i < h - baseH; i++) {
    const t = i / (h - baseH - 1);
    const bw = Math.round(tipW + t * (w - 6 - tipW));
    const x = Math.round((w - bw) / 2);
    c.hline(x, i + 1, bw, "s");
    c.px(x, i + 1, "t");
    if (bw > 3) c.px(x + bw - 1, i + 1, "q");
  }
  // The reflective band, set into the body rather than drawn across it.
  const bandY = Math.round((h - baseH) * 0.45);
  for (let j = 0; j < Math.max(2, Math.round(h * 0.14)); j++) {
    for (let x = 0; x < w; x++) if (c.get(x, bandY + j) !== ".") c.px(x, bandY + j, "R");
  }
  c.rect(1, h - baseH, w - 2, baseH, "r");
  c.hline(1, h - baseH, w - 2, "s");
  c.hline(0, h - 1, w, "=");
  return c;
}

/** Red-and-white striped barrier on two feet, the kind that fences off a hole in the road. */
export function barrier({ w = 40, h = 22 } = {}) {
  const c = new Canvas(w, h);
  const boardH = 9;
  for (let x = 0; x < w; x++) {
    const stripe = Math.floor(x / 5) % 2 === 0;
    c.vline(x, 1, boardH, stripe ? "t" : "R");
  }
  c.hline(0, 1, w, "s");
  c.hline(0, boardH, w, "M");
  c.frame(0, 1, w, boardH, "M");
  // Legs, splayed, with feet.
  for (const lx of [3, w - 5]) {
    c.vline(lx, boardH + 1, h - boardH - 3, "N");
    c.vline(lx + 1, boardH + 1, h - boardH - 3, "M");
    c.rect(lx - 2, h - 2, 6, 1, "M");
  }
  c.hline(0, h - 1, w, "=");
  return c;
}

/**
 * The amber matrix board on its yellow trailer.
 *
 * The message is drawn in the pixel font on a dark matrix, which is what makes it read as a sign
 * rather than as a yellow box. It is decoration: the caller passes short generic words, never a
 * real closure, because a drawing that states a fact the data has not got is a drawing that lies.
 */
export function messageBoard({ lines = ["ROAD", "WORKS", "AHEAD"] } = {}) {
  const w = 62;
  const h = 78;
  const c = new Canvas(w, h);
  const boardH = 44;

  // Trailer: yellow body, dark chassis, two wheels.
  c.rect(6, h - 18, w - 12, 9, "z");
  c.hline(6, h - 18, w - 12, "Z");
  c.hline(6, h - 10, w - 12, "y");
  c.frame(6, h - 18, w - 12, 9, "M");
  for (const wx of [13, w - 19]) {
    c.disc(wx, h - 6, 4, "K");
    c.disc(wx, h - 6, 2, "N");
    c.px(wx, h - 6, "P");
  }
  c.hline(4, h - 1, w - 8, "=");
  // The mast.
  c.rect(w / 2 - 2, boardH, 4, h - 18 - boardH, "N");
  c.vline(w / 2 - 2, boardH, h - 18 - boardH, "P");

  // The board: dark matrix in a yellow case.
  c.rect(0, 0, w, boardH, "z");
  c.frame(0, 0, w, boardH, "y");
  c.rect(3, 3, w - 6, boardH - 6, "K");
  c.frame(3, 3, w - 6, boardH - 6, "L");
  // Matrix dots, so the dark panel reads as LEDs rather than as a hole.
  for (let y = 4; y < boardH - 4; y += 2) for (let x = 4; x < w - 4; x += 2) c.px(x, y, "L");

  const lineH = 7;
  const top = Math.round((boardH - lines.length * lineH) / 2) + 1;
  lines.forEach((line, i) => {
    const tw = textWidth(line);
    text(c, Math.round((w - tw) / 2), top + i * lineH, line, "Z");
  });
  return c;
}

/** Yellow diversion sign with a black arrow, on a post. */
export function diversionSign({ w = 40, h = 46, arrow = "right" } = {}) {
  const c = new Canvas(w, h);
  const boardH = 26;
  c.rect(0, 0, w, boardH, "z");
  c.frame(0, 0, w, boardH, "K");
  c.hline(1, 1, w - 2, "Z");
  // Arrow: a shaft and a solid head, drawn on the pixel grid rather than as a glyph.
  const midY = Math.round(boardH / 2);
  const dir = arrow === "right" ? 1 : -1;
  const tipX = arrow === "right" ? w - 7 : 6;
  const tailX = arrow === "right" ? 7 : w - 8;
  c.rect(Math.min(tipX, tailX), midY - 1, Math.abs(tipX - tailX), 3, "K");
  for (let i = 0; i < 7; i++) c.vline(tipX - dir * i, midY - i, i * 2 + 1, "K");
  // Post.
  c.rect(w / 2 - 2, boardH, 4, h - boardH - 1, "P");
  c.vline(w / 2 - 2, boardH, h - boardH - 1, "R");
  c.vline(w / 2 + 1, boardH, h - boardH - 1, "N");
  c.hline(w / 2 - 5, h - 1, 10, "=");
  return c;
}

/** A road worker in a hi-vis jacket and hard hat. */
export function worker({ h = 44 } = {}) {
  const c = new Canvas(24, h);
  const headY = 6;
  /*
   * A hard hat: a domed crown and a brim that stops short of the eyes.
   *
   * The first one put a twelve-pixel brim across the top of the face and the whole cast came out
   * looking like it was on a beach holiday. A hat has to leave the eyes visible or the character
   * has no expression, which is the one thing the people in this artwork are for.
   */
  c.rect(9, headY - 4, 6, 2, "Z");
  c.rect(8, headY - 3, 8, 3, "z");
  c.hline(9, headY - 4, 6, "Z");
  c.vline(15, headY - 3, 3, "y");
  c.rect(7, headY, 10, 1, "y");
  // Face, below the brim.
  c.rect(9, headY + 1, 6, 6, "B");
  c.rect(9, headY + 1, 6, 1, "C");
  c.px(10, headY + 3, "K");
  c.px(13, headY + 3, "K");
  c.hline(11, headY + 5, 2, "C");
  // Hi-vis jacket with two reflective bands.
  c.rect(6, headY + 8, 12, 14, "z");
  c.hline(6, headY + 8, 12, "Z");
  c.vline(17, headY + 8, 14, "y");
  c.hline(6, headY + 13, 12, "R");
  c.hline(6, headY + 17, 12, "R");
  // Arms.
  c.rect(3, headY + 9, 3, 10, "z");
  c.rect(18, headY + 9, 3, 10, "z");
  c.rect(3, headY + 19, 3, 3, "B");
  c.rect(18, headY + 19, 3, 3, "B");
  // Trousers and boots.
  c.rect(7, headY + 22, 4, h - headY - 26, "a");
  c.rect(13, headY + 22, 4, h - headY - 26, "a");
  c.rect(6, h - 4, 5, 3, "K");
  c.rect(13, h - 4, 5, 3, "K");
  c.hline(5, h - 1, 14, "=");
  c.outerOutline("K");
  return c;
}

/* --------------------------------------------------------- control room */

/**
 * A desk monitor. `screen` picks what is on it, because three identical screens read as
 * wallpaper and an operations desk is interesting precisely because each one shows a
 * different kind of thing.
 */
export function monitor({ w = 44, h = 34, screen = "chart" } = {}) {
  const c = new Canvas(w, h);
  const panelH = h - 7;
  c.rect(0, 0, w, panelH, "M");
  c.frame(0, 0, w, panelH, "L");
  c.rect(2, 2, w - 4, panelH - 4, "K");
  const sx = 2;
  const sy = 2;
  const sw = w - 4;
  const sh = panelH - 4;

  if (screen === "map") {
    c.rect(sx, sy, sw, sh, "f");
    // Roads, then live incidents on them.
    for (let y = sy + 3; y < sy + sh; y += 6) c.hline(sx + 1, y, sw - 2, "g");
    for (let x = sx + 4; x < sx + sw; x += 7) c.vline(x, sy + 1, sh - 2, "g");
    for (const [dx, dy] of [
      [6, 5],
      [15, 11],
      [26, 7],
      [31, 17],
      [11, 19],
    ]) {
      c.disc(sx + dx, sy + dy, 1, "t");
      c.px(sx + dx, sy + dy, "u");
    }
  } else if (screen === "chart") {
    c.rect(sx, sy, sw, sh, "K");
    const bars = [4, 7, 5, 9, 6, 11, 8, 12, 7, 10];
    bars.forEach((v, i) => {
      const bx = sx + 2 + i * 3;
      if (bx + 2 > sx + sw) return;
      c.rect(bx, sy + sh - 2 - v, 2, v, i % 3 === 0 ? "t" : "d");
    });
    c.hline(sx + 1, sy + sh - 2, sw - 2, "N");
  } else {
    // An operational list: rows of status, most quiet, a couple not.
    c.rect(sx, sy, sw, sh, "K");
    for (let i = 0; i < Math.floor((sh - 3) / 4); i++) {
      const y = sy + 2 + i * 4;
      c.px(sx + 2, y, i === 1 ? "t" : i === 3 ? "z" : "4");
      c.hline(sx + 4, y, sw - 8 - (i % 3) * 3, "O");
    }
  }
  /*
   * A short streak in one corner, not a stripe across the whole panel.
   *
   * The first version ran a diagonal the full diagonal of the screen, which at four times scale
   * was a white bar straight through the chart it was supposed to be glazing. Glass reads from a
   * hint in a corner; anything more is a reflection of something the picture does not contain.
   */
  for (let i = 0; i < 6; i++) {
    c.px(sx + sw - 3 - i, sy + 1 + i, "=");
    c.px(sx + sw - 2 - i, sy + 1 + i, "=");
  }

  // Stand and foot.
  c.rect(w / 2 - 2, panelH, 4, 4, "N");
  c.rect(w / 2 - 7, h - 3, 14, 2, "M");
  c.hline(w / 2 - 8, h - 1, 16, "=");
  return c;
}

/** A plant in a terracotta pot: several tonal clusters, never one green blob. */
export function pottedPlant({ w = 22, h = 34 } = {}) {
  const c = new Canvas(w, h);
  const potH = 11;
  const potY = h - potH;
  c.rect(3, potY, w - 6, potH - 1, "r");
  c.hline(3, potY, w - 6, "s");
  c.rect(2, potY, w - 4, 3, "s");
  c.hline(2, potY, w - 4, "t");
  c.vline(w - 4, potY + 3, potH - 4, "q");
  // Foliage: three overlapping clusters with their own tones.
  const clusters = [
    [w / 2 - 6, potY - 14, 6, "3"],
    [w / 2 + 3, potY - 11, 5, "2"],
    [w / 2 - 1, potY - 19, 6, "4"],
  ];
  for (const [cx, cy, r, tone] of clusters) c.disc(Math.round(cx), Math.round(cy), r, tone);
  c.disc(Math.round(w / 2 - 2), potY - 20, 3, "5");
  c.vline(w / 2, potY - 12, 12, "2");
  c.hline(1, h - 1, w - 2, "=");
  return c;
}

/** A mug, because a control desk without one is a stock photograph. */
export function mug({ w = 14, h = 14 } = {}) {
  const c = new Canvas(w, h);
  /*
   * Body first, handle beside it — never through it.
   *
   * The first attempt drew the handle as a ring and then cleared a rectangle out of it to make
   * room for the body, which took a bite out of the mug as well and left something that read as
   * a torn label. The handle lives entirely to the right of the body's last column, so nothing
   * has to be erased and the silhouette closes on its own.
   */
  const bx = 1;
  const by = 3;
  const bw = 8;
  const bh = 10;
  c.rect(bx, by, bw, bh, "W");
  c.vline(bx, by, bh, "X");
  c.vline(bx + bw - 1, by, bh, "Q");
  c.hline(bx, by + bh - 1, bw, "P");
  // Rim, and the tea in it.
  c.rect(bx, by, bw, 2, "R");
  c.rect(bx + 1, by, bw - 2, 1, "C");
  // A red band, because everything else on this desk is red or black.
  c.rect(bx, by + 4, bw, 2, "s");
  c.hline(bx, by + 4, bw, "t");
  // Handle: two prongs off the body and a back, drawn as squares on the grid.
  const hx = bx + bw;
  c.hline(hx, by + 3, 2, "Q");
  c.hline(hx, by + 7, 2, "Q");
  c.vline(hx + 2, by + 3, 5, "Q");
  c.px(hx + 2, by + 4, "R");
  c.hline(0, h - 1, bw + 2, "=");
  c.outerOutline("K");
  return c;
}

/** A desk: a top with a lit edge, a shadow under it, and two legs. */
export function desk({ w = 150, h = 26 } = {}) {
  const c = new Canvas(w, h);
  c.rect(0, 0, w, 4, "6");
  c.hline(0, 0, w, "8");
  c.hline(0, 3, w, "M");
  c.rect(0, 4, w, 2, "+");
  for (const lx of [5, w - 9]) c.rect(lx, 6, 4, h - 7, "N");
  c.hline(0, h - 1, w, "=");
  return c;
}

/* ------------------------------------------------------------- scenery */

/** A stone or brick wall, with courses and a capping stone. */
export function wall({ w = 80, h = 30, kind = "stone" } = {}) {
  const c = new Canvas(w, h);
  /*
   * Brick and stone differ in colour first and in coursing second.
   *
   * Drawn only with `7` and `6` the two came out the same tan and the only thing telling them
   * apart was the size of the courses, which at a distance is nothing at all. Brick borrows the
   * deep end of the red ramp, which is what a weathered English brick actually is.
   */
  const body = kind === "brick" ? "q" : "8";
  const dark = kind === "brick" ? "L" : "7";
  const mortar = kind === "brick" ? "O" : "7";
  c.rect(0, 2, w, h - 2, body);
  // Capping.
  c.rect(0, 0, w, 3, "9");
  c.hline(0, 0, w, "R");
  c.hline(0, 2, w, dark);
  // Courses, offset every other row so it reads as masonry rather than as graph paper.
  const courseH = kind === "brick" ? 4 : 6;
  const unit = kind === "brick" ? 9 : 13;
  for (let y = 3 + courseH; y < h; y += courseH) {
    c.hline(0, y, w, mortar);
    const offset = ((y / courseH) % 2) * Math.round(unit / 2);
    for (let x = offset; x < w; x += unit) c.vline(x, y - courseH + 1, courseH - 1, mortar);
  }
  c.speckle(0, 3, w, h - 3, dark, 0.06, 7);
  return c;
}

/** Iron railings on a low plinth. */
export function railings({ w = 70, h = 26 } = {}) {
  const c = new Canvas(w, h);
  c.rect(0, h - 3, w, 3, "8");
  c.hline(0, h - 3, w, "9");
  c.hline(0, 4, w, "M");
  c.hline(0, h - 9, w, "M");
  for (let x = 2; x < w; x += 6) {
    c.vline(x, 2, h - 5, "L");
    c.px(x, 1, "M");
  }
  return c;
}

/** A pigeon. Small, grey, and doing nothing in particular. */
export function pigeon({ facing = "right" } = {}) {
  const c = new Canvas(16, 14);
  // Body: a teardrop with the tail at the blunt end, lit along the back.
  c.rect(3, 5, 8, 5, "N");
  c.hline(3, 5, 8, "O");
  c.hline(4, 4, 6, "P");
  c.rect(4, 9, 7, 2, "M");
  // Folded wing, a shade darker so the body still reads underneath it.
  c.rect(4, 6, 6, 3, "M");
  c.hline(4, 6, 6, "N");
  // Tail.
  c.rect(0, 7, 4, 2, "M");
  c.px(0, 9, "N");
  // Neck and head, with the green flash pigeons actually have.
  c.rect(10, 3, 3, 4, "O");
  c.px(10, 5, "3");
  c.disc(12, 3, 2, "P");
  c.px(13, 2, "Q");
  c.px(13, 3, "K");
  c.px(14, 4, "z");
  c.px(15, 4, "y");
  // Legs.
  c.vline(6, 11, 2, "y");
  c.vline(9, 11, 2, "y");
  c.px(5, 12, "y");
  c.px(10, 12, "y");
  c.hline(4, 13, 7, "=");
  const out = facing === "left" ? c.flipped() : c;
  out.outerOutline("K");
  return out;
}

/** A cat, sitting. */
export function cat({ facing = "left" } = {}) {
  const c = new Canvas(18, 18);
  // Body and haunch.
  c.disc(7, 12, 5, "L");
  c.rect(3, 9, 9, 8, "L");
  // Head with ears.
  c.disc(13, 7, 4, "L");
  c.px(11, 3, "L");
  c.px(12, 3, "L");
  c.px(12, 2, "L");
  c.px(15, 3, "L");
  c.px(16, 3, "L");
  c.px(16, 2, "L");
  c.px(12, 6, "z");
  c.px(15, 6, "z");
  c.px(13, 8, "M");
  // Tail curled round the front paws.
  c.hline(2, 16, 8, "M");
  c.px(1, 15, "M");
  c.hline(4, 17, 10, "=");
  const out = facing === "right" ? c.flipped() : c;
  out.outerOutline("K");
  return out;
}

/** A tiny red car, for a road that needs traffic other than buses. */
export function car({ facing = "right" } = {}) {
  const c = new Canvas(38, 18);
  c.rect(2, 8, 34, 6, "s");
  c.rect(9, 3, 19, 6, "s");
  c.hline(9, 3, 19, "t");
  c.rect(11, 4, 7, 4, "h");
  c.rect(19, 4, 7, 4, "h");
  c.px(11, 4, "j");
  c.px(19, 4, "j");
  c.hline(2, 8, 34, "t");
  c.hline(2, 13, 34, "q");
  c.px(35, 9, "z");
  c.px(2, 9, "R");
  for (const wx of [10, 28]) {
    c.disc(wx, 14, 3, "K");
    c.disc(wx, 14, 1, "P");
  }
  c.hline(2, 17, 34, "=");
  const out = facing === "left" ? c.flipped() : c;
  return out;
}
