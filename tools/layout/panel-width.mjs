/*
 * A ruler for the selected-stop panel. Not a screenshot, and not evidence about the product: it
 * renders the panel's own stylesheets over an empty box, with no data of any kind.
 *
 * The weather scene is drawn at a whole multiple of 176 art pixels, so the width the panel hands
 * it decides its size in steps rather than smoothly — and two steps versus one is the difference
 * between a picture and a stamp. That width is not arithmetic anyone should do in their head:
 * `box-sizing: border-box` puts the hairline inside the panel's width, and the scene bleeds back
 * over the padding but not over the border, so a panel of exactly 3 x 176 leaves the scene two
 * pixels short and it silently drops a whole scale. This says what it actually gets.
 *
 * Run from the repository root: `node tools/layout/panel-width.mjs`
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const css = [
  "apps/web/src/styles/tokens.css",
  "apps/web/src/styles/global.css",
  "apps/web/src/components/SelectedStopBoard.css",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

const html = `<!doctype html><html><head><style>
  html,body{margin:0}
  .map{position:relative;width:100%;height:100vh}
  ${css}
</style></head><body>
  <div class="map"><aside class="selected-stop"><div class="selected-stop__weather">
    <div class="vignette__holder"></div>
  </div></aside></div>
</body></html>`;

const browser = await chromium.launch();
for (const [name, width, height] of [
  ["desktop", 1440, 900],
  ["tablet", 768, 1024],
  ["phone", 390, 844],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html);
  const measured = await page.evaluate(() => ({
    panel: Math.round(document.querySelector(".selected-stop").getBoundingClientRect().width),
    holder: Math.round(document.querySelector(".vignette__holder").getBoundingClientRect().width),
  }));
  console.log(
    `${name.padEnd(8)} viewport ${String(width).padStart(4)}  panel ${String(measured.panel).padStart(4)}px  ` +
      `holder ${String(measured.holder).padStart(4)}px  ->  scale ${Math.max(1, Math.min(3, Math.floor(measured.holder / 176)))}` +
      `  (scene ${176 * Math.max(1, Math.min(3, Math.floor(measured.holder / 176)))}px wide)`,
  );
  await page.close();
}
await browser.close();
