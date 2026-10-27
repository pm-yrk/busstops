import type { MapStopSummary, MapVehicleSummary } from "@busstops/contracts";
import { accuracyRing, type LatLon } from "../lib/geo.js";

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
       * By identity where we have it, and by the number on the front where we do not.
       *
       * This used to be identity or nothing, and the reason was sound: "36" is a number several
       * operators put on the front of a bus, so emphasising by it emphasises all of them. That is
       * still true and it is still the first test below — a bus whose service we know, and know
       * to be a different one, stays context however its number reads.
       *
       * What changed is the price of knowing. `routeId` came from matching the bus against the
       * viewport's pattern geometry, and a dense city's pattern tiles reach three mebibytes:
       * Cloudflare measured `/v1/map` at a p95 of 56 ms against a ten-millisecond limit with that
       * read in the path, and it fired whenever any operator in the viewport omitted a line name.
       * So the Worker no longer reads it, every bus on the map now arrives unidentified, and
       * identity-or-nothing would draw a selected route with no buses on it at all.
       *
       * The cost of this is stated rather than hidden: in a viewport holding two different 36s,
       * both are emphasised. That is a worse answer than identity and a much better one than an
       * empty road.
       */
      if (vehicle.routeId !== null) return vehicle.routeId === intent.routeId ? 1 : 0;
      return intent.routePublicName !== null && vehicle.routePublicName === intent.routePublicName
        ? 1
        : 0;
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
  /*
   * Two degradations mean the same thing to a passenger, and only one of them was handled.
   *
   * `scheduled_only` is every live source down; `partial_sources` is at least one of them having
   * failed for this request — which is what the Worker reports when the map's live read runs out
   * of budget in a dense viewport, because the live stage gets whatever the stop read left it.
   * Reading only the first meant a viewport whose feed we never managed to ask was told "There
   * are no live buses in this area at the moment": a statement about the bus service, made out of
   * a failure of ours, in the two cities where it was measured.
   */
  if (degradation === "scheduled_only" || degradation === "partial_sources") {
    return "feed_unavailable";
  }
  return "none_reported";
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

/* ---- the passenger's own position ---------------------------------------- */

/**
 * Where a tap can land.
 *
 * Named here rather than written into the loops in `MapView`, so "which layers are things you can
 * open" is a list one can read and assert against. The user's own dot is deliberately not in any
 * of them: it is not a bus and not a stop, and a tap on it should fall through to whatever is
 * underneath rather than opening a panel about the passenger.
 */
export const CLICKABLE_LAYERS = {
  stops: ["stop-flags", "stop-pips"],
  vehicles: ["vehicle-buses", "vehicle-pips"],
  clusters: ["stop-clusters", "vehicle-clusters"],
} as const;

/** The layers that draw the passenger. Never clickable, never clustered, never red. */
export const USER_LAYERS = ["user-accuracy", "user-dot"] as const;

export interface UserFeatureProperties {
  kind: "dot" | "accuracy";
}

/**
 * Its own feature and collection types rather than the `FeatureCollection<P>` above, because this
 * is the one source here that is not all points: the halo is a polygon, and widening the shared
 * type to admit polygons would let a stop be published as one.
 */
export type UserFeature = {
  type: "Feature";
  properties: UserFeatureProperties;
  geometry:
    | { type: "Point"; coordinates: [number, number] }
    | { type: "Polygon"; coordinates: [number, number][][] };
};

export interface UserFeatureCollection {
  type: "FeatureCollection";
  features: UserFeature[];
}

/**
 * The dot, and the ground the browser thinks we might be on.
 *
 * Two features from one position, in one source, so a position update is a single `setData`. The
 * halo is a polygon rather than a pixel circle because an accuracy of forty metres has to still
 * mean forty metres after a zoom — see `accuracyRing`, which also decides when there is nothing
 * honest to draw and returns null.
 *
 * Empty when there is no position, which is every case where location is unknown: not asked,
 * refused, unsupported, or asked and unanswered. The map is identical in all of them.
 */
