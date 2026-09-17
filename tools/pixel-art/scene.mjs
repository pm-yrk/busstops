import { Canvas } from "./canvas.mjs";
import { busSide2, busMid2 } from "./bus2.mjs";
import { shopBuilding, distantBlock } from "./buildings.mjs";
import { tree, cloud, shelter, stopFlag, lamp, bench, bin } from "./street.mjs";
import { PEOPLE, drawPerson } from "./people.mjs";

/**
 * People waiting at the stop, from the weather vignette's cast.
 *
 * Standing on the kerb line rather than on one baseline, so the group has depth instead of
 * reading as a row of cut-outs.
 */
function waitingAtStop(c, g, placements) {
  placements.forEach(([id, x], index) => {
    const person = PEOPLE.find((entry) => entry.id === id);
    if (!person) return;
    const sprite = drawPerson(person, "plain");
    c.blit(sprite, x, g.kerb - sprite.h + (index % 2 === 0 ? 0 : 2));
  });
}

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

/*
 * Second-generation resolution.
 *
 * The first compositions were 320x144 and 144x250, and the detail they could carry had run out —
 * the hero bus was 100x32, a shelter door was two pixels, a person was fourteen pixels tall. More
 * detail was not available at that grid; the grid had to grow.
 *
 * The wide street is half as large again in each direction, which on a 1440-pixel desktop is a
 * whole-number scale of three rather than four and fills the width exactly. The upright street
 * grows by a third: 192 art pixels is the most a 390-pixel phone can show at a scale of two, and
 * a scale of two is the floor below which the artwork stops reading as artwork.
 *
 * Everything standing on the pavement grew with them, so nothing is smaller on screen than it was.
 */
const WIDE = { w: 480, h: 200, pavement: 132, kerb: 154, road: 160 };
const TALL = { w: 192, h: 264, pavement: 176, kerb: 196, road: 202 };

/** The first generation's coordinates, scaled. Written this way so the composition stays legible. */
const WIDE_K = 1.5;
const TALL_K = 1.336;
const sw = (n) => Math.round(n * WIDE_K);
const st = (n) => Math.round(n * TALL_K);
const scaleTerrace = (entries, k) =>
  entries.map((b) => ({
    ...b,
    x: Math.round(b.x * k),
    w: Math.round(b.w * k),
    h: Math.round(b.h * k),
    ...(b.shopH === undefined ? {} : { shopH: Math.round(b.shopH * k) }),
  }));

function sky(c, horizon) {
  c.rect(0, 0, c.w, horizon, "T");
  c.rect(0, 0, c.w, Math.floor(horizon * 0.45), "S");
}

/** Paving slabs, a kerb with a lit top edge, and a gutter. */
function pavement(c, { pavement: py, kerb, road }, { boardingAt = null } = {}) {
  c.rect(0, py, c.w, kerb - py, "Q");
  c.hline(0, py, c.w, "R");
  for (let x = py % 13; x < c.w; x += 13) c.vline(x, py + 1, kerb - py - 1, "P");
  c.hline(0, py + Math.floor((kerb - py) / 2), c.w, "P");
  c.speckle(0, py + 1, c.w, kerb - py - 2, "P", 0.05, 7);

  /*
   * Tactile paving where people board.
   *
   * The buff corduroy strip at a boarding point is not decoration: it is how a blind or partially
   * sighted passenger finds the door, and it is on the pavement at every proper bus stop in the
   * country. Leaving it out of a picture of a British bus stop is the kind of omission you only
   * notice if it matters to you, which is the reason to draw it.
   *
   * Buff, because that is the contrast colour the standard asks for, and ribbed along the length
   * of the kerb, which is the pattern that means "boarding point" rather than "crossing".
   */
  if (boardingAt) {
    const [bx, bw] = boardingAt;
    const ty = kerb - 4;
    c.rect(bx, ty, bw, 4, "8");
    c.hline(bx, ty, bw, "9");
    for (let x = bx; x < bx + bw; x += 2) c.vline(x, ty + 1, 3, "7");
    c.hline(bx, kerb - 1, bw, "6");
  }

  // Kerb.
  c.rect(0, kerb, c.w, road - kerb, "P");
  c.hline(0, kerb, c.w, "R");
  c.hline(0, road - 1, c.w, "N");
}

/**
 * Asphalt: patched, not flat, with a centre line, a stop cage and a gully.
 *
 * `markings` is off for the repeating edge tile. Those are one-off features of this stretch of
 * road; tiled, the stop cage came out as a row of little red boxes marching off both sides of
 * the window.
 */
