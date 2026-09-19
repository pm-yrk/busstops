import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { VehicleDetailResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { BusStoppedPanel } from "../components/BusStoppedPanel.js";
import { OfficialNotices } from "../components/OfficialNotices.js";
import {
  ConfidenceChip,
  DataAge,
  EmptyState,
  ErrorState,
  RouteBadge,
  ServiceBanner,
  StateLozenge,
} from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch, useTicker } from "../lib/use-fetch.js";
import { delayLabel } from "../lib/format.js";
import { haversineMetresBrowser } from "../lib/geo.js";
import { savedPlatform, suggestPlatform, walkingUrlFor } from "../lib/navigation-handoff.js";
import type { MapResponse, StopDeparturesResponse } from "@busstops/contracts";
import "./VehiclePage.css";

/**
 * Vehicle page (docs/03_SITE_MAP_AND_UX.md "Vehicle", docs/09_BUS_STOPS_LIVE.md "Tracking").
 *
 * Two things this page will not do. It will not present a stable public identifier for a bus:
 * the reference shown is the daily-rotating opaque one, and an old link is expected to stop
 * working. And it will not assert why a bus has stopped — that is what the Bus Stopped? panel is
 * for, and it lists candidates rather than picking one.
 */

const REFRESH_INTERVAL_MS = 20_000;
const LOADING_TIMEOUT_MS = 8_000;
const NEXT_STOPS_VISIBLE = 4;

