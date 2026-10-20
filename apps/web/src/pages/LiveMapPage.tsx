import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { MAP_QUERY_LIMITS, type MapResponse } from "@busstops/contracts";
import { apiClient, ApiError } from "../lib/api.js";
import { useFetch, useTicker } from "../lib/use-fetch.js";
import {
  boundsAroundMe,
  boundsFromParam,
  boundsOfPath,
  clampBoundsToMaxArea,
  splitShapeAtProgress,
  vehicleHref,
  type Bounds,
} from "../lib/geo.js";
import { useSelectedVehicle } from "../lib/use-selected-vehicle.js";
import { traceSegments } from "../lib/vehicle-trail.js";
import { useCurrentLocation, type CurrentLocation } from "../lib/use-current-location.js";
import { delayLabel, distanceLabel, freshnessLabel } from "../lib/format.js";
import { LoadingBus } from "../components/LoadingBus.js";
import { MapView } from "../components/MapView.js";
import { fetchMapWithFallback, type MapAttemptOutcome } from "../lib/map-fallback.js";
import { SelectedStopBoard } from "../components/SelectedStopBoard.js";
import { SelectedVehicleBoard } from "../components/SelectedVehicleBoard.js";
import { describeEmptyVehicles, emptyVehicleReason } from "../components/mapLayers.js";
import { DataAge, EmptyState, ServiceBanner, StateLozenge } from "../components/primitives.js";
import "./LiveMapPage.css";
import { PixelSectionHeading } from "../components/pixel/PixelSectionHeading.js";

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
/**
 * Where the map opens when it cannot open around the passenger.
 *
 * A **fallback**, not the default view. `/live` asks the browser where we are and opens there; this
 * is what a refusal, a timeout, a browser without geolocation, or a deliberate `?bbox` link gets
 * instead. Leeds rather than London because a non-London fallback is the quickest way to show the
 * product is not a London app, and nothing in the page is keyed to this city.
 *
 * This is a camera position, not data. Whatever is in frame is whatever is really there.
 */
const DEFAULT_VIEW: Bounds = {
  west: -1.6,
  south: 53.775,
  east: -1.49,
  north: 53.825,
};

