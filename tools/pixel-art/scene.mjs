import { Canvas } from "./canvas.mjs";
import { busSide, busMid } from "./bus.mjs";
import { shopBuilding, distantBlock } from "./buildings.mjs";
import { tree, cloud, shelter, stopFlag, person, lamp, bench, bin } from "./street.mjs";

/**
 * The hero street, composed on one canvas in three planes.
 *
 * Background: sky, cloud and a paler, flatter skyline behind the terrace.
 * Midground: the terrace itself, the pavement and everything standing on it.
 * Foreground: the carriageway, its markings and the buses, which overlap the pavement because a
 * bus is taller than a lane is deep — that overlap is where most of the depth comes from.
 *
 * The buses are not drawn into the scene: they are returned separately so the app can move them.
 */

const WIDE = { w: 320, h: 144, pavement: 98, kerb: 112, road: 116 };
const TALL = { w: 144, h: 250, pavement: 178, kerb: 196, road: 200 };

function sky(c, horizon) {
  c.rect(0, 0, c.w, horizon, "T");
  c.rect(0, 0, c.w, Math.floor(horizon * 0.45), "S");
}

/** Paving slabs, a kerb with a lit top edge, and a gutter. */
function pavement(c, { pavement: py, kerb, road }) {
  c.rect(0, py, c.w, kerb - py, "Q");
  c.hline(0, py, c.w, "R");
  for (let x = py % 13; x < c.w; x += 13) c.vline(x, py + 1, kerb - py - 1, "P");
  c.hline(0, py + Math.floor((kerb - py) / 2), c.w, "P");
  c.speckle(0, py + 1, c.w, kerb - py - 2, "P", 0.05, 7);
  // Kerb.
  c.rect(0, kerb, c.w, road - kerb, "P");
  c.hline(0, kerb, c.w, "R");
  c.hline(0, road - 1, c.w, "N");
}

/** Asphalt: patched, not flat, with a centre line, a stop line and a drain. */
function carriageway(c, { road, h }) {
  c.rect(0, road, c.w, h - road, "M");
  c.hline(0, road, c.w, "N");
  c.speckle(0, road + 1, c.w, h - road - 1, "N", 0.07, 3);
  c.speckle(0, road + 1, c.w, h - road - 1, "L", 0.05, 11);
  // A patch of newer asphalt, because a road that is one colour reads as a floor.
  c.rect(Math.floor(c.w * 0.18), road + 3, 46, h - road - 6, "L");
  c.speckle(Math.floor(c.w * 0.18), road + 3, 46, h - road - 6, "M", 0.18, 5);
  // Lane line down the middle of the carriageway.
  const mid = road + Math.floor((h - road) / 2);
  for (let x = 4; x < c.w; x += 14) c.hline(x, mid, 7, "Q");
  // Bus stop cage: the red-and-yellow marking outside the shelter.
  const cage = Math.floor(c.w * 0.44);
  c.rect(cage, road + 1, Math.floor(c.w * 0.3), 2, "r");
  c.hline(cage, road + 1, Math.floor(c.w * 0.3), "z");
  // Gully.
  c.rect(Math.floor(c.w * 0.72), road + 1, 7, 3, "L");
  for (let y = road + 2; y < road + 4; y++)
    for (let x = 0; x < 7; x += 2) c.px(Math.floor(c.w * 0.72) + x, y, "K");
}

