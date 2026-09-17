import { expect, test } from "@playwright/test";
import { MAP_WITH_TRAFFIC, META, mockApi, STOP_ID } from "./fixtures.js";

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
  /** Every viewport request the page makes, so panning can be shown to ask again. */
  const mapRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/v1/map")) mapRequests.push(request.url());
  });

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

  /*
   * A crowded viewport, because the defect this catches cannot happen in an empty one.
   *
   * Our own `.map-marker` rule set `position: relative`. MapLibre sets `position: absolute` on
   * every marker it owns, the two have equal specificity, and our stylesheet is bundled after
   * MapLibre's — so ours won and every marker fell back into normal flow. They stacked
   * vertically inside the map (scrollHeight 26,682px for one Leeds viewport) and MapLibre's
   * transform then offset each one from its flow position rather than from the map's origin.
   *
   * With six markers every one of them flows inside the first 264px and the bench looked
   * perfect. With a real viewport, stops are added before vehicles, so the few that landed in
   * frame were all stop flags and all 197 buses sat around y=18,000, clipped by the map's own
   * `overflow: hidden`. The page said "Buses in view 197" beside a map with no buses on it.
   *
   * So the assertion is not "markers exist" — that was always true. It is that every bus the
   * API returned is inside the rectangle the map occupies.
   */
  await page.route("**/v1/map**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(crowdedViewport()),
    }),
  );
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);

  const placement = await page.evaluate(() => {
    const canvas = document.querySelector(".map-view__canvas")?.getBoundingClientRect();
    const markers = [...document.querySelectorAll(".map-marker--vehicle")];
    if (!canvas) return { total: markers.length, inside: 0, mapScrollHeight: 0 };
    const inside = markers.filter((marker) => {
      const r = marker.getBoundingClientRect();
      return (
        r.left >= canvas.left - 40 &&
        r.right <= canvas.right + 40 &&
        r.top >= canvas.top - 40 &&
        r.bottom <= canvas.bottom + 40
      );
    }).length;
    return {
      total: markers.length,
      inside,
      mapScrollHeight: document.querySelector(".maplibregl-map")?.scrollHeight ?? 0,
    };
  });

  expect(placement.total, "buses the API returned").toBe(CROWDED_VEHICLES);
  expect(placement.inside, "buses actually inside the map").toBe(CROWDED_VEHICLES);
  /*
   * The map must not scroll. A map taller than its own box means the markers are in flow, which
   * is the failure above whether or not any of them happens to land in frame.
   */
  expect(placement.mapScrollHeight).toBeLessThan(2000);

  await map.screenshot({ path: `art-preview/${testInfo.project.name}-markers-crowded.png` });

  /*
   * Panning must ask again for the new viewport.
   *
   * A map that keeps drawing the buses from the box you started in is worse than one with no
   * buses: it looks live and is not. MapLibre's `moveend` is what carries the new bounds back to
   * the page, and nothing else would notice if that wiring came loose.
   */
  const before = mapRequests.length;
  // Scrolled into view first: the mouse works in viewport coordinates, and on a phone the map
  // starts below the fold, so dragging its "centre" was dragging the page behind it.
  await map.scrollIntoViewIfNeeded();
  const canvasBox = await map.boundingBox();
  if (canvasBox) {
    const midX = canvasBox.x + canvasBox.width / 2;
    const midY = canvasBox.y + canvasBox.height / 2;
    // A quarter of the box, so the gesture stays on the map at every width in this bench.
    const dx = Math.round(canvasBox.width / 4);
    const dy = Math.round(canvasBox.height / 4);
    await page.mouse.move(midX, midY);
    await page.mouse.down();
    await page.mouse.move(midX - dx, midY - dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
  }
  expect(mapRequests.length, "viewport requests after panning").toBeGreaterThan(before);
  // And the new request must name a different box than the one it opened on.
  expect(mapRequests.at(-1)).not.toBe(mapRequests[before - 1]);
});

/** Enough buses that a marker in normal flow would leave the visible map. */
const CROWDED_VEHICLES = 120;

/**
 * A Leeds viewport the size the deployed API actually answers with.
 *
 * Positions are spread deterministically across the default camera rather than randomly, so a
 * failure is reproducible and a screenshot is comparable between runs.
 */
function crowdedViewport() {
  const west = -1.6;
  const east = -1.49;
  const south = 53.775;
  const north = 53.825;
  const spread = (index: number, count: number, from: number, to: number) =>
    from + ((index * 7919) % count) * ((to - from) / count);

  return {
    meta: { ...META, degradation: "normal" },
    data: {
      stops: Array.from({ length: 200 }, (_, index) => ({
        id: `00000000-0000-5000-8000-${String(index).padStart(12, "0")}`,
        atcoCode: `450010${String(index).padStart(4, "0")}`,
        name: `Stop ${index}`,
        coordinate: {
          lat: spread(index, 200, south, north),
          lon: spread(index + 37, 200, west, east),
        },
        routePublicNames: ["36"],
        hasLiveCoverage: true,
      })),
      vehicles: Array.from({ length: CROWDED_VEHICLES }, (_, index) => ({
        vehicleRef: `crowd-${index}`,
        coordinate: {
          lat: spread(index + 11, CROWDED_VEHICLES, south, north),
          lon: spread(index + 53, CROWDED_VEHICLES, west, east),
        },
        bearingDegrees: (index * 29) % 360,
        routePublicName: String(36 + (index % 9)),
        destinationName: "Ripon",
        delaySeconds: null,
        freshnessSeconds: 20,
        motionState: "moving" as const,
      })),
      incidents: [],
      disruptions: [],
      truncated: { stops: false, vehicles: false, incidents: false },
    },
  };
}