function carriageway(c, { road, h }, { markings = true } = {}) {
  c.rect(0, road, c.w, h - road, "M");
  c.hline(0, road, c.w, "N");
  // The gutter runs in the kerb's shadow.
  c.hline(0, road, c.w, "+");
  c.hline(0, road + 1, c.w, "-");
  c.speckle(0, road + 1, c.w, h - road - 1, "N", 0.07, 3);
  c.speckle(0, road + 1, c.w, h - road - 1, "L", 0.05, 11);
  // Lane line down the middle of the carriageway. This one does tile.
  const mid = road + Math.floor((h - road) / 2);
  for (let x = 4; x < c.w; x += 14) c.hline(x, mid, 7, "Q");
  if (!markings) return;
  // A patch of newer asphalt, because a road that is one colour reads as a floor.
  c.rect(Math.floor(c.w * 0.18), road + 3, 46, h - road - 6, "L");
  c.speckle(Math.floor(c.w * 0.18), road + 3, 46, h - road - 6, "M", 0.18, 5);
  // The bus stop cage: an outlined box on the carriageway, which is what is actually painted
  // there. A single stripe read as a stray orange line lying in the road.
  const cage = Math.floor(c.w * 0.42);
  const cageW = Math.floor(c.w * 0.34);
  const cageH = Math.min(11, h - road - 5);
  /*
   * Painted, not washed.
   *
   * This was a rect of `*`, a thirty-two percent red. One cell of this canvas holds one colour,
   * so painting it did not tint the asphalt — it replaced it, and a translucent red over nothing
   * composites against the page rather than against the road. The bay came out as a flat pale
   * pink slab with no texture in it, sitting on the carriageway like a stain rather than like
   * paint, which is exactly what it looked like.
   *
   * So it is laid down in the road-paint ramp at full opacity and then given back its texture:
   * the same speckle the asphalt gets, in the darker red, so the surface underneath still reads
   * through the colour. Worn at the edges, because bus bays are.
   */
  c.rect(cage, road + 2, cageW, cageH, "r");
  c.speckle(cage, road + 2, cageW, cageH, "q", 0.22, 7);
  c.speckle(cage, road + 2, cageW, cageH, "s", 0.1, 23);
  c.frame(cage, road + 2, cageW, cageH, "q");
  c.hline(cage + 1, road + 2, cageW - 2, "s");
  // The worn dashes along the kerb side of the bay.
  for (let x = cage + 2; x < cage + cageW - 2; x += 4) c.hline(x, road + 2 + cageH - 1, 2, "Q");
  /*
   * Double yellow lines along the gutter.
   *
   * The single most recognisably British mark on a road surface, and the reason the kerb outside a
   * bus stop is empty of parked cars in the first place. They break for the bus bay, which is what
   * actually happens and what makes them read as markings rather than as a stripe.
   */
  const cageFrom = Math.floor(c.w * 0.42);
  const cageTo = cageFrom + Math.floor(c.w * 0.34);
  for (let x = 0; x < c.w; x++) {
    if (x >= cageFrom - 2 && x <= cageTo + 2) continue;
    c.px(x, road + 1, "z");
    c.px(x, road + 3, "z");
  }

  // Gully: a real grating, sunk into the gutter rather than painted on it.
  const gx = Math.floor(c.w * 0.72);
  c.rect(gx, road + 1, 8, 4, "L");
  c.hline(gx, road, 8, "N");
  for (let x = 0; x < 8; x += 2) c.vline(gx + x, road + 2, 2, "K");
  c.hline(gx, road + 4, 8, "M");

  // A manhole further out, because a carriageway is a lid over everything under it.
  const mx = Math.floor(c.w * 0.26);
  const my = road + Math.floor((h - road) / 2) + 3;
  c.rect(mx, my, 11, 5, "N");
  c.frame(mx, my, 11, 5, "L");
  for (let x = 1; x < 10; x += 2) c.vline(mx + x, my + 1, 3, "M");
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
    {
      x: 188,
      w: 44,
      h: 60,
      wall: "brick",
      shop: false,
      floors: 1,
      lit: [0],
      shopH: 28,
      chimney: false,
    },
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
  scaleTerrace(terrace, WIDE_K).forEach((b, i) => {
    c.blit(
      shopBuilding({ ...b, seed: i, chimney: b.chimney ?? b.h > sw(72) }),
      b.x,
      g.pavement - b.h,
    );
  });

  pavement(c, g, { boardingAt: [sw(146), sw(66)] });

  // ---- midground: the street ------------------------------------------
  // Nothing lines up on one baseline: the furniture stands at slightly different depths on the
  // pavement, so its feet sit on different rows.
  c.blit(tree({ w: 51, h: 69, seed: 2, spread: 1.15 }), sw(6), g.kerb - 69);
  c.blit(bench({ w: 39 }), sw(52), g.kerb - 26);
  c.blit(lamp({ h: 81 }), sw(92), g.kerb - 82);
  c.blit(tree({ w: 42, h: 60, seed: 6, spread: 0.8 }), sw(110), g.kerb - 60);
  c.blit(shelter({ w: 90, h: 72 }), sw(142), g.kerb - 73);
  c.blit(stopFlag({ h: 78 }), sw(206), g.kerb - 80); // in the gap between two frontages
  c.blit(bin(), sw(226), g.kerb - 26);
  c.blit(tree({ w: 48, h: 66, seed: 4, spread: 1 }), sw(268), g.kerb - 66);

  /*
   * The people at the stop are the vignette cast, not the old fourteen-pixel figures.
   *
   * Those were drawn for a 144-pixel composition and would be lost in this one. The weather
   * vignette already carries twelve characters at 24 x 44 — a wheelchair user, someone with a
   * rollator, a parent with a buggy, a cyclist, a nurse, a teenager — drawn well enough to stand
   * this close to the front of the picture. Reusing them upgrades the street and puts the range of
   * people who actually wait at a bus stop into the hero, which is where it belongs.
   */
  waitingAtStop(c, g, [
    ["commuter-red-coat", sw(154)],
    ["parent-with-buggy", sw(170)],
    ["wheelchair-user", sw(190)],
    ["older-with-stick", sw(244)],
  ]);

  carriageway(c, g);
  return c;
}

