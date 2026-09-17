#!/usr/bin/env node
/**
 * Opens the deployed preview in a real browser and measures it.
 *
 * The accessibility and end-to-end suites assert structure: that a heading exists, that a stale
 * badge is announced, that focus lands where it should. None of that can tell you the map is
 * blank, the hero has slid under the fold, or the artwork has been deleted on a phone — which is
 * exactly the set of defects this preview kept shipping. So this runs against the deployed URL,
 * at three real widths, and reports numbers rather than opinions.
 *
 * What it cannot do is judge the artwork. Every check here is structural: that a drawing loaded,
 * that it is scaled by a whole number, that nothing overflows. Whether a bus looks like a bus is
 * a question for the screenshots this saves, and answering it by counting nodes is how
 * placeholder art survives a green build.
 *
 * It lives outside the Playwright projects on purpose: those build and serve the app themselves,
 * and the point here is the thing that is actually deployed, basemap and CSP included.
 *
 *   node scripts/visual-qa.mjs <base-url> [screenshot-dir]
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
// From @playwright/test rather than `playwright`, which is only a transitive dependency.
import { chromium } from "@playwright/test";

/*
 * The bodies passed to page.evaluate are serialised and run inside the browser, not here, so the
 * DOM globals they use are legitimately undefined in this file's own scope.
 */
/* global document, window, getComputedStyle */

const [, , baseUrl, screenshotDir = "visual-qa", apiUrlArg] = process.argv;

if (!baseUrl) {
  console.error("Usage: node scripts/visual-qa.mjs <base-url> [screenshot-dir] [api-url]");
  process.exit(2);
}

const WIDTHS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "phone", width: 390, height: 844 },
];

/*
 * York as well as Leeds, by deep link.
 *
 * One city proves the map renders; two prove it renders wherever the data is, which is the claim
 * being made. York is also the destination this product is meant to plan a journey to, and it had
 * never been looked at.
 */
const YORK_BBOX = "-1.12,53.94,-1.03,53.99";

const PAGES = [
  { name: "home", path: "/" },
  { name: "live", path: "/live" },
  { name: "live-york", path: `/live?bbox=${encodeURIComponent(YORK_BBOX)}` },
  { name: "search", path: "/search" },
  { name: "journey", path: "/journey" },
  { name: "disruptions", path: "/disruptions" },
  { name: "pro", path: "/pro" },
];

/**
 * A real vehicle to look at, or none.
 *
 * The vehicle page cannot be reached by clicking: a bus on the map is a picture with a label, not
 * a link. So the page needs a reference, and inventing one would test the not-found state rather
 * than the page. Whether any bus is moving is a property of the hour — at three in the morning
 * the honest answer is none — so this returns null and the sweep says so.
 */

/**
 * Clicks a stop where the renderer actually drew one.
 *
 * There is no element to click any more: stops are a symbol layer. This asks the map for a stop
 * feature on screen, converts its position back to the page, and clicks there — which is what a
 * person does, and the only way the map's own click handler can be exercised.
 */
async function clickPaintedStop(page) {
  const point = await page.evaluate(() => {
    const map = globalThis.__busstopsMap;
    if (!map) return null;
    const features = map.queryRenderedFeatures({ layers: ["stop-flags", "stop-pips"] });
    const feature = features[0];
    if (!feature) return null;
    const projected = map.project(feature.geometry.coordinates);
    const box = map.getCanvas().getBoundingClientRect();
    return { x: box.left + projected.x, y: box.top + projected.y };
  });
  if (!point) throw new Error("no stop was painted, so none could be clicked");
  await page.mouse.click(point.x, point.y);
}

