import { Canvas } from "./canvas.mjs";
import { text } from "./font.mjs";

/**
 * A modern UK low-floor urban single-decker, side on, facing right. 100 x 32 art pixels.
 *
 * Built the way a pixel artist builds a vehicle rather than the way a developer assembles one:
 * a silhouette first, then flat tonal bands, then one continuous glasshouse with the pillars
 * drawn back over it in body colour, then the small hard details. Framing each pane separately
 * was tried and it turns the whole band black at this size.
 *
 * Light falls from the upper left throughout: roof highlight, mid-tone waist, shadowed skirt.
 */

const W = 100;
const H = 32;
const ROOF = 2;
const CANTRAIL = 6;
const GLASS_TOP = 7;
const GLASS_BOT = 18;
const WAISTRAIL = 19;
const SKIRT = 24;
const BODY_BOTTOM = 28;
const AXLE_Y = 26;
const WHEEL_R = 4;
const REAR_AXLE = 22;
const FRONT_AXLE = 80;
const DOOR_BOTTOM = 27;

/** Where the glasshouse is interrupted. Windows are what is left between them. */
const PILLARS = [
  [17, 3],
  [32, 3],
  [43, 3],
  [56, 3],
  [65, 2],
  [77, 3],
];
const DOORS = [
  [46, 10],
  [67, 10],
];

