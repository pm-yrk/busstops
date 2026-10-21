import { describe, expect, it } from "vitest";
import type { MapStopSummary, MapVehicleSummary } from "@busstops/contracts";
import {
  CLICKABLE_LAYERS,
  SELECTED_VEHICLE_LAYERS,
  USER_LAYERS,
  ZOOM,
  describeEmptyVehicles,
  describeUserLocation,
  describeView,
  emptyVehicleReason,
  scaleForZoom,
  selectedVehicleFeatures,
  stopFeatures,
  userFeatures,
  vehicleFeatures,
} from "./mapLayers.js";
import { basemapFontStack } from "./MapView.js";

/*
 * The live map's semantic zoom.
 *
 * Three hundred pixel buses on one screen is a texture, not a map. What is drawn depends on how
 * much ground is on screen, because the question a passenger is asking changes with it. These
 * cover the rules rather than the rendering: a WebGL context proves nothing about whether the
 * counts are honest, and the counts are the part that must not be invented.
 */

const stop = (over: Partial<MapStopSummary> = {}): MapStopSummary => ({
  id: "stop-1",
  atcoCode: "450010001",
  name: "Leeds City Bus Station",
  coordinate: { lat: 53.796, lon: -1.541 },
  routePublicNames: ["36", "X84"],
  hasLiveCoverage: true,
  ...over,
});

const bus = (over: Partial<MapVehicleSummary> = {}): MapVehicleSummary =>
  ({
    vehicleRef: "v1",
    coordinate: { lat: 53.797, lon: -1.542 },
    routePublicName: "36",
    routeId: "svc-36",
    routePatternId: "pattern-36",
    destinationName: "Ripon",
    bearingDegrees: 90,
    freshnessSeconds: 20,
    motionState: "moving",
    ...over,
  }) as MapVehicleSummary;

describe("what the map draws at each zoom", () => {
  it("groups a city, points a neighbourhood, and draws a street", () => {
    expect(scaleForZoom(9)).toBe("city");
    expect(scaleForZoom(ZOOM.neighbourhood - 0.1)).toBe("city");
    expect(scaleForZoom(ZOOM.neighbourhood)).toBe("neighbourhood");
    expect(scaleForZoom(ZOOM.street - 0.1)).toBe("neighbourhood");
    expect(scaleForZoom(ZOOM.street)).toBe("street");
    expect(scaleForZoom(18)).toBe("street");
  });

  it("never drops a bus in order to draw fewer of them", () => {
    // Clustering is a way of showing three hundred buses, not a way of showing thirty. Every
    // vehicle the API returned becomes a feature; the layers decide how it is painted.
    const buses = Array.from({ length: 300 }, (_, i) => bus({ vehicleRef: `v${i}` }));
    expect(vehicleFeatures(buses, { kind: "explore" }).features).toHaveLength(300);
  });
});

