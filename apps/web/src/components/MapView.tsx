import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import type { MapStopSummary, MapVehicleSummary } from "@busstops/contracts";
import type { Bounds, LatLon } from "../lib/geo.js";
import { MAP_ICONS, rasterise } from "./pixel/mapIcons.js";
import {
  CLICKABLE_LAYERS,
  ZOOM,
  describeUserLocation,
  describeView,
  scaleForZoom,
  selectedVehicleFeatures,
  stopFeatures,
  userFeatures,
  vehicleFeatures,
  type MapIntent,
  type MapScale,
  type SelectedVehicleOverlay,
} from "./mapLayers.js";
import "maplibre-gl/dist/maplibre-gl.css";
import "./MapView.css";

/**
 * MapLibre map surface.
 *
 * Base-map policy (docs/05_DATA_SOURCES.md, docs/13_FREE_TIER_RULES.md): the style URL is
 * configuration, never a hard-coded paid provider. When no style is configured the map does not
 * render at all and the caller's list view stands alone — that is deliberate. Silently falling
 * back to a third-party tile server would breach both the provider's usage policy and the rule
 * that production paths never quietly substitute something else.
 *
 * **Drawn in layers, not in markers.** Every stop and every bus used to be a DOM element: a
 * `<button>` or a `<div>` that the browser lays out, composites and moves on every frame of a
 * pan. A Leeds viewport holds five or six hundred of them. They are GeoJSON sources with
 * MapLibre layers over them now — the same artwork, uploaded once each as a texture, drawn by the
 * GPU however many there are.
 *
 * What is drawn depends on how much ground is on screen, because the question changes with it.
 * See mapLayers.ts: clusters with real counts over a city, directional marks over a
 * neighbourhood, and the buses themselves with their route numbers over a street.
 */

const SOURCES = {
  stops: "busstops-stops",
  vehicles: "busstops-vehicles",
  user: "busstops-user",
  selected: "busstops-selected-vehicle",
} as const;

export interface MapViewProps {
  bounds: Bounds;
  stops: readonly MapStopSummary[];
  vehicles: readonly MapVehicleSummary[];
  selectedStopId?: string | null;
  selectedVehicleRef?: string | null;
  onSelectStop?: (atcoCode: string) => void;
  /** A bus is a thing on the map, not decoration: clicking one opens it. */
  onSelectVehicle?: (vehicleRef: string) => void;
  onBoundsChange?: (bounds: Bounds, zoom: number) => void;
  /**
   * A deliberate camera move, as opposed to where the map happens to be.
   *
   * `bounds` is only read when the map is built, and nothing else moved it — so "Use my location"
   * refetched the data for a box the camera was not looking at, and `/live/stops/:stopId` opened
   * the board for a stop that was not on screen. Both looked like the map ignoring you.
   *
   * It cannot simply follow `bounds`: the map reports its own viewport back on every `moveend`,
   * so a synced prop would fight the user's panning in a loop. The nonce is what separates "the
   * page asked to go here" from "this is where the map ended up", and each one is applied once.
   */
  focus?: { bounds: Bounds; nonce: number } | null;
  showStops: boolean;
  showVehicles: boolean;
  /** What the map is being used for. Decides emphasis, never what is loaded. */
  intent?: MapIntent;
  /** True when the API said some stops are missing their route names. */
  degraded?: boolean;
  /**
   * Where the passenger is, when they have said we may know.
   *
   * Handed in rather than asked for: this component never calls `navigator.geolocation`. The
   * permission prompt is something that happens to a person and it belongs with the page that
   * knows why it is being asked for — see `useCurrentLocation`. All this does is draw a dot.
   *
   * Null covers every case where there is nothing to draw: not asked, refused, unsupported, or
   * asked and not answered. The map is identical in all of them.
   */
  userLocation?: { coordinate: LatLon; accuracyMetres: number | null } | null;
  /**
   * The route and trail of the bus a passenger has tapped, when one is selected.
   *
   * Handed in, like the user's position: this component fetches nothing. The page owns the one
   * selected-vehicle lookup and both the card and this map are given its answer, which is what
   * stops a tap costing two identical requests to a live feed.
   *
   * Null covers "no bus selected" and "selected but not loaded yet"; the map is identical in both,
   * and the overlay simply appears when the answer arrives.
   */
  selectedVehicleOverlay?: SelectedVehicleOverlay | null;
  /**
   * A camera move the page has asked for, as distinct from where the camera is.
   *
   * Separate from `focus` so that fitting a route cannot be confused with the page following a
   * stop or the passenger's own location, and so "Show whole route" is one nonce the map applies
   * once rather than a bounds prop it might re-apply on a re-render.
   */
  fitBounds?: { bounds: Bounds; nonce: number } | null;
}

