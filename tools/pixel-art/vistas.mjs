import { Canvas } from "./canvas.mjs";
import { busSide2, busMid2 } from "./bus2.mjs";
import { shelter, stopFlag, tree } from "./street.mjs";
import { PEOPLE, drawPerson, PERSON_H } from "./people.mjs";
import { shopBuilding } from "./buildings.mjs";
import { farBus } from "./vignette2.mjs";
import {
  barrier,
  cat,
  cone,
  desk,
  diversionSign,
  messageBoard,
  monitor,
  mug,
  pigeon,
  pottedPlant,
  worker,
} from "./props.mjs";

/**
 * One composed scene per page.
 *
 * The run before this one gave every page the same strip of pavement with a stop flag on it, and
 * the result was a footer tile moved to the top: it cost a lot of vertical space and told you
 * nothing about the page you were on. These are the replacement. Each is a small world that
 * belongs to its page — a road being dug up, a control desk, a street you would wait on — built
 * from the same sprite library the home page hero uses, so it is the same city throughout.
 *
 * All of them are decoration and none of them states a fact. A bus in the roadworks scene is not
 * a bus that is late; the message board says ROAD WORKS AHEAD and never a real closure. Anything
 * that has to be true is drawn by the page from its data, not in here.
 *
 * One height for all of them, so the masthead is one band and pages do not jump as you move
 * between them. Width varies, because a control room needs more of it than a bus does.
 */
export const VISTA_H = 76;

/** The ground line every vista shares, so the art sits on one pavement across the site. */
const GROUND = 62;
const KERB = 68;

/** Sky, in two bands, with a soft join. The top band is where the clouds go. */
function sky(c, { top = "S", low = "T" } = {}) {
  const horizon = Math.round(VISTA_H * 0.42);
  c.rect(0, 0, c.w, horizon, top);
  c.rect(0, horizon, c.w, GROUND - horizon, low);
  for (let x = 0; x < c.w; x += 2) c.px(x, horizon, top);
}

/** Pavement, kerb and a strip of road, the same three surfaces as the hero. */
function ground(c, { road = true } = {}) {
  c.rect(0, GROUND, c.w, KERB - GROUND, "Q");
  c.hline(0, GROUND, c.w, "R");
  // Paving joints, so the pavement is laid rather than poured.
  for (let x = 4; x < c.w; x += 14) c.vline(x, GROUND + 1, KERB - GROUND - 1, "P");
  c.hline(0, KERB - 1, c.w, "P");
  if (!road) return;
  c.rect(0, KERB, c.w, VISTA_H - KERB, "N");
  c.hline(0, KERB, c.w, "P");
  c.speckle(0, KERB + 1, c.w, VISTA_H - KERB - 1, "M", 0.16, 5);
}

/** A row of distant blocks along the horizon, paler than anything in front of them. */
function skylineRow(c, { from = 0, to = c.w, base = GROUND - 8, seed = 5, tone = "Q" } = {}) {
  let x = from;
  let n = seed;
  while (x < to) {
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    const w = 12 + (n % 18);
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    const h = 14 + (n % 18);
    c.rect(x, base - h, Math.min(w, to - x), h, tone);
    c.hline(x, base - h, Math.min(w, to - x), "P");
    if (w > 18) c.rect(x + 3, base - h - 4, 3, 4, tone);
    x += w + 2;
  }
}

function clouds(c, spots) {
  for (const [cx, cy, w] of spots) {
    c.rect(cx, cy + 3, w, 4, "W");
    c.rect(cx + 4, cy, w - 10, 4, "W");
    c.rect(cx + 2, cy + 1, 5, 3, "X");
    c.hline(cx, cy + 6, w, "R");
  }
}

/**
 * The red bus, at the middle size.
 *
 * `busMid2` defaults to the blue livery, which is the second operator on the home page's road.
 * Every vista that shows one bus should show the product's own red, so the colour that means
 * "Bus Stops." is the one carried across the site.
 */
function redMid(route) {
  return busMid2({
    route,
    body: "t",
    bodyDark: "s",
    bodyDeep: "r",
    bodyLight: "u",
    bodyGlow: "v",
  });
}

/** Drops a sprite with its feet on a given line. */
function stand(c, sprite, x, footY = GROUND) {
  c.blit(sprite, x, footY - sprite.h);
}

/* ------------------------------------------------------------------ route */

/**
 * The route page: the bus itself, large, against the city it runs through.
 *
 * The bus is the subject here — it is the thing the page is about — so it gets the middle of the
 * composition at full size rather than being a 96-pixel prop at the end of a kerb.
 */