export function busSide({
  body = "t",
  bodyDark = "s",
  bodyDeep = "r",
  bodyLight = "u",
  bodyGlow = "v",
  trim = "W",
  route = "36",
  wheelPhase = 0,
} = {}) {
  const c = new Canvas(W, H);

  // ---- silhouette -------------------------------------------------------
  for (let y = ROOF + 2; y <= BODY_BOTTOM - 1; y++) c.hline(2, y, 96, body);
  c.hline(6, ROOF, 88, body);
  c.hline(4, ROOF + 1, 92, body);
  c.hline(4, BODY_BOTTOM, 92, body);

  // ---- tonal bands ------------------------------------------------------
  const band = (y0, y1, colour) => {
    for (let y = y0; y <= y1; y++)
      for (let x = 0; x < W; x++) if (c.get(x, y) !== ".") c.px(x, y, colour);
  };
  band(ROOF, ROOF + 3, bodyLight);
  band(SKIRT, BODY_BOTTOM - 1, bodyDark);
  band(BODY_BOTTOM, BODY_BOTTOM, bodyDeep);
  c.hline(10, ROOF, 80, bodyGlow);

  // ---- livery, laid under the glass so nothing runs through a door ------
  c.hline(4, SKIRT - 1, 92, trim); // one pinstripe, not a band
  c.hline(5, WAISTRAIL + 2, 90, bodyLight); // a lit edge under the waist rail

  // ---- glasshouse -------------------------------------------------------
  // One band, laid once. Its reflections run the length of the bus, so the pillars cut them at
  // different points and no two windows repeat.
  c.rect(4, GLASS_TOP, 76, GLASS_BOT - GLASS_TOP + 1, "g");
  c.rect(4, GLASS_TOP, 76, 2, "f");
  c.hline(4, GLASS_BOT, 76, "h");
  // Raked reflections. Two long strokes at different rakes read as sky and building.
  for (let k = 0; k < 150; k++) {
    const rx = 2 + k;
    for (const [start, rake, tone] of [
      [GLASS_TOP + 2, 2, "i"],
      [GLASS_TOP + 5, 3, "h"],
    ]) {
      const ry = start + Math.floor(k / rake) - Math.floor(k / 22) * 5;
      if (c.get(rx, ry) === "g") c.px(rx, ry, tone);
      if (c.get(rx + 1, ry) === "g") c.px(rx + 1, ry, tone);
    }
  }
  // A crisp highlight along the head of each pane, which is what makes glass look like glass.
  for (let x = 4; x < 80; x++) if (c.get(x, GLASS_TOP + 2) === "g") c.px(x, GLASS_TOP + 2, "j");

  // ---- pillars, drawn back over the glass -------------------------------
  for (const [x, w] of PILLARS) {
    c.rect(x, GLASS_TOP - 1, w, GLASS_BOT - GLASS_TOP + 3, body);
    c.vline(x + w - 1, GLASS_TOP, GLASS_BOT - GLASS_TOP + 1, bodyDark);
    c.vline(x, GLASS_TOP, GLASS_BOT - GLASS_TOP + 1, bodyLight);
  }
  // Doors, drawn complete and last, so the livery lines stop at them rather than run through.
  // Glazed down to a dark threshold: that step is what separates a door from another window.
  for (const [dx, dw] of DOORS) {
    const glassBot = 23;
    c.rect(dx, GLASS_TOP, dw, glassBot - GLASS_TOP + 1, "g");
    c.rect(dx, GLASS_TOP, dw, 2, "f");
    for (let k = 0; k < dw + 6; k++) {
      const rx = dx + k,
        ry = GLASS_TOP + 3 + Math.floor(k / 2);
      if (c.get(rx, ry) === "g") c.px(rx, ry, "i");
    }
    c.hline(dx, glassBot, dw, "h");
    const mid = dx + dw / 2 - 1;
    c.vline(mid, GLASS_TOP, glassBot - GLASS_TOP + 1, "L");
    c.vline(mid + 1, GLASS_TOP, glassBot - GLASS_TOP + 1, "M");
    c.vline(dx + 1, GLASS_TOP + 5, 11, "O"); // grab pole
    c.vline(dx + dw - 2, GLASS_TOP + 5, 11, "O");
    // The lower leaf stays red. Painting it near-black turned both doors into holes in the bus.
    c.rect(dx, glassBot + 1, dw, DOOR_BOTTOM - glassBot, bodyDeep);
    c.hline(dx, glassBot + 1, dw, "M"); // step nosing
    c.hline(dx + 1, DOOR_BOTTOM, dw - 2, "L"); // shadow in the doorway
    c.vline(dx - 1, GLASS_TOP - 1, DOOR_BOTTOM - GLASS_TOP + 3, bodyDeep);
    c.vline(dx + dw, GLASS_TOP - 1, DOOR_BOTTOM - GLASS_TOP + 3, bodyDeep);
  }
  c.hline(3, CANTRAIL, 78, "K");
  c.hline(3, WAISTRAIL, 78, "K");
  c.hline(4, WAISTRAIL + 1, 76, bodyLight);

  // ---- windscreen, blind and cab ---------------------------------------
  c.rect(82, 3, 15, 6, "K"); // blind box
  text(c, 83, 4, route, "Z");
  c.rect(83 + route.length * 4 + 1, 5, 11, 1, "z");
  c.rect(83 + route.length * 4 + 1, 7, 7, 1, "y");
  c.frame(81, 2, 17, 8, "L");

  c.rect(82, 11, 15, 9, "g");
  c.rect(82, 11, 15, 2, "f");
  for (let k = 0; k < 18; k++) {
    c.px(82 + k, 13 + Math.floor(k / 3), "i");
    c.px(83 + k, 13 + Math.floor(k / 3), "i");
  }
  c.hline(82, 19, 15, "h");
  c.vline(96, 12, 7, "j");
  c.frame(81, 10, 17, 11, "K");
  // A driver. A lit cab with nobody in it reads as a fault rather than as a bus.
  c.rect(86, 14, 3, 3, "B");
  c.hline(86, 13, 3, "D");
  c.px(85, 14, "D");
  c.px(89, 14, "D");
  c.rect(85, 17, 5, 3, "M");
  c.hline(85, 17, 5, "N");
  c.vline(91, 14, 6, "L");

  // ---- rear end ---------------------------------------------------------
  c.rect(2, GLASS_TOP, 3, GLASS_BOT - GLASS_TOP + 1, "g");
  c.rect(2, GLASS_TOP, 3, 2, "f");
  c.px(2, GLASS_TOP + 3, "i");
  c.px(3, GLASS_TOP + 4, "i");
  c.hline(2, GLASS_BOT, 3, "h");
  for (let gy = SKIRT + 1; gy <= SKIRT + 3; gy++) c.hline(7, gy, 8, gy % 2 ? "q" : bodyDeep); // engine grille
  // Operator roundel, drawn last at the rear so nothing crosses it.
  c.disc(14, 21, 3, trim);
  c.hline(12, 21, 5, body); // a bar, not a cross: a disc with a dot reads as a first-aid sign
  c.px(13, 19, "X");
  c.rect(3, WAISTRAIL + 2, 2, 3, "u"); // tail light cluster
  c.rect(3, WAISTRAIL + 5, 2, 2, "z");
  c.frame(2, WAISTRAIL + 1, 4, 8, "L");
  c.rect(2, BODY_BOTTOM - 1, 9, 2, "M"); // rear bumper
  c.hline(2, BODY_BOTTOM - 1, 9, "N");

  // ---- front end --------------------------------------------------------
  c.rect(92, 21, 5, 3, "R");
  c.rect(93, 22, 3, 1, "X"); // headlight
  c.frame(91, 20, 7, 5, "L");
  c.rect(92, 25, 5, 2, "z"); // indicator
  c.rect(85, BODY_BOTTOM - 1, 13, 2, "M"); // bumper
  c.hline(85, BODY_BOTTOM - 1, 13, "N");
  c.rect(87, BODY_BOTTOM, 8, 1, "Q"); // number plate

  // ---- panel breaks -----------------------------------------------------
  for (const x of [30, 58, 80]) c.vline(x, WAISTRAIL + 1, 8, bodyDeep);

  // ---- wheels and arches ------------------------------------------------
  for (const cx of [REAR_AXLE, FRONT_AXLE]) {
    // Arch: a shadowed cut in the skirt, then the tyre sitting inside it.
    c.archTop(cx, AXLE_Y + 1, WHEEL_R + 2, "q");
    c.disc(cx, AXLE_Y, WHEEL_R, "K");
    c.disc(cx, AXLE_Y, WHEEL_R - 1, "L");
    c.disc(cx, AXLE_Y, 2, "N");
    c.px(cx - 1, AXLE_Y - 1, "P");
    c.px(cx, AXLE_Y, "M");
    // Four spokes, rotated between frames. It is two pixels of movement and it is the difference
    // between a bus travelling and a bus being slid across the picture.
    for (let a = 0; a < 4; a++) {
      const t = (a * Math.PI) / 2 + wheelPhase;
      c.px(cx + Math.round(Math.cos(t) * 3), AXLE_Y + Math.round(Math.sin(t) * 3), "M");
    }
    for (let a = 0; a <= 24; a++) {
      const t = Math.PI + (a / 24) * Math.PI;
      c.px(
        cx + Math.round(Math.cos(t) * (WHEEL_R + 2)),
        AXLE_Y + 1 + Math.round(Math.sin(t) * (WHEEL_R + 2)),
        "q",
      );
    }
  }

  c.outline("K");

  // ---- ground shadow, drawn after the outline so it stays soft ----------
  c.hline(8, 31, 84, "P");
  c.hline(16, 30, 12, "Q");
  c.hline(74, 30, 12, "Q");
  return c;
}

