import { chromium } from "playwright";
import { readFileSync } from "node:fs";

/* Renders the vignette in every weather it can show, at desktop and phone scale, from the real
   component's own markup rules — so what is judged is what ships. */
const gen = readFileSync("apps/web/src/components/pixel/sprites/generated.ts", "utf8");
const ART = JSON.parse(
  gen.match(/export const ART: Record<string, PixelImage> = ([\s\S]*?);\n/)[1],
);
const ANCHORS = JSON.parse(
  gen.match(
    /export const ACCESSORY_ANCHORS: Record<string, "hand" \| "head" \| "neck" \| "eyes"> = ([\s\S]*?);\n/,
  )[1],
);
const PEOPLE = JSON.parse(
  gen.match(/export const PEOPLE_META: readonly PixelPerson\[\] = ([\s\S]*?);\n/)[1],
);

const SCENES = [
  {
    kind: "rain",
    effects: ["effect_rainFar", "effect_rainNear"],
    acc: "accessory_umbrella",
    anchor: "hand",
    pose: "holding",
    day: true,
    label: "Rain — Don't forget your umbrella.",
  },
  {
    kind: "wind",
    effects: ["effect_wind"],
    acc: "accessory_scarf",
    anchor: "head",
    pose: "plain",
    day: true,
    label: "Wind — hold onto anything loose.",
  },
  {
    kind: "uv",
    effects: ["effect_sun"],
    acc: "accessory_sunHat",
    anchor: "head",
    pose: "plain",
    day: true,
    label: "High UV — sunscreen and shade.",
  },
  {
    kind: "hot",
    effects: ["effect_heat", "effect_sun"],
    acc: "accessory_sunglasses",
    anchor: "head",
    pose: "plain",
    day: true,
    label: "Hot — water and a bit of shade.",
  },
  {
    kind: "cold",
    effects: [],
    acc: "accessory_woollyHat",
    anchor: "head",
    pose: "plain",
    day: true,
    label: "Cold — wrap up warm.",
  },
  {
    kind: "snow",
    effects: ["effect_snow"],
    acc: "accessory_woollyHat",
    anchor: "head",
    pose: "plain",
    day: true,
    label: "Snow — allow a little extra time.",
  },
  {
    kind: "fog",
    effects: ["effect_fog"],
    acc: null,
    anchor: null,
    pose: "plain",
    day: true,
    label: "Fog — visibility is reduced.",
  },
  {
    kind: "none-night",
    effects: [],
    acc: null,
    anchor: null,
    pose: "plain",
    day: false,
    label: "Clear, after dark — no advice.",
  },
];

const V = JSON.parse(
  gen.match(/export const VIGNETTE_SIZE = ([\s\S]*?) as const;/)[1].replace(/(\w+):/g, '"$1":'),
);
const P = { w: 24, h: 44 };

function scene(s, person, scale) {
  const backdrop = s.day ? ART.vignetteDay : ART.vignetteNight;
  const personArt = ART[`person_${person.id.replace(/-/g, "_")}_${s.pose}`];
  const left = 62 * scale;
  const top = (V.ground - P.h + 3) * scale;
  const acc = s.acc ? ART[s.acc] : null;
  let accStyle = "";
  if (acc) {
    const anchorName = ANCHORS[s.acc.replace("accessory_", "")] ?? "head";
    const point =
      anchorName === "hand"
        ? person.hand
        : anchorName === "eyes"
          ? person.eyes
          : anchorName === "neck"
            ? person.neck
            : { x: P.w / 2, y: person.headTop };
    const ox = Math.floor(acc.w / 2);
    const oy = anchorName === "hand" ? acc.h - 2 : Math.floor(acc.h / 2);
    accStyle = `left:${left + (point.x - ox) * scale}px;top:${top + (point.y - oy) * scale}px`;
  }
  return `<figure style="margin:0">
  <div style="position:relative;width:${V.w * scale}px;height:${V.h * scale}px;overflow:hidden;border:1px solid #dad8d1;border-radius:4px">
    <img src="${backdrop.src}" width="${V.w * scale}" height="${V.h * scale}" style="position:absolute;left:0;top:0;image-rendering:pixelated">
    ${s.effects
      .map((n) => {
        const a = ART[n];
        const pos = n === "effect_sun" ? `left:${4 * scale}px;top:${2 * scale}px` : "left:0;top:0";
        return `<img src="${a.src}" width="${a.w * scale}" height="${a.h * scale}" style="position:absolute;${pos};image-rendering:pixelated;z-index:${n === "effect_rainNear" ? 3 : 1}">`;
      })
      .join("")}
    <img src="${personArt.src}" width="${P.w * scale}" height="${P.h * scale}" style="position:absolute;left:${left}px;top:${top}px;image-rendering:pixelated;z-index:2">
    ${acc ? `<img src="${acc.src}" width="${acc.w * scale}" height="${acc.h * scale}" style="position:absolute;${accStyle};image-rendering:pixelated;z-index:2">` : ""}
  </div>
  <figcaption style="font:11px system-ui;color:#66645f;margin-top:6px;max-width:${V.w * scale}px">${s.label}<br><span style="color:#a49b90">${person.id}</span></figcaption>
</figure>`;
}

const desktop = SCENES.map((s, i) => scene(s, PEOPLE[i % PEOPLE.length], 4)).join("");
const phone = SCENES.map((s, i) => scene(s, PEOPLE[(i + 5) % PEOPLE.length], 3)).join("");

const html = `<!doctype html><meta charset=utf-8><body style="background:#f7f6f1;margin:16px;font:12px system-ui">
<h2 style="font:600 13px system-ui">Weather vignette — desktop, 4x</h2>
<div style="display:flex;flex-wrap:wrap;gap:20px">${desktop}</div>
<h2 style="font:600 13px system-ui;margin-top:24px">Weather vignette — phone, 3x</h2>
<div style="display:flex;flex-wrap:wrap;gap:16px">${phone}</div>`;

import { writeFileSync } from "node:fs";
// Written into the public directory and loaded over http: the sprite srcs are absolute paths
// under /art, and setContent has no origin to resolve them against.
writeFileSync("apps/web/public/_vignette.html", html);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1320, height: 1400 } });
await page.goto("http://localhost:8899/_vignette.html", { waitUntil: "networkidle" });
await page.addStyleTag({ content: "img{display:block}" });
await page.waitForTimeout(400);
await page.screenshot({ path: process.argv[2], fullPage: true });
await browser.close();
