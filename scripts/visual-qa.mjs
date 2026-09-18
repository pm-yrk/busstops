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
import AxeBuilder from "@axe-core/playwright";
// From @playwright/test rather than `playwright`, which is only a transitive dependency.
import { chromium } from "@playwright/test";

/*
 * The bodies passed to page.evaluate are serialised and run inside the browser, not here, so the
 * DOM globals they use are legitimately undefined in this file's own scope.
 */
/* global document, window, getComputedStyle, NodeFilter */

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

/*
 * A viewport to look a bus up in.
 *
 * `/vehicles/:ref` needs one: the live feeds are area-scoped, so without a bounding box the page
 * renders "This link needs a map area" and nothing else. The sweep pushed a bare path, so every
 * run of it has screenshotted that empty state at three sizes and called the vehicle page looked
 * at. The reference is found in this box, so this is the box it is looked up in.
 */
const MANCHESTER_BBOX = "-2.26,53.46,-2.21,53.50";

const PAGES = [
  { name: "home", path: "/" },
  { name: "live", path: "/live" },
  { name: "live-york", path: `/live?bbox=${encodeURIComponent(YORK_BBOX)}` },
  { name: "search", path: "/search" },
  /*
   * A search with something in it, which no sweep had ever run.
   *
   * `/search` on its own photographs a form. The defect this product actually had was in the
   * results: a route or an operator linked to `/search?q=<its own title>` — back to the same page
   * with the same query, a loop that read as a broken link. That is only visible with results on
   * the screen, so the sweep now puts some there and follows one.
   */
  { name: "search-results", path: `/search?q=${encodeURIComponent("Leeds")}` },
  { name: "journey", path: "/journey" },
  { name: "disruptions", path: "/disruptions" },
  { name: "saved", path: "/saved" },
  { name: "methodology", path: "/methodology" },
  /*
   * Every Pro section, not just its front page.
   *
   * "all Pro sections" is the requirement and one screenshot of the control tower is not that:
   * each of these reads different artifacts and degrades differently when one is missing, which
   * is precisely the state a sweep exists to catch.
   */
  { name: "pro", path: "/pro" },
  { name: "pro-live", path: "/pro/live" },
  { name: "pro-routes", path: "/pro/routes" },
  { name: "pro-operators", path: "/pro/operators" },
  { name: "pro-congestion", path: "/pro/congestion" },
  { name: "pro-analytics", path: "/pro/analytics" },
  { name: "pro-disruptions", path: "/pro/disruptions" },
  { name: "pro-reports", path: "/pro/reports" },
  { name: "pro-brief", path: "/pro/brief" },
  { name: "pro-settings", path: "/pro/settings" },
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

/**
 * Clicks a bus where the renderer actually drew one.
 *
 * The same problem as a stop and, until now, without the same answer: the buses were a symbol
 * layer with no click handler at all, so a passenger watching the 36 go past could not ask it
 * anything. This exercises the handler the way a person does — find where a bus was painted,
 * convert it back to the page, click there.
 */
async function clickPaintedBus(page) {
  const point = await page.evaluate(() => {
    const map = globalThis.__busstopsMap;
    if (!map) return null;
    const features = map.queryRenderedFeatures({ layers: ["vehicle-buses", "vehicle-pips"] });
    const feature = features[0];
    if (!feature) return null;
    const projected = map.project(feature.geometry.coordinates);
    const box = map.getCanvas().getBoundingClientRect();
    return { x: box.left + projected.x, y: box.top + projected.y };
  });
  if (!point) throw new Error("no bus was painted, so none could be clicked");
  await page.mouse.click(point.x, point.y);
}

async function api(apiUrl, path) {
  if (!apiUrl) return null;
  try {
    const response = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/*
 * The real stop, route, operator and bus this deployment actually has.
 *
 * The sweep covered home, live, search, journey, disruptions and Pro, and the four pages a
 * passenger spends most of their time on were not in it — because each needs a real identifier
 * and inventing one would photograph a not-found page. So each is discovered from the one before
 * it: a viewport names a stop, the stop names its routes, the route names its operator.
 */
const map = await api(apiUrlArg, `/v1/map?bbox=${MANCHESTER_BBOX}&zoom=15`);
const vehicleRef = map?.data?.vehicles?.[0]?.vehicleRef ?? null;
if (vehicleRef) {
  PAGES.push({
    name: "vehicle",
    // With the viewport it was found in. Without one this page is "This link needs a map area".
    path: `/vehicles/${encodeURIComponent(vehicleRef)}?bbox=${encodeURIComponent(MANCHESTER_BBOX)}`,
  });
  console.log(`Following a real vehicle: ${vehicleRef}`);
} else {
  console.log("No live vehicle to follow, so the vehicle page is not in this sweep.");
}

const stops = map?.data?.stops ?? [];
// A stop with a service on it, so the board is photographed with something on it.
const stop = stops.find((entry) => (entry.routePublicNames ?? []).length > 0) ?? stops[0] ?? null;
if (stop) {
  PAGES.push({ name: "stop", path: `/stops/${encodeURIComponent(stop.id)}` });
  // And the same stop as a selected board on the map, which is a different layout entirely.
  PAGES.push({ name: "live-stop-deeplink", path: `/live/stops/${encodeURIComponent(stop.id)}` });
  console.log(`Looking at a real stop: ${stop.name}`);

  const detail = await api(apiUrlArg, `/v1/stops/${encodeURIComponent(stop.id)}`);
  const route = detail?.data?.routes?.[0] ?? null;
  if (route?.id) {
    PAGES.push({ name: "route", path: `/routes/${encodeURIComponent(route.id)}` });
    console.log(`Looking at a real route: ${route.publicName ?? route.id}`);
    const routeDetail = await api(apiUrlArg, `/v1/routes/${encodeURIComponent(route.id)}`);
    const operatorId = routeDetail?.data?.operator?.id ?? null;
    if (operatorId) {
      PAGES.push({ name: "operator", path: `/operators/${encodeURIComponent(operatorId)}` });
      console.log(`Looking at a real operator: ${routeDetail.data.operator.name}`);
    } else {
      console.log("The route named no operator, so the operator page is not in this sweep.");
    }
  } else {
    console.log("No route calls at that stop, so the route page is not in this sweep.");
  }
} else {
  console.log("No stop came back, so the stop, route and operator pages are not in this sweep.");
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

      /*
       * Raw identifiers, on the page, where a passenger would read them.
       *
       * `White_Rose_Shopping_Centre` and `Easterly_Road_Hollin_Park_Mount` reached the live map
       * and the arrival boards, and they were found by a person looking at a screenshot. The
       * humanising happens at the read boundary in the Worker, so a new endpoint or a new field
       * can reintroduce them anywhere — which makes this a sweep rather than a unit test.
       *
       * An underscore between two letters is the shape of a NaPTAN or headsign identifier and is
       * not something English writes. The legitimate punctuation this must never flag —
       * `King's Cross`, `Stratford-upon-Avon`, `Park & Ride` — has no underscore in it at all.
       */
      const rawIdentifiers = await page.evaluate(() => {
        const found = new Set();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement;
          if (!parent) continue;
          // Code samples and the methodology page legitimately show identifiers as identifiers.
          if (parent.closest("code, pre, [data-raw-identifier-ok]")) continue;
          for (const match of String(node.nodeValue ?? "").matchAll(/[A-Za-z]+_[A-Za-z]+\w*/g)) {
            found.add(match[0]);
          }
        }
        return [...found].slice(0, 5);
      });
      record(
        `${size.name}/${target.name} shows no raw identifiers`,
        rawIdentifiers.length === 0,
        rawIdentifiers.length === 0 ? "none" : rawIdentifiers.join(", "),
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
                /*
                 * The traffic, wherever it is — which is not inside the composition.
                 *
                 * This counted `.street-scene__vehicle img` within `.street-scene__street`, and
                 * the lanes are deliberately a *sibling* of it: the composition is exactly as
                 * wide as the artwork and clips what overflows, so a bus confined to it drove
                 * two thirds of the way across a desktop window and vanished. Moving the traffic
                 * out is what lets a bus enter beyond one edge and leave beyond the other, and
                 * this check had been reporting that fix as "0 vehicle frames" ever since.
                 *
                 * Scoped to the shown variant by its own suffix, so the hidden composition's
                 * traffic is not counted instead.
                 */
                buses: (() => {
                  const variant = shown.className.includes("--wide") ? "wide" : "tall";
                  const traffic = document.querySelector(`.street-scene__traffic--${variant}`);
                  return traffic
                    ? traffic.querySelectorAll(".street-scene__vehicle img").length
                    : 0;
                })(),
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
            // The page's own error state, which is a different thing from a missing map.
            apiError: !!document.querySelector(".state-block--error"),
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

        /*
         * Three outcomes, not two.
         *
         * This asked whether there was a canvas and no list-only fallback, and reported anything
         * else as "canvas absent, list-only fallback not shown" — which run 51 produced when the
         * API itself had failed and the page was showing its error state with a retry button.
         * That reads as a blank screen and is not one; the page was being honest and the check
         * could not see it. An API failure is a real failure, but it is the API's, and calling it
         * a missing fallback sends the next person looking in the wrong place.
         */
        /*
         * A deep-linked stop has to arrive with its board open.
         *
         * `/live/stops/:id` is an acceptance criterion in its own right — "must actually
         * initialise and open the selected stop board" — and the sweep was photographing the page
         * without ever asking whether it had. A link that lands on the map with nothing selected
         * looks identical in a screenshot to one that worked.
         */
        if (target.name === "live-stop-deeplink") {
          const board = await page
            .locator(".selected-stop")
            .first()
            .isVisible()
            .catch(() => false);
          /*
           * Bounded, because this one read cost a whole page.
           *
           * `textContent()` waits for its element with the default thirty-second timeout, and in
           * run 54 the board was open while its heading had not rendered yet. The throw escaped
           * into the per-page catch, so `tablet/live-stop-deeplink` reported only "could be
           * inspected at all — Timeout 30000ms exceeded" and every other check on that page was
           * lost. A heading that is not there yet is a fact to report, not a reason to stop.
           */
          const heading = board
            ? ((await page
                .locator(".selected-stop h2, .selected-stop h3")
                .first()
                .textContent({ timeout: 5_000 })
                .catch(() => null)) ?? "(no heading yet)")
            : "";
          record(
            `${size.name}/${target.name} opens the stop board it was linked to`,
            board,
            board ? `board open: ${heading.trim().slice(0, 60)}` : "no stop board on the page",
          );
        }

        record(
          `${size.name}/${target.name} renders a map rather than the fallback`,
          map.hasCanvas ? !map.unavailable : map.apiError,
          map.hasCanvas
            ? `canvas present, list-only fallback ${map.unavailable ? "shown" : "not shown"}`
            : map.apiError
              ? "no canvas: the API failed and the page says so, with a retry"
              : "canvas absent and nothing said about why",
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

        /*
         * And a bus, which is the interaction that did not exist at all.
         *
         * Whether any bus is on screen is a property of the hour, so an empty street is reported
         * rather than failed. What is checked when one is there is that clicking it opens a panel
         * that says which bus it is and where it is going — the questions a person points at a
         * bus to ask.
         */
        if (map.busesDrawn > 0) {
          let busClickFailed = null;
          try {
            await clickPaintedBus(page);
          } catch (error) {
            busClickFailed = error instanceof Error ? error.message.split("\n")[0] : String(error);
          }
          /*
           * Wait for the panel to settle, rather than for three seconds.
           *
           * The panel has three states — loading, error, loaded — and a fixed timeout reads
           * whichever one happens to be on screen. Run 54 reported "(no route) to (no
           * destination) — no facts" at all three widths and that was the loading state being
           * photographed, not an empty panel: the component renders `LoadingBus` while its
           * lookup is in flight and shows a real message when it fails. Reporting that as a
           * product defect is the same mistake as run 51's "blank screen", so the check now
           * waits for the loading indicator to go and says outright when it never did.
           */
          await page
            .locator(".selected-vehicle .loading-bus")
            .waitFor({ state: "detached", timeout: 15_000 })
            .catch(() => {
              /* Still loading is an outcome, reported below rather than thrown. */
            });
          const busPanel = await page.evaluate(() => {
            const panel = document.querySelector(".selected-vehicle");
            if (!panel) return { open: false };
            return {
              open: true,
              loading: panel.querySelector(".loading-bus") !== null,
              route: panel.querySelector(".route-badge")?.textContent?.trim() ?? "",
              destination:
                panel.querySelector(".selected-vehicle__destination")?.textContent?.trim() ?? "",
              facts: [...panel.querySelectorAll(".selected-vehicle__facts dd")].map((node) =>
                node.textContent.trim(),
              ),
              routeLink:
                panel
                  .querySelector(".selected-vehicle__links a[href*='/routes/']")
                  ?.getAttribute("href") ?? "",
              vehicleLink:
                panel
                  .querySelector(".selected-vehicle__links a[href*='/vehicles/']")
                  ?.getAttribute("href") ?? "",
              error: panel.querySelector(".selected-vehicle__error")?.textContent?.trim() ?? "",
            };
          });
          await page.screenshot({
            path: join(screenshotDir, `${size.name}-live-bus-selected.png`),
            fullPage: false,
          });
          record(
            `${size.name}/live opens a bus when one is clicked`,
            busClickFailed === null &&
              busPanel.open &&
              !busPanel.loading &&
              busPanel.error === "" &&
              busPanel.destination.length > 0,
            busClickFailed !== null
              ? `the click did not land: ${busClickFailed}`
              : !busPanel.open
                ? "no bus panel opened"
                : busPanel.loading
                  ? "the panel was still loading after 15s — the lookup never answered"
                  : `${busPanel.route || "(no route)"} to ${busPanel.destination || "(no destination)"} — ` +
                    `${busPanel.facts.join(", ") || "no facts"}` +
                    (busPanel.routeLink
                      ? `; route link ${busPanel.routeLink}`
                      : "; no route link") +
                    (busPanel.error ? `; error: ${busPanel.error}` : ""),
          );
          /*
           * A link built from the number on the front would be a link to somebody else's route.
           * When there is one at all it has to be an identifier, not "36".
           */
          if (busPanel.open && busPanel.routeLink) {
            record(
              `${size.name}/live links a bus to its route by identity`,
              /\/routes\/[0-9a-f]{8}-/.test(busPanel.routeLink),
              busPanel.routeLink,
            );
          }
        } else {
          console.log("        no buses in view, so the bus panel was not exercised");
        }
      }

      /*
       * "Bus stopped?", which no sweep had ever opened.
       *
       * The panel is behind a button and gathers its own context — the other buses in the
       * viewport, the board at the stop this one is heading for — so nothing about it is exercised
       * by loading the page. Its whole purpose is to be honest about what it does not know, and
       * the specific failure it is capable of is telling somebody "no other departures to suggest"
       * about a board it never managed to read. So the check waits for the lookup to settle and
       * then insists the panel says which of the three it is.
       */
      /*
       * Axe, against the deployed page rather than a fixture.
       *
       * The e2e accessibility suite runs eighteen pages against mocked responses, and the four a
       * passenger spends most of their time on are not among them because each needs a real
       * identifier. Those are exactly the pages this sweep has already discovered, with real data
       * in them — a departure board with real destinations, a route with a real operator — and
       * real data is where the contrast failures and the unlabelled controls actually appear. At
       * every width, because a barrier introduced by a phone layout is invisible at desktop.
       */
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze()
        .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));

      if (axe.error) {
        record(`${size.name}/${target.name} could be scanned for accessibility`, false, axe.error);
      } else {
        /*
         * Axe's own measurement, not just the selector.
         *
         * Run 54 reported `target-size (serious)` on a map control and a stop link, and neither
         * could be reproduced here — this container cannot reach the basemap host, so MapLibre
         * never draws its controls at all. A selector alone does not say how big the target
         * actually was or what it was too close to, which is the difference between a fix and a
         * guess. `failureSummary` carries the measured numbers, so the next run says outright
         * what to change.
         */
        const violations = axe.violations.map(
          (violation) =>
            `${violation.id} (${violation.impact ?? "unrated"}) on ` +
            violation.nodes
              .slice(0, 2)
              .map((node) => {
                const why = (node.failureSummary ?? "")
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0 && !line.startsWith("Fix"))
                  .join(" ");
                return `${node.target.join(" ")}${why ? ` [${why.slice(0, 160)}]` : ""}`;
              })
              .join(", "),
        );
        record(
          `${size.name}/${target.name} has no automatically detectable accessibility violations`,
          violations.length === 0,
          violations.length === 0 ? "none" : violations.join("; "),
        );
      }

      if (target.name === "search-results") {
        const results = await page.evaluate(() => {
          const items = [...document.querySelectorAll(".search-page__result")];
          return items.map((item) => ({
            title: item.querySelector(".search-page__result-title")?.textContent?.trim() ?? "",
            kind: item.querySelector(".lozenge")?.textContent?.trim() ?? "",
            href: item.querySelector("a.search-page__result-link")?.getAttribute("href") ?? "",
          }));
        });

        record(
          `${size.name}/search-results finds something for a real place name`,
          results.length > 0,
          results.length === 0
            ? "no results for Leeds"
            : `${results.length} result(s): ${results
                .slice(0, 4)
                .map((result) => `${result.title} [${result.kind}]`)
                .join(", ")}`,
        );

        /*
         * The loop, as a check. A result whose link is a search for its own title is the exact
         * shape of the defect, and it is cheaper to assert than to photograph.
         */
        const loops = results.filter((result) => result.href.startsWith("/search"));
        record(
          `${size.name}/search-results never links a result back to the search page`,
          loops.length === 0,
          loops.length === 0
            ? "every result links to its own page"
            : loops.map((result) => `${result.title} -> ${result.href}`).join(", "),
        );

        if (results.length > 0) {
          const first = results[0];
          await page.locator("a.search-page__result-link").first().click();
          await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
          const landed = await page.evaluate(() => ({
            path: window.location.pathname,
            heading: document.querySelector("h1")?.textContent?.trim() ?? "",
            notFound: document.body.textContent?.includes("We could not find that page") ?? false,
          }));
          record(
            `${size.name}/search-results opens the thing it found`,
            !landed.path.startsWith("/search") && !landed.notFound && landed.heading.length > 0,
            `${first.title} [${first.kind}] -> ${landed.path} (${landed.heading || "no heading"})`,
          );
          await page.goBack().catch(() => {});
        }
      }

      if (target.name === "vehicle") {
        const trigger = page.locator(".vehicle-page__stopped-trigger");
        if ((await trigger.count()) > 0) {
          await trigger.first().click();
          await page.locator(".bus-stopped").waitFor({ state: "visible", timeout: 10_000 });
          // The lookup is two API calls; give it room, then read whatever it settled on.
          await page
            .locator(".bus-stopped__pending")
            .waitFor({ state: "detached", timeout: 20_000 })
            .catch(() => {
              /* Still pending is itself a readable outcome, reported below. */
            });

          const stopped = await page.evaluate(() => {
            const panel = document.querySelector(".bus-stopped");
            if (!panel) return null;
            const text = panel.textContent ?? "";
            return {
              pending: panel.querySelector(".bus-stopped__pending")?.textContent?.trim() ?? "",
              retry: panel.querySelector(".bus-stopped__retry") !== null,
              states: panel.querySelectorAll(".bus-stopped__states li").length,
              services: panel.querySelectorAll(".bus-stopped__services li").length,
              claimsNothingDue: /no other departures to suggest/i.test(text),
              claimsBreakdown: /broken down|breakdown|cancelled|cancellation/i.test(text),
              emergency: /999/.test(text),
            };
          });

          const looking = stopped !== null && stopped.pending.length > 0;
          record(
            `${size.name}/vehicle opens Bus stopped? and lists what it can see`,
            stopped !== null && stopped.states > 0 && stopped.emergency,
            stopped === null
              ? "the panel did not render"
              : `${stopped.states} explanation(s), ${stopped.services} onward service(s)` +
                  (looking ? `; still looking: ${stopped.pending}` : "") +
                  (stopped.retry ? "; retry offered" : ""),
          );
          /*
           * The empty-state lie, stated as its own check because it is the one this panel is
           * capable of: "nothing is due" is a claim about a departure board, and it may only be
           * made once the board has actually been read.
           */
          record(
            `${size.name}/vehicle never says nothing is due about a board it could not read`,
            stopped !== null && !(looking && stopped.claimsNothingDue),
            stopped === null
              ? "the panel did not render"
              : looking
                ? `pending (${stopped.pending}) and claimsNothingDue=${stopped.claimsNothingDue}`
                : "the lookup settled before any claim was made",
          );
          record(
            `${size.name}/vehicle never asserts a breakdown`,
            stopped !== null && !stopped.claimsBreakdown,
            stopped === null ? "the panel did not render" : "no breakdown or cancellation claimed",
          );
          await page.screenshot({
            path: `${screenshotDir}/${size.name}-vehicle-bus-stopped.png`,
            fullPage: true,
          });
        } else {
          console.log("        no Bus stopped? trigger on this vehicle page");
        }
      }

      /*
       * The two navigation paths nothing had ever followed.
       *
       * P4 names three: Map to Vehicle, Route to Vehicle, Vehicle to Route. The first is checked
       * where the bus panel is opened, and its route link is checked for being an identifier
       * rather than the number on the front. The other two had only ever been checked as markup —
       * that a link was rendered — and the failure they actually had was the link resolving to
       * "This link needs a map area", which is a page that renders perfectly and helps nobody. So
       * both are clicked, and what they land on is read.
       */
      if (target.name === "vehicle" || target.name === "route") {
        const selector =
          target.name === "vehicle"
            ? "a[href^='/routes/']"
            : ".route-page__vehicles a[href^='/vehicles/']";
        const link = page.locator(selector).first();
        if ((await link.count()) > 0) {
          const href = await link.getAttribute("href");
          await link.click();
          /*
           * Wait for a heading, not for the network.
           *
           * These pages refresh on a ticker, so `networkidle` never arrives and the wait always
           * expired — leaving the DOM read before the page had rendered anything, which is what
           * "(no heading)" meant in run 54 rather than a broken link. A heading or an error state
           * is what "the page arrived" actually looks like; still having neither after fifteen
           * seconds is its own reported outcome.
           */
          await page
            .locator("h1, .state-block--error")
            .first()
            .waitFor({ state: "visible", timeout: 15_000 })
            .catch(() => {
              /* Neither appeared; reported below rather than thrown. */
            });
          const landed = await page.evaluate(() => {
            const body = document.body.textContent ?? "";
            return {
              path: window.location.pathname,
              heading: document.querySelector("h1")?.textContent?.trim() ?? "",
              needsViewport: body.includes("needs a map area"),
              notFound: body.includes("could not find"),
              errored: document.querySelector(".state-block--error") !== null,
            };
          });
          record(
            `${size.name}/${target.name} follows its ${target.name === "vehicle" ? "route" : "vehicle"} link to a real page`,
            landed.heading.length > 0 &&
              !landed.needsViewport &&
              !landed.notFound &&
              !landed.errored,
            `${href} -> ${landed.path} (${landed.heading || "no heading after 15s"})` +
              (landed.needsViewport ? "; asked for a map area" : "") +
              (landed.notFound ? "; not found" : "") +
              (landed.errored ? "; error state" : ""),
          );
          await page.goBack().catch(() => {});
          await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        } else {
          console.log(
            `        no ${target.name === "vehicle" ? "route" : "live vehicle"} link on this page right now`,
          );
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