describe("what the map emphasises", () => {
  it("keeps the rest of the street when one route is selected", () => {
    const features = vehicleFeatures(
      [
        bus({ routePublicName: "36", routeId: "svc-36" }),
        bus({ routePublicName: "1", routeId: "svc-1" }),
      ],
      { kind: "route", routeId: "svc-36", routePublicName: "36" },
    );
    // Both are still there — a passenger looking at the 36 still wants to see the road is busy.
    expect(features.features).toHaveLength(2);
    expect(features.features.map((f) => f.properties.emphasis)).toEqual([1, 0]);
  });

  /*
   * The bug this pair of fields exists to stop.
   *
   * "36" is a number several operators put on the front of a bus. Emphasising by it emphasised
   * every 36 in the viewport, and a link built from it opened somebody else's route page.
   */
  it("does not emphasise another operator's bus with the same number on the front", () => {
    const features = vehicleFeatures(
      [
        bus({ vehicleRef: "mine", routePublicName: "36", routeId: "svc-36" }),
        bus({ vehicleRef: "theirs", routePublicName: "36", routeId: "svc-other-36" }),
      ],
      { kind: "route", routeId: "svc-36", routePublicName: "36" },
    );
    expect(features.features.map((f) => f.properties.emphasis)).toEqual([1, 0]);
  });

  it("leaves a bus we could not identify as context rather than guessing by its number", () => {
    const features = vehicleFeatures([bus({ routePublicName: "36", routeId: null })], {
      kind: "route",
      routeId: "svc-36",
      routePublicName: "36",
    });
    expect(features.features[0]!.properties.emphasis).toBe(0);
    expect(features.features[0]!.properties.routeId).toBe("");
  });

  it("emphasises the selected bus and no other, whatever the intent was", () => {
    const features = vehicleFeatures(
      [bus({ vehicleRef: "a" }), bus({ vehicleRef: "b" })],
      { kind: "explore" },
      "b",
    );
    expect(features.features.map((f) => f.properties.emphasis)).toEqual([0, 1]);
    expect(features.features.map((f) => f.properties.selected)).toEqual([0, 1]);
  });

  it("emphasises the selected stop and no other", () => {
    const features = stopFeatures(
      [stop({ atcoCode: "A" }), stop({ atcoCode: "B" })],
      { kind: "explore" },
      "A",
    );
    expect(features.features.map((f) => f.properties.emphasis)).toEqual([1, 0]);
    expect(features.features.map((f) => f.properties.selected)).toEqual([1, 0]);
  });

  /*
   * The ring layer draws on `selected`, and this is why it cannot draw on `emphasis`: exploring
   * with nothing chosen emphasises every stop, so a ring on emphasis would ring the whole screen.
   */
  it("selects no stop at all when nothing is selected, though it emphasises them all", () => {
    const features = stopFeatures(
      [stop({ atcoCode: "A" }), stop({ atcoCode: "B" })],
      { kind: "explore" },
      null,
    );
    expect(features.features.map((f) => f.properties.emphasis)).toEqual([1, 1]);
    expect(features.features.map((f) => f.properties.selected)).toEqual([0, 0]);
  });

  it("emphasises the stops on a journey", () => {
    const features = stopFeatures(
      [stop({ id: "s1" }), stop({ id: "s2" })],
      { kind: "journey", stopIds: ["s2"] },
      null,
    );
    expect(features.features.map((f) => f.properties.emphasis)).toEqual([0, 1]);
  });

  it("marks an old position as stale rather than fading the same drawing", () => {
    const fresh = vehicleFeatures([bus({ freshnessSeconds: 20 })], { kind: "explore" });
    const old = vehicleFeatures([bus({ freshnessSeconds: 400 })], { kind: "explore" });
    expect(fresh.features[0]!.properties.stale).toBe(false);
    expect(old.features[0]!.properties.stale).toBe(true);
  });
});

describe("what the map says it is showing", () => {
  /*
   * The map is a canvas: there is nothing in it for anyone who cannot see it, and clusters make
   * that worse rather than better, because even the counts are painted.
   */
  it("says the same numbers the clusters do", () => {
    const sentence = describeView("city", 412, 34, false);
    expect(sentence).toContain("412 stops");
    expect(sentence).toContain("34 buses");
    expect(sentence).toContain("clusters");
  });

  it("says when there is nothing rather than implying an empty street", () => {
    expect(describeView("street", 12, 0, false)).toContain("no buses are being reported");
  });

  it("says what is missing when the route names did not arrive", () => {
    const sentence = describeView("street", 12, 4, true);
    expect(sentence).toContain("missing their route numbers");
    // And says what that does *not* mean, because "no routes" would be a claim about the stop.
    expect(sentence).toContain("rather than the stops");
  });

  it("counts one stop and one bus in the singular", () => {
    const sentence = describeView("street", 1, 1, false);
    expect(sentence).toContain("1 stop ");
    expect(sentence).toContain("1 bus,");
  });
});

