import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { VehicleDetailResponse } from "@busstops/contracts";
import { apiClient, ApiError } from "../lib/api.js";
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
 */

const NEXT_STOPS_VISIBLE = 3;

export interface SelectedVehicleBoardProps {
  vehicleRef: string;
  /** The viewport the bus was seen in; the lookup is area-scoped and needs it. */
  bounds: Bounds;
  onClose: () => void;
}

export function SelectedVehicleBoard({ vehicleRef, bounds, onClose }: SelectedVehicleBoardProps) {
  const [response, setResponse] = useState<VehicleDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useTicker(10_000);

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .vehicle(vehicleRef, bounds, controller.signal)
      .then(setResponse)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof ApiError
            ? cause.message
            : "This bus could not be loaded. The map is still usable.",
        );
      });
    return () => controller.abort();
    // The bounds object is rebuilt each render, so depend on its values rather than its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleRef, bounds.west, bounds.south, bounds.east, bounds.north]);

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

      {error === null && response === null && <LoadingBus label="Loading this bus" compact />}

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
              {upcoming.slice(0, NEXT_STOPS_VISIBLE).map((stop) => (
                <li key={stop.stopId}>
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
             * Said plainly rather than left blank. A bus we have a position for but no matched
             * journey for genuinely has no next stops to give, and an empty list reads as "this
             * bus is not going anywhere".
             */
            <p className="muted small">
              We could not match this bus to a timetabled journey, so we cannot say which stops it
              calls at next.
            </p>
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
