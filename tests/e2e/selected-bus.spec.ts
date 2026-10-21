import { expect, test } from "@playwright/test";
import { MAP_WITH_TRAFFIC, VEHICLE_DETAIL, mockApi } from "./fixtures.js";

/**
 * Tapping a bus, and what happens while you keep watching it.
 *
 * Three things about a selected bus can only be seen with a renderer and with time passing, and
 * all three were previously tested nowhere:
 *
 *   - the stops listed are the ones in front of the bus, with the next one flagged;
 *   - the blue route drawn is clipped at the bus rather than starting from the route's first stop;
 *   - a recent path appears from the map's own twenty-second refreshes, for no extra request.
 *
 * The third is the one this file exists for. The server's trail covers before the page was opened
 * and is empty for most of the day, so `recentTrace` here is deliberately empty: the only points
 * available are the ones the map is already being told, and a line that appears from them is the
 * feature working. The vehicle lookup is counted, because the whole design is that watching costs
 * nothing beyond the refresh that was happening anyway.
 */

/** As in the other map specs: a renderer with no glyphs and no tiles, handed in before scripts. */
const BARE_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "ground", type: "background", paint: { "background-color": "#eef1f2" } }],
};

/** The map's own cadence, from `REFRESH_INTERVAL_MS` in `LiveMapPage`. */
const REFRESH_MS = 20_000;

/** Leeds, northbound, far enough apart that the segmentation keeps every one of them. */
const SHAPE = [
  { lat: 53.7955, lon: -1.5432 },
  { lat: 53.7985, lon: -1.5432 },
  { lat: 53.8015, lon: -1.5432 },
  { lat: 53.8045, lon: -1.5432 },
  { lat: 53.8075, lon: -1.5432 },
  { lat: 53.8105, lon: -1.5432 },
];

const BASE_OBSERVED_AT = Date.parse("2026-09-03T08:59:30.000Z");

/**
 * The stops this bus is calling at, taken from the stops the map itself returns.
 *
 * `nextStops` carries names and codes and no positions, so the markers along the route come from
 * the stops already in the viewport, matched by ATCO code. A fixture whose next stops are not in
 * its own map is therefore a fixture in which no marker can be drawn — true to the product, and
 * useless for testing it. The first is behind the bus, so the window is a window and not a list
 * from the start of the route.
 */
const NEXT_STOPS = MAP_WITH_TRAFFIC.data.stops.map((stop, index) => ({
  stopId: stop.id,
  name: stop.name,
  atcoCode: stop.atcoCode,
  scheduledTime: new Date(BASE_OBSERVED_AT + index * 180_000).toISOString(),
  expectedTimeLow: new Date(BASE_OBSERVED_AT + index * 180_000).toISOString(),
  expectedTimeHigh: new Date(BASE_OBSERVED_AT + index * 180_000 + 120_000).toISOString(),
  passed: index === 0,
}));

interface Overlay {
  trailRuns: number;
  trailPoints: number;
  remainingPoints: number;
  travelledPoints: number;
  upcoming: number;
  destination: boolean;
  drawnAhead: number;
  drawnTrail: number;
  drawnTravelled: number;
}

/**
 * What was handed to the renderer, and what it drew.
 *
 * Both, because they answer different questions: the source says the overlay was built,
 * `queryRenderedFeatures` says a layer actually draws it. The source's GeoJSON is read through
 * MapLibre's own internals deliberately — a rendered query returns tile-clipped geometry and
 * cannot answer "how many positions are in this line".
 */
async function overlay(page: import("@playwright/test").Page): Promise<Overlay | null> {
  return page.evaluate(() => {
    interface SourceLike {
      serialize?: () => { data?: { features?: unknown[] } };
      _data?: { features?: unknown[] };
    }
    interface MapLike {
      getSource: (id: string) => SourceLike | undefined;
      queryRenderedFeatures: (options: { layers: string[] }) => unknown[];
    }
    const map = (globalThis as unknown as { __busstopsMap?: MapLike }).__busstopsMap;
    if (!map) return null;
    const source = map.getSource("busstops-selected-vehicle");
    if (!source) return null;
    const data = source.serialize ? source.serialize().data : source._data;
    const features = (Array.isArray(data?.features) ? data.features : []) as Array<{
      properties?: { kind?: string };
      geometry?: { coordinates?: unknown[] };
    }>;
    const of = (kind: string) => features.filter((feature) => feature.properties?.kind === kind);
    const points = (kind: string) =>
      of(kind).reduce((total, feature) => total + (feature.geometry?.coordinates?.length ?? 0), 0);
    const drawn = (layer: string) => {
      try {
        return map.queryRenderedFeatures({ layers: [layer] }).length;
      } catch {
        return 0;
      }
    };
    return {
      trailRuns: of("trail").length,
      trailPoints: points("trail"),
      remainingPoints: points("remaining"),
      travelledPoints: points("travelled"),
      upcoming: of("next").length + of("upcoming").length,
      destination: of("destination").length > 0,
      drawnAhead: drawn("route-ahead"),
      drawnTrail: drawn("trail-observed"),
      drawnTravelled: drawn("route-travelled"),
    };
  });
}

