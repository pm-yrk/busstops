import { Canvas } from "./canvas.mjs";
import { text } from "./font.mjs";

/**
 * The second-generation hero bus: a modern UK low-floor single-decker, 150 x 48 art pixels.
 *
 * The first one was 100 x 32 and the detail it could carry had run out. At that size a door is
 * two pixels wide, a wheel is a four-pixel disc with no hub, and there is nowhere to put a
 * destination blind, a number plate or a driver — so the bus read as a shape with windows rather
 * than as a vehicle. Adding detail to it was not possible; it needed more pixels.
 *
 * Half as wide again and half as tall again is 2.25 times the area, which buys: a raked
 * windscreen with a driver behind it, a proper entrance with a glazed door and a step, framed
 * windows with a visible cantrail and waistrail, wheel arches with the tyre sitting inside them,
 * hubs with spokes, lights at both ends, a registration plate, and passengers as suggestions
 * behind the glass rather than as noise.
 *
 * The rules are the old ones. Light from the upper left. Silhouette first, detail hung on it. One
 * palette, in ramps. Every drawing authored at its native size and shown at whole-number scale.
 */

export const BUS_W = 150;
export const BUS_H = 48;

const ROOF = 3;
const CANTRAIL = 9;
const GLASS_TOP = 11;
const GLASS_BOT = 27;
const WAIST = 29;
const SKIRT = 36;
const BODY_BOTTOM = 42;
const AXLE_Y = 39;
const WHEEL_R = 6;
const REAR_AXLE = 33;
const FRONT_AXLE = 120;
const NOSE = 146;
const TAIL = 3;

/** Window pillars, as x and width. Windows are what is left between them. */
const PILLARS = [
  [26, 4],
  [48, 4],
  [70, 4],
  [92, 4],
  [110, 3],
];

/** The entrance: a double-leaf glazed door behind the front axle. */
const DOOR = { x: 66, w: 17 };

