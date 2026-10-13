import { Canvas } from "./canvas.mjs";

/**
 * The people who wait at bus stops.
 *
 * Redrawn after looking at the first pass at real display scale, where three things were wrong
 * and all three were structural rather than a matter of adding detail:
 *
 *   1. **No contour.** Nothing had an outline, so every figure dissolved into the pavement behind
 *      it. A selective dark edge is not decoration at this size — it is what separates a person
 *      from a background, and it is the single biggest difference between a sprite that looks
 *      finished and one that looks like a first draft.
 *   2. **Invisible arms.** An arm drawn as a one-pixel line in the coat's own colour is not an
 *      arm; it is a slightly bumpy edge. Arms are now two pixels wide, drawn proud of the torso,
 *      with their own shading and a hand at the end.
 *   3. **A rectangle for a body.** Shoulders wider than the waist, and a head that sits on a neck
 *      rather than on a wall, is most of what makes a silhouette read as a person.
 *
 * Two rules the composition depends on:
 *
 *   - **Who is waiting has nothing to do with the weather.** The character is chosen from the stop
 *     and the day; the weather chooses the accessory and the effects around them. A wheelchair
 *     user does not appear only when it is sunny.
 *   - **Accessories are separate sprites at published anchors.** One umbrella positioned at each
 *     character's `hand` anchor is one umbrella to draw, not twelve.
 *
 * The grid is 24 x 44 art pixels with the feet on the bottom row, so every figure shares a
 * baseline and can be placed by its feet.
 */

export const PERSON_W = 24;
export const PERSON_H = 44;

/** Skin, with its own shadow and a darker line colour for features. */
const SKIN = {
  light: { base: "A", shade: "B", line: "C" },
  tan: { base: "B", shade: "C", line: "D" },
  brown: { base: "C", shade: "D", line: "L" },
  deep: { base: "D", shade: "L", line: "K" },
};

const HAIR = {
  black: { base: "L", shade: "K", light: "M" },
  brown: { base: "M", shade: "L", light: "N" },
  auburn: { base: "r", shade: "q", light: "s" },
  fair: { base: "7", shade: "6", light: "8" },
  grey: { base: "P", shade: "O", light: "Q" },
  white: { base: "R", shade: "P", light: "W" },
};

const CLOTH = {
  red: { base: "s", shade: "r", light: "t" },
  darkRed: { base: "r", shade: "q", light: "s" },
  blue: { base: "b", shade: "a", light: "c" },
  paleBlue: { base: "d", shade: "b", light: "e" },
  charcoal: { base: "M", shade: "L", light: "N" },
  stone: { base: "O", shade: "N", light: "P" },
  cream: { base: "Q", shade: "P", light: "R" },
  hiVis: { base: "z", shade: "y", light: "Z" },
  green: { base: "3", shade: "2", light: "4" },
  plum: { base: "q", shade: "K", light: "r" },
};

const LEG = {
  denim: { base: "g", shade: "f" },
  dark: { base: "L", shade: "K" },
  stone: { base: "N", shade: "M" },
  red: { base: "r", shade: "q" },
  green: { base: "2", shade: "1" },
  scrub: { base: "d", shade: "b" },
};

/**
 * A head on a neck.
 *
 * The face carries two eye pixels and nothing else: at six pixels across a mouth is a smear and a
 * nose is a blemish. Character comes from silhouette, hair and posture, which is how pixel art at
 * this size actually works. What the first pass got wrong was the jaw — a flat-bottomed head
 * reads as a box, so the chin is now narrower than the temples.
 */
