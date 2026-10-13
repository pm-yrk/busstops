import type { MapStopSummary, MapVehicleSummary } from "@busstops/contracts";

/**
 * What the live map shows at each zoom, and what it is for.
 *
 * Three hundred pixel buses on one screen is not a map of a city's buses; it is a texture. The
 * question a passenger asks changes with how much ground is on screen, so the answer does too:
 *
 * - **City.** How much is moving, and where is it busy? Clusters carrying real counts.
 * - **Neighbourhood.** Which way is everything going? Small directional marks, no labels.
 * - **Street.** Which bus is that, and when does mine come? The drawings, with route numbers.
 *
 * The thresholds are here rather than inside the component so they can be reasoned about and
 * tested without a WebGL context, and so the list under the map can describe the same thing the
 * map is drawing.
 */

export const ZOOM = {
  /** Below this, everything is clustered. */
  neighbourhood: 12,
  /** At and above this, individual vehicles are drawn as buses with their route numbers. */
  street: 14.5,
} as const;

export type MapScale = "city" | "neighbourhood" | "street";

export function scaleForZoom(zoom: number): MapScale {
  if (zoom < ZOOM.neighbourhood) return "city";
  if (zoom < ZOOM.street) return "neighbourhood";
  return "street";
}

/**
 * What the map is being used for, which decides what is emphasised rather than what is loaded.
 *
 * A selected route does not mean the other buses stop existing — a passenger looking at the 36
 * still wants to see that the road is busy — so the others stay, dimmed. Hiding them would be the
 * map telling a lie about the street to make a point about one service.
 */
export type MapIntent =
  | { kind: "explore" }
  /*
   * A route is identified by its published service id, not by the number on the front.
   *
   * These were the same field, and they are not the same thing: several operators run a 36, so
   * emphasising "the 36" emphasised all of them. The public name is carried alongside because a
   * stop only knows which route *numbers* call at it — that is all the map response gives — so
   * the vehicles are matched exactly and the stops as closely as the data allows.
   */
  | { kind: "route"; routeId: string; routePublicName: string | null }
  | { kind: "stop"; atcoCode: string }
  | { kind: "journey"; stopIds: readonly string[] };

export interface StopFeatureProperties {
  atcoCode: string;
  name: string;
  indicator: string | null;
  routes: string;
  emphasis: number;
  /**
   * 1 when this is the stop whose board is open.
   *
   * Distinct from `emphasis`, which answers a different question. Exploring with nothing chosen
   * emphasises every stop — that is what "no filter" means — so a ring drawn on emphasis would
   * ring four hundred stops at once. Selection is one stop or none.
   */
  selected: number;
}

export interface VehicleFeatureProperties {
  vehicleRef: string;
  route: string;
  /** The published service, or an empty string when this viewport could not identify it. */
  routeId: string;
  destination: string;
  bearing: number | null;
  stale: boolean;
  emphasis: number;
  /** 1 when this is the bus whose panel is open, which the layers draw differently. */
  selected: number;
}

type Feature<P> = {
  type: "Feature";
  id?: number;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: P;
};

export interface FeatureCollection<P> {
  type: "FeatureCollection";
  features: Feature<P>[];
}

/** 1 when this stop is what the user is looking at, 0 when it is context. */
function stopEmphasis(stop: MapStopSummary, intent: MapIntent, selectedId: string | null): number {
  /*
   * A selection settles it for every stop, not just for the selected one.
   *
   * Returning early only for the match left every *other* stop falling through to the explore
   * case, which emphasises everything — so selecting a stop emphasised it and the four hundred
   * around it equally, which is the same as emphasising nothing.
   */
  if (selectedId !== null) return stop.atcoCode === selectedId ? 1 : 0;

  switch (intent.kind) {
    case "stop":
      return stop.atcoCode === intent.atcoCode ? 1 : 0;
    case "route":
      return intent.routePublicName !== null &&
        stop.routePublicNames.includes(intent.routePublicName)
        ? 1
        : 0;
    case "journey":
      return intent.stopIds.includes(stop.id) ? 1 : 0;
    case "explore":
      return 1;
  }
}

function vehicleEmphasis(
  vehicle: MapVehicleSummary,
  intent: MapIntent,
  selectedRef: string | null,
): number {
  // A selected bus is the thing on screen; everything else is the street it is on.
  if (selectedRef !== null) return vehicle.vehicleRef === selectedRef ? 1 : 0;

  switch (intent.kind) {
    case "route":
      /*
       * By identity where we have it, and never by name alone.
       *
       * `routeId` is null when the viewport's patterns could not say which service a bus is on.
       * Falling back to the public name there would emphasise every operator's 36 — which is the
       * bug this pair of fields exists to stop — so an unidentified bus stays context.
       */
      return vehicle.routeId !== null && vehicle.routeId === intent.routeId ? 1 : 0;
    case "stop":
    case "journey":
    case "explore":
      return 1;
  }
}