export function busSide2({
  body = "t",
  bodyDark = "s",
  bodyDeep = "r",
  bodyLight = "u",
  bodyGlow = "v",
  route = "36",
  destination = "CITY CENTRE",
  wheelPhase = 0,
  facing = "right",
  seed = 1,
} = {}) {
  const c = new Canvas(BUS_W, BUS_H);

  // ---- silhouette -------------------------------------------------------
  // Squared-off tail, raked nose: the profile of a modern low-floor body.
  for (let y = ROOF + 2; y <= BODY_BOTTOM - 1; y++) c.hline(TAIL, y, NOSE - TAIL, body);
  c.hline(TAIL + 5, ROOF, NOSE - TAIL - 9, body);
  c.hline(TAIL + 2, ROOF + 1, NOSE - TAIL - 4, body);
  c.hline(TAIL + 1, BODY_BOTTOM, NOSE - TAIL - 2, body);
  /*
   * The front corner, chamfered rather than raked.
   *
   * A forward-leaning nose was drawn first and it was a mistake: the loop ran past the body's own
   * bottom edge and left a spike hanging below the floor line and a step above the roof. A modern
   * low-floor body is close to a box with its top front corner taken off, and drawing exactly
   * that is both truer and cleaner than an approximation of a rake.
   */
  for (let i = 0; i < 5; i++) {
    c.vline(NOSE - 4 + i, ROOF + 1 + (4 - i), BODY_BOTTOM - ROOF - (4 - i), body);
  }

  // ---- tonal bands: roof lit, waist mid, skirt in shadow ------------------
  const band = (y0, y1, colour) => {
    for (let y = y0; y <= y1; y++)
      for (let x = 0; x < BUS_W; x++) if (c.get(x, y) !== ".") c.px(x, y, colour);
  };
  band(ROOF, ROOF + 4, bodyLight);
  band(SKIRT, BODY_BOTTOM - 1, bodyDark);
  band(BODY_BOTTOM, BODY_BOTTOM, bodyDeep);
  c.hline(TAIL + 12, ROOF, NOSE - TAIL - 24, bodyGlow);

  // ---- glasshouse: one continuous band, pillars drawn back over it --------
  c.rect(TAIL + 5, GLASS_TOP, NOSE - TAIL - 14, GLASS_BOT - GLASS_TOP + 1, "g");
  // Raked highlight across the glass, the way daylight actually sits on a bus.
  for (let k = 0; k < NOSE; k++) {
    const x = TAIL + 5 + k;
    const y = GLASS_TOP + 1 + Math.floor(k / 5);
    if (c.get(x, y) === "g") c.px(x, y, "i");
    if (c.get(x, y + 1) === "g") c.px(x, y + 1, "h");
  }
  // A second, weaker reflection lower down, so the glass has depth rather than one stripe.
  for (let k = 0; k < NOSE; k++) {
    const x = TAIL + 5 + k;
    const y = GLASS_BOT - 3 + Math.floor(k / 9);
    if (c.get(x, y) === "g") c.px(x, y, "f");
  }

  // Passengers, as heads and shoulders behind the glass. Suggestions, not portraits: at this size
  // a face is three pixels and drawing one makes the window look dirty rather than occupied.
  let s = seed * 7919;
  const nextRandom = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const skins = ["A", "B", "C", "D"];
  const coats = ["a", "q", "2", "M", "b"];
  for (let x = TAIL + 10; x < 108; x += 11) {
    if (nextRandom() < 0.42) continue;
    const head = skins[Math.floor(nextRandom() * skins.length)];
    const coat = coats[Math.floor(nextRandom() * coats.length)];
    c.rect(x, GLASS_BOT - 8, 4, 4, head);
    c.px(x, GLASS_BOT - 8, "K");
    c.rect(x - 1, GLASS_BOT - 4, 6, 4, coat);
  }

  // Pillars over the glass, in body colour, with a lit left edge each.
  for (const [x, w] of PILLARS) {
    c.rect(x, GLASS_TOP - 1, w, GLASS_BOT - GLASS_TOP + 3, body);
    c.vline(x, GLASS_TOP - 1, GLASS_BOT - GLASS_TOP + 3, bodyLight);
    c.vline(x + w - 1, GLASS_TOP - 1, GLASS_BOT - GLASS_TOP + 3, bodyDeep);
  }
  // Cantrail and waistrail: the two horizontals that make a bus look built rather than extruded.
  c.hline(TAIL + 4, CANTRAIL, NOSE - TAIL - 12, "K");
  c.hline(TAIL + 4, CANTRAIL + 1, NOSE - TAIL - 12, bodyLight);
  c.hline(TAIL + 4, WAIST, NOSE - TAIL - 12, "K");
  c.hline(TAIL + 4, WAIST + 1, NOSE - TAIL - 12, bodyLight);

  // ---- entrance ----------------------------------------------------------
  // Glazed double leaf, a visible step, and the rubber edge down the middle.
  c.rect(DOOR.x, GLASS_TOP - 1, DOOR.w, BODY_BOTTOM - GLASS_TOP, bodyDeep);
  c.rect(DOOR.x + 1, GLASS_TOP, DOOR.w - 2, WAIST - GLASS_TOP + 6, "g");
  for (let k = 0; k < DOOR.w; k++) {
    const y = GLASS_TOP + 1 + Math.floor(k / 3);
    if (c.get(DOOR.x + 1 + k, y) === "g") c.px(DOOR.x + 1 + k, y, "i");
  }
  c.vline(DOOR.x + Math.floor(DOOR.w / 2), GLASS_TOP, WAIST - GLASS_TOP + 6, "L");
  c.vline(DOOR.x, GLASS_TOP - 1, BODY_BOTTOM - GLASS_TOP, "K");
  c.vline(DOOR.x + DOOR.w - 1, GLASS_TOP - 1, BODY_BOTTOM - GLASS_TOP, "K");
  // The step, lit along its nose, which is what says "low floor".
  c.rect(DOOR.x + 1, BODY_BOTTOM - 3, DOOR.w - 2, 3, "N");
  c.hline(DOOR.x + 1, BODY_BOTTOM - 3, DOOR.w - 2, "P");

  // ---- cab ---------------------------------------------------------------
  // Windscreen, raked, with the driver behind it and a mirror arm off the front.
  c.rect(120, GLASS_TOP, 20, GLASS_BOT - GLASS_TOP - 1, "g");
  for (let k = 0; k < 21; k++) {
    const y = GLASS_TOP + Math.floor(k / 3);
    if (c.get(120 + k, y) === "g") c.px(120 + k, y, "j");
    if (c.get(120 + k, y + 1) === "g") c.px(120 + k, y + 1, "i");
  }
  // Driver: shoulders, head, and a hand on the wheel. Three shapes, no face.
  c.rect(125, GLASS_BOT - 9, 5, 5, "B");
  c.px(125, GLASS_BOT - 9, "K");
  c.rect(123, GLASS_BOT - 4, 9, 5, "M");
  c.rect(132, GLASS_BOT - 3, 2, 2, "B");
  c.frame(119, GLASS_TOP - 1, 22, GLASS_BOT - GLASS_TOP + 1, "K");

  // ---- destination blind -------------------------------------------------
  // The route number in its own box, the destination beside it, both on the front.
  // Drawn last, by `blind`, once the facing is known.

  // ---- lights, plate and small hard details ------------------------------
  // Headlights: a lit pair low on the nose, with an indicator above.
  c.rect(NOSE - 5, SKIRT - 3, 5, 4, "R");
  c.rect(NOSE - 4, SKIRT - 2, 3, 2, "X");
  c.rect(NOSE - 5, SKIRT + 2, 5, 2, "z");
  // Tail lights: red cluster, and the reversing lamp under it.
  c.rect(TAIL, SKIRT - 4, 4, 5, "t");
  c.rect(TAIL, SKIRT - 3, 3, 3, "u");
  c.rect(TAIL, SKIRT + 2, 4, 2, "R");
  // Registration plate, as a plate rather than as letters: at this size legible type would be
  // noise, and a yellow rectangle in the right place is what the eye reads as a number plate.
  c.rect(NOSE - 16, BODY_BOTTOM - 5, 12, 4, "z");
  c.frame(NOSE - 17, BODY_BOTTOM - 6, 14, 6, "K");
  c.hline(NOSE - 15, BODY_BOTTOM - 4, 9, "y");
  // Mirror arm and head, off the front pillar.
  c.rect(NOSE - 3, CANTRAIL + 3, 3, 2, "M");
  c.rect(NOSE - 1, CANTRAIL + 1, 2, 6, "L");
  // Skirt shadow line and the fuel filler.
  c.hline(TAIL + 2, SKIRT, NOSE - TAIL - 6, bodyDeep);
  c.rect(52, SKIRT + 2, 5, 4, bodyDeep);
  c.frame(52, SKIRT + 2, 5, 4, "L");

  // ---- wheels ------------------------------------------------------------
  for (const cx of [REAR_AXLE, FRONT_AXLE]) {
    // The arch is cut into the skirt, so the tyre sits inside the body rather than under it.
    c.archTop(cx, AXLE_Y, WHEEL_R + 3, bodyDeep);
    c.archTop(cx, AXLE_Y, WHEEL_R + 2, "L");
    c.disc(cx, AXLE_Y, WHEEL_R, "K");
    c.disc(cx, AXLE_Y, WHEEL_R - 2, "N");
    c.disc(cx, AXLE_Y, 2, "P");
    // Spokes, turned by the frame's phase. Two frames alternating is what makes it roll.
    for (let a = 0; a < 5; a++) {
      const t = (a * 2 * Math.PI) / 5 + wheelPhase;
      c.px(cx + Math.round(Math.cos(t) * 4), AXLE_Y + Math.round(Math.sin(t) * 4), "L");
      c.px(cx + Math.round(Math.cos(t) * 3), AXLE_Y + Math.round(Math.sin(t) * 3), "M");
    }
    // A lit crescent on the top of the tyre, so the wheel reads as round.
    for (let a = 0; a <= 16; a++) {
      const t = Math.PI + (a / 16) * Math.PI;
      c.px(cx + Math.round(Math.cos(t) * WHEEL_R), AXLE_Y + Math.round(Math.sin(t) * WHEEL_R), "L");
    }
  }

  c.outline("K");

  // Contact with the road: a firm patch under each axle, softer either side, nothing between.
  for (const cx of [REAR_AXLE, FRONT_AXLE]) {
    c.hline(cx - WHEEL_R - 3, BUS_H - 1, WHEEL_R * 2 + 7, "=");
    c.hline(cx - WHEEL_R, BUS_H - 1, WHEEL_R * 2 + 1, "-");
    c.hline(cx - WHEEL_R + 1, BUS_H - 2, WHEEL_R * 2 - 1, "=");
  }

  // The blind goes on last, on whichever end is the front, so a flip cannot mirror its text.
  const drawn = facing === "left" ? c.flipped() : c;
  blind(drawn, facing === "left" ? BUS_W - 141 : 113, route, destination);
  return drawn;
}

/** Route number and destination, anchored at the left edge of the blind box. */
function blind(c, x, route, destination) {
  c.rect(x, ROOF + 2, 26, 6, "K");
  text(c, x + 1, ROOF + 3, route, "Z");
  const from = x + 1 + route.length * 4 + 2;
  // The destination is shown as rows of type rather than as letters: at four pixels of cap height
  // real words are unreadable, and unreadable words drawn anyway look like a fault.
  const width = x + 25 - from;
  if (width > 3) {
    c.hline(from, ROOF + 4, Math.min(width, destination.length * 2), "z");
    c.hline(from, ROOF + 6, Math.min(width - 2, destination.length), "y");
  }
  c.frame(x - 1, ROOF + 1, 28, 8, "L");
}
