import { describe, expect, it } from "vitest";
import type { MapStopSummary, MapVehicleSummary } from "@busstops/contracts";
import {
  ZOOM,
  describeEmptyVehicles,
  describeView,
  emptyVehicleReason,
  scaleForZoom,
  stopFeatures,
  vehicleFeatures,
} from "./mapLayers.js";

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

  it("falls back to the ordinary answer when no source is named", () => {
    expect(emptyVehicleReason([], "none")).toBe("none_reported");
    expect(describeEmptyVehicles("none_reported")).toContain("Try panning");
  });
});