export function wideScene() {
  const g = WIDE;
  const c = new Canvas(g.w, g.h);
  sky(c, g.pavement);

  // ---- background ------------------------------------------------------
  c.blit(cloud({ seed: 3 }), 14, 4);
  c.blit(cloud({ seed: 7 }), 132, 2);
  c.blit(cloud({ seed: 11 }), 244, 8);
  for (const [x, w, h, tone] of [
    [6, 44, 52, "8"],
    [88, 40, 44, "9"],
    [186, 46, 56, "8"],
    [268, 44, 48, "9"],
  ]) {
    c.blit(distantBlock({ w, h, tone }), x, g.pavement - 34 - h);
  }

  // ---- midground: the terrace ------------------------------------------
  // Heights, wall tones, frontage depths and setbacks all vary, and two buildings have no shop
  // at all. Uniform buildings on a level pavement drew one continuous painted stripe across the
  // whole terrace, which is the thing that made it read as a backdrop rather than as a street.
  const terrace = [
    {
      x: 0,
      w: 52,
      h: 78,
      wall: "brick",
      sign: "t",
      signText: "CAFE",
      awning: true,
      floors: 2,
      lit: [1],
      shopH: 32,
    },
    {
      x: 52,
      w: 44,
      h: 92,
      wall: "pale",
      sign: "c",
      signText: "BOOKS",
      floors: 3,
      lit: [0, 4],
      shopH: 26,
    },
    {
      x: 96,
      w: 38,
      h: 66,
      wall: "dark",
      shop: false,
      floors: 2,
      lit: [],
      shopH: 30,
      chimney: false,
    },
    {
      x: 134,
      w: 54,
      h: 84,
      wall: "grey",
      sign: "K",
      signText: "POST",
      floors: 2,
      lit: [2],
      shopH: 36,
    },
    { x: 188, w: 44, h: 70, wall: "brick", shop: false, floors: 2, lit: [1], shopH: 28 },
    {
      x: 232,
      w: 40,
      h: 88,
      wall: "render",
      sign: "W",
      signText: "BAKERY",
      awning: true,
      floors: 3,
      lit: [1, 4],
      shopH: 26,
    },
    {
      x: 272,
      w: 48,
      h: 74,
      wall: "pale",
      sign: "t",
      signText: "LAUNDRY",
      floors: 2,
      lit: [3],
      shopH: 34,
    },
  ];
  for (const b of terrace) {
    c.blit(shopBuilding({ ...b, chimney: b.chimney ?? b.h > 72 }), b.x, g.pavement - b.h);
  }

  pavement(c, g);

  // ---- midground: the street ------------------------------------------
  // Nothing lines up on one baseline: the furniture stands at slightly different depths on the
  // pavement, so its feet sit on different rows.
  c.blit(tree({ seed: 2 }), 8, g.kerb - 47);
  c.blit(bench({}), 52, g.kerb - 17);
  c.blit(lamp({}), 92, g.kerb - 55);
  c.blit(tree({ seed: 6 }), 108, g.kerb - 46);
  c.blit(shelter({}), 142, g.kerb - 49);
  c.blit(stopFlag({}), 206, g.kerb - 54); // in the gap between two frontages
  c.blit(bin(), 226, g.kerb - 19);
  c.blit(tree({ seed: 4 }), 268, g.kerb - 45);
  c.blit(person({ coat: "b", coatDark: "a", pose: 0 }), 154, g.kerb - 22);
  c.blit(person({ coat: "s", coatDark: "q", hair: "D", skin: "B", pose: 1 }), 168, g.kerb - 21);
  c.blit(person({ coat: "M", coatDark: "K", hair: "y", pose: 2 }), 184, g.kerb - 20);
  c.blit(person({ coat: "3", coatDark: "1", hair: "L", skin: "C", pose: 1 }), 244, g.kerb - 22);

  carriageway(c, g);
  return c;
}

export function tallScene() {
  const g = TALL;
  const c = new Canvas(g.w, g.h);
  sky(c, g.pavement);

  c.blit(cloud({ seed: 5 }), 2, 8);
  c.blit(cloud({ seed: 2 }), 80, 26);
  c.blit(cloud({ seed: 8 }), 30, 44);
  c.blit(distantBlock({ w: 44, h: 58, tone: "9" }), 94, g.pavement - 52 - 58);

  // Fewer buildings, taller, so the phone keeps the detail rather than the count.
  // Two buildings, not three: on a phone the detail has to survive, and it survives by having
  // fewer things in the frame rather than by being shrunk.
  const terrace = [
    {
      x: 0,
      w: 62,
      h: 96,
      wall: "brick",
      sign: "t",
      signText: "CAFE",
      awning: true,
      floors: 2,
      lit: [1, 2],
      shopH: 34,
    },
    {
      x: 62,
      w: 82,
      h: 82,
      wall: "pale",
      shop: false,
      floors: 2,
      lit: [1],
      shopH: 30,
      chimney: false,
    },
  ];
  for (const b of terrace)
    c.blit(shopBuilding({ ...b, chimney: b.chimney ?? b.h > 84 }), b.x, g.pavement - b.h);

  pavement(c, g);

  c.blit(tree({ seed: 3 }), 0, g.kerb - 46);
  c.blit(lamp({}), 32, g.kerb - 55);
  c.blit(shelter({ w: 62 }), 48, g.kerb - 49);
  c.blit(stopFlag({}), 118, g.kerb - 54);
  c.blit(person({ coat: "b", coatDark: "a", pose: 0 }), 58, g.kerb - 22);
  c.blit(person({ coat: "s", coatDark: "q", hair: "D", skin: "B", pose: 1 }), 74, g.kerb - 21);
  c.blit(person({ coat: "M", coatDark: "K", hair: "y", pose: 2 }), 92, g.kerb - 20);

  carriageway(c, g);
  return c;
}

/**
 * The strip that carries the street off both edges of the screen.
 *
 * The artwork is scaled by whole numbers, so it almost never comes out exactly as wide as the
 * window; centring it left the street sitting in a box with the page showing either side, which
 * is not what a street does. This tile repeats outward from both edges: a plain frontage of the
 * same terrace, the same pavement, the same kerb, the same road. It is 32 art pixels wide rather
 * than one, so the asphalt keeps its grain instead of turning into stripes.
 */
export function edgeStrip(g, { height = 72, wall = "brick" } = {}) {
  const c = new Canvas(32, g.h);
  sky(c, g.pavement);
  c.blit(
    shopBuilding({
      w: 32,
      h: height,
      wall,
      shop: false,
      floors: 2,
      lit: [],
      chimney: false,
      shopH: 26,
    }),
    0,
    g.pavement - height,
  );
  pavement(c, g);
  carriageway(c, g);
  return c;
}

/** The vehicles, kept out of the scene so they can be driven across it. */
export const VEHICLES = {
  near: busSide({ route: "36" }),
  far: busMid({ route: "12" }),
};
export const GEOMETRY = { WIDE, TALL };