describe("why a viewport has no buses on it", () => {
  const tfl = { source: "tfl", coverageArea: "london" };
  const bods = { source: "bods", coverageArea: "non_london" };

  it("names London's actual reason rather than suggesting the passenger pans", () => {
    expect(emptyVehicleReason([tfl], "none")).toBe("london_has_no_positions");
    const sentence = describeEmptyVehicles("london_has_no_positions");
    expect(sentence).toContain("when each bus will arrive rather than where it is now");
    // The advice that is true elsewhere and false here.
    expect(sentence).not.toContain("Try panning");
  });

  it("does not claim London when the viewport also reaches beyond it", () => {
    expect(emptyVehicleReason([tfl, bods], "none")).toBe("none_reported");
  });

  it("still reports a failed feed as a failed feed", () => {
    expect(emptyVehicleReason([bods], "scheduled_only")).toBe("feed_unavailable");
    expect(describeEmptyVehicles("feed_unavailable")).toContain("unavailable right now");
  });

  /*
   * Measured on the deployment: Manchester and Birmingham returned no vehicles while the upstream
   * had eight and nine plausible ones in the same box at the same minute. The Worker said so —
   * `partial_sources`, because the map's live read gets whatever the stop read leaves it and a
   * dense viewport leaves it 300ms — and this function read only `scheduled_only`, so the page
   * told the passenger there were no buses there.
   */
  it("treats one failed source as a failed feed, not as empty streets", () => {
    expect(emptyVehicleReason([bods], "partial_sources")).toBe("feed_unavailable");
  });

  /* London still wins: it has no positions to publish whatever else happened to the request. */
  it("keeps London's own reason when a source also failed", () => {
    expect(emptyVehicleReason([tfl], "partial_sources")).toBe("london_has_no_positions");
  });

  it("falls back to the ordinary answer when no source is named", () => {
    expect(emptyVehicleReason([], "none")).toBe("none_reported");
    expect(describeEmptyVehicles("none_reported")).toContain("Try panning");
  });
});

describe("the font the map draws its text with", () => {
  /**
   * A minimal stand-in for MapLibre's map: `basemapFontStack` reads one thing off it.
   */
  const mapWith = (layers: unknown[]) =>
    ({ getStyle: () => ({ layers }) }) as unknown as Parameters<typeof basemapFontStack>[0];

  it("borrows the stack the basemap's own labels already use", () => {
    expect(
      basemapFontStack(
        mapWith([
          { id: "ground", type: "background" },
          { id: "roads", type: "line" },
          { id: "place-labels", type: "symbol", layout: { "text-font": ["Noto Sans Regular"] } },
        ]),
      ),
    ).toEqual(["Noto Sans Regular"]);
  });

  /*
   * The whole defect: MapLibre asks for its *default* stack when a symbol layer names none, the
   * basemap 404s, and the layer draws nothing at all — silently, while the list beside it is
   * full. Where there is no stack to borrow, the text is omitted rather than requested.
   */
  it("reports none when the style has no symbol layer to borrow from", () => {
    expect(basemapFontStack(mapWith([{ id: "ground", type: "background" }]))).toBeNull();
  });

  it("reports none rather than throwing when the style cannot be read at all", () => {
    const broken = {
      getStyle: () => {
        throw new Error("style not loaded");
      },
    } as unknown as Parameters<typeof basemapFontStack>[0];
    expect(basemapFontStack(broken)).toBeNull();
  });

  it("ignores a symbol layer whose font is not a list of names", () => {
    expect(
      basemapFontStack(
        mapWith([
          { id: "odd", type: "symbol", layout: { "text-font": ["get", "font"] as unknown } },
          { id: "labels", type: "symbol", layout: { "text-font": ["Open Sans Regular"] } },
        ]),
      ),
    ).toEqual(["Open Sans Regular"]);
  });
});

/*
 * "You are here", as the two features that draw it.
 *
 * Asserted here rather than through the renderer for the same reason the stop and bus builders are:
 * jsdom has no WebGL, so a component test of the canvas proves nothing — and what matters about
 * this marker is not that a dot appeared but that the halo tells the truth about accuracy and
 * disappears when it cannot.
 */