export function routeVista({ route = "1" } = {}) {
  const c = new Canvas(232, VISTA_H);
  sky(c);
  skylineRow(c, { from: 0, to: 232, base: GROUND - 6, seed: 9, tone: "Q" });
  skylineRow(c, { from: 12, to: 232, base: GROUND - 4, seed: 21, tone: "P" });
  clouds(c, [
    [16, 6, 24],
    [150, 4, 20],
  ]);
  ground(c);
  stand(c, tree({ w: 30, h: 40, seed: 3 }), 6);
  stand(c, stopFlag({ h: 44, routes: route }), 206);
  stand(c, drawPerson(PEOPLE[0], "plain"), 182);
  // The bus on the road, wheels on the carriageway rather than on the kerb.
  c.blit(busSide2({ route }), 44, VISTA_H - 50);
  stand(c, pigeon({ facing: "left" }), 200, GROUND);
  return c;
}

/* ---------------------------------------------------------------- journey */

/**
 * The journey page: a street you would actually wait on.
 *
 * Terrace, tree, shelter, someone waiting, and a bus arriving — the beginning of a trip rather
 * than an illustration of transport in general.
 */
export function journeyVista() {
  const c = new Canvas(272, VISTA_H);
  sky(c);
  clouds(c, [
    [10, 5, 22],
    [128, 3, 26],
  ]);
  // Two terraced fronts, the nearer one taller, so the roofline steps.
  c.blit(
    shopBuilding({ w: 46, h: 58, sign: "s", signText: "SHOP", floors: 2, shopH: 22 }),
    4,
    GROUND - 58,
  );
  c.blit(
    shopBuilding({
      w: 40,
      h: 50,
      wall: "render",
      sign: "b",
      signText: "POST",
      floors: 1,
      shopH: 20,
      seed: 3,
    }),
    50,
    GROUND - 50,
  );
  ground(c);
  stand(c, tree({ w: 32, h: 42, seed: 7 }), 92);
  c.blit(shelter({ w: 56, h: 44 }), 124, GROUND - 44);
  stand(c, drawPerson(PEOPLE[3], "plain"), 130);
  stand(c, drawPerson(PEOPLE[1], "plain"), 152);
  stand(c, stopFlag({ h: 42, routes: "36" }), 182);
  /*
   * The bus on the carriageway, not over the pavement.
   *
   * The first placement put it at `VISTA_H - 36`, which is above the kerb line — so a
   * thirty-three-pixel bus floated across the shelter and the people waiting at it. Its wheels
   * belong on the road, which means its bottom edge is the canvas floor.
   */
  c.blit(redMid("36"), 172, VISTA_H - 33);
  return c;
}

/* ------------------------------------------------------------- roadworks */

/**
 * The disruptions page: a road being dug up.
 *
 * The message board carries generic words, never a real closure. The page states the actual
 * notices in type, where they can carry their source and their time; a drawing that spelled out
 * a specific road would be the artwork making a claim the data has not checked.
 */
export function roadworksVista() {
  const c = new Canvas(288, VISTA_H);
  sky(c);
  skylineRow(c, { from: 130, to: 288, base: GROUND - 6, seed: 4, tone: "Q" });
  clouds(c, [
    [96, 4, 22],
    [206, 9, 18],
  ]);
  ground(c);
  // A bus going past behind the works, so the street is still working.
  c.blit(redMid("36"), 142, VISTA_H - 33);
  // The works themselves, left to right: board, barrier, cones, worker, diversion.
  c.blit(messageBoard(), 4, GROUND - 72);
  stand(c, barrier({ w: 46, h: 20 }), 72);
  stand(c, cone({ h: 18 }), 122);
  stand(c, cone({ h: 20 }), 136, GROUND + 4);
  stand(c, worker({ h: 42 }), 96);
  stand(c, diversionSign({ w: 34, h: 42, arrow: "right" }), 244);
  stand(c, cone({ h: 16 }), 118, GROUND + 5);
  return c;
}

/* ----------------------------------------------------------- control room */

/**
 * Pro: the room behind the product.
 *
 * A window onto the city, a desk, three screens showing three different kinds of thing, and
 * somebody watching them. This one is an interior, so it has no sky band and no kerb — it is the
 * only vista that steps off the street, which is the point of it.
 */