/**
 * The map, answering differently each time it is asked.
 *
 * `mockApi` serves one fixed body per path, which is exactly what a trail cannot be built from:
 * the session keeps a position only when the feed reports a new moment. So this route is
 * registered after it — Playwright matches the most recently added route first — and moves the
 * selected bus about a hundred and thirty metres north on every refresh, stamping each response
 * with the moment the feed saw it.
 */
async function serveMovingMap(page: import("@playwright/test").Page): Promise<{
  refreshes: () => number;
  lookups: () => number;
}> {
  let refreshes = 0;
  let lookups = 0;

  await page.route("**/api/v1/map**", async (route) => {
    const step = refreshes;
    refreshes += 1;
    const vehicles = MAP_WITH_TRAFFIC.data.vehicles.map((vehicle, index) =>
      index === 0
        ? {
            ...vehicle,
            coordinate: { lat: 53.7972 + step * 0.0012, lon: -1.5432 },
            freshnessSeconds: 10,
          }
        : vehicle,
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...MAP_WITH_TRAFFIC,
        meta: {
          ...MAP_WITH_TRAFFIC.meta,
          observedAt: new Date(BASE_OBSERVED_AT + step * REFRESH_MS).toISOString(),
        },
        data: { ...MAP_WITH_TRAFFIC.data, vehicles },
      }),
    });
  });

  await page.route("**/api/v1/vehicles/**", async (route) => {
    lookups += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...VEHICLE_DETAIL,
        data: {
          ...VEHICLE_DETAIL.data,
          /* Nothing from the server: the only history available is what the map has reported. */
          recentTrace: [],
          nextStops: NEXT_STOPS,
          nextStopsState: "ahead",
          /* A third of the way along, so the line is clipped somewhere visible. */
          progressAlongShapeMetres: 1100,
          scheduledShape: SHAPE,
        },
      }),
    });
  });

  return { refreshes: () => refreshes, lookups: () => lookups };
}

/** Click the first bus where it is painted, which is the only way in — there is no deep link. */
async function tapTheBus(page: import("@playwright/test").Page): Promise<void> {
  /*
   * Let the map settle before touching it.
   *
   * Asking a half-built map what it has rendered, or clicking it, makes MapLibre raise an error —
   * and `MapView` treats any error from the renderer as "the map could not be loaded" and swaps
   * itself for the list. That is correct behaviour and it made this file red three times while
   * blaming the product: the leftover map object still answers `queryRenderedFeatures`, so a bus
   * projects and a click lands on a `div`. The other map specs settle for two seconds for the
   * same reason; the poll below additionally waits for the condition itself.
   */
  await page.waitForTimeout(2500);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          interface MapLike {
            isStyleLoaded?: () => boolean;
            queryRenderedFeatures: (options: { layers: string[] }) => unknown[];
          }
          const map = (globalThis as unknown as { __busstopsMap?: MapLike }).__busstopsMap;
          /*
           * Not before the style is loaded.
           *
           * Asking a half-built map what it has rendered makes MapLibre raise an error, and the
           * component treats an error from the renderer as "the map could not be loaded" — which
           * is correct behaviour and turns an impatient test into a red one that blames the
           * product. The other map specs avoid this by waiting a fixed two seconds; this waits
           * for the condition itself.
           */
          if (!map || map.isStyleLoaded?.() !== true) return 0;
          try {
            return map.queryRenderedFeatures({ layers: ["vehicle-buses", "vehicle-pips"] }).length;
          } catch {
            return 0;
          }
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  const point = await page.evaluate(() => {
    interface MapLike {
      queryRenderedFeatures: (options: { layers: string[] }) => Array<{
        geometry: { coordinates: [number, number] };
        properties?: { vehicleRef?: string };
      }>;
      project: (coordinates: [number, number]) => { x: number; y: number };
      getCanvas: () => HTMLCanvasElement;
    }
    const map = (globalThis as unknown as { __busstopsMap?: MapLike }).__busstopsMap;
    if (!map) return null;
    const features = map.queryRenderedFeatures({ layers: ["vehicle-buses", "vehicle-pips"] });
    const wanted = features.find((feature) => feature.properties?.vehicleRef === "v1");
    if (!wanted) return null;
    const box = map.getCanvas().getBoundingClientRect();
    const projected = map.project(wanted.geometry.coordinates);
    return { x: box.left + projected.x, y: box.top + projected.y };
  });

  expect(point, "bus v1 was not painted, so it could not be tapped").not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
  await expect(page.locator(".selected-vehicle")).toBeVisible();
  await expect(page.locator(".selected-vehicle .loading-bus")).toHaveCount(0, { timeout: 15_000 });
}

