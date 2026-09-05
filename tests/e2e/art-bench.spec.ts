import { expect, test } from "@playwright/test";
import { MAP_WITH_TRAFFIC, mockApi, STOP_ID } from "./fixtures.js";

/**
 * A style with one background layer. MapLibre draws a blank ground and puts the markers on it,
 * which is what this bench is for: the tile host is unreachable from the build container, and
 * the markers are DOM elements that do not need it.
 */
const BLANK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "ground", type: "background", paint: { "background-color": "#eef1f2" } }],
};

test("art bench", async ({ page }, testInfo) => {
  await page.route("**/style.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(BLANK_STYLE),
    }),
  );
  await mockApi(page, { "/v1/map": MAP_WITH_TRAFFIC });
  const shots: Array<[string, string]> = [
    // The home page is the first thing anyone sees, so it is the first thing this looks at.
    ["home", "/"],
    ["stop", `/stops/${STOP_ID}`],
    ["live", "/live"],
    ["journey", "/journey"],
    ["disruptions", "/disruptions"],
    ["notfound", "/no-such-page"],
    ["search", "/search"],
    ["saved", "/saved"],
    ["pro", "/pro"],
  ];
  for (const [name, path] of shots) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `art-preview/${testInfo.project.name}-${name}.png` });

    /*
     * A page in its error state has no artwork on it, so "every sprite loaded" is trivially true
     * and this bench passed for days over a live map that said "Something went wrong". It did,
     * because the map fixture here was not updated when official disruptions were added to the
     * response contract, and a schema the client rejects looks exactly like a failed request.
     * Looking at the picture caught it; the assertion is here so the next one does not need to.
     */
    await expect(
      page.getByRole("heading", { name: "Something went wrong" }),
      `${name}: rendered its error state`,
    ).toHaveCount(0);

    // Every sprite on the page decoded. `complete` alone is true for a 404, so the size is what
    // is checked.
    const broken = await page.evaluate(() =>
      [...document.querySelectorAll("img")]
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => img.getAttribute("src")?.slice(0, 60) ?? "(no src)"),
    );
    expect(broken, `${name}: sprites that did not load`).toEqual([]);
  }

  // The markers are 24 and 12 art pixels wide; a full-page screenshot is not enough to judge them.
  await page.goto("/live");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);
  /*
   * Markers only exist when a basemap style is configured, and the default end-to-end build has
   * none — that is deliberate, because the other specs use it to exercise the list-only fallback.
   * `npm run art:bench` builds with a stub style so the markers can be looked at and counted.
   */
  const map = page.locator(".maplibregl-map").first();
  if ((await map.count()) === 0) {
    testInfo.annotations.push({
      type: "note",
      description: "No basemap style configured, so the map markers are not in this bench.",
    });
    return;
  }
  await map.screenshot({ path: `art-preview/${testInfo.project.name}-markers.png` });
  // The markers are the hero artwork reduced; if they stop being drawn, they stop being that.
  await expect(page.locator(".map-marker--vehicle .map-marker__art")).toHaveCount(3);
  await expect(page.locator(".map-marker--stop .map-marker__art")).toHaveCount(3);

  /*
   * Every marker says what it is. MapLibre writes `aria-label="Map marker"` onto the element it
   * is handed, so a map of named stops and numbered buses announced a hundred identical objects
   * until the name was reapplied after construction. This is the assertion that catches it
   * coming back.
   */
  await expect(page.locator('.map-marker[aria-label="Map marker"]')).toHaveCount(0);
  await expect(page.getByRole("img", { name: "36 to Ripon" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Boar Lane, Stand A" })).toHaveCount(1);
});
