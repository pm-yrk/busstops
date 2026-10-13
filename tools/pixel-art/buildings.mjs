import { Canvas } from "./canvas.mjs";
import { text } from "./font.mjs";

/**
 * The terrace behind the stop.
 *
 * A façade is not a white box with three grey rectangles: it has a roofline, courses in the
 * brick, window openings with a lintel above and a sill below, a fascia over the shopfront, and
 * a drainpipe down one side. Those are the things that make a building read as a building at
 * thirty pixels wide, so those are what is drawn.
 */

const WALLS = {
  brick: { face: "7", light: "8", dark: "6", course: "6" },
  render: { face: "9", light: "R", dark: "8", course: "8" },
  stone: { face: "8", light: "9", dark: "7", course: "7" },
  // A pale render and a dark brick, so the terrace is not seven shades of the same beige.
  pale: { face: "R", light: "W", dark: "Q", course: "Q" },
  dark: { face: "6", light: "7", dark: "M", course: "M" },
  grey: { face: "P", light: "Q", dark: "N", course: "N" },
};

/** A sash window: opening, glazing bars, a lit or dark interior, a sill and a lintel. */
function window_(c, x, y, w, h, { lit = false, wall }) {
  c.rect(x, y, w, h, lit ? "z" : "g");
  c.rect(x, y, w, 2, lit ? "y" : "f");
  if (lit) {
    c.rect(x + 1, y + 2, w - 2, 2, "Z");
    c.rect(x + 1, y + h - 4, w - 3, 2, "z");
  } else {
    for (let k = 0; k < w + h; k++) {
      const rx = x + k,
        ry = y + 2 + Math.floor(k / 2);
      if (c.get(rx, ry) === "g") c.px(rx, ry, "h");
    }
  }
  c.hline(x, y + Math.floor(h / 2), w, "P"); // transom
  c.vline(x + Math.floor(w / 2), y, h, "P"); // mullion
  c.frame(x - 1, y - 1, w + 2, h + 2, "M");
  c.hline(x - 2, y - 2, w + 4, wall.dark); // lintel
  c.hline(x - 2, y - 3, w + 4, "M");
  c.hline(x - 2, y + h + 1, w + 4, wall.light); // sill
  c.hline(x - 2, y + h + 2, w + 4, "M");
}