/**
 * Configured at build time; absent in environments with no licence-compliant style available.
 *
 * `__busstopsMapStyle` is a seam for the end-to-end suite, alongside the `__busstopsMap` one
 * below. The style URL is baked in by Vite, and the e2e build deliberately has none so that most
 * specs exercise the list-only fallback a style-less deployment really gets — but one spec asks
 * what the renderer actually painted, and it cannot do that without a renderer. Rather than give
 * every spec a basemap to fix one, that spec hands a style straight to this function before the
 * page scripts run.
 *
 * Read-only, and it can only ever *add* a map to a page that would otherwise show a list. It
 * cannot reach a deployment: nothing in the product writes it.
 */
export function configuredStyleUrl(): string | StyleSpecification | null {
  const injected = (globalThis as { __busstopsMapStyle?: string | StyleSpecification })
    .__busstopsMapStyle;
  if (injected) return injected;
  const url = import.meta.env?.VITE_MAP_STYLE_URL;
  return typeof url === "string" && url.length > 0 ? url : null;
}

export function MapView({
  bounds,
  stops,
  vehicles,
  selectedStopId,
  selectedVehicleRef,
  onSelectStop,
  onSelectVehicle,
  onBoundsChange,
  focus = null,
  showStops,
  showVehicles,
  intent = { kind: "explore" },
  degraded = false,
  userLocation = null,
  selectedVehicleOverlay = null,
  fitBounds = null,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const selectRef = useRef(onSelectStop);
  const selectVehicleRef = useRef(onSelectVehicle);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState<MapScale>(() => scaleForZoom(14));
  const styleUrl = configuredStyleUrl();

  /*
   * The latest handler, without re-creating the map to get it.
   *
   * The map's click listeners are registered once, when the map is built, so they close over
   * whatever `onSelectStop` was at that moment. Keeping it in a ref updated by an effect means a
   * click always calls the current one; assigning during render would be reading and writing a
   * ref in the render pass, which React rightly objects to.
   */
  useEffect(() => {
    selectRef.current = onSelectStop;
  }, [onSelectStop]);

  useEffect(() => {
    selectVehicleRef.current = onSelectVehicle;
  }, [onSelectVehicle]);

  const stopData = useMemo(
    () => stopFeatures(showStops ? stops : [], intent, selectedStopId ?? null),
    [stops, showStops, intent, selectedStopId],
  );
  const vehicleData = useMemo(
    () => vehicleFeatures(showVehicles ? vehicles : [], intent, selectedVehicleRef ?? null),
    [vehicles, showVehicles, intent, selectedVehicleRef],
  );
  /*
   * The passenger's own position, as the two features that draw it. Built in `mapLayers.ts`
   * beside the stop and vehicle builders, for the same reason they are there: what the map draws
   * is worth being able to assert without a renderer.
   */
  const userData = useMemo(() => userFeatures(userLocation), [userLocation]);
  /*
   * The selected bus's route, trail and stops. One source, so selecting a different bus is one
   * `setData` and the previous bus's route cannot survive it.
   */
  const selectedData = useMemo(
    () => selectedVehicleFeatures(selectedVehicleOverlay),
    [selectedVehicleOverlay],
  );

  useEffect(() => {
    if (!containerRef.current || !styleUrl || mapRef.current) return;

    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: styleUrl,
        bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
        attributionControl: { compact: true },
        // Motion is a preference, not a default: honour it at the map level too.
        fadeDuration: prefersReducedMotion() ? 0 : 300,
      });
    } catch {
      // MapLibre reports construction failure synchronously, so there is no callback to defer
      // this to. Rendering the list-only fallback immediately is the whole point.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailed(true);
      return;
    }

    /*
     * Top left, because every panel this map shows is on the right.
     *
     * The selected-stop board is a right-hand side panel from 700px up and a bottom sheet below
     * it, and MapLibre's default corner is the top right — so the zoom buttons sat underneath the
     * board. Axe measured it on the deployment twice: first "29px by 16px" when the phone sheet
     * rose over them, then "10px by 44px" once that was capped and the tablet side panel was left
     * covering all but a sliver of their width. Both are the same mistake, which is putting the
     * controls in the corner the product uses.
     *
     * Nothing is drawn in the top left at any width.
     */
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    map.on("error", () => setFailed(true));

    map.on("moveend", () => {
      const view = map.getBounds();
      setScale(scaleForZoom(map.getZoom()));
      onBoundsChange?.(
        {
          west: view.getWest(),
          south: view.getSouth(),
          east: view.getEast(),
          north: view.getNorth(),
        },
        map.getZoom(),
      );
    });

    map.on("load", () => {
      void (async () => {
        for (const icon of MAP_ICONS) {
          const data = await rasterise(icon);
          // A missing icon means that layer does not draw. The map still works, which is a better
          // answer than a map that fails to load because one texture could not be made.
          if (data && !map.hasImage(icon.name)) map.addImage(icon.name, data, { pixelRatio: 1 });
        }
        // Built here rather than fetched: the directional mark must not depend on a font.
        if (!map.hasImage("direction-pip")) {
          map.addImage("direction-pip", trianglePip(), { pixelRatio: 1, sdf: true });
        }
        addSourcesAndLayers(map);
        setReady(true);
        setScale(scaleForZoom(map.getZoom()));
      })();
    });

    // A stop is chosen by clicking the thing that represents it, at whatever scale that is.
    for (const layer of CLICKABLE_LAYERS.stops) {
      map.on("click", layer, (event) => {
        const code = event.features?.[0]?.properties?.atcoCode;
        if (typeof code === "string") selectRef.current?.(code);
      });
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }

    /*
     * And a bus, at whatever scale it is drawn.
     *
     * The buses were painted and inert: a passenger could see the 36 going past and had no way to
     * ask anything about it. Both representations answer — the drawing at street zoom and the
     * directional mark over a neighbourhood — because which one is on screen is a fact about the
     * camera, not about whether the bus is selectable.
     */
    for (const layer of CLICKABLE_LAYERS.vehicles) {
      map.on("click", layer, (event) => {
        const ref = event.features?.[0]?.properties?.vehicleRef;
        if (typeof ref === "string") selectVehicleRef.current?.(ref);
      });
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }

    // Clicking a cluster zooms into it, which is what a count is an invitation to do.
    for (const layer of CLICKABLE_LAYERS.clusters) {
      map.on("click", layer, (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        // A cluster is always a Point; the cast narrows MapLibre's union rather than asserting.
        const geometry = feature.geometry as unknown as { coordinates: [number, number] };
        map.easeTo({
          center: geometry.coordinates,
          zoom: Math.max(map.getZoom() + 2, ZOOM.neighbourhood),
        });
      });
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }

    mapRef.current = map;
    /*
     * A deliberate seam for the deployed visual pass.
     *
     * With the markers gone there is nothing in the DOM to count, and counting DOM nodes was never
     * the question anyway — what matters is whether the renderer painted anything. `queryRenderedFeatures`
     * asks exactly that, and it needs the map instance. Read-only, and it exposes no data the page
     * is not already drawing on screen.
     */
    (globalThis as { __busstopsMap?: MapLibreMap }).__busstopsMap = map;

    return () => {
      map.remove();
      mapRef.current = null;
      delete (globalThis as { __busstopsMap?: MapLibreMap }).__busstopsMap;
      setReady(false);
    };
    // Bounds are applied through a separate effect; re-creating the map on every pan would
    // fight the user's own navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl]);

  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !focus) return;
    if (appliedFocus.current === focus.nonce) return;
    appliedFocus.current = focus.nonce;
    map.fitBounds(
      [
        [focus.bounds.west, focus.bounds.south],
        [focus.bounds.east, focus.bounds.north],
      ],
      prefersReducedMotion() ? { animate: false } : { duration: 600 },
    );
  }, [ready, focus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource(SOURCES.stops) as maplibregl.GeoJSONSource | undefined)?.setData(stopData);
    (map.getSource(SOURCES.vehicles) as maplibregl.GeoJSONSource | undefined)?.setData(vehicleData);
    (map.getSource(SOURCES.user) as maplibregl.GeoJSONSource | undefined)?.setData(userData);
    (map.getSource(SOURCES.selected) as maplibregl.GeoJSONSource | undefined)?.setData(
      selectedData,
    );
  }, [ready, stopData, vehicleData, userData, selectedData]);

  /*
   * "Show whole route", applied once per press.
   *
   * Deliberately not merged with `focus`: that one is the page following a stop or the passenger,
   * and a route fit is a third kind of camera move with its own trigger. Same nonce discipline, so
   * a re-render cannot re-fit a route the passenger has since panned away from.
   */
  const appliedFit = useRef<number | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !fitBounds) return;
    if (appliedFit.current === fitBounds.nonce) return;
    appliedFit.current = fitBounds.nonce;
    map.fitBounds(
      [
        [fitBounds.bounds.west, fitBounds.bounds.south],
        [fitBounds.bounds.east, fitBounds.bounds.north],
      ],
      prefersReducedMotion() ? { animate: false, padding: 48 } : { duration: 700, padding: 48 },
    );
  }, [ready, fitBounds]);

  if (!styleUrl) {
    return (
      <div className="map-view map-view--unavailable">
        <p className="muted small">
          No map style is configured for this environment, so the map is not shown. Everything on
          the map is listed below.
        </p>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="map-view map-view--unavailable" role="status">
        <p className="muted small">
          The map could not be loaded. The list below has the same stops and buses.
        </p>
      </div>
    );
  }

  return (
    <div className="map-view" data-scale={scale}>
      <div ref={containerRef} className="map-view__canvas" />
      <p className="visually-hidden" role="status">
        {describeView(scale, stopData.features.length, vehicleData.features.length, degraded)} The
        same items are listed below this map.
        {describeUserLocation(userLocation !== null)}
      </p>
      {degraded && (
        <p className="map-view__degraded small" role="status">
          Some stops are missing their route numbers on this screen.
        </p>
      )}
    </div>
  );
}

