import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import type { MapStopSummary, MapVehicleSummary } from "@busstops/contracts";
import type { Bounds } from "../lib/geo.js";
import { MAP_ICONS, rasterise } from "./pixel/mapIcons.js";
import {
  ZOOM,
  describeView,
  scaleForZoom,
  stopFeatures,
  vehicleFeatures,
  type MapIntent,
  type MapScale,
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

const SOURCES = { stops: "busstops-stops", vehicles: "busstops-vehicles" } as const;

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
}

/** Configured at build time; absent in environments with no licence-compliant style available. */
export function configuredStyleUrl(): string | null {
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

  useEffect(() => {
    if (!containerRef.current || !styleUrl || mapRef.current) return;

    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: styleUrl as string | StyleSpecification,
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

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
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
    for (const layer of ["stop-flags", "stop-pips"]) {
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
    for (const layer of ["vehicle-buses", "vehicle-pips"]) {
      map.on("click", layer, (event) => {
        const ref = event.features?.[0]?.properties?.vehicleRef;
        if (typeof ref === "string") selectVehicleRef.current?.(ref);
      });
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }

    // Clicking a cluster zooms into it, which is what a count is an invitation to do.
    for (const layer of ["stop-clusters", "vehicle-clusters"]) {
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
  }, [ready, stopData, vehicleData]);

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
export function basemapFontStack(map: MapLibreMap): string[] | null {
  try {
    for (const layer of map.getStyle()?.layers ?? []) {
      if (layer.type !== "symbol") continue;
      const font = (layer.layout as { "text-font"?: unknown } | undefined)?.["text-font"];
      if (Array.isArray(font) && font.every((entry) => typeof entry === "string")) {
        return font as string[];
      }
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
      "icon-image": ["case", ["get", "stale"], "bus-amber", "bus-red"],
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
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
