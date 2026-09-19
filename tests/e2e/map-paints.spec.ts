import { expect, test } from "@playwright/test";
import { MAP_WITH_TRAFFIC, mockApi } from "./fixtures.js";

/**
 * Every bus the API returned is on the map, at every scale.
 *
 * Run 51's sweep of the deployment reported `0 bus(es) painted ... the list says 155` at desktop,
 * tablet and phone, and the cause was one line: `vehicle-pips` drew its directional mark with
 * `"text-field": "▲"`. A symbol layer's text needs glyphs — the basemap has to serve a font, and
 * MapLibre asks for its default stack unless told otherwise — so on a style that does not serve
 * that stack the layer draws nothing at all, silently, while the list beside it is full.
 *
 * The style here has no glyphs whatsoever, which is the strongest version of that condition: a
 * map that paints its buses against this one cannot be depending on a font. Three scales, because
 * the bug lived in the middle one and both neighbours were fine.
 */
const GLYPHLESS_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "ground", type: "background", paint: { "background-color": "#eef1f2" } }],
};

for (const size of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`the map paints every bus the list counts at ${size.name}`, async ({ page }) => {
    await page.setViewportSize(size);
    /*
     * Hand the style to the page before its scripts run.
     *
     * The e2e build has no `VITE_MAP_STYLE_URL` on purpose — the other specs use the style-less
     * build to exercise the list-only fallback, and `art-bench` skips its marker section on the
     * same basis — so `MapView` would render that fallback here and there would be no renderer to
     * ask what was painted. That is why these twelve cases had been red in CI for weeks: not a
     * fault in the product, but a spec that could only ever pass against a real deployment.
     *
     * Injecting it rather than serving it at a URL also removes a moving part: no route, no
     * fetch, no 404 to reason about, and the style under test is right here in the file.
     */
    await page.addInitScript((style) => {
      (globalThis as { __busstopsMapStyle?: unknown }).__busstopsMapStyle = style;
    }, GLYPHLESS_STYLE);
    await mockApi(page, { "/v1/map": MAP_WITH_TRAFFIC });
    await page.goto("/live");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    const seen = await page.evaluate(() => {
      const instance = (globalThis as unknown as { __busstopsMap?: MapLikeForTest }).__busstopsMap;
      const count = (layers: string[], cluster: boolean) => {
        if (!instance) return 0;
        try {
          const features = instance.queryRenderedFeatures({ layers });
          return cluster
            ? features.reduce((n, f) => n + (Number(f.properties?.point_count) || 0), 0)
            : features.length;
        } catch {
          return 0;
        }
      };
      return {
        zoom: instance ? Math.round(instance.getZoom() * 10) / 10 : null,
        buses: count(["vehicle-buses", "vehicle-pips"], false) + count(["vehicle-clusters"], true),
        stops: count(["stop-flags", "stop-pips"], false) + count(["stop-clusters"], true),
        /*
         * The count sits beside the heading, not inside it.
         *
         * `PixelSectionHeading` puts the words in the `h2` and anything that belongs on its line —
         * a count, an age — in a sibling. Reaching for `#vehicles-heading .lozenge` found nothing
         * once that landed, and a test that reads zero buses in the list passes its first
         * assertion by failing to look. The row is what carries both.
         */
        listed: Number(
          document
            .querySelector(".pixel-heading:has(#vehicles-heading) .lozenge")
            ?.textContent?.trim() ?? "0",
        ),
      };
    });

    expect(seen.listed, "the list found buses to draw").toBeGreaterThan(0);
    expect(seen.buses, `buses painted at zoom ${String(seen.zoom)}`).toBe(seen.listed);
    expect(seen.stops, `stops painted at zoom ${String(seen.zoom)}`).toBeGreaterThan(0);
  });
}

/** The parts of MapLibre's map this test touches, so it needs no import from the bundle. */
interface MapLikeForTest {
  getZoom(): number;
  queryRenderedFeatures(options: { layers: string[] }): Array<{
    properties?: Record<string, unknown> | null;
  }>;
}