/**
 * The sources and the layers over them.
 *
 * Clustering is MapLibre's, so the counts are computed from the features actually present rather
 * than estimated: a cluster that says 34 is 34 buses. Nothing here invents a number.
 */
/**
 * A triangle, drawn as an image rather than as a character.
 *
 * `vehicle-pips` used `"text-field": "▲"`, and a symbol layer's text needs glyphs: the basemap has
 * to serve a font, and MapLibre asks for its default stack unless told otherwise. On the
 * deployment those requests 404 and the layer draws nothing — which is why the neighbourhood band
 * showed no buses at all while the list beside it said a hundred and fifty-five. A local
 * reproduction against a style with no glyphs shows the same: stops draw, buses do not.
 *
 * An icon needs no font. This is a 9x9 pixel triangle pointing up, built here so the map depends
 * on nothing it did not bring with it, and rotated by `icon-rotate` exactly as the character was.
 */
const PIP_SIZE = 9;

function trianglePip(): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(PIP_SIZE * PIP_SIZE * 4);
  const middle = (PIP_SIZE - 1) / 2;
  for (let y = 0; y < PIP_SIZE; y += 1) {
    // A solid triangle: the row's half-width is its distance from the apex, so the last row is
    // the full width and the first is a single pixel.
    for (let x = 0; x < PIP_SIZE; x += 1) {
      if (Math.abs(x - middle) > y) continue;
      const at = (y * PIP_SIZE + x) * 4;
      // White, so `icon-color` can tint it per feature the way the text colour used to.
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = 255;
    }
  }
  return { width: PIP_SIZE, height: PIP_SIZE, data };
}