export function stopFeatures(
  stops: readonly MapStopSummary[],
  intent: MapIntent,
  selectedId: string | null,
): FeatureCollection<StopFeatureProperties> {
  return {
    type: "FeatureCollection",
    features: stops.map((stop, index) => ({
      type: "Feature",
      id: index,
      geometry: { type: "Point", coordinates: [stop.coordinate.lon, stop.coordinate.lat] },
      properties: {
        atcoCode: stop.atcoCode,
        name: stop.name,
        indicator: stop.indicator ?? null,
        // Joined rather than nested: MapLibre feature properties are flat, and a label wants a
        // string anyway. Sorted upstream, so this is stable between refreshes.
        routes: stop.routePublicNames.join(" "),
        emphasis: stopEmphasis(stop, intent, selectedId),
        selected: selectedId !== null && stop.atcoCode === selectedId ? 1 : 0,
      },
    })),
  };
}

export function vehicleFeatures(
  vehicles: readonly MapVehicleSummary[],
  intent: MapIntent,
  selectedRef: string | null = null,
): FeatureCollection<VehicleFeatureProperties> {
  return {
    type: "FeatureCollection",
    features: vehicles.map((vehicle, index) => ({
      type: "Feature",
      id: index,
      geometry: { type: "Point", coordinates: [vehicle.coordinate.lon, vehicle.coordinate.lat] },
      properties: {
        vehicleRef: vehicle.vehicleRef,
        route: vehicle.routePublicName ?? "",
        routeId: vehicle.routeId ?? "",
        destination: vehicle.destinationName ?? "",
        bearing: vehicle.bearingDegrees,
        // A stale position is a different drawing, never the same one faded: colour alone is
        // never the signal.
        stale: vehicle.freshnessSeconds > 180,
        emphasis: vehicleEmphasis(vehicle, intent, selectedRef),
        selected: vehicle.vehicleRef === selectedRef ? 1 : 0,
      },
    })),
  };
}

/**
 * What the map is showing, in words, for the line under it and for a screen reader.
 *
 * The map is a canvas: there is nothing in it for anyone who cannot see it, and clusters make that
 * worse rather than better because even the counts are painted. This sentence is the map's
 * content, and it says the same numbers the clusters do.
 */
export function describeView(
  scale: MapScale,
  stops: number,
  vehicles: number,
  degraded: boolean,
): string {
  const buses =
    vehicles === 0
      ? "no buses are being reported here at the moment"
      : `${vehicles} ${vehicles === 1 ? "bus" : "buses"}`;
  const where =
    scale === "city"
      ? "grouped into clusters because the whole city is on screen"
      : scale === "neighbourhood"
        ? "shown as small marks pointing the way each one is going"
        : "drawn individually with their route numbers";
  const caveat = degraded
    ? " Some stops are missing their route numbers: the timetable lookup ran out of time for this screen, so what is missing is the labelling rather than the stops."
    : "";
  return `${stops} ${stops === 1 ? "stop" : "stops"} and ${buses}, ${where}.${caveat}`;
}

/**
 * Why this viewport has no buses on it, when it has none.
 *
 * "There are no live buses here at the moment, try panning" is true over Leeds at four in the
 * morning and false over London at any hour: TfL publishes arrival predictions and does not
 * publish vehicle positions at all, so panning around Westminster will never produce a bus. The
 * map knowing that is the difference between an empty screen that is working and one that looks
 * broken.
 *
 * The viewport is identified as London from the sources the response actually consulted rather
 * than from a bounding box held twice — the Worker already decided which feeds cover this screen,
 * and it is the only thing that knows.
 */
export type EmptyVehicleReason = "london_has_no_positions" | "feed_unavailable" | "none_reported";

export function emptyVehicleReason(
  sources: readonly { source: string; coverageArea: string }[],
  degradation: string,
): EmptyVehicleReason {
  if (sources.length > 0 && sources.every((source) => source.coverageArea === "london")) {
    return "london_has_no_positions";
  }
  return degradation === "scheduled_only" ? "feed_unavailable" : "none_reported";
}

export function describeEmptyVehicles(reason: EmptyVehicleReason): string {
  switch (reason) {
    case "london_has_no_positions":
      return (
        "This is London, where Transport for London publishes when each bus will arrive rather " +
        "than where it is now. There is nothing to draw on the map, and the stops below carry " +
        "live arrival predictions rather than a timetable."
      );
    case "feed_unavailable":
      return "Live vehicle positions are unavailable right now. Stops and timetables below still work.";
    case "none_reported":
      return "There are no live buses in this area at the moment. Try panning, or check the stops below.";
  }
}
