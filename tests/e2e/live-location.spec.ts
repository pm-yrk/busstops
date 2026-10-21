import { expect, test } from "@playwright/test";
import { MAP_WITH_TRAFFIC, mockApi } from "./fixtures.js";

/**
 * "I am here, and these are the buses and stops around me."
 *
 * The deterministic half of the current-location check. A real GPS fix in CI is neither available
 * nor repeatable, so the browser's own geolocation emulation stands in: Chromium reports the
 * position this file names, through exactly the API the product calls, with exactly the permission
 * model a passenger's browser uses. What is emulated is the *device*, not the product — the page
 * cannot tell the difference, which is the point.
 *
 * Three behaviours, and the third is the one most likely to regress: a shared link must open where
 * it was sent, not where the person opening it happens to be standing.
 */

/** Leeds, near the fixture's stops, so the dot lands among things worth seeing. */
const HERE = { latitude: 53.7965, longitude: -1.5478 };

/**
 * A style with no sources and no glyphs.
 *
 * The e2e build deliberately ships without `VITE_MAP_STYLE_URL` so most specs exercise the
 * list-only fallback a style-less deployment gets. This spec needs a renderer to ask what was
 * painted, so it hands one in before the page scripts run — the same device `map-paints.spec.ts`
 * uses, and for the same reason.
 */
const BARE_STYLE = {
  version: 8,
  /*
   * One source with a licence line, and a layer that uses it.
   *
   * MapLibre credits the sources a *rendered layer* draws from, and marks the control
   * `maplibregl-attrib-empty` otherwise — so a style with no sources, or with a source no layer
   * touches, renders a zero-by-zero control. The overlap test below then asserted `toBeVisible()`
   * on something permanently hidden, which is a test that checks nothing. A real deployment always
   * has a basemap source with a licence line; this is the smallest thing that behaves like one.
   * The source carries no features, so the layer draws nothing and no other assertion here moves.
   */
  sources: {
    credit: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      attribution: "Test basemap attribution",
    },
  },
  layers: [
    { id: "ground", type: "background", paint: { "background-color": "#eef1f2" } },
    { id: "credit-anchor", type: "circle", source: "credit" },
  ],
};

/** The parts of MapLibre this spec touches, so it needs no import from the bundle. */
interface MapLikeForTest {
  getCenter(): { lat: number; lng: number };
  getZoom(): number;
  queryRenderedFeatures(options: { layers: string[] }): Array<{
    properties?: Record<string, unknown> | null;
  }>;
}

async function painted(
  page: import("@playwright/test").Page,
  layers: string[],
): Promise<number | null> {
  return page.evaluate((names) => {
    const instance = (globalThis as unknown as { __busstopsMap?: MapLikeForTest }).__busstopsMap;
    if (!instance) return null;
    try {
      return instance.queryRenderedFeatures({ layers: names }).length;
    } catch {
      return null;
    }
  }, layers);
}

/**
 * How many stops are on screen, however this viewport happens to draw them.
 *
 * Semantic zoom means the answer is in different layers at different widths: over a street the
 * stops are flags, over a neighbourhood they are pips, and over a city they are clusters carrying a
 * `point_count`. Counting only the first two reported zero stops at phone width for the fallback
 * viewport — the same box fitted into 375 pixels is a lower zoom, so everything was clustered — and
 * that was a test looking in the wrong place, not a map that had stopped drawing. `map-paints.spec.ts`
 * had already learned this; this is the same sum.
 */
async function paintedStops(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const instance = (globalThis as unknown as { __busstopsMap?: MapLikeForTest }).__busstopsMap;
    if (!instance) return 0;
    const count = (layers: string[], cluster: boolean) => {
      try {
        const features = instance.queryRenderedFeatures({ layers });
        return cluster
          ? features.reduce((total, f) => total + (Number(f.properties?.point_count) || 0), 0)
          : features.length;
      } catch {
        return 0;
      }
    };
    return count(["stop-flags", "stop-pips"], false) + count(["stop-clusters"], true);
  });
}