function head(canvas, x, y, skinName, hairName, style) {
  const s = SKIN[skinName];
  const h = HAIR[hairName];

  // Skull: widest at the temples, narrowing to the chin.
  canvas.rect(x + 1, y, 5, 1, s.base);
  canvas.rect(x, y + 1, 7, 4, s.base);
  canvas.rect(x + 1, y + 5, 5, 1, s.base);
  canvas.rect(x + 2, y + 6, 3, 1, s.base);

  // Form: the light is upper-left, so the right cheek and the underside of the jaw are in shade.
  canvas.vline(x + 6, y + 1, 4, s.shade);
  canvas.hline(x + 2, y + 6, 3, s.shade);
  canvas.px(x + 5, y + 5, s.shade);

  // Eyes, set slightly left: the head is turned towards the road.
  canvas.px(x + 2, y + 3, s.line);
  canvas.px(x + 4, y + 3, s.line);

  // Neck, in shade because it is under the jaw.
  canvas.rect(x + 2, y + 7, 3, 2, s.shade);

  switch (style) {
    case "crop":
      canvas.rect(x, y - 1, 7, 2, h.base);
      canvas.hline(x + 1, y - 1, 4, h.light);
      canvas.px(x, y + 1, h.shade);
      canvas.px(x + 6, y + 1, h.shade);
      break;
    case "long":
      canvas.rect(x, y - 1, 7, 2, h.base);
      canvas.hline(x + 1, y - 1, 4, h.light);
      canvas.vline(x - 1, y, 9, h.base);
      canvas.vline(x + 7, y, 9, h.shade);
      canvas.px(x - 1, y + 9, h.shade);
      canvas.px(x + 7, y + 9, h.shade);
      break;
    case "curls":
      // Lumps, not a rectangle: a curly silhouette is an irregular outline.
      canvas.rect(x - 1, y - 2, 9, 3, h.base);
      for (const [dx, dy, c] of [
        [-1, -3, h.base],
        [1, -3, h.light],
        [3, -4, h.light],
        [5, -3, h.base],
        [7, -3, h.base],
        [-2, -1, h.base],
        [8, -1, h.shade],
        [-2, 1, h.shade],
        [8, 1, h.shade],
      ]) {
        canvas.px(x + dx, y + dy, c);
      }
      break;
    case "bun":
      canvas.rect(x, y - 1, 7, 2, h.base);
      canvas.hline(x + 1, y - 1, 4, h.light);
      canvas.disc(x + 7, y - 2, 2, h.base);
      canvas.px(x + 6, y - 3, h.light);
      break;
    case "locs":
      canvas.rect(x, y - 2, 7, 3, h.base);
      canvas.hline(x + 1, y - 2, 4, h.light);
      for (let i = 0; i < 3; i += 1) {
        canvas.vline(x - 1, y + i * 3, 2, h.base);
        canvas.vline(x + 7, y + 1 + i * 3, 2, h.shade);
      }
      break;
    case "headscarf":
      canvas.rect(x - 1, y - 2, 9, 4, h.base);
      canvas.hline(x, y - 2, 5, h.light);
      canvas.vline(x - 1, y + 2, 7, h.base);
      canvas.vline(x + 7, y + 2, 6, h.shade);
      // The tied end, falling over the shoulder.
      canvas.rect(x + 6, y + 8, 2, 3, h.base);
      canvas.px(x + 7, y + 10, h.shade);
      break;
    case "cap":
      canvas.rect(x, y - 2, 7, 3, h.base);
      canvas.hline(x + 1, y - 2, 4, h.light);
      canvas.hline(x - 3, y + 1, 5, h.shade);
      canvas.hline(x - 3, y + 1, 2, h.base);
      break;
    case "bald":
      // A lit crown is what says "bald" rather than "hair the colour of skin".
      canvas.hline(x + 1, y, 4, s.base);
      canvas.px(x + 2, y, "X");
      canvas.px(x + 1, y + 1, s.base);
      break;
    default:
      canvas.rect(x, y - 1, 7, 2, h.base);
  }
}

/**
 * A coat: shoulders wider than the waist, a lit left edge, a shadowed right, and a hem.
 *
 * `taper` narrows the last rows, which is what turns a rectangle into a body.
 */
function torso(canvas, x, y, w, h, clothName, { open = false, taper = 1 } = {}) {
  const c = CLOTH[clothName];
  for (let row = 0; row < h; row += 1) {
    const inset = row >= h - 3 ? taper : 0;
    canvas.rect(x + inset, y + row, w - inset * 2, 1, c.base);
  }
  // Shoulders catch the light; the right side and the hem fall away.
  canvas.hline(x + 1, y, w - 2, c.light);
  canvas.vline(x, y + 1, h - 3, c.light);
  canvas.vline(x + w - 1, y + 1, h - 3, c.shade);
  canvas.hline(x + taper, y + h - 1, w - taper * 2, c.shade);

  if (open) {
    const mid = x + Math.floor(w / 2);
    canvas.vline(mid - 1, y + 1, h - 2, c.shade);
    canvas.vline(mid, y + 1, h - 2, "R");
    canvas.vline(mid + 1, y + 1, h - 2, c.shade);
  }
}