/**
 * The font the basemap itself uses, or none.
 *
 * Cluster counts and the route number on a bus are genuinely text, so they genuinely need glyphs
 * — and the mistake was not asking for text, it was asking for it in MapLibre's default font,
 * which the style does not serve. Rather than hard-coding a font name and hoping (the same guess
 * in a different place), the layers borrow whatever stack the style's own labels already use.
 * That is self-correcting: change the basemap and this follows it.
 *
 * Null when the style has no symbol layers at all, which is what a blank test style is. The
 * layers then draw their icons and circles and skip their text, rather than failing to draw.
 */
/**
 * The heads of the expressions `text-font` is allowed to be.
 *
 * A font stack and a data-driven expression are both arrays of strings — `["Noto Sans Regular"]`
 * and `["get", "font"]` are indistinguishable by shape — so borrowing the second as though it were
 * the first would ask the basemap for a font called "get" and land back where this started. No
 * font is named after a MapLibre operator, which makes the head the reliable tell.
 */
const FONT_EXPRESSION_HEADS = new Set([
  "literal",
  "step",
  "case",
  "match",
  "coalesce",
  "get",
  "interpolate",
  "concat",
  "to-string",
  "let",
  "var",
]);

export function basemapFontStack(map: MapLibreMap): string[] | null {
  try {
    for (const layer of map.getStyle()?.layers ?? []) {
      if (layer.type !== "symbol") continue;
      const font = (layer.layout as { "text-font"?: unknown } | undefined)?.["text-font"];
      if (!Array.isArray(font) || font.length === 0) continue;
      if (!font.every((entry) => typeof entry === "string")) continue;
      if (FONT_EXPRESSION_HEADS.has(font[0] as string)) continue;
      return font as string[];
    }
  } catch {
    // A style that cannot be read is a style with no font to borrow.
  }
  return null;
}