export function userFeatures(
  location: { coordinate: LatLon; accuracyMetres: number | null } | null,
): UserFeatureCollection {
  const features: UserFeature[] = [];
  if (location) {
    const ring = accuracyRing(location.coordinate, location.accuracyMetres);
    if (ring) {
      features.push({
        type: "Feature",
        properties: { kind: "accuracy" },
        geometry: { type: "Polygon", coordinates: [ring] },
      });
    }
    features.push({
      type: "Feature",
      properties: { kind: "dot" },
      geometry: {
        type: "Point",
        coordinates: [location.coordinate.lon, location.coordinate.lat],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * The dot's accessible label.
 *
 * It is painted on a canvas, so there is no element to hang an `aria-label` on and this sentence
 * is the whole of its accessible representation. Phrased as a fact about the map rather than as a
 * marker name, because that is what it is useful to hear: not "there is a blue dot" but "the map
 * knows where you are, and the things listed below are around you".
 *
 * Empty string, not a sentence saying location is unknown: a screen reader user who has refused
 * permission does not need the map to mention it every time the viewport changes, and the page
 * says it once in its own notice.
 */
export function describeUserLocation(hasLocation: boolean): string {
  return hasLocation ? " Your location is shown on the map." : "";
}

/* ---- the selected bus's route and trail ---------------------------------- */

/**
 * Decoration, in the literal sense: these layers are drawn and never asked about.
 *
 * A route line is wide — eight pixels at street zoom — and it runs under every bus and stop on it.
 * If MapLibre were allowed to answer a click with one of these, every tap along a selected route
 * would hit the line instead of the thing the passenger aimed at. No handler is registered for
 * them, and `queryRenderedFeatures` only reaches layers that asked, so a tap falls through to the
 * markers above.
 */
export const SELECTED_VEHICLE_LAYERS = [
  "route-travelled",
  "route-ahead",
  "trail-observed",
  "route-upcoming-stops",
  "route-destination",
] as const;

export interface SelectedVehicleOverlay {
  /** The part of the scheduled shape the bus still has to travel. */
  remaining: readonly LatLon[];
  /** The part it has already covered, drawn heavily subdued. */
  travelled: readonly LatLon[];
  /**
   * Where it has actually been, as separate runs.
   *
   * Segments rather than one line: a feed that drops out for ten minutes, or reports a position on
   * the wrong side of the city, must not be joined up into a confident path the bus never took.
   */
  trail: readonly (readonly LatLon[])[];
  /** Upcoming stops along the remaining route, nearest first. */
  upcoming: readonly { coordinate: LatLon; name: string }[];
  /** The last stop of the matched pattern, distinguished from the rest. */
  destination: { coordinate: LatLon; name: string } | null;
}

export type OverlayFeature = {
  type: "Feature";
  properties: { kind: "remaining" | "travelled" | "trail" | "upcoming" | "next" | "destination" };
  geometry:
    | { type: "Point"; coordinates: [number, number] }
    | { type: "LineString"; coordinates: [number, number][] };
};

export interface OverlayFeatureCollection {
  type: "FeatureCollection";
  features: OverlayFeature[];
}

const asPair = (point: LatLon): [number, number] => [point.lon, point.lat];

/**
 * The selected bus's route, trail and stops as one source.
 *
 * One source and one `setData` per selection, with the layers filtering on `kind`: selecting a
 * different bus replaces the whole collection, which is what makes "bus B cleanly replaces bus A"
 * a property of the data rather than of remembering to tear things down.
 *
 * A line needs two points to be a line. One-point runs are dropped rather than drawn, because a
 * single observation is a position and not a path — which is also why a bus with one observation
 * gets no trail at all rather than a trail invented from its schedule.
 */
export function selectedVehicleFeatures(
  overlay: SelectedVehicleOverlay | null,
): OverlayFeatureCollection {
  const features: OverlayFeature[] = [];
  if (!overlay) return { type: "FeatureCollection", features };

  const line = (points: readonly LatLon[], kind: OverlayFeature["properties"]["kind"]) => {
    if (points.length < 2) return;
    features.push({
      type: "Feature",
      properties: { kind },
      geometry: { type: "LineString", coordinates: points.map(asPair) },
    });
  };

  line(overlay.travelled, "travelled");
  line(overlay.remaining, "remaining");
  for (const run of overlay.trail) line(run, "trail");

  overlay.upcoming.forEach((stop, index) => {
    features.push({
      type: "Feature",
      // The first one is the stop the bus is heading for, which is the one worth emphasising.
      properties: { kind: index === 0 ? "next" : "upcoming" },
      geometry: { type: "Point", coordinates: asPair(stop.coordinate) },
    });
  });

  if (overlay.destination) {
    features.push({
      type: "Feature",
      properties: { kind: "destination" },
      geometry: { type: "Point", coordinates: asPair(overlay.destination.coordinate) },
    });
  }

  return { type: "FeatureCollection", features };
}