/**
 * An arm, proud of the body so it is actually visible.
 *
 * Two pixels wide with its own shaded edge and a hand at the end. `raised` bends it up and out so
 * an umbrella handle meets the hand; the elbow is drawn, because an arm that goes straight up
 * from the shoulder reads as a flagpole.
 */
function arm(canvas, x, y, len, clothName, skinName, { raised = false, mirrored = false } = {}) {
  const c = CLOTH[clothName];
  const s = SKIN[skinName];
  const dir = mirrored ? -1 : 1;

  if (raised) {
    // Upper arm down and out, forearm up: a bend, not a stick.
    canvas.rect(x, y, 2, 4, c.base);
    canvas.vline(x + (mirrored ? 1 : 0), y, 4, c.light);
    canvas.rect(x + dir, y - 4, 2, 5, c.base);
    canvas.vline(x + dir + (mirrored ? 1 : 0), y - 4, 5, c.light);
    canvas.rect(x + dir, y - 6, 2, 2, s.base);
    canvas.px(x + dir + 1, y - 6, s.shade);
    return;
  }

  canvas.rect(x, y, 2, len, c.base);
  canvas.vline(x + (mirrored ? 0 : 1), y, len, c.shade);
  // The hand.
  canvas.rect(x, y + len, 2, 2, s.base);
  canvas.px(x + 1, y + len + 1, s.shade);
}

function legs(canvas, x, y, w, h, legName, style) {
  const l = LEG[legName];
  if (style === "skirt") {
    canvas.rect(x, y, w, 3, l.base);
    canvas.rect(x - 1, y + 3, w + 2, 3, l.base);
    canvas.hline(x - 1, y + 5, w + 2, l.shade);
    canvas.rect(x + 1, y + 6, 2, h - 6, "B");
    canvas.rect(x + w - 3, y + 6, 2, h - 6, "C");
  } else {
    canvas.rect(x, y, w, h, l.base);
    // The gap between the legs, which is what stops them reading as a skirt.
    canvas.vline(x + Math.floor(w / 2), y + 2, h - 2, l.shade);
    canvas.vline(x + w - 1, y, h, l.shade);
  }
  // Shoes: dark, and wider than the leg, which is what holds a figure on the ground.
  canvas.rect(x - 1, y + h, 3, 2, "K");
  canvas.rect(x + w - 2, y + h, 3, 2, "K");
  canvas.hline(x - 1, y + h, 3, "L");
  canvas.hline(x + w - 2, y + h, 3, "L");
}

/**
 * The library.
 *
 * Twelve people, written out one at a time rather than generated from a product of options: a
 * generated cast has the uncanny sameness of a character creator, and the point is that the stop
 * looks like a street.
 *
 * `hand` is where an umbrella handle goes in the `holding` pose; `headTop` is where a hat sits.
 * Both in art pixels from the sprite's own origin.
 */