/**
 * The same bus at half the detail, for the far carriageway and for the vehicle page. A bus is
 * taller than a lane is deep in this projection, so a second vehicle drawn at hero size on the
 * far side covers the whole pavement; drawing it smaller is what puts it up the street.
 */
export function busMid({
  body = "c",
  bodyDark = "b",
  bodyDeep = "a",
  bodyLight = "d",
  trim = "W",
  route = "12",
  wheelPhase = 0,
} = {}) {
  const c = new Canvas(64, 22);
  for (let y = 3; y <= 17; y++) c.hline(1, y, 62, body);
  c.hline(4, 1, 56, body);
  c.hline(2, 2, 60, body);
  c.hline(3, 18, 58, body);
  for (let x = 0; x < 64; x++) {
    for (const y of [1, 2, 3]) if (c.get(x, y) !== ".") c.px(x, y, bodyLight);
    for (const y of [15, 16, 17, 18]) if (c.get(x, y) !== ".") c.px(x, y, bodyDark);
  }
  c.hline(6, 1, 44, "v");

  c.rect(2, 5, 44, 8, "g");
  c.rect(2, 5, 44, 2, "f");
  c.hline(2, 12, 44, "h");
  for (let k = 0; k < 90; k++) {
    const rx = 2 + k,
      ry = 7 + Math.floor(k / 2) - Math.floor(k / 14) * 4;
    if (c.get(rx, ry) === "g") c.px(rx, ry, "i");
  }
  for (const [x, w] of [
    [12, 2],
    [24, 2],
    [33, 2],
    [44, 2],
  ]) {
    c.rect(x, 4, w, 10, body);
    c.vline(x, 5, 8, bodyLight);
  }
  for (const dx of [26, 36]) {
    // doors, glazed to a step
    c.rect(dx, 5, 7, 11, "g");
    c.rect(dx, 5, 7, 2, "f");
    c.vline(dx + 3, 5, 11, "L");
    c.rect(dx, 16, 7, 2, bodyDeep);
    c.hline(dx, 16, 7, "M");
  }
  c.hline(1, 4, 46, "K");
  c.hline(1, 13, 46, "K");
  c.hline(2, 14, 60, trim);

  c.rect(48, 1, 13, 6, "K"); // blind
  text(c, 49, 2, route, "Z");
  c.rect(49 + route.length * 4, 4, 9, 1, "z");
  c.frame(47, 0, 15, 8, "L");
  c.rect(48, 8, 13, 7, "g"); // windscreen
  c.rect(48, 8, 13, 2, "f");
  for (let k = 0; k < 14; k++) c.px(48 + k, 10 + Math.floor(k / 3), "i");
  c.frame(47, 7, 15, 9, "K");
  c.rect(51, 10, 2, 3, "B");
  c.hline(51, 10, 2, "D");
  c.rect(58, 15, 4, 2, "R"); // headlight
  c.rect(58, 18, 4, 1, "z");
  c.rect(1, 15, 2, 2, "u"); // tail light
  c.rect(1, 18, 8, 1, "M");
  c.rect(54, 18, 8, 1, "M");

  for (const cx of [14, 52]) {
    c.archTop(cx, 18, 5, "q");
    c.disc(cx, 18, 3, "K");
    c.disc(cx, 18, 1, "N");
    c.px(cx - 1, 17, "P");
    for (let a = 0; a < 4; a++) {
      const t = (a * Math.PI) / 2 + wheelPhase;
      c.px(cx + Math.round(Math.cos(t) * 2), 18 + Math.round(Math.sin(t) * 2), "L");
    }
    for (let a = 0; a <= 18; a++) {
      const t = Math.PI + (a / 18) * Math.PI;
      c.px(cx + Math.round(Math.cos(t) * 5), 18 + Math.round(Math.sin(t) * 5), "q");
    }
  }
  c.outline("K");
  c.hline(4, 21, 56, "P");
  return c;
}

