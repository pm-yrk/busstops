import { expect, test } from "@playwright/test";
import { mockApi, META, STOP_ID } from "./fixtures.js";

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

const MAP_WITH_TRAFFIC = {
  meta: META,
  data: {
    stops: [
      {
        id: "00000000-0000-5000-8000-0000000000d1",
        atcoCode: "450010001",
        name: "Boar Lane",
        indicator: "Stand A",
        coordinate: { lat: 53.7965, lon: -1.5445 },
        routePublicNames: ["36"],
        hasLiveCoverage: true,
      },
      {
        id: "00000000-0000-5000-8000-0000000000d2",
        atcoCode: "450010002",
        name: "City Square",
        indicator: "B",
        coordinate: { lat: 53.7952, lon: -1.5478 },
        routePublicNames: ["12"],
        hasLiveCoverage: true,
      },
      {
        id: "00000000-0000-5000-8000-0000000000d3",
        atcoCode: "450010003",
        name: "Park Row",
        coordinate: { lat: 53.7988, lon: -1.5462 },
        routePublicNames: [],
        hasLiveCoverage: false,
      },
    ],
    vehicles: [
      {
        vehicleRef: "v1",
        coordinate: { lat: 53.7972, lon: -1.5432 },
        bearingDegrees: 90,
        routePublicName: "36",
        destinationName: "Ripon",
        delaySeconds: 60,
        freshnessSeconds: 20,
        motionState: "moving" as const,
      },
      {
        vehicleRef: "v2",
        coordinate: { lat: 53.7944, lon: -1.5495 },
        bearingDegrees: 260,
        routePublicName: "12",
        destinationName: "Beeston",
        delaySeconds: null,
        freshnessSeconds: 40,
        motionState: "moving" as const,
      },
      {
        // Old enough to be drawn as a stale vehicle rather than a fresh one.
        vehicleRef: "v3",
        coordinate: { lat: 53.7995, lon: -1.543 },
        bearingDegrees: 10,
        routePublicName: "X84",
        destinationName: "Otley",
        delaySeconds: null,
        freshnessSeconds: 900,
        motionState: "stationary" as const,
      },
    ],
    incidents: [],
    truncated: { stops: false, vehicles: false, incidents: false },
  },
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
});