export const PEOPLE = [
  {
    id: "commuter-red-coat",
    description: "Adult in a red winter coat with a satchel",
    hand: { x: 18, y: 12 },
    headTop: 3,
    eyes: { x: 8, y: 9 },
    neck: { x: 10, y: 13 },
    draw(canvas, pose) {
      head(canvas, 8, 5, "light", "brown", "crop");
      torso(canvas, 6, 14, 11, 13, "red", { taper: 1 });
      arm(canvas, 4, 15, 10, "red", "light");
      arm(canvas, 17, 15, 10, "red", "light", { raised: pose === "holding", mirrored: true });
      legs(canvas, 8, 27, 7, 13, "denim");
      // Satchel: a strap across the chest and a bag on the hip.
      canvas.line(8, 15, 15, 23, "M");
      canvas.rect(14, 23, 5, 5, "M");
      canvas.hline(14, 23, 5, "N");
      canvas.hline(15, 25, 3, "L");
    },
  },
  {
    id: "student-headphones",
    description: "Young adult in a hoodie with over-ear headphones",
    hand: { x: 18, y: 13 },
    headTop: 2,
    eyes: { x: 8, y: 10 },
    neck: { x: 10, y: 14 },
    draw(canvas, pose) {
      head(canvas, 8, 6, "brown", "black", "curls");
      torso(canvas, 6, 15, 11, 13, "charcoal", { taper: 1 });
      // The hood, bunched behind the neck: a shape, not a stripe.
      canvas.rect(6, 14, 11, 3, "L");
      canvas.hline(7, 14, 9, "M");
      canvas.px(5, 15, "L");
      canvas.px(17, 15, "L");
      arm(canvas, 4, 16, 10, "charcoal", "brown");
      arm(canvas, 17, 16, 10, "charcoal", "brown", {
        raised: pose === "holding",
        mirrored: true,
      });
      legs(canvas, 8, 28, 7, 12, "dark");
      // Headphones over the curls: a band with a cup each side, in a colour the hair is not.
      canvas.line(8, 4, 14, 4, "K");
      canvas.line(8, 3, 14, 3, "N");
      canvas.rect(6, 8, 3, 4, "K");
      canvas.rect(14, 8, 3, 4, "L");
      canvas.hline(6, 8, 3, "N");
    },
  },
  {
    id: "wheelchair-user",
    description: "Wheelchair user in a blue jacket",
    hand: { x: 19, y: 17 },
    headTop: 8,
    eyes: { x: 9, y: 14 },
    neck: { x: 11, y: 18 },
    draw(canvas, pose) {
      /*
       * The chair is drawn as a chair: a back post, a seat frame, a footplate, a large rear wheel
       * with a handrim and spokes, and a small front castor. The first pass drew a ring and a
       * person, which read as somebody sitting on a bicycle wheel.
       */
      canvas.rect(5, 18, 2, 12, "N");
      canvas.rect(5, 28, 13, 2, "M");
      canvas.line(17, 30, 19, 36, "M");
      canvas.rect(17, 36, 4, 2, "N");

      canvas.ring(9, 33, 7, "K");
      canvas.ring(9, 33, 6, "L");
      canvas.ring(9, 33, 4, "O");
      for (const [dx, dy] of [
        [0, -4],
        [4, 0],
        [0, 4],
        [-4, 0],
        [3, -3],
        [-3, 3],
      ]) {
        canvas.line(9, 33, 9 + dx, 33 + dy, "N");
      }
      canvas.disc(9, 33, 1, "P");
      canvas.ring(20, 38, 2, "K");

      head(canvas, 9, 10, "tan", "black", "crop");
      torso(canvas, 7, 19, 11, 9, "blue", { taper: 1 });
      arm(canvas, 5, 20, 7, "blue", "tan");
      arm(canvas, 18, 20, 7, "blue", "tan", { raised: pose === "holding", mirrored: true });
      // Lap and lower legs, forward of the seat.
      canvas.rect(7, 28, 11, 3, "L");
      canvas.hline(7, 28, 11, "M");
      canvas.rect(15, 31, 4, 5, "L");
      canvas.hline(15, 31, 4, "M");
      canvas.rect(17, 34, 4, 2, "K");
    },
  },
  {
    id: "older-with-stick",
    description: "Older person with a walking stick and a shopping bag",
    hand: { x: 4, y: 15 },
    headTop: 3,
    eyes: { x: 8, y: 9 },
    neck: { x: 10, y: 13 },
    draw(canvas, pose) {
      head(canvas, 8, 5, "light", "white", "crop");
      // A slight stoop: the shoulders round.
      torso(canvas, 6, 15, 11, 12, "stone", { taper: 1 });
      canvas.hline(6, 15, 4, "P");
      arm(canvas, 4, 16, 9, "stone", "light", { raised: pose === "holding" });
      arm(canvas, 17, 16, 9, "stone", "light", { mirrored: true });
      legs(canvas, 8, 27, 7, 13, "stone");
      // The stick: planted ahead of the feet, with a crook and a ferrule.
      canvas.line(19, 27, 20, 41, "y");
      canvas.px(18, 26, "z");
      canvas.px(19, 26, "z");
      canvas.px(20, 41, "K");
      // A shopping bag, with handles that reach the hand.
      canvas.rect(2, 27, 5, 6, "3");
      canvas.hline(2, 27, 5, "4");
      canvas.px(3, 26, "3");
      canvas.px(5, 26, "3");
    },
  },
  {
    id: "child-in-yellow",
    description: "Child in a bright yellow coat and red wellies",
    hand: { x: 17, y: 22 },
    headTop: 12,
    eyes: { x: 9, y: 18 },
    neck: { x: 11, y: 22 },
    draw(canvas, pose) {
      // Shorter, with a proportionally larger head: that ratio is what reads as a child.
      head(canvas, 9, 14, "deep", "black", "bun");
      torso(canvas, 8, 23, 9, 9, "hiVis", { taper: 1 });
      arm(canvas, 6, 24, 7, "hiVis", "deep");
      arm(canvas, 17, 24, 7, "hiVis", "deep", { raised: pose === "holding", mirrored: true });
      legs(canvas, 10, 32, 5, 8, "red");
    },
  },
  {
    id: "nurse-in-scrubs",
    description: "Adult in scrubs with a lanyard, coming off shift",
    hand: { x: 18, y: 12 },
    headTop: 3,
    eyes: { x: 8, y: 9 },
    neck: { x: 10, y: 13 },
    draw(canvas, pose) {
      head(canvas, 8, 5, "tan", "brown", "bun");
      torso(canvas, 6, 14, 11, 13, "paleBlue", { taper: 1 });
      arm(canvas, 4, 15, 10, "paleBlue", "tan");
      arm(canvas, 17, 15, 10, "paleBlue", "tan", {
        raised: pose === "holding",
        mirrored: true,
      });
      legs(canvas, 8, 27, 7, 13, "scrub");
      // A V-neck: what makes scrubs read as scrubs rather than as pyjamas.
      canvas.px(10, 14, "b");
      canvas.px(12, 14, "b");
      canvas.px(11, 15, "b");
      // Lanyard down to a card.
      canvas.line(10, 15, 11, 20, "s");
      canvas.line(13, 15, 12, 20, "s");
      canvas.rect(10, 20, 4, 5, "W");
      canvas.hline(10, 20, 4, "R");
      canvas.hline(11, 22, 2, "P");
    },
  },
  {
    id: "rollator-user",
    description: "Older person using a rollator",
    hand: { x: 3, y: 20 },
    headTop: 4,
    eyes: { x: 10, y: 10 },
    neck: { x: 12, y: 14 },
    draw(canvas, pose) {
      head(canvas, 10, 6, "brown", "grey", "crop");
      torso(canvas, 8, 16, 11, 12, "cream", { taper: 1 });
      arm(canvas, 6, 17, 9, "cream", "brown", { raised: pose === "holding" });
      arm(canvas, 19, 17, 9, "cream", "brown", { mirrored: true });
      legs(canvas, 10, 28, 7, 12, "dark");

      /*
       * The rollator, ahead of the figure: two handles, a frame that rakes forward, a padded seat
       * and two wheels. In metal grey against the cream coat, so it separates.
       */
      canvas.rect(1, 24, 3, 2, "M");
      canvas.rect(6, 23, 3, 2, "N");
      canvas.line(2, 26, 3, 36, "N");
      canvas.line(7, 25, 6, 36, "M");
      canvas.rect(1, 29, 8, 2, "O");
      canvas.hline(1, 29, 8, "P");
      canvas.ring(3, 38, 2, "K");
      canvas.ring(7, 38, 2, "K");
    },
  },
  {
    id: "cyclist-waiting",
    description: "Adult in a hi-vis jacket and helmet",
    hand: { x: 18, y: 13 },
    headTop: 2,
    eyes: { x: 8, y: 10 },
    neck: { x: 10, y: 14 },
    draw(canvas, pose) {
      head(canvas, 8, 6, "light", "auburn", "cap");
      torso(canvas, 6, 15, 11, 12, "hiVis", { taper: 1 });
      // Two reflective bands with a dark gap, which is what a hi-vis jacket actually looks like.
      canvas.hline(6, 19, 11, "W");
      canvas.hline(6, 20, 11, "P");
      canvas.hline(6, 23, 11, "W");
      arm(canvas, 4, 16, 10, "hiVis", "light");
      arm(canvas, 17, 16, 10, "hiVis", "light", { raised: pose === "holding", mirrored: true });
      legs(canvas, 8, 27, 7, 13, "dark");
    },
  },
  {
    id: "parent-with-buggy",
    description: "Adult pushing a pram",
    hand: { x: 4, y: 16 },
    headTop: 3,
    eyes: { x: 11, y: 9 },
    neck: { x: 13, y: 13 },
    draw(canvas, pose) {
      head(canvas, 11, 5, "deep", "black", "locs");
      torso(canvas, 9, 15, 11, 12, "darkRed", { taper: 1 });
      arm(canvas, 7, 16, 9, "darkRed", "deep", { raised: pose === "holding" });
      arm(canvas, 20, 16, 9, "darkRed", "deep", { mirrored: true });
      legs(canvas, 11, 27, 7, 13, "denim");

      /*
       * The pram: a raked handle down to a body, a hood over the head end, and two wheels of
       * different sizes. A recognisable object rather than a box on castors.
       */
      canvas.line(6, 22, 2, 30, "M");
      canvas.line(7, 22, 3, 30, "N");
      canvas.rect(0, 25, 8, 6, "b");
      canvas.hline(0, 25, 8, "c");
      canvas.hline(0, 30, 8, "a");
      canvas.rect(0, 22, 4, 4, "a");
      canvas.hline(0, 22, 4, "b");
      canvas.ring(2, 36, 3, "K");
      canvas.ring(7, 37, 2, "K");
      canvas.line(2, 31, 2, 33, "M");
      canvas.line(7, 31, 7, 35, "M");
    },
  },
  {
    id: "worker-with-flask",
    description: "Adult in a heavy green jacket with a flask",
    hand: { x: 18, y: 13 },
    headTop: 3,
    eyes: { x: 8, y: 9 },
    neck: { x: 10, y: 13 },
    draw(canvas, pose) {
      head(canvas, 8, 5, "brown", "grey", "bald");
      torso(canvas, 6, 15, 11, 13, "green", { open: true, taper: 1 });
      arm(canvas, 4, 16, 10, "green", "brown");
      arm(canvas, 17, 16, 10, "green", "brown", { raised: pose === "holding", mirrored: true });
      legs(canvas, 8, 28, 7, 12, "dark");
      // A flask: a body, a lighter cup on top and a handle, held low in the near hand.
      canvas.rect(2, 26, 4, 7, "s");
      canvas.hline(2, 26, 4, "t");
      canvas.rect(2, 24, 4, 2, "P");
      canvas.px(6, 28, "M");
      canvas.px(6, 29, "M");
    },
  },
  {
    id: "person-in-headscarf",
    description: "Adult in a headscarf and a long coat",
    hand: { x: 18, y: 12 },
    headTop: 3,
    eyes: { x: 8, y: 9 },
    neck: { x: 10, y: 13 },
    draw(canvas, pose) {
      head(canvas, 8, 5, "tan", "auburn", "headscarf");
      // A long coat changes the silhouette entirely: the hem is near the ankle.
      torso(canvas, 6, 15, 11, 18, "plum", { taper: 1 });
      arm(canvas, 4, 16, 13, "plum", "tan");
      arm(canvas, 17, 16, 13, "plum", "tan", { raised: pose === "holding", mirrored: true });
      legs(canvas, 8, 33, 7, 7, "dark");
    },
  },
  {
    id: "teen-with-skateboard",
    description: "Teenager with a skateboard stood against their leg",
    hand: { x: 18, y: 13 },
    headTop: 2,
    eyes: { x: 8, y: 9 },
    neck: { x: 10, y: 13 },
    draw(canvas, pose) {
      head(canvas, 8, 5, "light", "fair", "long");
      torso(canvas, 6, 15, 11, 11, "blue", { open: true, taper: 1 });
      arm(canvas, 4, 16, 9, "blue", "light");
      arm(canvas, 17, 16, 9, "blue", "light", { raised: pose === "holding", mirrored: true });
      legs(canvas, 8, 26, 7, 14, "denim");
      /*
       * The board stood on its tail against the leg — how anyone actually holds one while
       * waiting, and far more legible at this size than a board tucked under an arm.
       */
      canvas.rect(1, 20, 3, 14, "s");
      canvas.vline(1, 20, 14, "t");
      canvas.px(2, 19, "s");
      canvas.px(2, 34, "s");
      canvas.rect(4, 23, 2, 2, "P");
      canvas.rect(4, 29, 2, 2, "P");
    },
  },
];