async function findVehicleRef(apiUrl) {
  if (!apiUrl) return null;
  try {
    const response = await fetch(
      `${apiUrl.replace(/\/$/, "")}/v1/map?bbox=-2.26,53.46,-2.21,53.50&zoom=15`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (!response.ok) return null;
    const body = await response.json();
    return body?.data?.vehicles?.[0]?.vehicleRef ?? null;
  } catch {
    return null;
  }
}

const vehicleRef = await findVehicleRef(apiUrlArg);
if (vehicleRef) {
  PAGES.push({ name: "vehicle", path: `/vehicles/${encodeURIComponent(vehicleRef)}` });
  console.log(`Following a real vehicle: ${vehicleRef}`);
} else {
  console.log("No live vehicle to follow, so the vehicle page is not in this sweep.");
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name} — ${detail}`);
}

mkdirSync(screenshotDir, { recursive: true });

// Use the Chromium already in the image when one is pointed at, rather than downloading another
// copy — the same arrangement the Playwright projects use.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);

/** Console errors and failed subresources, which is where a CSP mistake shows up. */
function watch(page, sink) {
  page.on("console", (message) => {
    if (message.type() === "error") sink.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => sink.consoleErrors.push(String(error)));
  page.on("requestfailed", (request) => {
    sink.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? "failed"}`);
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("openfreemap") || url.includes("tiles")) {
      sink.tileResponses.push({ url, status: response.status() });
    }
  });
}

/*
 * Nothing here may throw.
 *
 * A browser action that fails raises an error whose trace is hundreds of lines, and one of those
 * took every result already gathered out of the retrievable end of the log — so a run that had
 * measured the hero, the basemap and six pages reported only a stack trace about a click. A
 * failure is a failed check with a one-line reason, which is what the rest of this file does.
 */
