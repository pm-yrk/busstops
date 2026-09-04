import { Canvas } from "./canvas.mjs";
import { text } from "./font.mjs";

/**
 * The things a bus stop stands among. Every sprite here shares the bus's grid, palette and
 * lighting: one art pixel is one art pixel everywhere, and the light comes from the upper left.
 */

/** Overlapping discs make an organic mass; stacked rectangles make a staircase. */
function blob(c, discs, colour) {
  for (const [x, y, r] of discs) c.disc(x, y, r, colour);
}

/**
 * A street tree. The canopy is a cluster of discs of different sizes at irregular centres, then
 * lit from the upper left, then bitten into at the edges so the silhouette is never symmetrical.
 */
export function tree({ w = 34, h = 46, seed = 1 } = {}) {
  const c = new Canvas(w, h);
  const cx = Math.floor(w / 2);
  const cy = 17;
  const wob = (n) => ((seed * 37 + n * 61) % 7) - 3;

  // The mass. Eight discs at uneven centres are already lumpy; the silhouette comes from their
  // union rather than from cutting a smooth shape about afterwards. Subtracting discs was tried
  // twice — from inside it spots the canopy, from the rim it shreds it — so every irregularity
  // here is added, never removed.
  const canopy = [
    [cx - 6 + wob(1), 13, 8],
    [cx + 5 + wob(2), 11, 7],
    [cx + wob(3), 8, 8],
    [cx - 9 + wob(4), 20, 6],
    [cx + 8 + wob(5), 19, 6],
    [cx - 1 + wob(6), 19, 9],
    [cx + 3 + wob(7), 24, 6],
    [cx - 5 + wob(8), 25, 5],
  ];
  blob(c, canopy, "3");
  // Outlying clumps push the rim out at seven irregular points.
  const lumps = [];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + seed * 1.7;
    const rad = 9 + ((seed * 13 + k * 7) % 3);
    lumps.push([
      cx + Math.round(Math.cos(a) * rad),
      cy + Math.round(Math.sin(a) * rad * 0.85),
      2 + (k % 2),
    ]);
  }
  blob(c, lumps, "3");
  // Light the crown, shade the underside: the same mass, twice, offset toward and away from the sun.
  blob(
    c,
    canopy.map(([x, y, r]) => [x + 2, y + 4, r - 2]),
    "2",
  );
  blob(
    c,
    canopy.map(([x, y, r]) => [x - 2, y - 3, Math.max(2, r - 3)]),
    "4",
  );
  blob(
    c,
    canopy.slice(0, 3).map(([x, y, r]) => [x - 3, y - 4, Math.max(1, r - 5)]),
    "5",
  );
  // Loose leaves at the edge, so the outline never closes into a smooth curve.
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2 + seed * 0.9;
    const rad = 11 + ((seed * 7 + k * 11) % 4);
    const lx = cx + Math.round(Math.cos(a) * rad);
    const ly = cy + Math.round(Math.sin(a) * rad * 0.85);
    if (c.get(lx, ly) === ".") c.px(lx, ly, k % 3 === 0 ? "4" : "3");
  }
  // Gaps between leaf clumps: darker, never transparent, so the mass keeps its silhouette.
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + seed;
    c.px(cx + Math.round(Math.cos(a) * 5), cy + Math.round(Math.sin(a) * 4), "1");
    c.px(cx + Math.round(Math.cos(a) * 5) + 1, cy + Math.round(Math.sin(a) * 4), "2");
  }
  // Branches showing through, then the trunk.
  c.line(cx, 33, cx - 4, 24, "1");
  c.line(cx, 33, cx + 5, 26, "1");
  c.rect(cx - 1, 28, 3, h - 30, "L");
  c.vline(cx - 1, 28, h - 30, "M");
  c.vline(cx + 1, 28, h - 30, "K");
  c.hline(cx - 3, h - 2, 7, "M");
  c.hline(cx - 4, h - 1, 9, "P");
  return c;
}

/** Stepped organic contours, not rectangular bars. */
export function cloud({ w = 46, h = 14, seed = 1 } = {}) {
  const c = new Canvas(w, h);
  const r = (n) => ((seed * 29 + n * 53) % 5) - 2;
  blob(
    c,
    [
      [12 + r(1), 8, 5],
      [20 + r(2), 6, 6],
      [29 + r(3), 7, 5],
      [36 + r(4), 9, 4],
      [7 + r(5), 10, 4],
    ],
    "R",
  );
  blob(
    c,
    [
      [19 + r(2), 5, 4],
      [28 + r(3), 6, 3],
    ],
    "X",
  );
  for (let x = 0; x < w; x++)
    for (let y = h - 3; y < h; y++) if (c.get(x, y) !== ".") c.px(x, y, "Q");
  c.hline(6, h - 1, 34, ".");
  return c;
}

/**
 * A UK cantilever bus shelter: roof, glazed back and end panels, a poster case at one end,
 * a timetable case with actual timetable marks, and a perch seat.
 */