function addSourcesAndLayers(map: MapLibreMap): void {
  const font = basemapFontStack(map);
  /**
   * A cluster's number, only when there is a font to draw it with.
   *
   * Asking for text without a font is not a smaller version of asking for it — MapLibre requests
   * its default stack, the basemap 404s, and the layer draws nothing. Where there is no font the
   * count is simply omitted and the cluster circle stands alone, which is a legible map rather
   * than a missing one.
   */
  const countLayout = (): Record<string, unknown> =>
    font === null
      ? {}
      : {
          "text-font": font,
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
          "text-allow-overlap": true,
        };
  const empty = { type: "FeatureCollection" as const, features: [] };

  map.addSource(SOURCES.stops, {
    type: "geojson",
    data: empty,
    cluster: true,
    // Clustering stops exactly where the neighbourhood scale begins, so the two never disagree
    // about whether this screen is showing groups or things.
    clusterMaxZoom: ZOOM.neighbourhood - 1,
    clusterRadius: 48,
  });
  map.addSource(SOURCES.vehicles, {
    type: "geojson",
    data: empty,
    cluster: true,
    clusterMaxZoom: ZOOM.neighbourhood - 1,
    clusterRadius: 56,
  });
  /*
   * Never clustered: there is one of them, and it is not traffic.
   *
   * It is also the only source here that is not data from the API — the coordinate came from the
   * browser and goes no further than this layer.
   */
  map.addSource(SOURCES.user, { type: "geojson", data: empty });

  /*
   * ---- the passenger ----------------------------------------------------
   *
   * The halo first, so it is beneath every stop and bus: it is ground, not a marker, and a
   * translucent disc painted over the stops would tint the things somebody is trying to read. The
   * dot itself is added last, at the very end of this function, because "you are here" has to
   * survive a street full of buses drawn on top of it.
   *
   * Blue, not red. Red is a bus and red is a warning in this design system, and a red dot in the
   * middle of a map full of red buses is a bus. `--colour-blue` is the system's information blue;
   * MapLibre paint cannot read a CSS variable, so the hex is named here and the token is the
   * comment — the one place in the app where that trade is unavoidable.
   */
  map.addSource(SOURCES.selected, { type: "geojson", data: empty });

  /*
   * ---- the selected bus's route, under everything it runs past -----------
   *
   * Order inside this block matters as much as where the block sits. The observed trail goes down
   * first, then the scheduled route over it, because the question "where is this bus going" is the
   * one the passenger tapped for and the answer should be the line on top. The travelled part of
   * the schedule is first of all and barely there: it is context, and at full weight it competes
   * with the route ahead for exactly the wrong attention.
   *
   * All of it is below the stop and bus layers added after it, so a route drawn through a street
   * full of buses never covers them, and none of these layers is clickable.
   */
  map.addLayer({
    id: "route-travelled",
    type: "line",
    source: SOURCES.selected,
    filter: ["==", ["get", "kind"], "travelled"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ROUTE_BLUE,
      "line-width": 3,
      // Faint enough to read as "already done" rather than as a second route.
      "line-opacity": 0.18,
    },
  });

  /*
   * Where it has actually been. Blue-grey and thinner than the schedule, dashed so the difference
   * survives a greyscale screenshot and a passenger who cannot separate two blues — the card says
   * which is which in words as well.
   */
  map.addLayer({
    id: "trail-observed",
    type: "line",
    source: SOURCES.selected,
    filter: ["==", ["get", "kind"], "trail"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": TRAIL_BLUE,
      "line-width": 3,
      "line-opacity": 0.75,
      "line-dasharray": [2, 1.5],
    },
  });

  /*
   * The route ahead: solid, and the widest line on the map, because it is the answer.
   *
   * Width grows with zoom so it stays legible over a city and does not swamp a street. A white
   * casing underneath would be another layer and another draw; the opacity and width here are
   * enough to read over both the pale and the dark basemaps this product ships.
   */
  map.addLayer({
    id: "route-ahead",
    type: "line",
    source: SOURCES.selected,
    filter: ["==", ["get", "kind"], "remaining"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ROUTE_BLUE,
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 13, 5, 16, 7],
      "line-opacity": 0.9,
    },
  });

  map.addLayer({
    id: "user-accuracy",
    type: "fill",
    source: SOURCES.user,
    filter: ["==", ["get", "kind"], "accuracy"],
    paint: {
      "fill-color": USER_BLUE,
      "fill-opacity": 0.12,
      "fill-outline-color": USER_BLUE,
    },
  });

  // ---- city: how much is here, and where is it busy ----------------------
  map.addLayer({
    id: "stop-clusters",
    type: "circle",
    source: SOURCES.stops,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#f7f6f1",
      "circle-stroke-color": "#14110f",
      "circle-stroke-width": 2,
      // Area, not radius, so a cluster of 200 does not swamp the screen.
      "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 12, 50, 20, 300, 30],
      "circle-opacity": 0.92,
    },
  });
  map.addLayer({
    id: "stop-cluster-counts",
    type: "symbol",
    source: SOURCES.stops,
    filter: ["has", "point_count"],
    layout: countLayout(),
    paint: { "text-color": "#14110f" },
  });

  map.addLayer({
    id: "vehicle-clusters",
    type: "circle",
    source: SOURCES.vehicles,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#e5242a",
      "circle-stroke-color": "#14110f",
      "circle-stroke-width": 2,
      "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 11, 50, 18, 300, 26],
    },
  });
  map.addLayer({
    id: "vehicle-cluster-counts",
    type: "symbol",
    source: SOURCES.vehicles,
    filter: ["has", "point_count"],
    layout: countLayout(),
    paint: { "text-color": "#ffffff" },
  });

  /*
   * The selected stop, under its own mark, for the same reason the selected bus has one.
   *
   * A board can be open on a stop that is one grey pip among four hundred, and a passenger who
   * pans the map then has no way to find the stop they are reading about. The ring is drawn at
   * every scale — a selection has to survive a zoom — and under the pip and the flag, so the stop
   * is still the same drawing with something around it rather than a different kind of stop.
   */
  map.addLayer({
    id: "stop-selected",
    type: "circle",
    source: SOURCES.stops,
    filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "selected"], 1]],
    paint: {
      "circle-radius": 14,
      "circle-color": "#e5242a",
      "circle-opacity": 0.14,
      "circle-stroke-color": "#e5242a",
      "circle-stroke-width": 2,
    },
  });

  // ---- neighbourhood: which way is everything going ----------------------
  map.addLayer({
    id: "stop-pips",
    type: "circle",
    source: SOURCES.stops,
    filter: ["!", ["has", "point_count"]],
    maxzoom: ZOOM.street,
    paint: {
      "circle-radius": ["case", ["==", ["get", "emphasis"], 1], 4, 2.5],
      "circle-color": ["case", ["==", ["get", "emphasis"], 1], "#e5242a", "#7b736a"],
      "circle-stroke-color": "#f7f6f1",
      "circle-stroke-width": 1,
    },
  });
  map.addLayer({
    id: "vehicle-pips",
    type: "symbol",
    source: SOURCES.vehicles,
    filter: ["!", ["has", "point_count"]],
    maxzoom: ZOOM.street,
    layout: {
      // An image, not a character: a symbol layer's text needs glyphs the basemap does not serve,
      // and this layer drew nothing at all on the deployment because of it.
      "icon-image": "direction-pip",
      // The character it replaced was drawn at text-size 11; nine art pixels at 1.2 is the same
      // mark at the same weight, which is what keeps a zoom from changing how busy the map looks.
      "icon-size": 1.2,
      "icon-rotate": ["coalesce", ["get", "bearing"], 0],
      "icon-allow-overlap": true,
      "icon-rotation-alignment": "map",
    },
    paint: {
      "icon-color": ["case", ["get", "stale"], "#a49b90", "#e5242a"],
      "icon-opacity": ["case", ["==", ["get", "emphasis"], 1], 1, 0.35],
    },
  });

  /*
   * The selected bus, under everything, so a chosen bus is findable in a street full of them.
   *
   * A ring rather than a different drawing: the bus is the same bus, and swapping its artwork on
   * selection would read as a different kind of vehicle. Drawn at both scales because a selection
   * has to survive a zoom out.
   */
  map.addLayer({
    id: "vehicle-selected",
    type: "circle",
    source: SOURCES.vehicles,
    filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "selected"], 1]],
    paint: {
      "circle-radius": 16,
      "circle-color": "#e5242a",
      "circle-opacity": 0.16,
      "circle-stroke-color": "#e5242a",
      "circle-stroke-width": 2,
    },
  });

  // ---- street: which bus is that -----------------------------------------
  map.addLayer({
    id: "stop-flags",
    type: "symbol",
    source: SOURCES.stops,
    filter: ["!", ["has", "point_count"]],
    minzoom: ZOOM.street,
    layout: {
      "icon-image": ["case", ["==", ["get", "emphasis"], 1], "stop-flag-large", "stop-flag"],
      "icon-allow-overlap": true,
      // The pole's foot is the point on the ground, so the flag hangs above it.
      "icon-anchor": "bottom",
    },
  });
  map.addLayer({
    id: "vehicle-buses",
    type: "symbol",
    source: SOURCES.vehicles,
    filter: ["!", ["has", "point_count"]],
    minzoom: ZOOM.street,
    layout: {
      /*
       * Which way it is going, drawn rather than described.
       *
       * A street full of identical buses facing the same way is a pattern, not traffic. The
       * marker is a side view whose blind is at its right-hand end, so it is already a bus
       * driving east; a bearing in the western half of the compass gets the mirrored texture.
       * Not rotated: rotating a side elevation through 200 degrees draws a bus on its roof.
       *
       * A bus whose feed gives no bearing keeps the eastbound drawing rather than being assigned
       * a direction — the same rule as everywhere else, that an unknown is not a guess.
       */
      "icon-image": [
        "case",
        [">", ["coalesce", ["get", "bearing"], 0], 180],
        ["case", ["get", "stale"], "bus-amber-west", "bus-red-west"],
        ["case", ["get", "stale"], "bus-amber", "bus-red"],
      ],
      "icon-allow-overlap": true,
      ...(font === null
        ? {}
        : {
            "text-font": font,
            "text-field": ["get", "route"],
            "text-size": 11,
            "text-offset": [0, -1.4],
            "text-allow-overlap": false,
            // Optional already, so the bus draws with or without its number — but without a font
            // the whole text is skipped rather than requested and 404ed.
            "text-optional": true,
          }),
    },
    paint: {
      "text-color": "#14110f",
      "text-halo-color": "#f7f6f1",
      "text-halo-width": 1.5,
      "icon-opacity": ["case", ["==", ["get", "emphasis"], 1], 1, 0.4],
      "text-opacity": ["case", ["==", ["get", "emphasis"], 1], 1, 0.4],
    },
  });

  /*
   * The selected bus's upcoming stops, over the ordinary stop layer.
   *
   * Restrained on purpose: small points along the line, the next one larger, and the destination
   * larger again with a ring. Not labels — a route with forty stops and forty labels is a map
   * nobody can read, and the card beside it is the detailed list.
   */
  map.addLayer({
    id: "route-upcoming-stops",
    type: "circle",
    source: SOURCES.selected,
    filter: ["in", ["get", "kind"], ["literal", ["upcoming", "next"]]],
    paint: {
      "circle-radius": ["case", ["==", ["get", "kind"], "next"], 6, 3.5],
      "circle-color": "#ffffff",
      "circle-stroke-color": ROUTE_BLUE,
      "circle-stroke-width": ["case", ["==", ["get", "kind"], "next"], 3, 1.5],
    },
  });

  /* Where this journey ends, which is the other thing a route preview is asked for. */
  map.addLayer({
    id: "route-destination",
    type: "circle",
    source: SOURCES.selected,
    filter: ["==", ["get", "kind"], "destination"],
    paint: {
      "circle-radius": 7,
      "circle-color": ROUTE_BLUE,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3,
    },
  });

  /*
   * And the dot, over everything, with a white collar so it reads on a dark basemap as well as a
   * pale one.
   *
   * In pixels rather than metres, unlike the halo: this one is a marker and it should be the same
   * size whatever the zoom, exactly as it is in every map application a passenger has used. No
   * click handler is registered for it anywhere — it is not a thing to open, and `queryRenderedFeatures`
   * only reaches layers that asked for it, so a tap here falls through to whatever is underneath.
   */
  map.addLayer({
    id: "user-dot",
    type: "circle",
    source: SOURCES.user,
    filter: ["==", ["get", "kind"], "dot"],
    paint: {
      "circle-radius": 7,
      "circle-color": USER_BLUE,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3,
    },
  });
}

/** `--colour-blue` from the design tokens. Paint expressions cannot read a CSS variable. */
const USER_BLUE = "#1557ff";

/**
 * The route ahead, and the path already taken.
 *
 * The same blue family as the location dot, which is right — this is all map information rather
 * than transport red — and separated from it by form instead of hue: the dot is a small filled
 * circle with a white collar, these are lines. The trail is pulled towards grey and dashed so the
 * two lines differ in more than one channel.
 */
const ROUTE_BLUE = "#1557ff";
const TRAIL_BLUE = "#5a7fb8";

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