for (const size of WIDTHS) {
  console.log(`\n${size.name} (${size.width}×${size.height})`);
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
  });

  for (const target of PAGES) {
    const sink = { consoleErrors: [], failedRequests: [], tileResponses: [] };
    const page = await context.newPage();
    watch(page, sink);

    try {
      /*
       * "domcontentloaded" and then a fixed settle, not "networkidle". The live map polls for
       * vehicles on a ticker, so the network never goes idle and waiting for it to would throw a
       * timeout out of the script rather than reporting a failed check — turning a page that works
       * into a run with a stack trace in it.
       */
      await page.goto(`${baseUrl}${target.path}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(target.name.startsWith("live") ? 9_000 : 2_000);

      await page.screenshot({
        path: join(screenshotDir, `${size.name}-${target.name}.png`),
        fullPage: false,
      });

      /*
       * A page wider than its viewport is a defect at every width, and the one most easily missed.
       * The measurement names the widest thing sticking out, because "48px" on its own sends you
       * guessing at CSS — which cost a whole deploy cycle before this said anything useful.
       */
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        const px = doc.scrollWidth - doc.clientWidth;
        if (px <= 0) return { px, culprit: "" };

        /*
         * Something sticking out only scrolls the page if nothing between it and the root clips
         * it. The Pro section tabs are a deliberate scrolling strip, so its last link hangs 301px
         * past the edge and scrolls nothing — and naming it sent me looking at the wrong element
         * entirely. An element inside a clipping ancestor is contained, by definition.
         */
        const contained = (el) => {
          for (let node = el.parentElement; node && node !== doc; node = node.parentElement) {
            const overflowX = getComputedStyle(node).overflowX;
            if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") {
              return true;
            }
          }
          return false;
        };

        let worst = null;
        for (const el of document.querySelectorAll("body *")) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const past = Math.round(rect.right - doc.clientWidth);
          if (past <= 0) continue;
          if (contained(el)) continue;
          // The innermost offender is the useful one: its ancestors are only as wide as it is.
          if (!worst || past > worst.past || (past === worst.past && el.contains(worst.el))) {
            worst = { el, past };
          }
        }
        if (!worst) return { px, culprit: "(nothing measurable sticks out)" };
        const el = worst.el;
        const classes = String(el.className || "").trim();
        const name =
          el.tagName.toLowerCase() + (classes ? `.${classes.split(/\s+/).join(".")}` : "");
        return { px, culprit: `${name.slice(0, 120)} overhangs by ${worst.past}px` };
      });
      record(
        `${size.name}/${target.name} does not scroll sideways`,
        overflow.px <= 0,
        overflow.px <= 0 ? "0px" : `${overflow.px}px — ${overflow.culprit}`,
      );

      if (sink.consoleErrors.length > 0) {
        record(
          `${size.name}/${target.name} loads without console errors`,
          false,
          sink.consoleErrors.slice(0, 3).join(" | "),
        );
      }

      if (target.name === "home") {
        const hero = await page.evaluate(() => {
          const heroEl = document.querySelector(".home__hero");
          const scene = document.querySelector(".home__hero-scene");
          const mark = document.querySelector(".home__hero .wordmark");
          const stop = document.querySelector(".home__hero .wordmark__dot");
          const cta = document.querySelector(".home__cta-row");
          return {
            heroBottom: heroEl?.getBoundingClientRect().bottom ?? null,
            sceneBottom: scene?.getBoundingClientRect().bottom ?? null,
            sceneHeight: scene?.getBoundingClientRect().height ?? null,
            markVisible: !!mark && mark.getBoundingClientRect().height > 0,
            stopColour: stop ? getComputedStyle(stop).color : null,
            ctaTop: cta?.getBoundingClientRect().top ?? null,
            viewportHeight: window.innerHeight,
            // Both compositions are in the DOM and one is hidden, so only the drawn one counts.
            street: (() => {
              const shown = [...document.querySelectorAll(".street-scene__street")].find(
                (el) => el.getBoundingClientRect().height > 0,
              );
              const ground = shown?.querySelector(".street-scene__ground");
              if (!ground) return null;
              const box = ground.getBoundingClientRect();
              return {
                natural: `${ground.naturalWidth}x${ground.naturalHeight}`,
                drawn: `${Math.round(box.width)}x${Math.round(box.height)}`,
                scale: ground.naturalWidth ? box.width / ground.naturalWidth : 0,
                complete: ground.complete && ground.naturalWidth > 0,
                buses: shown.querySelectorAll(".street-scene__vehicle img").length,
              };
            })(),
          };
        });

        record(
          `${size.name}/home hero fills the first viewport`,
          hero.heroBottom !== null && Math.abs(hero.heroBottom - hero.viewportHeight) <= 2,
          `hero ends at ${Math.round(hero.heroBottom ?? -1)}, viewport ${hero.viewportHeight}`,
        );
        /*
         * Structural only, and named so. Whether the artwork is any good is a question for the
         * screenshots this sweep saves, not for a number: a node count says nothing about
         * whether a bus looks like a bus, and reporting one as if it did is how placeholder art
         * survives a green build. What can be checked mechanically is that the drawing loaded,
         * that it is the composition meant for this shape of window, and that it is scaled by a
         * whole number — pixel art at 2.4x is a photograph of pixel art.
         */
        const street = hero.street;
        record(
          `${size.name}/home hero artwork loads`,
          !!street && street.complete && street.buses >= 2,
          street
            ? `${street.natural} drawn at ${street.drawn}, ${street.buses} vehicle frames`
            : "(no street found)",
        );
        record(
          `${size.name}/home hero artwork is scaled by a whole number`,
          !!street && street.scale >= 2 && Number.isInteger(Math.round(street.scale * 1000) / 1000),
          street ? `${street.scale}x` : "(no street found)",
        );
        record(
          `${size.name}/home hero artwork actually paints`,
          (hero.sceneHeight ?? 0) > 100,
          `${Math.round(hero.sceneHeight ?? 0)}px tall`,
        );
        record(
          `${size.name}/home keeps the explanation below the fold`,
          hero.ctaTop !== null && hero.ctaTop >= hero.viewportHeight,
          `first call to action at ${Math.round(hero.ctaTop ?? -1)}`,
        );
        record(
          `${size.name}/home full stop is red`,
          /rgb\(\s*(1[6-9]\d|2[0-5]\d)\s*,\s*([0-5]\d|\d)\s*,/.test(hero.stopColour ?? ""),
          hero.stopColour ?? "(no full stop found)",
        );
      }

      if (target.name.startsWith("live")) {
        const map = await page.evaluate(() => {
          const canvas = document.querySelector("canvas.maplibregl-canvas");
          const unavailable = document.querySelector(".map-view--unavailable");

          /*
           * What the renderer actually painted, rather than what the DOM contains.
           *
           * The old version of this counted `.map-marker` elements and then checked each one's
           * rectangle against the map's, because a CSS rule had once dropped every marker into
           * normal flow: the DOM held 197 buses and the screen showed none. There are no marker
           * elements any more — stops and buses are GeoJSON layers — so that whole class of bug
           * is gone, and the question is answered directly instead. `queryRenderedFeatures` is
           * the renderer's own answer to "what is on screen".
           */
          const instance = globalThis.__busstopsMap;
          const painted = (layers) => {
            if (!instance) return 0;
            try {
              return instance.queryRenderedFeatures({ layers }).length;
            } catch {
              // A layer that does not exist at this zoom is not an error; it is the point.
              return 0;
            }
          };
          const clusterTotal = (layers) => {
            if (!instance) return 0;
            try {
              return instance
                .queryRenderedFeatures({ layers })
                .reduce((sum, f) => sum + (Number(f.properties?.point_count) || 0), 0);
            } catch {
              return 0;
            }
          };

          return {
            hasCanvas: !!canvas,
            unavailable: !!unavailable,
            zoom: instance ? Math.round(instance.getZoom() * 10) / 10 : null,
            scale: document.querySelector(".map-view")?.getAttribute("data-scale") ?? null,
            busesDrawn: painted(["vehicle-buses", "vehicle-pips"]),
            busesClustered: clusterTotal(["vehicle-clusters"]),
            stopsDrawn: painted(["stop-flags", "stop-pips"]),
            stopsClustered: clusterTotal(["stop-clusters"]),
            degraded: !!document.querySelector(".map-view__degraded"),
            // A map taller than its own box would mean something is in flow, which layers cannot
            // do — kept because it costs nothing and would catch a regression that reintroduced it.
            mapScrollHeight: document.querySelector(".maplibregl-map")?.scrollHeight ?? 0,
            // What the list says, which is what the API returned for this viewport.
            listedBuses: Number(
              document.querySelector("#vehicles-heading .lozenge")?.textContent?.trim() ?? "0",
            ),
            attribution:
              document.querySelector(".maplibregl-ctrl-attrib")?.textContent?.trim() ?? "",
          };
        });

        /*
         * Whether the map drew anything, measured from a screenshot rather than from the canvas.
         *
         * Reading the canvas directly does not work and is not the map's fault: MapLibre renders
         * with WebGL and does not ask for `preserveDrawingBuffer`, so the drawing buffer is cleared
         * once it has been composited and `drawImage` copies an empty one. That reported "1 distinct
         * colour" on a map that was demonstrably drawing — twelve tiles answered 200 and the
         * attribution was on screen.
         *
         * A screenshot captures what was composited, which is what a person sees. It is compared by
         * size because PNG compresses flat colour to almost nothing: a blank rectangle of this area
         * is a few hundred bytes, and one with roads, water and labels in it is tens of thousands.
         * The number is far enough from the boundary that it does not need to be precise.
         */
        const BLANK_CANVAS_BYTES = 8_000;
        let paintedBytes = 0;
        const canvas = page.locator("canvas.maplibregl-canvas").first();
        if (await canvas.count()) {
          paintedBytes = (await canvas.screenshot()).length;
        }

        const tileHits = sink.tileResponses.filter((r) => r.status === 200).length;
        const tileErrors = sink.tileResponses.filter((r) => r.status >= 400);

        record(
          `${size.name}/${target.name} renders a map rather than the fallback`,
          map.hasCanvas && !map.unavailable,
          `canvas ${map.hasCanvas ? "present" : "absent"}, list-only fallback ${
            map.unavailable ? "shown" : "not shown"
          }`,
        );
        record(
          `${size.name}/${target.name} basemap actually paints`,
          paintedBytes > BLANK_CANVAS_BYTES,
          `${paintedBytes} bytes of rendered map (a blank one is a few hundred)`,
        );

        /*
         * The check this whole script exists for: when the API returned buses, buses must be on
         * the screen. Reported when the viewport genuinely has none, failed when it has some and
         * none of them made it into the map's rectangle.
         */
        const busesOnScreen = map.busesDrawn + map.busesClustered;
        if (map.listedBuses === 0) {
          record(
            `${size.name}/${target.name} shows the buses the API returned`,
            true,
            "no buses in this viewport at this moment, so there is nothing to draw",
          );
        } else {
          record(
            `${size.name}/${target.name} shows the buses the API returned`,
            busesOnScreen > 0,
            `${busesOnScreen} bus(es) painted at zoom ${map.zoom} (${map.scale} scale): ` +
              `${map.busesDrawn} drawn individually, ${map.busesClustered} inside clusters; ` +
              `the list says ${map.listedBuses}`,
          );
        }
        record(
          `${size.name}/${target.name} draws its stops`,
          map.stopsDrawn + map.stopsClustered > 0,
          `${map.stopsDrawn} stop(s) drawn and ${map.stopsClustered} inside clusters`,
        );
        record(
          `${size.name}/${target.name} keeps its map out of normal flow`,
          map.mapScrollHeight > 0 && map.mapScrollHeight < 2000,
          `the map's scrollHeight is ${map.mapScrollHeight}px`,
        );
        record(
          `${size.name}/live loads tiles from the configured host`,
          tileHits > 0 && tileErrors.length === 0,
          `${tileHits} tile responses 200, ${tileErrors.length} errors`,
        );
        record(
          `${size.name}/live states its map attribution`,
          map.attribution.length > 0,
          map.attribution.slice(0, 80) || "(none)",
        );
        console.log(
          `        ${map.scale} scale at zoom ${map.zoom}: ${map.stopsDrawn}+${map.stopsClustered} stops, ` +
            `${map.busesDrawn}+${map.busesClustered} buses` +
            (map.degraded ? " (route names degraded)" : ""),
        );

        /*
         * Clicking a stop is the one interaction the whole Live page exists for, and nothing else
         * checks it end to end: the API test proves the endpoint answers, and the accessibility
         * suite runs against a mocked map. Only here is it a real marker, drawn from real published
         * stops, opening a real board.
         */
        if (map.stopsDrawn > 0) {
          /*
           * `force`, and inside a try. Four hundred stops in a city centre genuinely overlap, and
           * some sit under the sticky header, so the browser's actionability check refuses a click
           * that a person makes without thinking — it waits, retries for thirty seconds, and then
           * throws a stack trace long enough to push every other result out of the log. A person
           * clicks whatever is on top; so does this.
           */
          let clickFailed = null;
          try {
            // Stops are painted by the renderer now, so the click goes to where one was drawn.
            await clickPaintedStop(page);
          } catch (error) {
            clickFailed = error instanceof Error ? error.message.split("\n")[0] : String(error);
          }
          await page.waitForTimeout(3_000);
          const board = await page.evaluate(() => {
            const panel = document.querySelector(".selected-stop");
            return {
              open: !!panel,
              heading: panel?.querySelector(".arrival-board__stop")?.textContent?.trim() ?? "",
              label: panel?.querySelector(".arrival-board__next")?.textContent?.trim() ?? "",
              rows: panel?.querySelectorAll(".arrival-board__table tbody tr").length ?? 0,
              error: panel?.querySelector(".selected-stop__error")?.textContent?.trim() ?? "",
            };
          });
          await page.screenshot({
            path: join(screenshotDir, `${size.name}-live-selected.png`),
            fullPage: false,
          });
          record(
            `${size.name}/live opens the arrival board when a stop is clicked`,
            clickFailed === null && board.open && board.error === "" && board.label === "NEXT BUS",
            clickFailed !== null
              ? `the click did not land: ${clickFailed}`
              : board.open
                ? `${board.label || "(no label)"} — ${board.heading || "(no stop)"}, ${board.rows} row(s)${
                    board.error ? `, error: ${board.error}` : ""
                  }`
                : "no board opened",
          );
        } else {
          // Not a failure of the page: no stops in view is a data question, answered elsewhere.
          console.log("        no stop markers to click, so the board was not exercised");
        }
      }

      if (sink.failedRequests.length > 0) {
        console.log(`        failed requests: ${sink.failedRequests.slice(0, 3).join(" | ")}`);
      }
    } catch (error) {
      // One page that misbehaves must not take the other seventeen down with it.
      record(
        `${size.name}/${target.name} could be inspected at all`,
        false,
        error instanceof Error ? error.message.split("\n")[0] : String(error),
      );
    }

    await page.close();
  }

  await context.close();
}

await browser.close();

const failures = results.filter((result) => !result.ok);
console.log(
  `\nVisual QA: ${results.length - failures.length} of ${results.length} checks passed against ${baseUrl}.`,
);
console.log(`Screenshots in ${screenshotDir}/.`);
process.exit(failures.length > 0 ? 1 : 0);