export function shelter({ w = 60, h = 48 } = {}) {
  const c = new Canvas(w, h);
  // Roof, cantilevered forward, with a lit top edge and a shadowed fascia.
  c.rect(1, 6, w - 2, 3, "M");
  c.hline(1, 6, w - 2, "O");
  c.hline(0, 9, w, "L");
  c.rect(2, 10, w - 4, 1, "K");
  // Uprights.
  for (const x of [3, w - 6]) {
    c.rect(x, 10, 3, h - 14, "N");
    c.vline(x, 10, h - 14, "P");
    c.vline(x + 2, 10, h - 14, "L");
  }
  // Glazed back panels. Glass is a pale wash with a raked highlight, not a solid fill.
  const glassX = 7,
    glassW = w - 15;
  c.rect(glassX, 12, glassW, h - 20, "k");
  for (let k = 0; k < glassW + 20; k++) {
    const rx = glassX + k,
      ry = 13 + Math.floor(k / 3);
    if (c.get(rx, ry) === "k") c.px(rx, ry, "X");
    if (c.get(rx + 1, ry) === "k") c.px(rx + 1, ry, "X");
  }
  for (let k = 0; k < glassW; k++) {
    const rx = glassX + k,
      ry = 20 + Math.floor(k / 4);
    if (c.get(rx, ry) === "k") c.px(rx, ry, "j");
  }
  // Panel divisions with real mullions.
  for (const x of [glassX + 14, glassX + 28]) {
    c.vline(x, 12, h - 20, "O");
    c.vline(x + 1, 12, h - 20, "N");
  }
  c.frame(glassX - 1, 11, glassW + 2, h - 18, "M");
  // Timetable case: a red header and legible rows of timetable marks underneath.
  const tx = glassX + 1;
  c.rect(tx, 14, 12, 16, "W");
  c.rect(tx, 14, 12, 3, "s");
  c.hline(tx + 1, 15, 10, "v");
  for (let row = 0; row < 6; row++) {
    c.hline(tx + 1, 18 + row * 2, 4, "N");
    c.hline(tx + 6, 18 + row * 2, 2 + (row % 3), "P");
  }
  c.frame(tx - 1, 13, 14, 18, "K");
  // Poster panel at the far end, with a red field and a pale block of "type".
  const px = glassX + 30;
  c.rect(px, 14, 11, 20, "t");
  c.rect(px + 1, 16, 9, 6, "W");
  c.hline(px + 2, 24, 7, "v");
  c.hline(px + 2, 26, 5, "v");
  c.frame(px - 1, 13, 13, 22, "K");
  // Perch seat.
  c.rect(glassX + 2, h - 14, glassW - 4, 3, "N");
  c.hline(glassX + 2, h - 14, glassW - 4, "P");
  for (const x of [glassX + 4, glassX + glassW - 7]) c.rect(x, h - 11, 2, 6, "M");
  // Pavement shadow.
  c.hline(2, h - 2, w - 4, "P");
  c.hline(6, h - 1, w - 12, "Q");
  return c;
}

/** A UK bus stop flag: pole, transport-red panel, a bus mark, and the routes it serves. */
export function stopFlag({ h = 52, routes = "36" } = {}) {
  const c = new Canvas(18, h);
  // Pole, round in section so it carries a highlight and a shadow.
  c.rect(7, 24, 3, h - 26, "N");
  c.vline(7, 24, h - 26, "P");
  c.vline(9, 24, h - 26, "L");
  c.hline(5, h - 2, 7, "N");
  c.hline(4, h - 1, 9, "P");
  // Sign panel: red header carrying a bus mark, white field carrying the routes.
  c.rect(1, 2, 16, 23, "W");
  c.rect(1, 2, 16, 9, "t");
  c.hline(2, 3, 14, "u");
  // Bus pictogram, the same vehicle reduced to eleven pixels of width.
  c.rect(3, 5, 12, 4, "W");
  c.rect(4, 6, 2, 2, "t");
  c.rect(7, 6, 2, 2, "t");
  c.rect(10, 6, 2, 2, "t");
  c.rect(12, 6, 2, 2, "u");
  c.px(4, 9, "K");
  c.px(5, 9, "K");
  c.px(12, 9, "K");
  c.px(13, 9, "K");
  // Routes.
  text(c, 3, 13, routes, "K");
  c.hline(2, 19, 14, "Q");
  c.hline(3, 21, 5, "P");
  c.hline(10, 21, 5, "P");
  c.frame(0, 1, 18, 25, "K");
  return c;
}