test.describe("the selected bus", () => {
  /*
   * One width, deliberately.
   *
   * These wait for real refreshes to arrive, and the overlay they measure is a map layer rather
   * than a layout — nothing here changes with the viewport. The panel itself is swept at three
   * widths against the deployment; running a two-refresh wait four times over would add minutes
   * to every CI run to re-measure the same GeoJSON.
   */
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "one width is enough for a map layer");
    await page.addInitScript((style) => {
      (globalThis as { __busstopsMapStyle?: unknown }).__busstopsMapStyle = style;
    }, BARE_STYLE);
    await mockApi(page);
    await serveMovingMap(page);
  });

  test("names the stops in front of it and draws the route clipped at the bus", async ({
    page,
  }) => {
    await page.goto("/live");
    await tapTheBus(page);

    const panel = page.locator(".selected-vehicle");
    const stops = panel.locator(".selected-vehicle__stops li");
    await expect(stops).not.toHaveCount(0);
    /* The flag is what makes the first entry a next stop rather than the top of a list. */
    await expect(stops.first()).toHaveClass(/is-next/);
    await expect(panel.getByText("Next stop")).toBeVisible();

    const drawn = await overlay(page);
    expect(drawn).not.toBeNull();
    /*
     * Clipped, not whole: the route ahead starts at the bus and the part behind it is a separate
     * line. A single line carrying every point of the shape is the defect this replaced.
     */
    expect(drawn!.remainingPoints).toBeGreaterThan(1);
    expect(drawn!.travelledPoints).toBeGreaterThan(1);
    expect(drawn!.remainingPoints + drawn!.travelledPoints).toBeGreaterThan(SHAPE.length);
    expect(drawn!.drawnAhead).toBeGreaterThan(0);
    expect(drawn!.upcoming).toBeGreaterThan(0);

    /* And the line is explained in words, not only in two shades of blue. */
    await expect(panel.getByText("Scheduled route")).toBeVisible();
  });

  test("builds a recent path out of the refreshes it was already making", async ({ page }) => {
    /* Two refreshes of real time, because the trail is made of time passing. */
    test.setTimeout(120_000);

    await page.goto("/live");
    await tapTheBus(page);

    const atFirst = await overlay(page);
    expect(atFirst).not.toBeNull();
    /*
     * Whatever it starts at, which is a property of how long the tap took rather than of the
     * feature. The fixture's server trail is empty on purpose, so the only points there can be are
     * the ones the map has already reported — and one of those is a position, not a path, so a
     * bus tapped on the first response has nothing drawn and says so.
     */
    const baseline = atFirst!.trailPoints;
    if (baseline === 0) {
      await expect(page.locator(".selected-vehicle__trail-note")).toBeVisible();
    }

    await expect
      .poll(async () => (await overlay(page))?.trailPoints ?? 0, { timeout: 70_000 })
      .toBeGreaterThan(Math.max(1, baseline));

    const later = (await overlay(page))!;
    expect(later.trailRuns).toBeGreaterThan(0);
    expect(later.drawnTrail).toBeGreaterThan(0);
    /* Named, now that there is a line to name. */
    await expect(page.locator(".selected-vehicle__key--observed")).toBeVisible();
    await expect(page.getByText("Recent observed path")).toBeVisible();
  });

  test("costs nothing beyond the refresh it was already making", async ({ page }) => {
    test.setTimeout(120_000);

    /*
     * Counted from before the page exists, because the claim covers every write the page makes
     * while a bus is selected — not only the ones after a patch applied mid-session.
     */
    await page.addInitScript(() => {
      const written: string[] = [];
      (globalThis as { __storageWrites?: string[] }).__storageWrites = written;
      const original = globalThis.Storage.prototype.setItem;
      globalThis.Storage.prototype.setItem = function patched(key: string, value: string) {
        written.push(key);
        return original.call(this, key, value);
      };
    });

    await page.goto("/live");
    await tapTheBus(page);

    const before = await overlay(page);
    expect(before).not.toBeNull();
    const baseline = before!.trailPoints;

    /*
     * Watched from after the tap. The tap's own lookup is the one request this feature is allowed;
     * what matters is that nothing further is asked for while the path builds, and that the map
     * kept refreshing — those were happening anyway.
     */
    const lookups: string[] = [];
    const refreshes: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.includes("/v1/vehicles/")) lookups.push(path);
      if (path.includes("/v1/map")) refreshes.push(path);
    });

    await expect
      .poll(async () => (await overlay(page))?.trailPoints ?? 0, { timeout: 70_000 })
      .toBeGreaterThan(Math.max(1, baseline));

    expect(refreshes.length).toBeGreaterThan(0);
    expect(lookups).toEqual([]);

    /*
     * And the difference between a visual trail and a tracking feature: nothing about where a bus
     * has been may outlive the tab, so there is no key to find and no reload that could restore
     * one.
     */
    const written = await page.evaluate(
      () => (globalThis as { __storageWrites?: string[] }).__storageWrites ?? [],
    );
    expect(written.filter((key) => /trail|trace|vehicle/i.test(key))).toEqual([]);
  });
});