/** Street-level without being nose-to-the-pavement: the zoom a map opens at when it knows where you are. */
const AROUND_ME_ZOOM = 15;

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

  /*
   * Whether this page may ask the browser where we are, decided once, from the URL the person
   * arrived on.
   *
   * An explicit navigation intent wins: a shared `?bbox` link and `/live/stops/:stopId` both name
   * a place, and asking for location there would either move the camera off the thing somebody was
   * sent to look at, or — worse — show them their own street for a moment first and then jump. So
   * those two never auto-locate at all, which makes the "no brief jump" requirement a property of
   * the code rather than a race it has to win. The location button still works on those pages; it
   * is being *asked* that changes.
   *
   * `useState` with an initialiser rather than a `useMemo`: this must be the value from the first
   * render and must never change afterwards, even if the search params object is replaced.
   */
  const [mayAutoLocate] = useState(
    () => deepLinkedStop === undefined && boundsFromParam(searchParams.get("bbox")) === null,
  );

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

  /*
   * The camera follows the passenger only when the hook says to: once on the first fix, and once
   * per press of the location button. Never on a position update in between — that is the rule
   * that stops the map dragging itself out from under somebody reading it, and it lives in the
   * hook so neither this page nor the map can get it wrong.
   *
   * Both halves are set: `bounds` is what the next request asks for, `focus` is what the camera is
   * told to do. They are separate because the map reports its own viewport back on every pan, so a
   * camera that simply followed `bounds` would fight the person moving it.
   */
  const {
    status: locationStatus,
    location,
    request,
    recentre,
  } = useCurrentLocation({
    onCameraMove: useCallback((here: CurrentLocation) => {
      const around = boundsAroundMe(here.coordinate);
      setBounds(around);
      setFocus({ bounds: around, nonce: Date.now() });
      setZoom(AROUND_ME_ZOOM);
    }, []),
  });

  // The viewport is clamped before the request, so panning out shrinks the query rather than
  // producing a rejected one.
  const clamped = clampBoundsToMaxArea(bounds, MAP_QUERY_LIMITS.maxBboxAreaSquareDegrees);
  const safeZoom = Math.min(
    MAP_QUERY_LIMITS.maxZoom,
    Math.max(MAP_QUERY_LIMITS.minZoom, Math.round(zoom)),
  );

  /*
   * The map asks up to three times, because one refusal is not an answer.
   *
   * `/v1/map` is the request that error 1102 lands on, and in a browser that arrives as a blocked
   * fetch rather than a status — so the page used to show nothing at all: no basemap, no stops, no
   * way to open a stop. See map-fallback.ts: ask again, then ask for a quarter of the view, and only
   * then report a failure.
   */
  /*
   * The ladder is for the first load, not for every refresh.
   *
   * A blank map is worth three attempts. A map that already has stops on it is not: the page polls
   * every refresh interval, and retrying three times on each poll turns one failing viewport into a
   * standing stream of requests against a Worker that is already over its limit — and makes the page
   * never settle, which is its own bug. Once there is something on screen, one attempt is enough and
   * the stops already drawn stay drawn.
   */
  const hasMapData = useRef(false);

  const fetcher = useCallback(
    (signal: AbortSignal) =>
      fetchMapWithFallback(
        (bounds, inner) => apiClient.map(bounds, safeZoom, inner),
        clamped,
        signal,
        { attempts: hasMapData.current ? 1 : 3 },
      ),
    // The bounds object is recreated each render, so depend on its values, not its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clamped.west, clamped.south, clamped.east, clamped.north, safeZoom],
  );

  const {
    data: outcome,
    error,
    loading,
    reload,
  } = useFetch<MapAttemptOutcome<MapResponse>>(fetcher, { refreshMs: REFRESH_INTERVAL_MS });
  const response = outcome?.response ?? null;
  // In an effect, not during render: the fetcher reads this on its next call, which is always after
  // a commit, so there is nothing to gain from assigning it a moment earlier and a lint rule to break.
  useEffect(() => {
    hasMapData.current = response !== null;
  }, [response]);

  const now = useTicker();

  /*
   * Ask on arrival, once.
   *
   * This is the whole "location-first" behaviour: a passenger opening `/live` should see where they
   * are, not a city they may never have been to. The prompt is the browser's own — nothing here
   * pre-empts it with a dialogue of our own, and a refusal is final for the visit.
   */
  useEffect(() => {
    if (mayAutoLocate) request();
  }, [mayAutoLocate, request]);

  /*
   * Memoised because the overlay below depends on them: `response?.data.stops ?? []` is a new
   * array identity on every render, which would rebuild the selected bus's route features on every
   * tick of the map's refresh ticker.
   */
  const stops = useMemo(() => response?.data.stops ?? [], [response]);
  const vehicles = useMemo(() => response?.data.vehicles ?? [], [response]);

  /*
   * One lookup for the selected bus, shared by the card and the map.
   *
   * The card used to fetch this itself, which was right while it was the only consumer. The map
   * now needs the same answer — the shape, the progress along it, the trail, the upcoming stops —
   * and two components asking the same endpoint for the same bus would be two requests per tap on
   * the path that reads a live feed. `clamped` rather than `bounds`: the raw viewport can exceed
   * what the API accepts, and a lookup in a box the API rejects is a bus that cannot be opened.
   */
  const selected = useSelectedVehicle(selectedVehicle, clamped);

  /** A camera fit the passenger asked for, applied once. Never on selection. */
  const [fit, setFit] = useState<{ bounds: Bounds; nonce: number } | null>(null);

  /*
   * The route, the trail and the stops to draw for the selected bus.
   *
   * All of it derived from the one response, so there is nothing to keep in step. The shape is
   * split at the Worker's own projection of the bus onto it: the remaining section is the answer to
   * "where is this bus going", and the travelled section is drawn barely-there as context rather
   * than competing with it.
   */
  const overlay = useMemo(() => {
    const data = selected.detail?.data;
    if (!data) return null;

    const { travelled, remaining } = splitShapeAtProgress(
      data.scheduledShape,
      data.progressAlongShapeMetres,
    );

    /*
     * Upcoming stops need coordinates, and `nextStops` carries names and codes rather than
     * positions — so the points along the line come from the stops the map already has in view,
     * matched by ATCO code. No extra request for a decoration, and a stop that is off screen
     * simply has no point drawn on a line that is also off screen.
     */
    const byAtco = new Map(stops.map((stop) => [stop.atcoCode, stop.coordinate]));
    const ahead = data.nextStops.filter((stop) => !stop.passed);
    const upcoming = ahead
      .map((stop) => {
        const coordinate = byAtco.get(stop.atcoCode);
        return coordinate ? { coordinate, name: stop.name } : null;
      })
      .filter(
        (entry): entry is { coordinate: { lat: number; lon: number }; name: string } =>
          entry !== null,
      );

    const last = ahead[ahead.length - 1];
    const lastCoordinate = last ? byAtco.get(last.atcoCode) : undefined;

    return {
      remaining,
      travelled,
      trail: traceSegments(data.recentTrace),
      upcoming,
      /*
       * The end of the matched pattern, and only when it is genuinely the end: `nextStops` is a
       * bounded window, so its last entry is the terminus only when the window reached it.
       */
      destination:
        last && lastCoordinate && data.nextStopsState === "ahead" && ahead.length < 40
          ? { coordinate: lastCoordinate, name: last.name }
          : null,
    };
  }, [selected.detail, stops]);

  /*
   * Fit the remaining route, when the passenger asks.
   *
   * Undefined rather than a no-op when there is nothing to fit, so the card can leave the control
   * out entirely instead of offering a button that does nothing.
   */
  const showWholeRoute = useMemo(() => {
    const remainingRoute = overlay?.remaining ?? [];
    if (remainingRoute.length < 2) return undefined;
    return () => {
      const box = boundsOfPath(remainingRoute);
      if (box) setFit({ bounds: box, nonce: Date.now() });
    };
  }, [overlay]);

  const observedAgeSeconds = useMemo(() => {
    if (!response?.meta.observedAt) return null;
    return Math.max(0, (now.getTime() - new Date(response.meta.observedAt).getTime()) / 1000);
  }, [response, now]);

  return (
    <div className="live-map">
      <div className="live-map__controls no-print">
        <h1 className="live-map__title">Live map</h1>

        <div className="live-map__control-row">
          {/*
           * One control, two jobs, and the label says which one it is doing.
           *
           * Before a fix it is an invitation; afterwards it is a recentre, which is what a
           * passenger who has panned across town actually wants from it. Disabled only while the
           * first request is outstanding — once a position is known, a press is instant, so
           * disabling it during the background refresh would make it feel broken.
           */}
          {locationStatus !== "unsupported" && (
            <button
              type="button"
              onClick={recentre}
              className="button-quiet"
              disabled={locationStatus === "requesting"}
            >
              {locationStatus === "requesting"
                ? "Finding you…"
                : location
                  ? "Centre on me"
                  : "Use my location"}
            </button>
          )}
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

        {/*
         * What happened, in the passenger's terms, and never instead of the map.
         *
         * Three outcomes that are genuinely different to somebody standing at a bus stop: they
         * said no, the device could not say, or this browser cannot. All three keep the map, the
         * layers and the search link exactly as they were — the only thing missing is the dot.
         */}
        {locationStatus === "denied" && (
          <p className="muted small" role="status">
            Location permission is not available, so the map is showing a default area. You can
            still search for a place, and pan the map anywhere.
          </p>
        )}
        {locationStatus === "unavailable" && (
          <p className="muted small" role="status">
            Your device could not work out where you are just now, so the map is showing a default
            area. Try the location button again, or search for a place.
          </p>
        )}
        {locationStatus === "unsupported" && (
          <p className="muted small" role="status">
            This browser cannot share your location, so the map is showing a default area. Search
            works without it.
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

        {/*
         * A failed data request is a notice beside the map, not instead of it.
         *
         * This was an `ErrorState` *replacing* the whole canvas, so one refused `/v1/map` left the
         * page with no basemap, no attribution, no stops and nothing to click — the deployed sweep
         * measured 0 bytes of rendered map and 0 stops drawn. The basemap and the camera do not
         * depend on our API at all, and a person can still pan, zoom and read where they are while
         * we retry. So the map stays and this says what is missing.
         */}
        {error && (
          <div className="live-map__notice state-block state-block--error" role="status">
            <p>
              {error instanceof ApiError && error.code === "bbox_too_large"
                ? "That area is too large to load at once. Zoom in and the map will update."
                : "We could not load stops and buses for this area. The map below is still yours to " +
                  "move; we tried three times, including a smaller area."}
            </p>
            <button type="button" className="button button--secondary" onClick={reload}>
              Try again
            </button>
          </div>
        )}

        {/*
         * Narrowed means the Worker refused the full view twice and answered for a quarter of it.
         * Said out loud, because a map that silently covers less than the screen is a map that
         * looks like a part of England with no buses in it.
         */}
        {outcome?.narrowed && (
          <p className="live-map__notice small" role="status">
            Only the middle of this view could be loaded, so stops near the edges are missing. Zoom
            in, or try again, for the rest.
          </p>
        )}

        {
          <>
            <div className="live-map__canvas">
              <MapView
                bounds={bounds}
                focus={focus}
                stops={stops}
                vehicles={vehicles}
                selectedStopId={selectedStop}
                selectedVehicleRef={selectedVehicle}
                degraded={response?.data.degraded ?? false}
                intent={
                  selectedStop ? { kind: "stop", atcoCode: selectedStop } : { kind: "explore" }
                }
                showStops={layers.stops}
                showVehicles={layers.vehicles}
                userLocation={location}
                selectedVehicleOverlay={overlay}
                fitBounds={fit}
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

              {/*
               * The same action, within reach of the map.
               *
               * The sidebar button is scrolled off the top of a phone by the time the canvas is
               * what somebody is looking at, so the recentre lives over the map as well — which is
               * where every map application puts it. A real `<button>` in the DOM, so it is in the
               * tab order and reads as a button, rather than a MapLibre control built out of divs.
               *
               * Bottom right, because MapLibre's zoom buttons are top left and the boards come in
               * from the right above it.
               */}
              {locationStatus !== "unsupported" && (
                <button
                  type="button"
                  className="live-map__recentre"
                  onClick={recentre}
                  disabled={locationStatus === "requesting"}
                  aria-label={location ? "Centre the map on your location" : "Use my location"}
                >
                  <span aria-hidden="true" className="live-map__recentre-mark" />
                </button>
              )}

              {selectedStop && (
                <SelectedStopBoard
                  key={selectedStop}
                  atcoCode={selectedStop}
                  /*
                   * Proximity, and nothing more.
                   *
                   * The board already fetches the stop, so it already knows where the stop is;
                   * handing it the passenger's coordinate lets it say "200 m from you" with one
                   * subtraction and no request. It says how far away the stop is — not which bus
                   * somebody wants, not which bus they are on, and not whether a bus is theirs.
                   */
                  userCoordinate={location?.coordinate ?? null}
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
                  /*
                   * The clamped box, which is the one the vehicle was actually returned in. The
                   * raw viewport can be larger than the API accepts, and a lookup in a box the
                   * API rejects is a bus that cannot be opened.
                   */
                  bounds={clamped}
                  onClose={() => setSelectedVehicle(null)}
                  detail={selected.detail}
                  loading={selected.loading}
                  error={selected.error}
                  onShowWholeRoute={showWholeRoute}
                />
              )}
            </div>

            {/*
              The list is the map's equal, not its fallback: it carries the same objects in the
              same order, with the same freshness and delay information.

              It needs an answer to describe, though — every line of it reports what the API said
              about this viewport — so unlike the canvas it waits for one. The canvas does not: a
              basemap a person can move is worth having while we ask again.
            */}
            {response && (
              <>
                {layers.vehicles && (
                  <section aria-labelledby="vehicles-heading" className="live-map__section">
                    <PixelSectionHeading
                      mark="bus"
                      id="vehicles-heading"
                      aside={<StateLozenge tone="live">{vehicles.length}</StateLozenge>}
                    >
                      Buses in view
                    </PixelSectionHeading>

                    {vehicles.length === 0 ? (
                      <EmptyState
                        art="bus"
                        title={
                          emptyVehicleReason(response.meta.sources, response.meta.degradation) ===
                          "london_has_no_positions"
                            ? "London does not put buses on the map"
                            : "No buses in view"
                        }
                        description={describeEmptyVehicles(
                          emptyVehicleReason(response.meta.sources, response.meta.degradation),
                        )}
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
                    <PixelSectionHeading
                      mark="stop"
                      id="stops-heading"
                      aside={<StateLozenge tone="neutral">{stops.length}</StateLozenge>}
                    >
                      Stops in view
                    </PixelSectionHeading>

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
                              {stop.indicator && (
                                <span className="muted small"> {stop.indicator}</span>
                              )}
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
          </>
        }
      </div>
    </div>
  );
}

export { distanceLabel };
