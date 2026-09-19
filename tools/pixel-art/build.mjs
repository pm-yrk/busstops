import { writeFileSync, mkdirSync } from "node:fs";
import { PALETTE } from "./palette.mjs";
import { encodePng } from "./png.mjs";
import { busFront, busMarker, stopMarker } from "./bus.mjs";
import { busSide2, busMid2 } from "./bus2.mjs";
import { wideScene, tallScene, edgeStrip, GEOMETRY } from "./scene.mjs";
import { shelter, stopFlag, tree, person, cloud, bin } from "./street.mjs";
import {
  routeVista,
  journeyVista,
  roadworksVista,
  controlRoomVista,
  depotVista,
} from "./vistas.mjs";
import { PEOPLE, ACCESSORIES, drawPerson, drawAccessory, PERSON_W, PERSON_H } from "./people.mjs";
import { GEOMETRIES } from "./vignette2.mjs";
import {
  vignetteScene,
  farBus,
  EFFECTS,
  setEffectGeometry,
  VIGNETTE_W,
  VIGNETTE_H,
  VIGNETTE_GROUND,
} from "./vignette.mjs";

/**
 * Emits the finished artwork into the web app.
 *
 * Big pieces become files under public/art so the browser caches them and the bundle stays out
 * of it. Map markers become inline data URIs instead: they are a couple of hundred bytes each
 * and MapLibre wants them synchronously.
 */

const ART_DIR = "apps/web/public/art";
mkdirSync(ART_DIR, { recursive: true });

/** name in code -> [file name, drawing]. */
const FILES = {
  streetWide: ["street-wide", wideScene()],
  /*
   * One composed scene per page, replacing the strip of pavement every page shared.
   *
   * These are decoration and state nothing: the roadworks board says ROAD WORKS AHEAD and never
   * a real closure, and the bus in the control room's window is not a bus that is running.
   */
  vistaRoute: ["vista-route", routeVista()],
  vistaJourney: ["vista-journey", journeyVista()],
  vistaRoadworks: ["vista-roadworks", roadworksVista()],
  vistaControlRoom: ["vista-control-room", controlRoomVista()],
  vistaDepot: ["vista-depot", depotVista()],

  /* The stop page's world: the same street, composed wide, with a skyline behind it. */
  vignetteWorldDay: ["vignette-world-day", vignetteScene({ geometry: "world" })],
  vignetteWorldNight: ["vignette-world-night", vignetteScene({ night: true, geometry: "world" })],
  streetTall: ["street-tall", tallScene()],
  busNear: ["bus-near", busSide2({ route: "36" })],
  busNearB: ["bus-near-b", busSide2({ route: "36", wheelPhase: Math.PI / 4 })],
  // The far carriageway runs the second livery, and runs the other way, so it is drawn facing
  // left rather than transformed: a CSS mirror reverses the route number with the bodywork.
  busFar: ["bus-far", busMid2({ route: "12", facing: "left" })],
  busFarB: ["bus-far-b", busMid2({ route: "12", wheelPhase: Math.PI / 4, facing: "left" })],
  busMid: [
    "bus-mid",
    busMid2({
      body: "t",
      bodyDark: "s",
      bodyDeep: "r",
      bodyLight: "u",
      bodyGlow: "v",
      route: "36",
    }),
  ],
  busMidB: [
    "bus-mid-b",
    busMid2({
      body: "t",
      bodyDark: "s",
      bodyDeep: "r",
      bodyLight: "u",
      bodyGlow: "v",
      route: "36",
      wheelPhase: Math.PI / 4,
    }),
  ],
  busFront: ["bus-front", busFront({ route: "36" })],
  shelter: ["shelter", shelter({})],
  stopFlag: ["stop-flag", stopFlag({})],
  tree: ["tree", tree({ seed: 2 })],
  personWaiting: ["person-waiting", person({ coat: "b", coatDark: "a", pose: 0 })],
  cloud: ["cloud", cloud({ seed: 3 })],
  bin: ["bin", bin()],
  edgeWide: ["street-wide-edge", edgeStrip(GEOMETRY.WIDE, { height: 72 })],
  edgeTall: ["street-tall-edge", edgeStrip(GEOMETRY.TALL, { height: 108, wall: "pale" })],
};