export function VehiclePage() {
  const { vehicleRef = "" } = useParams();
  const [searchParams] = useSearchParams();
  const [showAllStops, setShowAllStops] = useState(false);
  const [showStoppedPanel, setShowStoppedPanel] = useState(false);

  const bbox = useMemo(() => {
    const raw = searchParams.get("bbox");
    if (!raw) return null;
    const parts = raw.split(",").map(Number);
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
    return { west: parts[0]!, south: parts[1]!, east: parts[2]!, north: parts[3]! };
  }, [searchParams]);

  const fetcher = useCallback(
    (signal: AbortSignal) => {
      if (!bbox) return Promise.reject(new Error("no viewport"));
      return apiClient.vehicle(vehicleRef, bbox, signal);
    },
    [vehicleRef, bbox],
  );

  const {
    data: response,
    error,
    loading,
    timedOut,
    reload,
  } = useFetch<VehicleDetailResponse>(fetcher, {
    timeoutMs: LOADING_TIMEOUT_MS,
    refreshMs: REFRESH_INTERVAL_MS,
    enabled: vehicleRef.length > 0 && bbox !== null,
  });

  const now = useTicker();

  /*
   * What "Bus Stopped?" actually knows, fetched only when someone asks.
   *
   * The panel was given `otherVehiclesMoving={null}`, `otherVehiclesObserved={0}`,
   * `nextServices={[]}` and `alternativeStop={null}` — hard-coded, so its reasoning could never
   * fire and a passenger was told "we cannot tell why" by construction. Every one of those facts
   * is available from endpoints this page can already reach: the viewport it was found in has the
   * other buses and the nearby stops, and the stop it is heading for has a departure board.
   *
   * Behind the button, because none of it is worth fetching for somebody whose bus is fine.
   */
  interface StoppedContext {
    peers: number;
    peersMoving: boolean | null;
    alternative: {
      id: string;
      name: string;
      walkingMinutes: number;
      lat: number;
      lon: number;
    } | null;
    nextServices: Array<{
      routeName: string;
      destination: string;
      expectedTime: string;
      live: boolean;
    }>;
  }

  /** Bumped by "Try again", which is the only thing that re-runs a lookup that failed. */
  const [contextAttempt, setContextAttempt] = useState(0);
  /*
   * The result carries the lookup it belongs to.
   *
   * "Still looking" has to be distinguishable from "looked and found nothing", and the obvious way
   * — setting a loading flag as the effect starts — is a second render for a fact already on hand.
   * Stamping the answer with its key means the three states are read off what is stored rather
   * than tracked alongside it, and a stale answer from the previous viewport cannot be mistaken
   * for this one's.
   */
  const [stored, setStored] = useState<{ key: string; context: StoppedContext | null } | null>(
    null,
  );

  const vehicleState = response?.data.vehicle ?? null;
  const nextStops = useMemo(() => response?.data.nextStops ?? [], [response]);

  const contextKey = `${vehicleState?.vehicleRef ?? ""}|${
    bbox ? `${bbox.west},${bbox.south},${bbox.east},${bbox.north}` : ""
  }|${contextAttempt}`;
  const settled = stored?.key === contextKey ? stored : null;
  const context = settled?.context ?? null;
  const contextState: "loading" | "ready" | "unavailable" =
    settled === null ? "loading" : settled.context === null ? "unavailable" : "ready";

  useEffect(() => {
    if (!showStoppedPanel || !bbox || !vehicleState) return;
    const controller = new AbortController();

    void (async () => {
      try {
        const map = (await apiClient.map(bbox, 15, controller.signal)) as MapResponse;

        /*
         * Other buses near this one, which is the fact that separates a jam from a breakdown.
         *
         * Eight hundred metres: close enough to be on the same road, far enough to contain more
         * than one vehicle. Anything further is a different street and tells you nothing.
         */
        const here = vehicleState.position;
        const peers = map.data.vehicles.filter(
          (other) =>
            other.vehicleRef !== vehicleState.vehicleRef &&
            haversineMetresBrowser(here, other.coordinate) <= 800,
        );
        const moving = peers.filter((other) => other.motionState === "moving").length;

        // The nearest stop that is not the one this bus is heading to.
        const upcoming = new Set(nextStops.filter((stop) => !stop.passed).map((s) => s.atcoCode));
        const nearest = map.data.stops
          .filter((stop) => !upcoming.has(stop.atcoCode))
          .map((stop) => ({ stop, metres: haversineMetresBrowser(here, stop.coordinate) }))
          .sort((a, b) => a.metres - b.metres)[0];

        let nextServices: Array<{
          routeName: string;
          destination: string;
          expectedTime: string;
          live: boolean;
        }> = [];
        const heading = nextStops.find((stop) => !stop.passed);
        if (heading) {
          const board = (await apiClient.stop(
            heading.atcoCode,
            controller.signal,
          )) as StopDeparturesResponse;
          nextServices = board.data.departures
            .filter((departure) => departure.expectedTime !== null)
            .slice(0, 4)
            .map((departure) => ({
              routeName: departure.serviceRoutePublicName,
              destination: departure.destinationName,
              expectedTime: departure.expectedTime!,
              live: departure.liveState === "live" || departure.liveState === "estimated",
            }));
        }

        const gathered: StoppedContext = {
          peers: peers.length,
          // Null when there is nothing nearby to compare against: zero buses is not evidence that
          // nothing is moving, and the panel reasons differently about the two.
          peersMoving: peers.length === 0 ? null : moving > 0,
          alternative: nearest
            ? {
                id: nearest.stop.atcoCode,
                name: nearest.stop.name,
                // A brisk 1.3 m/s, the same pace the journey planner walks at.
                walkingMinutes: Math.max(1, Math.round(nearest.metres / 1.3 / 60)),
                lat: nearest.stop.coordinate.lat,
                lon: nearest.stop.coordinate.lon,
              }
            : null,
          nextServices,
        };
        setStored({ key: contextKey, context: gathered });
      } catch {
        /*
         * The panel is help, not a promise, so a failed lookup does not put an error over a page
         * that is working. It does have to be distinguishable from an empty answer: clearing the
         * context alone left the panel saying "no other departures to suggest" about a board it
         * had never managed to read.
         */
        if (!controller.signal.aborted) setStored({ key: contextKey, context: null });
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showStoppedPanel,
    vehicleState?.vehicleRef,
    bbox?.west,
    bbox?.south,
    bbox?.east,
    bbox?.north,
    contextAttempt,
    contextKey,
  ]);

  const alternativeWalkingUrl = useMemo(() => {
    if (!context?.alternative) return null;
    const platform = savedPlatform() ?? suggestPlatform(globalThis.navigator?.userAgent ?? "");
    return walkingUrlFor(platform, {
      lat: context.alternative.lat,
      lon: context.alternative.lon,
      label: context.alternative.name,
    });
  }, [context]);

  if (!bbox) {
    return (
      <EmptyState
        art="front"
        title="This link needs a map area"
        description="Buses are looked up within the part of the map you were viewing, because the live feeds are area-based. Open the bus from the live map or a route page."
        action={<Link to="/live">Go to the live map</Link>}
      />
    );
  }

  if (loading && !response) {
    return <LoadingBus label="Loading bus" timedOut={timedOut} />;
  }

  if (error || !response) {
    return (
      <ErrorState
        title="We could not find this bus"
        description={
          error?.message ??
          "This bus is no longer reporting a position. Bus references change every day, so links do not last."
        }
        onRetry={reload}
      />
    );
  }

  const { vehicle, routePublicName, routeId, destinationName, scheduledShape } = response.data;
  const visibleStops = showAllStops ? nextStops : nextStops.slice(0, NEXT_STOPS_VISIBLE);

  return (
    <article className="page vehicle-page">
      <ServiceBanner meta={response.meta} />

      <header className="vehicle-page__header">
        {routePublicName ? <RouteBadge name={routePublicName} /> : null}
        <div>
          <h1>{destinationName ?? "Destination not published"}</h1>
          <p className="muted">
            {/*
              The link is built from the service id, never from the number on the front.

              It was `/routes/${routePublicName}` — the route endpoint looks a service up by its
              published identifier, so "Route 36" pointed at `/routes/36` and every one of these
              links was a guaranteed 404. `routeId` is null when the match was not confident
              enough to name the service, and then the number is shown as text: a passenger
              reading "36" with no link is told the truth, and a link to a route we are not sure
              about is not.
            */}
            {routePublicName && routeId ? (
              <>
                Route <Link to={`/routes/${encodeURIComponent(routeId)}`}>{routePublicName}</Link>
              </>
            ) : routePublicName ? (
              <>Route {routePublicName} — we could not confirm which service this is.</>
            ) : (
              "We could not match this bus to a route confidently."
            )}
          </p>
        </div>
        <DataAge seconds={vehicle.freshnessSeconds} prefix="Last seen" />
      </header>

      {/*
        "Not known" is what a broken site says. This says which.
 
        Both of these are null for almost every bus, and it is worth writing down why, because it
        is not a gap we can close by trying harder. The captured BODS SIRI-VM response carries
        `VehicleLocation`, `Bearing`, `LineRef`, `OperatorRef`, origin and destination, and the
        journey refs — and no `Velocity`, no `Delay`, no `MonitoredCall` and no `OnwardCalls`.
        There is nothing in the feed to derive a delay or a speed from, so the adapter parses
        everything that is published and the Worker reports null honestly.
 
        A passenger reading "Not known" concludes the site is broken. A passenger reading "this
        operator's feed does not publish it" has learned something true about the data, which is
        the whole posture of the product.
      */}
      <section className="vehicle-page__facts" aria-label="Current status">
        <div>
          <span className="vehicle-page__fact-label">Punctuality</span>
          <span className="vehicle-page__fact-value">
            {vehicle.delaySeconds === null ? (
              <span className="muted small">Not published by this feed</span>
            ) : (
              delayLabel(vehicle.delaySeconds)
            )}
          </span>
        </div>
        <div>
          <span className="vehicle-page__fact-label">Movement</span>
          <span className="vehicle-page__fact-value">
            {vehicle.motionState === "moving" ? (
              "Moving"
            ) : vehicle.motionState === "stationary" ? (
              "Stationary"
            ) : (
              <span className="muted small">No speed in this feed</span>
            )}
          </span>
        </div>
        <div>
          <span className="vehicle-page__fact-label">Match confidence</span>
          <ConfidenceChip confidence={vehicle.matchConfidence} />
        </div>
      </section>

      <section aria-labelledby="vehicle-stops-heading" className="vehicle-page__section">
        <h2 id="vehicle-stops-heading">Stops ahead</h2>
        {visibleStops.length > 0 ? (
          <>
            <ol className="vehicle-page__stops">
              {visibleStops.map((stop) => (
                <li key={stop.stopId} className={stop.passed ? "is-passed" : ""}>
                  <Link to={`/stops/${encodeURIComponent(stop.atcoCode)}`}>{stop.name}</Link>
                  <span className="muted small">
                    {stop.expectedTimeLow && stop.expectedTimeHigh
                      ? `between ${new Date(stop.expectedTimeLow).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} and ${new Date(stop.expectedTimeHigh).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
                      : "no predicted time"}
                  </span>
                </li>
              ))}
            </ol>
            {nextStops.length > NEXT_STOPS_VISIBLE ? (
              <button
                type="button"
                className="vehicle-page__toggle"
                onClick={() => setShowAllStops((value) => !value)}
                aria-expanded={showAllStops}
              >
                {showAllStops
                  ? "Show fewer stops"
                  : `Show all ${nextStops.length} stops on this route`}
              </button>
            ) : null}
          </>
        ) : (
          <EmptyState
            art="bus"
            title="No stop sequence to show"
            description="We could not match this bus to a published route with enough confidence to list its stops. Showing a guessed sequence would be worse than showing none."
          />
        )}
      </section>

      <section aria-labelledby="vehicle-path-heading" className="vehicle-page__section">
        <h2 id="vehicle-path-heading">Where it has been</h2>
        <p className="muted small">
          {scheduledShape.length > 0
            ? "The scheduled route shape is published; the actual path travelled is held only in the bounded analysis window and is not served here."
            : "No scheduled shape is published for this route."}
        </p>
      </section>

      {/*
        What has been announced about this bus's route.

        The panel below reasons from what can be observed — where the bus is, whether its peers
        are moving — and an operator's own notice is the one thing that can explain it outright.
        It was not being read at all on this endpoint, so a diverted route looked like a stationary
        bus with no explanation.
      */}
      {response.data.disruptions.length > 0 ? (
        <OfficialNotices
          notices={response.data.disruptions}
          sourcesQueried={[]}
          collectedAt={response.meta.observedAt}
          headingId="vehicle-official-now"
        />
      ) : null}

      <section aria-labelledby="vehicle-help-heading" className="vehicle-page__section">
        <h2 id="vehicle-help-heading">Not moving?</h2>
        {showStoppedPanel ? (
          <BusStoppedPanel
            vehicle={vehicle}
            contextState={contextState}
            onRetryContext={() => setContextAttempt((attempt) => attempt + 1)}
            otherVehiclesMoving={context?.peersMoving ?? null}
            otherVehiclesObserved={context?.peers ?? 0}
            incidents={response.data.incidents}
            /*
             * Near the end when two or fewer calls remain. A bus that has finished its run and is
             * standing at the terminus is the commonest reason a vehicle stops moving, and it is
             * not a fault — saying so stops the panel offering alternatives to somebody whose bus
             * has simply arrived.
             */
            nearEndOfRoute={nextStops.filter((stop) => !stop.passed).length <= 2}
            now={now}
            nextServices={context?.nextServices ?? []}
            alternativeStop={
              context?.alternative
                ? {
                    id: context.alternative.id,
                    name: context.alternative.name,
                    walkingMinutes: context.alternative.walkingMinutes,
                  }
                : null
            }
            walkingUrl={alternativeWalkingUrl}
            /*
             * Who to contact, when the observation matched a service and the service named an
             * operator. Both of these were literal nulls: the panel offered to put somebody in
             * touch with an operator it had never looked up.
             */
            operatorContactUrl={response.data.operator?.contactUrl ?? null}
            operatorName={response.data.operator?.name ?? null}
            onDismiss={() => setShowStoppedPanel(false)}
          />
        ) : (
          <button
            type="button"
            className="vehicle-page__stopped-trigger"
            onClick={() => setShowStoppedPanel(true)}
          >
            Bus stopped? See what we can tell you
          </button>
        )}
      </section>

      <footer className="vehicle-page__footer">
        <StateLozenge tone="neutral">Reference rotates daily</StateLozenge>
        <p className="muted small">
          This bus has no permanent public identifier. The reference in this link is rotated every
          service day so journeys cannot be followed from one day to the next.
        </p>
      </footer>
    </article>
  );
}
