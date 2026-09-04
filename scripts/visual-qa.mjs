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
/* global document, window, getComputedStyle, HTMLCanvasElement */

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

const PAGES = [
  { name: "home", path: "/" },
  { name: "live", path: "/live" },
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
      await page.waitForTimeout(target.name === "live" ? 9_000 : 2_000);

      await page.screenshot({
        path: join(screenshotDir, `${size.name}-${target.name}.png`),
        fullPage: false,
      });

      // A page wider than its viewport is a defect at every width, and the one most easily missed.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      record(
        `${size.name}/${target.name} does not scroll sideways`,
        overflow <= 0,
        `${overflow}px`,
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
            sceneRects: [...document.querySelectorAll(".home__hero-scene .street-scene__canvas")]
              .filter((svg) => svg.getBoundingClientRect().height > 0)
              .reduce((total, svg) => total + svg.querySelectorAll("rect").length, 0),
          };
        });

        record(
          `${size.name}/home hero fills the first viewport`,
          hero.heroBottom !== null && Math.abs(hero.heroBottom - hero.viewportHeight) <= 2,
          `hero ends at ${Math.round(hero.heroBottom ?? -1)}, viewport ${hero.viewportHeight}`,
        );
        record(
          `${size.name}/home street scene is drawn, not a row of icons`,
          hero.sceneRects >= 60 && (hero.sceneHeight ?? 0) > 100,
          `${hero.sceneRects} shapes, ${Math.round(hero.sceneHeight ?? 0)}px tall`,
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

      if (target.name === "live") {
        const map = await page.evaluate(() => {
          const canvas = document.querySelector("canvas.maplibregl-canvas");
          const unavailable = document.querySelector(".map-view--unavailable");
          let painted = 0;
          if (canvas instanceof HTMLCanvasElement) {
            // A style that failed to load leaves a canvas of one flat colour. Sampling a grid is
            // the only way to tell "a map rendered" from "a rectangle exists".
            const probe = document.createElement("canvas");
            probe.width = 40;
            probe.height = 40;
            const context2d = probe.getContext("2d");
            if (context2d) {
              try {
                context2d.drawImage(canvas, 0, 0, 40, 40);
                const data = context2d.getImageData(0, 0, 40, 40).data;
                const seen = new Set();
                for (let i = 0; i < data.length; i += 4) {
                  seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
                }
                painted = seen.size;
              } catch {
                painted = -1;
              }
            }
          }
          return {
            hasCanvas: !!canvas,
            unavailable: !!unavailable,
            distinctColours: painted,
            markers: document.querySelectorAll(".map-marker").length,
            attribution:
              document.querySelector(".maplibregl-ctrl-attrib")?.textContent?.trim() ?? "",
          };
        });

        const tileHits = sink.tileResponses.filter((r) => r.status === 200).length;
        const tileErrors = sink.tileResponses.filter((r) => r.status >= 400);

        record(
          `${size.name}/live renders a map rather than the fallback`,
          map.hasCanvas && !map.unavailable,
          `canvas ${map.hasCanvas ? "present" : "absent"}, list-only fallback ${
            map.unavailable ? "shown" : "not shown"
          }`,
        );
        record(
          `${size.name}/live basemap actually paints`,
          map.distinctColours > 8,
          `${map.distinctColours} distinct colours sampled`,
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
        console.log(`        markers on the map: ${map.markers}`);

        /*
         * Clicking a stop is the one interaction the whole Live page exists for, and nothing else
         * checks it end to end: the API test proves the endpoint answers, and the accessibility
         * suite runs against a mocked map. Only here is it a real marker, drawn from real published
         * stops, opening a real board.
         */
        if (map.markers > 0) {
          /*
           * `force`, and inside a try. Four hundred stops in a city centre genuinely overlap, and
           * some sit under the sticky header, so the browser's actionability check refuses a click
           * that a person makes without thinking — it waits, retries for thirty seconds, and then
           * throws a stack trace long enough to push every other result out of the log. A person
           * clicks whatever is on top; so does this.
           */
          let clickFailed = null;
          try {
            await page.locator(".map-marker--stop").first().click({ force: true, timeout: 5_000 });
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
