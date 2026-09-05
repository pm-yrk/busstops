import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import type { MapStopSummary, MapVehicleSummary } from "@busstops/contracts";
import type { Bounds } from "../lib/geo.js";
import {
  PIXEL_BUS_MARKER,
  PIXEL_BUS_MARKER_STALE,
  PIXEL_STOP_MARKER,
  PIXEL_STOP_MARKER_SELECTED,
} from "./pixel/pixelMarkers.js";
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
 */

/** How many buses a viewport can hold before their route numbers stop being readable. */
const ROUTE_LABELS_UP_TO = 40;

export interface MapViewProps {
  bounds: Bounds;
  stops: readonly MapStopSummary[];
  vehicles: readonly MapVehicleSummary[];
  selectedStopId?: string | null;
  onSelectStop?: (atcoCode: string) => void;
  onBoundsChange?: (bounds: Bounds, zoom: number) => void;
  showStops: boolean;
  showVehicles: boolean;
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
  onSelectStop,
  onBoundsChange,
  showStops,
  showVehicles,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [failed, setFailed] = useState(false);
  const styleUrl = configuredStyleUrl();

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
      if (!onBoundsChange) return;
      const view = map.getBounds();
      onBoundsChange(
        {
          west: view.getWest(),
          south: view.getSouth(),
          east: view.getEast(),
          north: view.getNorth(),
        },
        map.getZoom(),
      );
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Bounds are applied through a separate effect; re-creating the map on every pan would
    // fight the user's own navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const marker of markersRef.current) marker.remove();
    markersRef.current = [];

    if (showStops) {
      for (const stop of stops) {
        const element = document.createElement("button");
        element.type = "button";
        element.className = `map-marker map-marker--stop ${
          selectedStopId === stop.atcoCode ? "map-marker--selected" : ""
        }`;
        // Every marker is a real button with an accessible name, so the map is operable by
        // keyboard as well as pointer.
        const label = `${stop.name}${stop.indicator ? `, ${stop.indicator}` : ""}`;
        // Static markup with no interpolated data; everything about this stop is on the element.
        // The selected flag is a larger drawing rather than the same one under a transform.
        element.innerHTML =
          selectedStopId === stop.atcoCode ? PIXEL_STOP_MARKER_SELECTED : PIXEL_STOP_MARKER;
        element.addEventListener("click", () => onSelectStop?.(stop.atcoCode));

        markersRef.current.push(
          addMarker(map, element, [stop.coordinate.lon, stop.coordinate.lat], label),
        );
      }
    }

    if (showVehicles) {
      for (const vehicle of vehicles) {
        const element = document.createElement("div");
        element.className = "map-marker map-marker--vehicle";
        element.setAttribute("role", "img");
        const label = `${vehicle.routePublicName ?? "Bus"} to ${vehicle.destinationName ?? "unknown destination"}`;
        // A stale position is drawn as a different vehicle, not as the same one faded.
        const stale = vehicle.freshnessSeconds > 180;
        element.innerHTML = stale ? PIXEL_BUS_MARKER_STALE : PIXEL_BUS_MARKER;
        // The route number, revealed when the vehicle is pointed at or focused. Set as text, so
        // an operator's own naming can never be markup.
        if (vehicle.routePublicName) {
          const route = document.createElement("span");
          route.className = "map-marker__route";
          route.textContent = vehicle.routePublicName;
          element.appendChild(route);
        }
        if (vehicle.bearingDegrees !== null) {
          element.style.setProperty("--bearing", `${vehicle.bearingDegrees}deg`);
          // A drawn bus has a front, unlike a dot: heading west it faces the other way.
          const westbound = vehicle.bearingDegrees > 180;
          element.classList.toggle("map-marker--westbound", westbound);
          // North and south are carried by a pip that orbits the bus, because the sprite is a
          // side view and a side view turned to a northbound bearing is a bus on its back end.
          const heading = document.createElement("span");
          heading.className = "map-marker__heading";
          heading.setAttribute("aria-hidden", "true");
          element.appendChild(heading);
        }
        if (stale) element.classList.add("map-marker--stale");

        markersRef.current.push(
          addMarker(map, element, [vehicle.coordinate.lon, vehicle.coordinate.lat], label),
        );
      }
    }
  }, [stops, vehicles, showStops, showVehicles, selectedStopId, onSelectStop]);

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

  /*
   * Whether every bus can wear its route number.
   *
   * The number belongs on the vehicle rather than in a legend, but a viewport holding two hundred
   * buses would become two hundred numbered chips on top of each other, which is a worse map than
   * two hundred buses. So the labels are shown while the view is quiet enough to read and fall
   * back to hover and focus when it is not. Leeds at midday sits either side of this line, which
   * is the point: the map stays legible at both.
   */
  const labelled = vehicles.length <= ROUTE_LABELS_UP_TO;

  return (
    <div className={labelled ? "map-view map-view--labelled" : "map-view"}>
      <div ref={containerRef} className="map-view__canvas" />
      <p className="visually-hidden">
        The map shows {stops.length} stops and {vehicles.length} buses. The same items are listed
        below this map.
      </p>
    </div>
  );
}

/**
 * Place a marker and give it back its name.
 *
 * MapLibre writes `aria-label="Map marker"` onto the element it is handed, overwriting whatever
 * the caller set. Every stop and every bus on this map therefore announced itself as "Map marker"
 * to a screen reader — a hundred identical objects where the visual map has a hundred named ones.
 * The name is reapplied after construction, which is the only point at which it survives.
 */
function addMarker(
  map: maplibregl.Map,
  element: HTMLElement,
  lngLat: [number, number],
  label: string,
): maplibregl.Marker {
  const marker = new maplibregl.Marker({ element }).setLngLat(lngLat).addTo(map);
  element.setAttribute("aria-label", label);
  return marker;
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
