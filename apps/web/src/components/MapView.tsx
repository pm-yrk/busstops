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
        element.setAttribute(
          "aria-label",
          `${stop.name}${stop.indicator ? `, ${stop.indicator}` : ""}`,
        );
        // Static markup with no interpolated data; everything about this stop is on the element.
        // The selected flag is a larger drawing rather than the same one under a transform.
        element.innerHTML =
          selectedStopId === stop.atcoCode ? PIXEL_STOP_MARKER_SELECTED : PIXEL_STOP_MARKER;
        element.addEventListener("click", () => onSelectStop?.(stop.atcoCode));

        markersRef.current.push(
          new maplibregl.Marker({ element })
            .setLngLat([stop.coordinate.lon, stop.coordinate.lat])
            .addTo(map),
        );
      }
    }

    if (showVehicles) {
      for (const vehicle of vehicles) {
        const element = document.createElement("div");
        element.className = "map-marker map-marker--vehicle";
        element.setAttribute("role", "img");
        element.setAttribute(
          "aria-label",
          `${vehicle.routePublicName ?? "Bus"} to ${vehicle.destinationName ?? "unknown destination"}`,
        );
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
          // A drawn bus has a front, unlike a dot: heading west it must be mirrored rather than
          // rotated upside down.
          const westbound = vehicle.bearingDegrees > 180;
          element.classList.toggle("map-marker--westbound", westbound);
        }
        if (stale) element.classList.add("map-marker--stale");

        markersRef.current.push(
          new maplibregl.Marker({ element })
            .setLngLat([vehicle.coordinate.lon, vehicle.coordinate.lat])
            .addTo(map),
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

  return (
    <div className="map-view">
      <div ref={containerRef} className="map-view__canvas" />
      <p className="visually-hidden">
        The map shows {stops.length} stops and {vehicles.length} buses. The same items are listed
        below this map.
      </p>
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