export function shopBuilding({
  w = 52,
  h = 88,
  wall = "brick",
  sign = "t",
  signText = "CAFE",
  awning = false,
  floors = 2,
  chimney = true,
  lit = [1],
  shopH = 30,
  shop = true,
  seed = 0,
} = {}) {
  const c = new Canvas(w, h);
  const k = WALLS[wall];
  // Room above the parapet for a chimney; without it the stack was drawn off the top of the sprite.
  const top = chimney ? 9 : 0;

  // ---- wall and courses -------------------------------------------------
  c.rect(0, top + 4, w, h - top - 4, k.face);
  // Courses every fourth row with the perpends offset alternately. Every third row at full
  // contrast read as timber siding; brick is mostly face with the joints only just visible.
  for (let y = top + 8; y < h; y += 4) {
    for (let x = 0; x < w; x += 2) c.px(x, y, k.course); // dashed bed joint
    for (let x = ((y / 4) % 2) * 3; x < w; x += 6) c.px(x, y - 1, k.course);
  }
  c.speckle(0, top + 6, w, h - top - 8, k.dark, 0.04, w + h);
  c.vline(0, top + 4, h - top - 4, k.dark);
  c.vline(w - 1, top + 4, h - top - 4, k.dark);

  // ---- roofline ---------------------------------------------------------
  c.rect(0, top, w, 3, "M"); // parapet coping
  c.hline(0, top, w, "N");
  c.hline(0, top + 3, w, "L");
  c.rect(1, top + 3, w - 2, 2, k.light); // corbel course under the coping
  if (chimney) {
    c.rect(w - 14, 3, 8, 7, k.dark);
    for (let y = 5; y < 10; y += 2) c.hline(w - 14, y, 8, k.face);
    c.rect(w - 15, 1, 10, 2, "M");
    c.hline(w - 15, 1, 10, "N");
    c.rect(w - 13, 0, 2, 2, "L"); // pots
    c.rect(w - 10, 0, 2, 2, "L");
  }

  // ---- upper floors -----------------------------------------------------
  const shopTop = h - shopH;
  const bays = w >= 44 ? 2 : 1;
  const bayW = Math.floor((w - 8) / bays);
  const winW = Math.min(14, bayW - 6);
  for (let f = 0; f < floors; f++) {
    const y = top + 10 + f * 24;
    if (y + 18 > shopTop - 4) break;
    for (let b = 0; b < bays; b++) {
      const x = 5 + b * bayW + Math.floor((bayW - winW) / 2);
      window_(c, x, y, winW, 16, { lit: lit.includes(f * bays + b), wall: k });
    }
  }

  // ---- fascia and shopfront ---------------------------------------------
  if (!shop) {
    // A plain ground floor: a doorway, a step and one tall window. Seven fascias in a row read
    // as one painted stripe across the terrace however much their heights are varied.
    window_(c, 6, shopTop + 4, Math.min(14, w - 14), shopH - 12, { lit: false, wall: k });
    const dx = w - 14;
    c.rect(dx, shopTop + 4, 9, shopH - 7, "r");
    c.rect(dx + 1, shopTop + 5, 7, 4, "j");
    c.hline(dx + 1, shopTop + 10, 7, "q");
    c.px(dx + 7, shopTop + Math.floor(shopH / 2), "Z");
    c.frame(dx - 1, shopTop + 3, 11, shopH - 6, "M");
    c.rect(dx - 1, h - 5, 11, 2, "P");
    c.rect(0, h - 3, w, 3, "M");
    c.hline(0, h - 3, w, "N");
    c.vline(w - 3, 5, shopTop - 5, "N");
    c.vline(w - 2, 5, shopTop - 5, "L");
    return c;
  }
  c.rect(0, shopTop, w, 9, sign);
  c.hline(0, shopTop, w, "K");
  c.hline(0, shopTop + 8, w, "K");
  c.hline(1, shopTop + 1, w - 2, sign === "t" ? "u" : "R");
  const tw = signText.length * 4 - 1;
  text(c, Math.floor((w - tw) / 2), shopTop + 2, signText, sign === "W" ? "K" : "W");

  if (awning) {
    // A striped awning, folded down over the window.
    for (let i = 0; i < w - 4; i++) {
      const stripe = Math.floor(i / 4) % 2 === 0;
      c.vline(2 + i, shopTop + 9, 5, stripe ? "W" : sign);
    }
    c.hline(2, shopTop + 9, w - 4, "L");
    for (let i = 0; i < w - 4; i += 8) c.px(2 + i, shopTop + 14, "M");
    c.hline(2, shopTop + 13, w - 4, "M");
  }

  // ---- shop window and door ---------------------------------------------
  const gy = shopTop + (awning ? 15 : 10);
  const gh = h - gy - 3;
  c.rect(2, gy, w - 12, gh, "f");
  c.rect(2, gy, w - 12, 2, "K");
  // A warm interior showing through, and a reflection across the glass.
  c.rect(4, gy + 3, w - 16, gh - 6, "y");
  // Shelving, stock and a figure at the counter. Speckling the interior read as television static.
  for (let sy = gy + 6; sy < gy + gh - 4; sy += 6) {
    c.hline(4, sy, w - 16, "M");
    for (let sx = 5; sx < w - 13; sx += 4) {
      c.rect(sx, sy - 3, 2, 3, (sx + sy) % 3 === 0 ? "s" : sx % 8 === 1 ? "Z" : "z");
    }
  }
  c.rect(w - 18, gy + gh - 12, 4, 9, "L"); // someone behind the counter
  c.rect(w - 17, gy + gh - 14, 2, 2, "C");
  // The rake and the starting point move per building. One angle repeated down a terrace reads
  // as a stencil rather than as five separate windows.
  const rake = 2 + (seed % 2);
  for (let i = 0; i < (w + gh) * rake; i++) {
    const rx = 2 - (seed % 5) * 3 + i,
      ry = gy + 1 + Math.floor(i / rake);
    if (rx > 1 && rx < w - 10 && ry < gy + gh) {
      c.px(rx, ry, "j");
      c.px(rx + 1, ry, "j");
    }
  }
  c.vline(2 + Math.floor((w - 12) / 2), gy, gh, "M");
  c.frame(1, gy - 1, w - 10, gh + 1, "M");
  // Door with a fanlight.
  c.rect(w - 9, gy, 7, gh, "r");
  c.rect(w - 8, gy + 1, 5, 4, "j");
  c.hline(w - 8, gy + 6, 5, "q");
  c.px(w - 4, gy + Math.floor(gh / 2), "Z"); // handle
  c.frame(w - 10, gy - 1, 9, gh + 1, "M");
  c.rect(0, h - 3, w, 3, "M"); // plinth
  c.hline(0, h - 3, w, "N");

  // ---- drainpipe --------------------------------------------------------
  c.vline(w - 3, 5, shopTop - 5, "N");
  c.vline(w - 2, 5, shopTop - 5, "L");
  for (let y = 12; y < shopTop; y += 18) c.rect(w - 4, y, 3, 1, "M");

  return c;
}

/** Background terrace: flatter, paler, fewer details. Distance is drawn, not implied. */
export function distantBlock({ w = 44, h = 60, tone = "8", roof = "M" } = {}) {
  const c = new Canvas(w, h);
  c.rect(0, 3, w, h - 3, tone);
  c.rect(0, 0, w, 4, roof);
  c.hline(0, 0, w, "N");
  c.vline(w - 1, 3, h - 3, "7");
  for (let y = 9; y < h - 6; y += 11)
    for (let x = 4; x < w - 6; x += 9) {
      const litWindow = ((x * 37 + y * 101) ^ (x * y)) % 7 < 2;
      c.rect(x, y, 5, 6, litWindow ? "z" : "h");
      c.hline(x, y, 5, litWindow ? "y" : "g");
      c.hline(x, y + 6, 5, "9");
    }
  return c;
}