/**
 * The weather layer: things a person holds, wears or stands under.
 *
 * Separate sprites at published sizes, positioned against a character's `hand` or `headTop`
 * anchor — `hand` for something carried, `head` for something worn on top, and `neck` for
 * something worn round it, because a scarf placed at the crown reads as a flag. Redrawn larger
 * after the first pass, where the hats and glasses were so small they read
 * as debris on the pavement rather than as things somebody was wearing.
 */
export const ACCESSORIES = {
  umbrella: {
    anchor: "hand",
    w: 26,
    h: 24,
    draw(canvas) {
      // Canopy: six panels over ribs, alternating tone, domed rather than flat.
      for (let i = 0; i < 6; i += 1) {
        const x = 1 + i * 4;
        const lift = Math.round(3 - Math.abs(2.5 - i));
        canvas.rect(x, 5 - lift, 4, 5 + lift, i % 2 ? "s" : "t");
      }
      canvas.hline(1, 4, 24, "t");
      canvas.hline(3, 3, 20, "u");
      canvas.hline(7, 2, 12, "u");
      canvas.hline(10, 1, 6, "v");
      // Rib tips: the scalloped edge a real umbrella has.
      for (const x of [1, 5, 9, 13, 17, 21, 24]) canvas.px(x, 9, "q");
      // Shaft, ferrule and a crook handle that actually hooks.
      canvas.vline(13, 9, 12, "M");
      canvas.px(13, 0, "N");
      canvas.px(12, 21, "M");
      canvas.px(11, 22, "M");
      canvas.px(11, 21, "N");
    },
  },
  sunglasses: {
    anchor: "eyes",
    w: 11,
    h: 4,
    draw(canvas) {
      canvas.rect(0, 0, 4, 3, "K");
      canvas.rect(7, 0, 4, 3, "K");
      canvas.hline(4, 1, 3, "K");
      // A highlight in each lens: the only reason they read as glass rather than as holes.
      canvas.px(1, 0, "h");
      canvas.px(8, 0, "h");
      canvas.px(2, 1, "g");
      canvas.px(9, 1, "g");
    },
  },
  scarf: {
    anchor: "neck",
    w: 13,
    h: 11,
    draw(canvas) {
      canvas.rect(0, 0, 9, 4, "s");
      canvas.hline(0, 0, 9, "t");
      canvas.hline(0, 3, 9, "r");
      // The loose end, blown out and downward — the thing that shows the wind.
      canvas.rect(8, 2, 4, 3, "s");
      canvas.rect(10, 5, 3, 3, "r");
      canvas.rect(11, 8, 2, 3, "q");
    },
  },
  woollyHat: {
    anchor: "head",
    w: 11,
    h: 8,
    draw(canvas) {
      canvas.rect(1, 2, 9, 4, "b");
      canvas.hline(2, 1, 7, "c");
      canvas.hline(3, 0, 5, "c");
      // Turned-up brim, in a lighter wool.
      canvas.rect(0, 6, 11, 2, "R");
      canvas.hline(0, 6, 11, "W");
    },
  },
  sunHat: {
    anchor: "head",
    w: 16,
    h: 8,
    draw(canvas) {
      // Brim, wider than the crown, with a shaded underside.
      canvas.hline(0, 5, 16, "9");
      canvas.hline(1, 6, 14, "8");
      canvas.hline(3, 7, 10, "6");
      canvas.rect(4, 0, 8, 5, "9");
      canvas.hline(4, 0, 8, "R");
      canvas.hline(4, 3, 8, "z");
      canvas.hline(4, 4, 8, "y");
    },
  },
};