/** A person waiting. Coat silhouette, hair, and something in their hands. */
export function person({ coat = "b", coatDark = "a", hair = "L", skin = "A", pose = 0 } = {}) {
  const c = new Canvas(11, 21);
  const top = pose === 2 ? 2 : 0; // a shorter figure, so the group is not one height

  // Head: hair sits on the crown and at the temples, leaving the face. Filling the top two rows
  // edge to edge is what made every one of these look like it was wearing a bowler hat.
  c.rect(3, top + 1, 4, 5, skin);
  c.hline(3, top + 1, 4, hair);
  c.px(2, top + 2, hair);
  c.px(7, top + 2, hair);
  c.px(3, top + 2, hair);
  c.px(4, top + 3, "K");
  c.px(6, top + 3, "K");
  c.px(5, top + 5, "N");
  c.rect(4, top + 6, 3, 1, skin);

  if (pose === 0) {
    // Long coat, hands in pockets, weight on one leg.
    c.rect(2, top + 7, 7, 10, coat);
    c.hline(2, top + 7, 7, "R");
    c.vline(2, top + 8, 9, coatDark);
    c.vline(8, top + 8, 9, coatDark);
    c.vline(5, top + 9, 7, coatDark);
    c.rect(1, top + 8, 2, 6, coat);
    c.rect(8, top + 8, 2, 6, coat);
    c.rect(3, top + 17, 2, 3, "M");
    c.rect(6, top + 17, 2, 3, "M");
  } else if (pose === 1) {
    // Shorter jacket, one arm up with a phone.
    c.rect(2, top + 7, 7, 7, coat);
    c.hline(2, top + 7, 7, "R");
    c.vline(2, top + 8, 6, coatDark);
    c.vline(8, top + 8, 6, coatDark);
    c.rect(1, top + 8, 2, 5, coat);
    c.rect(8, top + 8, 2, 2, coat);
    c.rect(8, top + 9, 2, 2, skin);
    c.rect(8, top + 7, 2, 3, "K");
    c.px(9, top + 8, "j");
    c.rect(3, top + 14, 2, 6, "f");
    c.rect(6, top + 14, 2, 6, "f");
  } else {
    // Rucksack, standing square.
    c.rect(2, top + 7, 7, 8, coat);
    c.hline(2, top + 7, 7, "R");
    c.vline(2, top + 8, 7, coatDark);
    c.vline(8, top + 8, 7, coatDark);
    c.rect(0, top + 8, 2, 6, "q");
    c.hline(0, top + 8, 2, "r");
    c.px(2, top + 9, "r");
    c.px(2, top + 12, "r");
    c.rect(8, top + 8, 2, 5, coat);
    c.rect(3, top + 15, 2, 5, "M");
    c.rect(6, top + 15, 2, 5, "M");
  }
  c.rect(2, 19, 3, 2, "K");
  c.rect(6, 19, 3, 2, "K");
  c.hline(1, 20, 9, "P");
  return c;
}

/** A cast-iron style lamp column with a modern head. */
export function lamp({ h = 54 } = {}) {
  const c = new Canvas(16, h);
  c.rect(6, 6, 3, h - 8, "N");
  c.vline(6, 6, h - 8, "P");
  c.vline(8, 6, h - 8, "L");
  c.rect(5, h - 6, 5, 4, "M"); // base
  c.hline(5, h - 6, 5, "N");
  c.hline(4, h - 2, 7, "N");
  c.hline(3, h - 1, 9, "P");
  c.line(7, 6, 12, 2, "N"); // arm
  c.line(7, 7, 12, 3, "L");
  c.rect(11, 1, 5, 3, "M"); // head
  c.hline(11, 1, 5, "O");
  c.hline(11, 4, 5, "Z"); // lit underside
  c.hline(12, 5, 3, "z");
  return c;
}

/** A slatted bench, seen from the side of the pavement. */
export function bench({ w = 26 } = {}) {
  const c = new Canvas(w, 16);
  for (let k = 0; k < 3; k++) {
    c.rect(2, 2 + k * 2, w - 4, 2, "7");
    c.hline(2, 2 + k * 2, w - 4, "9");
    c.hline(2, 3 + k * 2, w - 4, "6");
  }
  c.rect(2, 8, w - 4, 3, "7");
  c.hline(2, 8, w - 4, "9");
  c.hline(2, 10, w - 4, "6");
  for (const x of [3, w - 6]) {
    c.rect(x, 11, 3, 4, "M");
    c.vline(x, 11, 4, "N");
    c.vline(x + 2, 11, 4, "K");
  }
  c.hline(3, 15, w - 6, "N");
  c.hline(2, 15, w - 4, "P");
  return c;
}

/** A litter bin, the small object that makes a pavement look used. */
export function bin() {
  const c = new Canvas(12, 18);
  c.rect(2, 4, 8, 12, "M");
  c.vline(2, 4, 12, "N");
  c.vline(9, 4, 12, "L");
  c.rect(1, 2, 10, 3, "N");
  c.hline(1, 2, 10, "P");
  c.rect(4, 3, 4, 1, "K");
  c.rect(3, 8, 6, 4, "s"); // a red band, tying it to the palette
  c.hline(3, 8, 6, "u");
  c.hline(2, 17, 8, "P");
  return c;
}
