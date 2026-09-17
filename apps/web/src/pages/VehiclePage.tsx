import { useCallback, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { VehicleDetailResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { BusStoppedPanel } from "../components/BusStoppedPanel.js";
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

  const { vehicle, routePublicName, routeId, destinationName, nextStops, scheduledShape } =
    response.data;
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

      <section className="vehicle-page__facts" aria-label="Current status">
        <div>
          <span className="vehicle-page__fact-label">Punctuality</span>
          <span className="vehicle-page__fact-value">
            {vehicle.delaySeconds === null ? "Not known" : delayLabel(vehicle.delaySeconds)}
          </span>
        </div>
        <div>
          <span className="vehicle-page__fact-label">Movement</span>
          <span className="vehicle-page__fact-value">
            {vehicle.motionState === "moving"
              ? "Moving"
              : vehicle.motionState === "stationary"
                ? "Stationary"
                : "Not known"}
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
                  <Link to={`/stops/${stop.stopId}`}>{stop.name}</Link>
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

      <section aria-labelledby="vehicle-help-heading" className="vehicle-page__section">
        <h2 id="vehicle-help-heading">Not moving?</h2>
        {showStoppedPanel ? (
          <BusStoppedPanel
            vehicle={vehicle}
            otherVehiclesMoving={null}
            otherVehiclesObserved={0}
            incidents={response.data.incidents}
            nearEndOfRoute={false}
            now={now}
            nextServices={[]}
            alternativeStop={null}
            walkingUrl={null}
            operatorContactUrl={null}
            operatorName={null}
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