export function tallScene() {
  const g = TALL;
  const c = new Canvas(g.w, g.h);
  sky(c, g.pavement);

  c.blit(cloud({ seed: 5 }), st(2), st(6));
  c.blit(cloud({ seed: 2 }), st(80), st(20));
  c.blit(cloud({ seed: 8 }), st(30), st(36));
  c.blit(distantBlock({ w: st(46), h: st(74), tone: "9" }), st(92), st(96) - st(74));
  c.blit(distantBlock({ w: st(30), h: st(52), tone: "8" }), st(58), st(96) - st(52));

  /*
   * Fewer buildings, taller, so the phone keeps the detail rather than the count.
   *
   * Taller than they were. The upright composition is 250 rows and the terrace used to top out at
   * 82, so a third of the picture was empty sky — on the surface with the least room to spare, the
   * least was happening. Raising them is not stretching the desktop picture: these are more
   * storeys, with more windows and more of them lit, which is what a city looks like from a phone
   * held upright. The sky band that is left is the one the clouds drift across.
   */
  const terrace = [
    {
      x: 0,
      w: 62,
      h: 122,
      wall: "brick",
      sign: "t",
      signText: "CAFE",
      awning: true,
      floors: 3,
      lit: [1, 3],
      shopH: 34,
    },
    {
      x: 62,
      w: 82,
      h: 104,
      wall: "pale",
      shop: false,
      floors: 3,
      lit: [1, 2],
      shopH: 30,
      chimney: false,
    },
  ];
  for (const b of scaleTerrace(terrace, TALL_K))
    c.blit(shopBuilding({ ...b, chimney: b.chimney ?? b.h > st(84) }), b.x, g.pavement - b.h);

  pavement(c, g, { boardingAt: [st(52), st(68)] });

  c.blit(tree({ w: 45, h: 62, seed: 3, spread: 1.1 }), 0, g.kerb - 62);
  c.blit(lamp({ h: 74 }), st(32), g.kerb - 75);
  c.blit(shelter({ w: 84, h: 68 }), st(48), g.kerb - 69);
  c.blit(stopFlag({ h: 74 }), st(118), g.kerb - 76);
  // Fewer figures than the wide street, larger: a phone keeps the detail rather than the count.
  waitingAtStop(c, g, [
    ["parent-with-buggy", st(58)],
    ["wheelchair-user", st(80)],
  ]);

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
  carriageway(c, g, { markings: false });
  return c;
}

/** The vehicles, kept out of the scene so they can be driven across it. */
export const VEHICLES = {
  near: busSide2({ route: "36" }),
  far: busMid2({ route: "12", facing: "left" }),
};
export const GEOMETRY = { WIDE, TALL };