/** The same vehicle head on, for the vehicle page and the empty states. */
export function busFront({
  body = "t",
  bodyDark = "s",
  bodyDeep = "r",
  bodyLight = "u",
  route = "36",
} = {}) {
  const c = new Canvas(40, 34);
  for (let y = 4; y <= 29; y++) c.hline(2, y, 36, body);
  c.hline(7, 2, 26, body);
  c.hline(4, 3, 32, body);
  for (let x = 0; x < 40; x++) {
    for (const y of [2, 3, 4]) if (c.get(x, y) !== ".") c.px(x, y, bodyLight);
    for (let y = 24; y <= 29; y++) if (c.get(x, y) !== ".") c.px(x, y, bodyDark);
  }
  c.hline(9, 2, 22, "v");

  // Blind: number centred over the screen, destination on the line beneath it.
  c.rect(5, 5, 30, 6, "K");
  const rw = route.length * 4 - 1;
  text(c, 20 - rw - 3, 5, route, "Z");
  c.rect(21, 6, 12, 1, "z");
  c.rect(21, 8, 9, 1, "y");
  c.frame(4, 4, 32, 8, "L");

  c.rect(4, 13, 32, 10, "g"); // windscreen, two panes
  c.rect(4, 13, 32, 2, "f");
  for (let k = 0; k < 34; k++) {
    c.px(4 + k, 15 + Math.floor(k / 4), "i");
    c.px(5 + k, 15 + Math.floor(k / 4), "i");
  }
  c.hline(4, 22, 32, "h");
  c.vline(20, 13, 10, "M");
  c.frame(3, 12, 34, 12, "K");
  c.rect(25, 16, 4, 4, "B"); // driver, offside
  c.hline(25, 15, 4, "D");
  c.px(24, 16, "D");
  c.px(29, 16, "D");
  c.rect(24, 20, 6, 3, "M");
  c.hline(6, 20, 6, "P");
  c.hline(22, 20, 6, "P"); // wipers at rest

  c.rect(0, 14, 3, 2, "M");
  c.rect(37, 14, 3, 2, "M"); // mirror arms
  c.rect(0, 12, 2, 4, "L");
  c.rect(38, 12, 2, 4, "L"); // mirror heads

  c.rect(13, 24, 14, 5, bodyDeep); // grille
  for (let y = 25; y <= 28; y += 2) c.hline(14, y, 12, "q");
  c.rect(4, 24, 6, 4, "R");
  c.rect(5, 25, 4, 2, "X"); // headlights
  c.rect(30, 24, 6, 4, "R");
  c.rect(31, 25, 4, 2, "X");
  c.frame(3, 23, 8, 6, "L");
  c.frame(29, 23, 8, 6, "L");
  c.rect(4, 29, 5, 2, "z");
  c.rect(31, 29, 5, 2, "z"); // indicators
  c.rect(2, 30, 36, 2, "M"); // bumper
  c.hline(2, 30, 36, "N");
  c.rect(15, 30, 10, 2, "Q"); // plate
  c.outline("K");
  c.hline(4, 33, 32, "P");
  return c;
}

