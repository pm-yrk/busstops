import { useCallback, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { MAP_QUERY_LIMITS, type MapResponse } from "@busstops/contracts";
import { apiClient, ApiError } from "../lib/api.js";
import { useFetch, useTicker } from "../lib/use-fetch.js";
import { boundsFromParam, clampBoundsToMaxArea, vehicleHref, type Bounds } from "../lib/geo.js";
import { delayLabel, distanceLabel, freshnessLabel } from "../lib/format.js";
import { LoadingBus } from "../components/LoadingBus.js";
import { MapView } from "../components/MapView.js";
import { SelectedStopBoard } from "../components/SelectedStopBoard.js";
import { SelectedVehicleBoard } from "../components/SelectedVehicleBoard.js";
import {
  DataAge,
  EmptyState,
  ErrorState,
  ServiceBanner,
  StateLozenge,
} from "../components/primitives.js";
import "./LiveMapPage.css";

/**
 * Live map (docs/09_BUS_STOPS_LIVE.md "Live map").
 *
 * The map is never the only way to use Live: every marker has a list equivalent, and the list
 * is a real list, not a visually hidden afterthought. Requests are viewport-scoped and the
 * viewport is clamped client-side to the API's maximum area, so panning out degrades to a
 * smaller query rather than a rejected one.
 */

/**
 * Where the map opens.
 *
 * Leeds, because a non-London default is the quickest way to show the product is not a London
 * app. Widened from a 4 km box to roughly 12 km across: the tight version framed three streets,
 * and a first view that happens to contain two buses demonstrates far less than one that contains
 * twenty. It is still an order of magnitude inside the API's maximum query area.
 *
 * This is a camera position, not data. Whatever is in frame is whatever is really there.
 */
const DEFAULT_VIEW: Bounds = {
  west: -1.6,
  south: 53.775,
  east: -1.49,
  north: 53.825,
};

const REFRESH_INTERVAL_MS = 20_000;

type LayerKey = "stops" | "vehicles";

/**
 * A viewport named in the URL, or null.
 *
 * `?bbox=west,south,east,north`, the same four numbers in the same order the API takes, so a link
 * to a place on the map is a link anyone can read and anyone can write. Without this the map only
 * ever opened on its default camera and there was no way to point at anywhere else — not for a
 * person sharing where they are, and not for the deployed visual check, which cannot photograph
 * York if it cannot ask for York.
 *
 * Anything that is not four finite numbers in the right order is ignored rather than corrected:
 * a half-understood bbox would frame somewhere nobody asked for, and the default camera is a
 * better answer than a wrong one. The parsing lives in geo.ts now, because the vehicle page needs
 * exactly the same rules and two copies of them is how they come to disagree.
 */

export function LiveMapPage() {
  const [searchParams] = useSearchParams();
  /*
   * `/live/stops/:stopId` — a link to a stop on the map rather than to its page.
   *
   * The route existed and nothing read it: the page opened on its default camera with no board,
   * so every one of these links was a link to Leeds. The stop opens here, and the camera follows
   * once the board has found out where the stop is.
   */
  const { stopId: deepLinkedStop } = useParams();
  /*
   * Read once, as the initial camera. The map is a live surface after that: panning changes the
   * viewport and the URL is deliberately left alone rather than rewritten on every `moveend`,
   * which would fill the history with a hundred entries between two streets.
   */
  const [bounds, setBounds] = useState<Bounds>(
    () => boundsFromParam(searchParams.get("bbox")) ?? DEFAULT_VIEW,
  );
  // The stop whose arrival board is open over the map, by ATCO code. Null when none is selected.
  const [selectedStop, setSelectedStop] = useState<string | null>(deepLinkedStop ?? null);
  /*
   * And the bus, which is a separate selection and a mutually exclusive one.
   *
   * Two panels open at once would cover the map between them, and they answer different questions
   * — "when is my bus" and "where is that bus going" — so choosing one closes the other.
   */
  const [selectedVehicle, setSelectedVehicle] = useState<string | null>(null);
  const [zoom, setZoom] = useState(15);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ stops: true, vehicles: true });
  const [locating, setLocating] = useState(false);
  const [locationDenied, setLocationDenied] = useState(false);
  /*
   * The camera follows a deep-linked stop exactly once.
   *
   * Recentring on every load of the board would fight the user: they open the link, pan away to
   * see what else is nearby, the board refreshes and the map snaps back.
   */
  const [followedDeepLink, setFollowedDeepLink] = useState(deepLinkedStop === undefined);
  /*
   * Where the page has asked the camera to go, as distinct from where the camera is.
   *
   * The nonce is the whole point: `bounds` changes on every pan, and a map that followed it would
   * fight the person moving it. This only changes when the page deliberately moves the view.
   */
  const [focus, setFocus] = useState<{ bounds: Bounds; nonce: number } | null>(null);

  // The viewport is clamped before the request, so panning out shrinks the query rather than
  // producing a rejected one.
  const clamped = clampBoundsToMaxArea(bounds, MAP_QUERY_LIMITS.maxBboxAreaSquareDegrees);
  const safeZoom = Math.min(
    MAP_QUERY_LIMITS.maxZoom,
    Math.max(MAP_QUERY_LIMITS.minZoom, Math.round(zoom)),
  );

  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.map(clamped, safeZoom, signal),
    // The bounds object is recreated each render, so depend on its values, not its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clamped.west, clamped.south, clamped.east, clamped.north, safeZoom],
  );

  const {
    data: response,
    error,
    loading,
    reload,
  } = useFetch<MapResponse>(fetcher, { refreshMs: REFRESH_INTERVAL_MS });

  const now = useTicker();

  const locate = () => {
    if (!globalThis.navigator?.geolocation) {
      setLocationDenied(true);
      return;
    }
    setLocating(true);
    globalThis.navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const here = {
          west: longitude - 0.02,
          east: longitude + 0.02,
          south: latitude - 0.01,
          north: latitude + 0.01,
        };
        setBounds(here);
        setFocus({ bounds: here, nonce: Date.now() });
        setZoom(15);
        setLocating(false);
      },
      () => {
        setLocationDenied(true);
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  };

  const observedAgeSeconds = useMemo(() => {
    if (!response?.meta.observedAt) return null;
    return Math.max(0, (now.getTime() - new Date(response.meta.observedAt).getTime()) / 1000);
  }, [response, now]);

  const stops = response?.data.stops ?? [];
  const vehicles = response?.data.vehicles ?? [];

  return (
    <div className="live-map">
      <div className="live-map__controls no-print">
        <h1 className="live-map__title">Live map</h1>

        <div className="live-map__control-row">
          <button type="button" onClick={locate} className="button-quiet" disabled={locating}>
            {locating ? "Locating…" : "Use my location"}
          </button>
          <Link to="/search" className="live-map__link">
            Search instead
          </Link>
        </div>

        <fieldset className="live-map__layers">
          <legend className="live-map__legend">Layers</legend>
          {(["stops", "vehicles"] as LayerKey[]).map((layer) => (
            <label key={layer} className="live-map__layer">
              <input
                type="checkbox"
                checked={layers[layer]}
                onChange={(event) =>
                  setLayers((prev) => ({ ...prev, [layer]: event.target.checked }))
                }
              />
              {layer === "stops" ? "Stops" : "Buses"}
            </label>
          ))}
        </fieldset>

        {locationDenied && (
          <p className="muted small" role="status">
            Location is unavailable, so the map is showing a default area. Search works without it.
          </p>
        )}

        {response && (
          <p className="live-map__freshness small">
            <DataAge seconds={observedAgeSeconds} />
          </p>
        )}
      </div>

      <div className="live-map__body">
        {response && <ServiceBanner meta={response.meta} />}

        {loading && !response && <LoadingBus label="Loading the live map" />}

        {error && (
          <ErrorState
            description={
              error instanceof ApiError && error.code === "bbox_too_large"
                ? "That area is too large to load at once. Zoom in and the map will update."
                : "We could not load live data for this area."
            }
            onRetry={reload}
          />
        )}

        {response && (
          <>
            <div className="live-map__canvas">
              <MapView
                bounds={bounds}
                focus={focus}
                stops={stops}
                vehicles={vehicles}
                selectedStopId={selectedStop}
                selectedVehicleRef={selectedVehicle}
                degraded={response.data.degraded}
                intent={
                  selectedStop ? { kind: "stop", atcoCode: selectedStop } : { kind: "explore" }
                }
                showStops={layers.stops}
                showVehicles={layers.vehicles}
                onSelectStop={(code) => {
                  setSelectedVehicle(null);
                  setSelectedStop(code);
                }}
                onSelectVehicle={(ref) => {
                  setSelectedStop(null);
                  setSelectedVehicle(ref);
                }}
                onBoundsChange={(next, nextZoom) => {
                  setBounds(next);
                  setZoom(nextZoom);
                }}
              />

              {selectedStop && (
                <SelectedStopBoard
                  key={selectedStop}
                  atcoCode={selectedStop}
                  onClose={() => setSelectedStop(null)}
                  onResolved={({ coordinate }) => {
                    if (followedDeepLink) return;
                    setFollowedDeepLink(true);
                    const around = {
                      west: coordinate.lon - 0.012,
                      east: coordinate.lon + 0.012,
                      south: coordinate.lat - 0.006,
                      north: coordinate.lat + 0.006,
                    };
                    setBounds(around);
                    setFocus({ bounds: around, nonce: Date.now() });
                    setZoom(16);
                  }}
                />
              )}

              {selectedVehicle && (
                <SelectedVehicleBoard
                  key={selectedVehicle}
                  vehicleRef={selectedVehicle}
                  /*
                   * The clamped box, which is the one the vehicle was actually returned in. The
                   * raw viewport can be larger than the API accepts, and a lookup in a box the
                   * API rejects is a bus that cannot be opened.
                   */
                  bounds={clamped}
                  onClose={() => setSelectedVehicle(null)}
                />
              )}
            </div>

            {/*
              The list is the map's equal, not its fallback: it carries the same objects in the
              same order, with the same freshness and delay information.
            */}
            {layers.vehicles && (
              <section aria-labelledby="vehicles-heading" className="live-map__section">
                <h2 id="vehicles-heading">
                  Buses in view <StateLozenge tone="live">{vehicles.length}</StateLozenge>
                </h2>

                {vehicles.length === 0 ? (
                  <EmptyState
                    art="bus"
                    title="No buses in view"
                    description={
                      response.meta.degradation === "scheduled_only"
                        ? "Live vehicle positions are unavailable right now. Stops and timetables below still work."
                        : "There are no live buses in this area at the moment. Try panning, or check the stops below."
                    }
                  />
                ) : (
                  <ul className="live-map__list">
                    {vehicles.map((vehicle) => (
                      <li key={vehicle.vehicleRef} className="live-map__item surface">
                        <span className="route-badge route-badge--inline">
                          {vehicle.routePublicName ?? "—"}
                        </span>
                        <span className="live-map__item-main">
                          {/*
                            The list is the map's equal, so a bus in it opens the same way a bus on
                            the map does. It is a link rather than a button so it can be opened in
                            a new tab and read by anything that lists a page's links — and it
                            carries the viewport, because the live feeds are area-scoped.
                          */}
                          <Link
                            to={vehicleHref(vehicle.vehicleRef, {
                              bounds: clamped,
                              coordinate: vehicle.coordinate,
                            })}
                            className="live-map__item-title"
                          >
                            {vehicle.destinationName ?? "Destination unknown"}
                          </Link>
                          <span className="muted small">
                            {delayLabel(vehicle.delaySeconds)} ·{" "}
                            {vehicle.motionState === "stationary"
                              ? "not moving"
                              : vehicle.motionState === "moving"
                                ? "moving"
                                : "movement unknown"}
                          </span>
                        </span>
                        <span className="muted small live-map__item-age">
                          {freshnessLabel(vehicle.freshnessSeconds)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {response.data.truncated.vehicles && (
                  <p className="muted small">
                    Showing the closest buses only. Zoom in to see the rest.
                  </p>
                )}
              </section>
            )}

            {layers.stops && (
              <section aria-labelledby="stops-heading" className="live-map__section">
                <h2 id="stops-heading">
                  Stops in view <StateLozenge tone="neutral">{stops.length}</StateLozenge>
                </h2>

                {stops.length === 0 ? (
                  <EmptyState
                    art="stop"
                    title="No stops in view"
                    description="There are no bus stops in this area. Try panning the map or searching for a place."
                  />
                ) : (
                  <ul className="live-map__list">
                    {stops.map((stop) => (
                      <li key={stop.id} className="live-map__item surface">
                        <Link to={`/stops/${stop.atcoCode}`} className="live-map__item-link">
                          <span className="live-map__item-title">{stop.name}</span>
                          {stop.indicator && <span className="muted small"> {stop.indicator}</span>}
                        </Link>
                        {!stop.hasLiveCoverage && (
                          <StateLozenge tone="warning">Timetable only</StateLozenge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {response.data.truncated.stops && (
                  <p className="muted small">
                    Showing the stops closest to the centre of the map. Zoom in to see them all.
                  </p>
                )}
              </section>
            )}

            <p className="live-map__attribution micro muted">
              {response.meta.attribution.join(" · ")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export { distanceLabel };