/*
 * The weather vignette: one backdrop per light, one sprite per person per pose, one per
 * accessory, and the effect layers. Composed in the DOM rather than baked, so twelve people in
 * seven kinds of weather is twelve drawings and seven effects rather than eighty-four pictures.
 */
for (const night of [false, true]) {
  FILES[`vignette${night ? "Night" : "Day"}`] = [
    `vignette-${night ? "night" : "day"}`,
    vignetteScene({ night }),
  ];
}
/*
 * A bus approaching, drawn only where one truthfully is.
 *
 * Separate from the backdrop because it is conditional: the caller knows whether a departure is
 * due, and a bus painted into a scene where none is coming would be the picture telling a lie the
 * rest of the product is careful not to.
 */
for (const night of [false, true]) {
  FILES[`farBus${night ? "Night" : "Day"}`] = [
    `far-bus-${night ? "night" : "day"}`,
    farBus({ night }),
  ];
}
for (const person of PEOPLE) {
  for (const pose of ["plain", "holding"]) {
    FILES[`person_${person.id.replace(/-/g, "_")}_${pose}`] = [
      `person-${person.id}-${pose}`,
      drawPerson(person, pose),
    ];
  }
}
for (const name of Object.keys(ACCESSORIES)) {
  FILES[`accessory_${name}`] = [`accessory-${name}`, drawAccessory(name)];
}
/*
 * One set of effect layers per scene geometry.
 *
 * The stop page's world is 320 x 104 and the map panel's is 176 x 128, and an effect layer is
 * positioned over its scene pixel for pixel — so each composition needs rain cut to its own size.
 * Stretching one to fit the other is the one thing this whole art system exists to avoid.
 */
for (const geometry of ["panel", "world"]) {
  setEffectGeometry(geometry);
  const suffix = geometry === "panel" ? "" : "-world";
  const key = geometry === "panel" ? "" : "World";
  for (const [name, make] of Object.entries(EFFECTS)) {
    const file = `effect-${name.replace(/([A-Z])/g, "-$1").toLowerCase()}${suffix}`;
    FILES[`effect_${name}${key}`] = [file, make()];
  }
}
setEffectGeometry("panel");

const INLINE = {
  busMarkerRed: busMarker({}),
  busMarkerBlue: busMarker({ body: "c", bodyDark: "b", bodyLight: "d" }),
  busMarkerAmber: busMarker({ body: "z", bodyDark: "y", bodyLight: "Z" }),
  stopMarker: stopMarker(),
};

const meta = {};
let totalBytes = 0;
for (const [name, [file, canvas]] of Object.entries(FILES)) {
  const rows = canvas.rows();
  const png = encodePng(rows, PALETTE);
  writeFileSync(`${ART_DIR}/${file}.png`, png);
  totalBytes += png.length;
  meta[name] = { src: `/art/${file}.png`, w: rows[0].length, h: rows.length, bytes: png.length };
}

const inlineMeta = {};
for (const [name, canvas] of Object.entries(INLINE)) {
  const rows = canvas.rows();
  const png = encodePng(rows, PALETTE);
  inlineMeta[name] = {
    src: `data:image/png;base64,${png.toString("base64")}`,
    w: rows[0].length,
    h: rows.length,
  };
}