/**
 * Map marker. The same bus reduced until only the things that survive reduction are left: the
 * silhouette, the glasshouse, two wheels and the blind. It is still recognisably this bus.
 */
export function busMarker({ body = "t", bodyDark = "s", bodyLight = "u" } = {}) {
  const c = new Canvas(24, 11);
  for (let y = 1; y <= 7; y++) c.hline(1, y, 22, body);
  c.hline(2, 0, 20, bodyLight);
  c.hline(1, 1, 22, bodyLight);
  c.hline(1, 6, 22, bodyDark);
  c.hline(1, 7, 22, bodyDark);
  c.rect(2, 2, 14, 3, "g");
  c.hline(2, 2, 14, "f");
  c.px(4, 3, "i");
  c.px(8, 3, "i");
  c.px(12, 3, "i");
  for (const x of [6, 10, 14]) c.vline(x, 2, 3, body);
  c.rect(17, 2, 5, 3, "g");
  c.hline(17, 2, 5, "f");
  c.px(21, 3, "j");
  c.rect(17, 0, 5, 2, "K");
  c.px(18, 0, "Z");
  c.px(20, 0, "Z");
  c.px(19, 1, "Z");
  c.rect(21, 6, 2, 1, "R");
  for (const cx of [5, 18]) {
    c.disc(cx, 8, 2, "K");
    c.px(cx, 8, "N");
  }
  c.outline("K");
  c.hline(3, 10, 18, "P");
  return c;
}

/** Stop marker: the flag, reduced the same way. */
export function stopMarker() {
  const c = new Canvas(12, 14);
  c.rect(2, 0, 8, 8, "W");
  c.rect(2, 0, 8, 3, "t");
  c.rect(3, 4, 6, 2, "K");
  c.px(4, 4, "k");
  c.px(6, 4, "k");
  c.rect(5, 8, 2, 5, "N");
  c.vline(5, 8, 5, "P");
  c.frame(1, -1, 10, 10, "K");
  c.hline(3, 13, 6, "P");
  return c;
}