/**
 * Renders one character.
 *
 * The outline pass runs last and is the reason these read as finished: a near-black contour round
 * the whole silhouette lifts the figure off whatever is behind it. It is drawn *outside* the
 * artwork — an in-place outline recolours the sprite's own edge pixels, which on a seven-pixel
 * head means the eyes and the jaw, and left every character looking hooded.
 */
export function drawPerson(person, pose = "plain") {
  const canvas = new Canvas(PERSON_W, PERSON_H);
  person.draw(canvas, pose);
  // Outside the silhouette, not over it: an in-place outline ate the eyes off a seven-pixel head.
  canvas.outerOutline("K");
  return canvas;
}

export function drawAccessory(name) {
  const accessory = ACCESSORIES[name];
  const canvas = new Canvas(accessory.w, accessory.h);
  accessory.draw(canvas);
  return canvas;
}

/**
 * Which person is at this stop today.
 *
 * Deterministic on the stop and the date, and — deliberately — on nothing else. The weather is
 * not an input: the same person is at the same stop all day whatever the sky does, which is both
 * how a street works and the only way to avoid implying that some people only go out when it is
 * sunny.
 */
export function personForStop(atcoCode, serviceDate) {
  const seed = `${atcoCode}:${serviceDate}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PEOPLE[hash % PEOPLE.length];
}