async function paintedBuses(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const instance = (globalThis as unknown as { __busstopsMap?: MapLikeForTest }).__busstopsMap;
    if (!instance) return 0;
    const count = (layers: string[], cluster: boolean) => {
      try {
        const features = instance.queryRenderedFeatures({ layers });
        return cluster
          ? features.reduce((total, f) => total + (Number(f.properties?.point_count) || 0), 0)
          : features.length;
      } catch {
        return 0;
      }
    };
    return count(["vehicle-buses", "vehicle-pips"], false) + count(["vehicle-clusters"], true);
  });
}

async function centre(
  page: import("@playwright/test").Page,
): Promise<{ lat: number; lng: number } | null> {
  return page.evaluate(() => {
    const instance = (globalThis as unknown as { __busstopsMap?: MapLikeForTest }).__busstopsMap;
    return instance ? instance.getCenter() : null;
  });
}

async function openLive(page: import("@playwright/test").Page, path: string): Promise<void> {
  await page.addInitScript((style) => {
    (globalThis as { __busstopsMapStyle?: unknown }).__busstopsMapStyle = style;
  }, BARE_STYLE);
  await mockApi(page, { "/v1/map": MAP_WITH_TRAFFIC });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  // The camera move is animated, and the dot is drawn from a position that arrives asynchronously.
  await page.waitForTimeout(2500);
}