const ts = `/*
 * Generated by tools/pixel-art/build.mjs. Do not edit by hand.
 *
 * The artwork's source is the drawing code in tools/pixel-art; this module is only the index of
 * what that produced. Every sprite shares one art-pixel grid, one palette and one light
 * direction, and every one of them is meant to be scaled by whole numbers.
 */

export interface PixelImage {
  readonly src: string;
  readonly w: number;
  readonly h: number;
}

/** Cached under /art. Scale these by integers and render them with image-rendering: pixelated. */
export const ART: Record<string, PixelImage> = ${JSON.stringify(
  Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, { src: v.src, w: v.w, h: v.h }])),
  null,
  2,
)};

/** Small enough to inline, and MapLibre needs them without a round trip. */
export const MARKERS: Record<string, PixelImage> = ${JSON.stringify(inlineMeta, null, 2)};

/** Where the ground and the carriageway sit in each composition, so buses can be driven along it. */
export const SCENE_GEOMETRY = ${JSON.stringify(GEOMETRY, null, 2)} as const;

/**
 * The cast, and where things attach to each of them.
 *
 * \`hand\` is where an umbrella's handle goes in the holding pose and \`headTop\` is where a hat
 * sits, both in art pixels from the sprite's own top-left. The vignette multiplies them by the
 * scale it is drawn at, which is why they are whole numbers.
 */
export interface PixelPerson {
  readonly id: string;
  readonly description: string;
  readonly hand: { readonly x: number; readonly y: number };
  readonly headTop: number;
  readonly eyes: { readonly x: number; readonly y: number };
  readonly neck: { readonly x: number; readonly y: number };
}

export const PEOPLE_META: readonly PixelPerson[] = ${JSON.stringify(
  PEOPLE.map((p) => ({
    id: p.id,
    description: p.description,
    hand: p.hand,
    headTop: p.headTop,
    // Derived from where each figure's head was drawn, so an accessory lands on the face and the
    // throat rather than at a guessed offset from the sprite's own top.
    eyes: p.eyes ?? { x: 8, y: p.headTop + 4 },
    neck: p.neck ?? { x: 8, y: p.headTop + 8 },
  })),
  null,
  2,
)};

export const PERSON_SIZE = { w: ${PERSON_W}, h: ${PERSON_H} } as const;

/**
 * Where each accessory attaches.
 *
 * "hand" is carried, "head" sits on the crown, "neck" wraps the throat and "eyes" sits across the
 * face. A scarf placed at the crown reads as a flag, which is what the first composition did.
 */
export const ACCESSORY_ANCHORS: Record<string, "hand" | "head" | "neck" | "eyes"> = ${JSON.stringify(
  Object.fromEntries(Object.entries(ACCESSORIES).map(([k, v]) => [k, v.anchor ?? "head"])),
  null,
  2,
)};
export const VIGNETTE_SIZE = { w: ${VIGNETTE_W}, h: ${VIGNETTE_H}, ground: ${VIGNETTE_GROUND} } as const;

/**
 * The stop page's wide composition of the same street.
 *
 * Same drawing code, different shape: the map's panel is a portrait of one shelter and the stop
 * page has room for the street it stands on. Everything positioned against the scene — the
 * people, the approaching bus, the weather layers — reads its geometry from here.
 */
export const VIGNETTE_WORLD_SIZE = { w: ${GEOMETRIES.world.w}, h: ${GEOMETRIES.world.h}, ground: ${GEOMETRIES.world.ground} } as const;
`;

/*
 * Formatted here rather than by hand afterwards.
 *
 * This wrote raw `JSON.stringify` output, which the repository's own format gate rejects — so
 * every rebuild of the art left the tree failing `npm run format:check` until somebody remembered
 * to run prettier, and one rebuild reached a commit without that having happened. A generator that
 * emits source has to emit source the project accepts; prettier is already a pinned devDependency,
 * so this is the same formatting the gate applies, applied once at the point it is written.
 */
const out = "apps/web/src/components/pixel/sprites/generated.ts";
const { format, resolveConfig } = await import("prettier");
const prettierOptions = (await resolveConfig(out)) ?? {};
writeFileSync(out, await format(ts, { ...prettierOptions, filepath: out }));
console.log(
  `${Object.keys(FILES).length} images -> ${ART_DIR} (${(totalBytes / 1024).toFixed(1)} KiB total)`,
);
for (const [name, m] of Object.entries(meta)) console.log(`  ${name}: ${m.w}x${m.h}, ${m.bytes} B`);
console.log(`index -> ${out} (${(ts.length / 1024).toFixed(1)} KiB)`);
