import { useEffect } from "react";
import { Link } from "react-router-dom";
import type { VehicleDetailResponse } from "@busstops/contracts";
import { useTicker } from "../lib/use-fetch.js";
import { LoadingBus } from "./LoadingBus.js";
import { delayLabel, formatLondonTime, freshnessLabel } from "../lib/format.js";
import { vehicleHref, type Bounds } from "../lib/geo.js";
import "./SelectedVehicleBoard.css";

/**
 * The panel for the bus selected on the live map.
 *
 * The buses were painted and inert. A passenger could watch the 36 crawl along the Headrow and
 * had no way to ask it anything — which route, going where, how late, what next — and the only
 * route to that information was a list underneath the map that did not say which item was the
 * bus they were pointing at.
 *
 * Opening it in place keeps the map and the viewport, the same reason the stop board works this
 * way. The link to the full vehicle page carries the viewport with it, because the live feeds are
 * area-scoped and a bare vehicle reference is not enough to find a bus with.
 *
 * Keyed by vehicle by the caller, so selecting a different bus remounts this and its state starts
 * clean rather than briefly showing one bus's stops under another's number.
 *
 * It no longer fetches. The map needs the same response — the scheduled shape, the progress along
 * it, the recent trail — and two components calling the same endpoint with the same arguments
 * would be two requests for one tap on the endpoint that reads a live feed. The page owns the
 * lookup (`useSelectedVehicle`) and hands the answer to both.
 */

const NEXT_STOPS_VISIBLE = 3;

export interface SelectedVehicleBoardProps {
  /** The viewport the bus was seen in; the links out of here carry it. */
  bounds: Bounds;
  onClose: () => void;
  /** The one selected-vehicle response, fetched by the page and shared with the map. */
  detail: VehicleDetailResponse | null;
  loading: boolean;
  error: string | null;
  /** Fit the remaining scheduled route into the viewport. Absent when there is no route to fit. */
  onShowWholeRoute?: (() => void) | undefined;
}

export function SelectedVehicleBoard({
  bounds,
  onClose,
  detail,
  loading,
  error,
  onShowWholeRoute,
}: SelectedVehicleBoardProps) {
  const response = detail;
  const now = useTicker(10_000);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const data = response?.data ?? null;
  const vehicle = data?.vehicle ?? null;
  const upcoming = (data?.nextStops ?? []).filter((stop) => !stop.passed);

  return (
    <aside className="selected-vehicle" aria-live="polite">
      <button
        type="button"
        className="selected-vehicle__close"
        onClick={onClose}
        aria-label="Close this bus"
      >
        ×
      </button>

      {error !== null && <p className="selected-vehicle__error">{error}</p>}

      {error === null && loading && <LoadingBus label="Loading this bus" compact />}

      {data && vehicle && (
        <>
          <header className="selected-vehicle__header">
            <span className="route-badge route-badge--inline">{data.routePublicName ?? "Bus"}</span>
            <h2 className="selected-vehicle__destination">
              {data.destinationName ?? "Destination not published"}
            </h2>
          </header>

          <dl className="selected-vehicle__facts">
            <div>
              <dt>Running</dt>
              <dd>{delayLabel(vehicle.delaySeconds)}</dd>
            </div>
            <div>
              <dt>Movement</dt>
              <dd>
                {vehicle.motionState === "stationary"
                  ? "Not moving"
                  : vehicle.motionState === "moving"
                    ? "Moving"
                    : "Not reported"}
              </dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>{freshnessLabel(vehicle.freshnessSeconds)}</dd>
            </div>
          </dl>

          {upcoming.length > 0 ? (
            <ol className="selected-vehicle__stops">
              {upcoming.slice(0, NEXT_STOPS_VISIBLE).map((stop, index) => (
                <li key={stop.stopId} className={index === 0 ? "is-next" : undefined}>
                  {index === 0 && <span className="selected-vehicle__next micro">Next stop</span>}
                  <Link to={`/stops/${stop.atcoCode}`}>{stop.name}</Link>
                  {stop.expectedTimeLow && (
                    <span className="muted small">
                      {" "}
                      <time dateTime={stop.expectedTimeLow}>
                        {formatLondonTime(new Date(stop.expectedTimeLow))}
                      </time>
                    </span>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            /*
             * Said plainly, and said differently for each cause.
             *
             * One sentence used to cover every empty list, which made a bus sitting at its
             * terminus and a bus we could not identify at all read as the same thing. They are
             * not, and the third case — route known, position not — is different again. An empty
             * list on its own reads as "this bus is not going anywhere", which is true of none of
             * them.
             */
            <p className="muted small">
              {data.nextStopsState === "end_of_route"
                ? "This bus has no more stops: it has reached the end of the journey it was matched to."
                : data.nextStopsState === "progress_unknown"
                  ? "We know which route this bus is on, but cannot place it along the route confidently enough to say which stops come next."
                  : "We can see this bus, but cannot confidently match it to a timetabled journey yet, so we cannot say which stops it calls at next."}
            </p>
          )}

          {/*
           * Which line is which, said in words.
           *
           * Two blue lines appear on the map for a selected bus and they mean opposite kinds of
           * thing: one is a plan and one is an observation. A passenger should never have to work
           * that out from the styling, and the styling alone cannot say it to somebody who cannot
           * see the difference between two blues. Each row appears only when that line is actually
           * drawn, so the legend never explains something that is not there.
           */}
          {(data.scheduledShape.length > 1 || data.recentTrace.length > 1) && (
            <ul className="selected-vehicle__legend micro">
              {data.scheduledShape.length > 1 && (
                <li>
                  <span
                    aria-hidden="true"
                    className="selected-vehicle__key selected-vehicle__key--scheduled"
                  />
                  Scheduled route — where it is due to go
                </li>
              )}
              {data.recentTrace.length > 1 && (
                <li>
                  <span
                    aria-hidden="true"
                    className="selected-vehicle__key selected-vehicle__key--observed"
                  />
                  Recent observed path — where it has just been
                </li>
              )}
            </ul>
          )}

          {onShowWholeRoute && data.scheduledShape.length > 1 && (
            /*
             * Offered rather than done to you. Selecting a bus must not drag the camera off what
             * the passenger was looking at, so fitting the route is a thing they ask for.
             */
            <button
              type="button"
              className="button-quiet selected-vehicle__whole-route"
              onClick={onShowWholeRoute}
            >
              Show whole route
            </button>
          )}

          <p className="selected-vehicle__links">
            <Link to={vehicleHref(vehicle.vehicleRef, { bounds })}>Everything about this bus</Link>
            {/*
              By identity, never by the number on the front. `routeId` is null when the viewport
              could not say which operator's service this is, and then there is no link — a link
              to somebody else's 36 is worse than no link.
            */}
            {data.routeId && (
              <>
                {" · "}
                <Link to={`/routes/${encodeURIComponent(data.routeId)}`}>
                  The {data.routePublicName ?? "route"} route
                </Link>
              </>
            )}
          </p>

          <p className="selected-vehicle__caveat micro muted">
            Vehicle references rotate daily, so a link to this bus will stop working. Position read{" "}
            {freshnessLabel(vehicle.freshnessSeconds)}, {now.toLocaleTimeString("en-GB")}.
          </p>
        </>
      )}
    </aside>
  );
}