describe("the passenger's own position on the map", () => {
  const here = { lat: 53.7965, lon: -1.5478 };

  it("draws nothing at all when there is no position", () => {
    // Not asked, refused, unsupported, timed out: one state on the map, which is no dot.
    expect(userFeatures(null).features).toEqual([]);
  });

  it("draws the dot where the browser says we are", () => {
    const { features } = userFeatures({ coordinate: here, accuracyMetres: null });
    const dot = features.find((feature) => feature.properties.kind === "dot");
    expect(dot).toBeDefined();
    expect(dot!.geometry).toEqual({ type: "Point", coordinates: [-1.5478, 53.7965] });
  });

  it("omits the halo when the browser gave no accuracy", () => {
    const { features } = userFeatures({ coordinate: here, accuracyMetres: null });
    expect(features.map((feature) => feature.properties.kind)).toEqual(["dot"]);
  });

  it("draws a halo on the ground, not in pixels, when accuracy is known", () => {
    const { features } = userFeatures({ coordinate: here, accuracyMetres: 40 });
    const halo = features.find((feature) => feature.properties.kind === "accuracy");
    expect(halo).toBeDefined();
    expect(halo!.geometry.type).toBe("Polygon");

    const ring = (halo!.geometry as { coordinates: [number, number][][] }).coordinates[0]!;
    // A linear ring is explicitly closed, or MapLibre will not fill it.
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // Forty metres, in degrees of latitude, is small and non-zero — the halo is a circle on the
    // ground rather than a fixed blob, which is the whole reason it is a polygon.
    const northmost = Math.max(...ring.map(([, lat]) => lat));
    expect(northmost - here.lat).toBeGreaterThan(0.0002);
    expect(northmost - here.lat).toBeLessThan(0.0007);
  });

  /*
   * A browser that has fallen back to an IP lookup reports tens of kilometres. Drawn honestly that
   * is a blue tint over the whole screen, which says nothing except that the map has broken.
   */
  it("omits the halo rather than tinting the screen when accuracy is hopeless", () => {
    const { features } = userFeatures({ coordinate: here, accuracyMetres: 45_000 });
    expect(features.map((feature) => feature.properties.kind)).toEqual(["dot"]);
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("omits the halo when accuracy is %s", (_why, accuracyMetres) => {
    const { features } = userFeatures({ coordinate: here, accuracyMetres });
    expect(features.map((feature) => feature.properties.kind)).toEqual(["dot"]);
  });

  /* The dot is drawn after the halo, so it is never under its own translucent disc. */
  it("puts the dot after the halo", () => {
    const { features } = userFeatures({ coordinate: here, accuracyMetres: 40 });
    expect(features.map((feature) => feature.properties.kind)).toEqual(["accuracy", "dot"]);
  });

  it("is announced when it is known, and silent when it is not", () => {
    expect(describeUserLocation(true)).toContain("Your location");
    expect(describeUserLocation(false)).toBe("");
  });

  /*
   * Not a bus and not a stop.
   *
   * A tap on the dot must fall through to whatever is underneath rather than opening a panel about
   * the passenger, and MapLibre only reaches layers a handler was registered for — so the
   * invariant is that these ids appear in no clickable list.
   */
  it("is not clickable as though it were a bus or a stop", () => {
    const clickable = Object.values(CLICKABLE_LAYERS).flat();
    for (const layer of USER_LAYERS) {
      expect(clickable).not.toContain(layer);
    }
  });

  it("is drawn by its own layers, distinct from every clickable one", () => {
    // Distinct ids as well as distinct colours: the halo and the dot share nothing with the
    // stop and vehicle layers, so a change to either cannot silently restyle the other.
    expect(new Set(USER_LAYERS).size).toBe(USER_LAYERS.length);
    expect(Object.values(CLICKABLE_LAYERS).flat()).not.toContain("user-dot");
  });
});

/*
 * The selected bus's route, trail and stops, as the features that draw them.
 *
 * One source for all of it, so selecting a different bus is a single `setData` and the previous
 * bus's route cannot survive it — "bus B replaces bus A" is then a property of the data rather
 * than of remembering to tear something down.
 */
describe("the selected bus's route overlay", () => {
  const line = (count: number, from = 53.79) =>
    Array.from({ length: count }, (_, index) => ({ lat: from + index * 0.009, lon: -1.55 }));

  const overlay = (patch: Record<string, unknown> = {}) => ({
    remaining: line(3),
    travelled: line(2, 53.77),
    trail: [line(3, 53.76)],
    upcoming: [
      { coordinate: { lat: 53.8, lon: -1.55 }, name: "Boar Lane" },
      { coordinate: { lat: 53.81, lon: -1.55 }, name: "City Square" },
    ],
    destination: { coordinate: { lat: 53.82, lon: -1.55 }, name: "Bradford Interchange" },
    ...patch,
  });

  const kinds = (collection: { features: Array<{ properties: { kind: string } }> }) =>
    collection.features.map((feature) => feature.properties.kind);

  it("draws nothing at all when no bus is selected", () => {
    expect(selectedVehicleFeatures(null).features).toEqual([]);
  });

  it("carries the route ahead, the travelled part, the trail and the stops", () => {
    const features = selectedVehicleFeatures(overlay());
    expect(kinds(features)).toEqual([
      "travelled",
      "remaining",
      "trail",
      "next",
      "upcoming",
      "destination",
    ]);
  });

  /*
   * The route ahead is drawn after the travelled part and after the trail, so the answer to the
   * question the passenger tapped for is the line on top.
   */
  it("puts the route ahead over the path already taken", () => {
    const order = kinds(selectedVehicleFeatures(overlay()));
    expect(order.indexOf("remaining")).toBeGreaterThan(order.indexOf("travelled"));
  });

  it("marks the first upcoming stop as the next one", () => {
    const features = selectedVehicleFeatures(overlay());
    const next = features.features.filter((feature) => feature.properties.kind === "next");
    expect(next.length, "exactly one stop is the next one").toBe(1);
    expect(next[0]!.geometry).toEqual({ type: "Point", coordinates: [-1.55, 53.8] });
  });

  /* A line needs two points. One observation is a position, and one-point runs draw nothing. */
  it("drops a line that is a single point", () => {
    expect(kinds(selectedVehicleFeatures(overlay({ trail: [line(1)] })))).not.toContain("trail");
    expect(kinds(selectedVehicleFeatures(overlay({ remaining: line(1) })))).not.toContain(
      "remaining",
    );
  });

  it("keeps a broken trail as separate runs rather than joining them", () => {
    const features = selectedVehicleFeatures(overlay({ trail: [line(3, 53.7), line(3, 53.9)] }));
    const trails = features.features.filter((feature) => feature.properties.kind === "trail");
    expect(trails.length).toBe(2);
    // And no feature bridges the two: the gap on the map is the gap in what we saw.
    for (const trail of trails) {
      expect(trail.geometry.type).toBe("LineString");
    }
  });

  it("omits a destination that is not known", () => {
    expect(kinds(selectedVehicleFeatures(overlay({ destination: null })))).not.toContain(
      "destination",
    );
  });

  /*
   * The route line is the widest thing on the map and it runs under every bus and stop on it. If
   * MapLibre were allowed to answer a click with it, every tap along a selected route would hit
   * the line instead of the bus or the stop the passenger aimed at.
   */
  it("is map decoration: none of its layers can take a click", () => {
    const clickable = Object.values(CLICKABLE_LAYERS).flat();
    for (const layer of SELECTED_VEHICLE_LAYERS) {
      expect(clickable, `${layer} must not be clickable`).not.toContain(layer);
    }
  });

  it("shares no layer id with the stop, bus or location layers", () => {
    const others = [...Object.values(CLICKABLE_LAYERS).flat(), ...USER_LAYERS];
    for (const layer of SELECTED_VEHICLE_LAYERS) {
      expect(others).not.toContain(layer);
    }
  });
});