test.describe("with location permission", () => {
  test.use({ permissions: ["geolocation"], geolocation: HERE });

  test("opens around the passenger and shows where they are", async ({ page }) => {
    await openLive(page, "/live");

    const where = await centre(page);
    expect(where, "the map was built").not.toBeNull();
    /*
     * Within roughly a kilometre of the emulated position. Not an exact match on purpose: the
     * camera is fitted to a box around the passenger rather than centred on the coordinate, and
     * asserting the arithmetic of that box would be asserting the implementation.
     */
    expect(Math.abs(where!.lat - HERE.latitude)).toBeLessThan(0.01);
    expect(Math.abs(where!.lng - HERE.longitude)).toBeLessThan(0.02);

    // The dot itself, as the renderer actually painted it.
    expect(await painted(page, ["user-dot"]), "the you-are-here dot").toBe(1);

    // And the things around them, which is the other half of the sentence.
    expect(await paintedStops(page), "stops around the passenger").toBeGreaterThan(0);
  });

  test("names the passenger's location for a screen reader", async ({ page }) => {
    await openLive(page, "/live");
    // The dot is painted on a canvas, so this sentence is the whole of its accessible form.
    await expect(page.getByText(/your location is shown on the map/i)).toBeAttached();
  });

  test("offers a recentre that is reachable by keyboard", async ({ page }) => {
    await openLive(page, "/live");

    const recentre = page.getByRole("button", { name: /centre the map on your location/i });
    await expect(recentre).toBeVisible();
    // Focusable and operable without a pointer, which is the whole requirement on a phone too.
    await recentre.focus();
    await expect(recentre).toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);

    const where = await centre(page);
    expect(Math.abs(where!.lat - HERE.latitude)).toBeLessThan(0.01);
  });

  /*
   * The rule that keeps the map from fighting the person using it: a pan is respected, and only an
   * explicit press brings the camera back.
   */
  test("respects a pan, and comes back when asked", async ({ page }) => {
    await openLive(page, "/live");

    await page.evaluate(() => {
      const instance = (
        globalThis as unknown as { __busstopsMap?: { panBy(offset: [number, number]): void } }
      ).__busstopsMap;
      instance?.panBy([400, 300]);
    });
    await page.waitForTimeout(1500);

    const moved = await centre(page);
    expect(
      Math.abs(moved!.lat - HERE.latitude) + Math.abs(moved!.lng - HERE.longitude),
      "the pan was not undone by the map",
    ).toBeGreaterThan(0.002);

    await page.getByRole("button", { name: /centre the map on your location/i }).click();
    await page.waitForTimeout(1500);

    const back = await centre(page);
    expect(Math.abs(back!.lat - HERE.latitude)).toBeLessThan(0.01);
  });

  /*
   * The requirement stated as a test: an explicit link wins. A passenger opening a shared York
   * viewport sees York, and never their own street first.
   */
  test("a shared viewport opens where it was sent, not at the passenger", async ({ page }) => {
    await openLive(page, "/live?bbox=-1.12,53.94,-1.03,53.99");

    const where = await centre(page);
    // York, a quarter of a degree north of the emulated position.
    expect(where!.lat).toBeGreaterThan(53.9);
    expect(Math.abs(where!.lat - HERE.latitude)).toBeGreaterThan(0.1);
    // And no dot, because the page never asked: there is no fix to arrive late and move it.
    expect(await painted(page, ["user-dot"])).toBe(0);
  });

  /*
   * The attribution toggle must stay tappable.
   *
   * MapLibre's compact attribution is a `<details><summary>` in the bottom-right corner, and the
   * first version of the recentre button sat on top of it — the deployed accessibility pass caught
   * it as `target-size (serious) on summary — partially obscured (smallest space is 24px by 5px)`.
   * Worse than a score: the attribution is a licence condition of the basemap, so covering its
   * toggle covers something this product is required to show.
   *
   * Asserted as geometry rather than through axe, because the rule is "these two do not overlap"
   * and that is checkable exactly.
   */
  test("does not cover the basemap attribution", async ({ page }) => {
    await openLive(page, "/live");

    const control = page.locator(".live-map__recentre");
    const attribution = page.locator(".maplibregl-ctrl-attrib").first();
    await expect(control).toBeVisible();
    await expect(attribution).toBeVisible();

    const button = await control.boundingBox();
    const credit = await attribution.boundingBox();
    expect(button, "the recentre control has a box").not.toBeNull();
    expect(credit, "the attribution has a box").not.toBeNull();

    const overlaps =
      button!.x < credit!.x + credit!.width &&
      credit!.x < button!.x + button!.width &&
      button!.y < credit!.y + credit!.height &&
      credit!.y < button!.y + button!.height;
    expect(
      overlaps,
      `recentre at ${button!.x},${button!.y} ${button!.width}x${button!.height} against ` +
        `attribution at ${credit!.x},${credit!.y} ${credit!.width}x${credit!.height}`,
    ).toBe(false);
  });

  /*
   * And the zoom controls, now that the button is on their side of the map.
   *
   * It was moved to the bottom left because the attribution's height varies with the viewport and
   * clearing it by a fixed number of pixels had been wrong twice — at phone the deployed
   * accessibility pass measured only 44px by 21.5px of the button as reachable. The corner is
   * free, and this is what keeps it free: MapLibre's zoom controls are top left, so on a short
   * map they are the other thing that could end up underneath.
   */
  test("does not cover the zoom controls", async ({ page }) => {
    await openLive(page, "/live");

    const control = page.locator(".live-map__recentre");
    const zoom = page.locator(".maplibregl-ctrl-top-left").first();
    await expect(control).toBeVisible();

    const button = await control.boundingBox();
    const controls = await zoom.boundingBox();
    expect(button, "the recentre control has a box").not.toBeNull();
    expect(controls, "the zoom controls have a box").not.toBeNull();

    const overlaps =
      button!.x < controls!.x + controls!.width &&
      controls!.x < button!.x + button!.width &&
      button!.y < controls!.y + controls!.height &&
      controls!.y < button!.y + button!.height;
    expect(
      overlaps,
      `recentre at ${button!.x},${button!.y} ${button!.width}x${button!.height} against ` +
        `zoom at ${controls!.x},${controls!.y} ${controls!.width}x${controls!.height}`,
    ).toBe(false);
  });

  test("buses stay tappable with the dot on the map", async ({ page }) => {
    await openLive(page, "/live");
    expect(await paintedBuses(page), "buses painted alongside the dot").toBeGreaterThan(0);
  });
});

test.describe("with location refused", () => {
  // No `permissions` granted, which is how Chromium models a refusal.
  test.use({ permissions: [] });

  test("keeps a usable map and says location is unavailable", async ({ page }) => {
    await openLive(page, "/live");

    // The map is not replaced by an error, and the search route out of it is right there.
    await expect(page.locator(".live-map__canvas")).toBeVisible();
    await expect(page.getByRole("link", { name: /search instead/i })).toBeVisible();
    await expect(
      page.getByText(/location permission is not available|cannot share your location/i),
    ).toBeVisible();

    // Nothing is drawn for a passenger whose position we do not have.
    expect(await painted(page, ["user-dot"])).toBe(0);

    // And the stops for the fallback viewport still arrive, at whatever scale this width draws them.
    expect(await paintedStops(page), "the fallback viewport still loads").toBeGreaterThan(0);
  });
});