export function controlRoomVista() {
  const c = new Canvas(248, VISTA_H);
  const floor = VISTA_H - 6;
  const deskTop = floor - 18;

  // Wall, skirting, floor.
  c.rect(0, 0, c.w, floor, "8");
  c.speckle(0, 0, c.w, floor, "7", 0.05, 3);
  c.rect(0, floor, c.w, VISTA_H - floor, "6");
  c.hline(0, floor, c.w, "M");

  /*
   * The window sits entirely above the desk.
   *
   * The first version gave it forty-four rows starting at six, and the monitors — which stand on
   * a desk two thirds of the way down — were drawn straight through it. An interior only reads
   * as a room if the things in it are at different depths *and* different heights; a window and
   * a monitor occupying the same rectangle is neither.
   */
  const win = { x: 8, y: 2, w: 104, h: 32 };
  c.rect(win.x, win.y, win.w, win.h, "S");
  c.rect(win.x, win.y + 18, win.w, win.h - 18, "T");
  // Skyline outside, kept low so most of the pane is sky.
  let n = 17;
  let bx = win.x;
  while (bx < win.x + win.w) {
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    const bw = Math.min(9 + (n % 12), win.x + win.w - bx);
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    const bh = 6 + (n % 12);
    c.rect(bx, win.y + win.h - 6 - bh, bw, bh, "Q");
    c.hline(bx, win.y + win.h - 6 - bh, bw, "P");
    bx += bw + 2;
  }
  // The street outside, with a small bus on it — the far-distance bus, not the full-size one.
  c.rect(win.x, win.y + win.h - 6, win.w, 6, "P");
  c.hline(win.x, win.y + win.h - 6, win.w, "Q");
  /*
   * The bus goes in the left half of the pane, which is the half no monitor stands in front of.
   *
   * Everything interesting in a window is worth nothing if a screen is parked over it. The desk
   * starts far enough right that the first forty-odd columns of glass stay visible, so that is
   * where the one moving thing outside is put.
   */
  c.blit(farBus({}), win.x + 4, win.y + win.h - 6 - 22);
  // Glazing bars, then the frame over the top so the pane is behind it.
  c.vline(win.x + Math.round(win.w / 2), win.y, win.h, "N");
  c.hline(win.x, win.y + 15, win.w, "N");
  c.frame(win.x, win.y, win.w, win.h, "M");
  c.rect(win.x - 2, win.y - 2, win.w + 4, 2, "M");
  c.rect(win.x - 3, win.y + win.h + 1, win.w + 6, 2, "9");
  c.hline(win.x - 3, win.y + win.h + 1, win.w + 6, "R");

  // A status board on the wall, beside the window rather than over the desk.
  c.rect(206, 6, 34, 22, "K");
  c.frame(206, 6, 34, 22, "M");
  for (let y = 10; y < 26; y += 4) c.hline(209, y, 16 + ((y * 7) % 10), "z");

  /*
   * The operator goes down before the desk does, so the desk occludes her legs.
   *
   * Drawn afterwards she stood on top of it, which is the classic painter's-algorithm mistake:
   * in a side-on interior, everything behind the desk must be laid down before the desk is.
   */
  c.blit(drawPerson(PEOPLE[0], "plain"), 176, deskTop - PERSON_H + 22);

  // The desk, and what is on it.
  c.blit(desk({ w: 184, h: 18 }), 56, deskTop);
  c.blit(monitor({ w: 40, h: 24, screen: "map" }), 62, deskTop - 24);
  c.blit(monitor({ w: 36, h: 22, screen: "chart" }), 106, deskTop - 22);
  c.blit(monitor({ w: 36, h: 22, screen: "list" }), 146, deskTop - 22);
  c.blit(mug(), 210, deskTop - 14);
  // A keyboard: a dark slab with key rows, not a rectangle.
  c.rect(104, deskTop - 4, 32, 4, "M");
  c.hline(104, deskTop - 4, 32, "N");
  for (let x = 106; x < 134; x += 3) c.px(x, deskTop - 3, "P");

  // A plant in the corner, and a cat under the desk because somebody brought one in.
  c.blit(pottedPlant({ w: 20, h: 28 }), 224, floor - 28);
  c.blit(cat({ facing: "right" }), 80, floor - 18);
  return c;
}

/* --------------------------------------------------------------- operator */

/**
 * The operator page: a depot rather than a street.
 *
 * Two buses, the shed they sleep in, and somebody with a clipboard — the place the vehicles on
 * the rest of the site come from.
 */
export function depotVista() {
  const c = new Canvas(264, VISTA_H);
  sky(c);
  clouds(c, [[150, 5, 22]]);
  // The depot shed: a long dark building with a roller door and a sign band.
  const shedTop = 8;
  c.rect(0, shedTop, 150, GROUND - shedTop, "7");
  c.rect(0, shedTop, 150, 5, "M");
  c.hline(0, shedTop, 150, "N");
  c.rect(6, shedTop + 2, 30, 6, "s");
  c.hline(6, shedTop + 2, 30, "t");
  // Roller door: horizontal slats, darker towards the bottom.
  c.rect(44, shedTop + 10, 62, GROUND - shedTop - 10, "N");
  for (let y = shedTop + 12; y < GROUND; y += 3) c.hline(45, y, 60, "M");
  c.frame(44, shedTop + 10, 62, GROUND - shedTop - 10, "M");
  // A high strip window along the shed.
  for (let x = 112; x < 146; x += 9) {
    c.rect(x, shedTop + 10, 7, 8, "h");
    c.hline(x, shedTop + 10, 7, "g");
  }
  ground(c);
  // Two buses on the apron: one nosing out of the door, one alongside.
  c.blit(busMid2({ route: "1" }), 50, GROUND - 31);
  c.blit(redMid("36"), 152, VISTA_H - 33);
  stand(c, drawPerson(PEOPLE[5], "plain"), 18);
  stand(c, tree({ w: 26, h: 34, seed: 11 }), 236);
  return c;
}
