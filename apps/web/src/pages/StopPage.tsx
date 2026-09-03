import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { StopDeparturesResponse } from "@busstops/contracts";
import { ArrivalBoard } from "../components/ArrivalBoard.js";
import { LoadingBus } from "../components/LoadingBus.js";
import {
  ConfidenceChip,
  DataAge,
  EmptyState,
  ErrorState,
  ServiceBanner,
  StateLozenge,
} from "../components/primitives.js";
import { WillIMakeItPanel } from "../components/WillIMakeItPanel.js";
import { apiClient, ApiError } from "../lib/api.js";
import { useFetch, useTicker } from "../lib/use-fetch.js";
import { formatLondonTime, walkingMinutes } from "../lib/format.js";
import { isFavourited, toggleFavourite } from "../lib/favourites.js";
import { savedPlatform, suggestPlatform, walkingUrlFor } from "../lib/navigation-handoff.js";
import { EXTERNAL_LINK_ATTRIBUTES } from "../lib/tickets.js";
import "./StopPage.css";

/**
 * Stop page (docs/03_SITE_MAP_AND_UX.md "Stop").
 *
 * Shows the pixel arrival board first, then full departures with live and timetable-only rows
 * clearly separated, the stop's identity and sources, a favourite control that works without an
 * account, and walking directions handed off to the user's maps app.
 */

const REFRESH_INTERVAL_MS = 30_000;
const LOADING_TIMEOUT_MS = 8_000;

export function StopPage() {
  const { stopId = "" } = useParams();
  const [storageBlocked, setStorageBlocked] = useState(false);

  const fetcher = useCallback((signal: AbortSignal) => apiClient.stop(stopId, signal), [stopId]);
  const {
    data: response,
    error,
    loading,
    timedOut: loadingTimedOut,
    reload,
  } = useFetch<StopDeparturesResponse>(fetcher, {
    timeoutMs: LOADING_TIMEOUT_MS,
    refreshMs: REFRESH_INTERVAL_MS,
    enabled: stopId.length > 0,
  });

  const now = useTicker();

  // Favourite state is derived from storage during render, with the stop id as the reset key,
  // rather than synchronised through an effect that would render twice on every navigation.
  const [favouriteState, setFavouriteState] = useState(() => ({
    stopId,
    favourited: isFavourited("stop", stopId),
  }));
  if (favouriteState.stopId !== stopId) {
    setFavouriteState({ stopId, favourited: isFavourited("stop", stopId) });
  }
  const favourited = favouriteState.favourited;

  const ageSeconds = useMemo(() => {
    if (!response?.meta.observedAt) return null;
    return Math.max(0, (now.getTime() - new Date(response.meta.observedAt).getTime()) / 1000);
  }, [response, now]);

  const stop = response?.data.stop;

  const walkingUrl = useMemo(() => {
    if (!stop) return null;
    const platform = savedPlatform() ?? suggestPlatform(globalThis.navigator?.userAgent ?? "");
    return walkingUrlFor(platform, {
      lat: stop.locationCoordinate.lat,
      lon: stop.locationCoordinate.lon,
      label: stop.name,
    });
  }, [stop]);

  if (loading && !response) {
    return (
      <div className="page">
        <LoadingBus label="Loading departures" timedOut={loadingTimedOut} />
      </div>
    );
  }

  if (error) {
    const isNotFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="page">
        {isNotFound ? (
          <EmptyState
            title="We could not find that stop"
            description="The link may be out of date, or the stop may have been withdrawn. Try searching for it by name or code."
            action={
              <Link to="/search" className="button-primary">
                Search for a stop
              </Link>
            }
          />
        ) : (
          <ErrorState
            description={
              error instanceof ApiError && error.status === 503
                ? "Stop information is not available right now. This is usually temporary."
                : "We could not load departures for this stop."
            }
            onRetry={reload}
          />
        )}
      </div>
    );
  }

  if (!response || !stop) return null;

  const { departures } = response.data;
  const liveDepartures = departures.filter(
    (d) => d.liveState === "live" || d.liveState === "estimated",
  );
  const timetableDepartures = departures.filter(
    (d) => d.liveState === "scheduled_only" || d.liveState === "no_service",
  );

  const handleFavourite = () => {
    const stored = toggleFavourite({
      kind: "stop",
      id: stop.atcoCode,
      title: stop.name,
      ...(stop.indicator === undefined ? {} : { subtitle: stop.indicator }),
    });
    setStorageBlocked(!stored);
    setFavouriteState({ stopId, favourited: isFavourited("stop", stop.atcoCode) });
  };

  return (
    <div className="page stop-page">
      <ServiceBanner meta={response.meta} />

      <nav aria-label="Breadcrumb" className="stop-page__breadcrumb small">
        <Link to="/live">Live map</Link> <span aria-hidden="true">/</span> <span>{stop.name}</span>
      </nav>

      <ArrivalBoard
        stopName={stop.name}
        stopCode={stop.naptanCode ?? stop.atcoCode}
        departures={departures}
        now={now}
        ageSeconds={ageSeconds}
        degraded={response.meta.degradation !== "normal"}
      />

      <div className="stop-page__actions">
        <button
          type="button"
          onClick={handleFavourite}
          aria-pressed={favourited}
          className={favourited ? "button-primary" : ""}
        >
          {favourited ? "Saved" : "Save this stop"}
        </button>

        {walkingUrl && (
          <a className="stop-page__walk" href={walkingUrl} {...EXTERNAL_LINK_ATTRIBUTES}>
            Walking directions
            <span className="visually-hidden"> (opens your maps app in a new tab)</span>
          </a>
        )}
      </div>

      {storageBlocked && (
        <p className="stop-page__storage-note small muted" role="status">
          We could not save this stop on this device. Saving needs site data to be allowed, and
          nothing is sent to us either way.
        </p>
      )}

      <WillIMakeItPanel departures={departures} stop={stop} now={now} />

      <section className="stop-page__departures" aria-labelledby="all-departures-heading">
        <h2 id="all-departures-heading">All departures</h2>

        {departures.length === 0 ? (
          <EmptyState
            title="No departures to show"
            description={
              response.meta.degradation === "scheduled_only"
                ? "Live tracking is unavailable for this stop right now, and we have no timetabled departures in the next hour."
                : "There are no departures from this stop in the next hour."
            }
          />
        ) : (
          <>
            {liveDepartures.length > 0 && (
              <DepartureList
                heading="Live"
                description="Predicted from the operator's own live data."
                departures={liveDepartures}
                now={now}
              />
            )}
            {timetableDepartures.length > 0 && (
              <DepartureList
                heading="Timetable only"
                description="No live data for these journeys, so these are the scheduled times."
                departures={timetableDepartures}
                now={now}
              />
            )}
          </>
        )}
      </section>

      <section className="stop-page__details" aria-labelledby="stop-details-heading">
        <h2 id="stop-details-heading">About this stop</h2>
        <dl className="stop-page__facts">
          <div>
            <dt>NaPTAN code</dt>
            <dd>{stop.atcoCode}</dd>
          </div>
          {stop.naptanCode && (
            <div>
              <dt>SMS code</dt>
              <dd>{stop.naptanCode}</dd>
            </div>
          )}
          {stop.indicator && (
            <div>
              <dt>Stand</dt>
              <dd>{stop.indicator}</dd>
            </div>
          )}
          <div>
            <dt>Position</dt>
            <dd>
              {stop.locationCoordinate.lat.toFixed(5)}, {stop.locationCoordinate.lon.toFixed(5)}
            </dd>
          </div>
        </dl>

        {/* Amenities are shown only when a source states them; nothing is inferred. */}
        {stop.amenities.length === 0 ? (
          <p className="muted small">
            We do not have sourced accessibility or facilities information for this stop, so none is
            shown.
          </p>
        ) : (
          <ul className="stop-page__amenities">
            {stop.amenities.map((amenity) => (
              <li key={amenity.key}>
                {amenity.key.replace(/_/g, " ")} — {amenity.value ? "yes" : "no"}{" "}
                <span className="muted small">({amenity.provenance})</span>
              </li>
            ))}
          </ul>
        )}

        <p className="stop-page__sources small muted">
          Sources: {response.meta.sources.map((s) => s.source).join(", ") || "timetable data"}.{" "}
          <DataAge seconds={ageSeconds} />
        </p>
      </section>
    </div>
  );
}

function DepartureList({
  heading,
  description,
  departures,
  now,
}: {
  heading: string;
  description: string;
  departures: StopDeparturesResponse["data"]["departures"];
  now: Date;
}) {
  return (
    <div className="departure-list">
      <h3 className="departure-list__heading">
        {heading}{" "}
        <StateLozenge tone={heading === "Live" ? "live" : "neutral"}>
          {departures.length}
        </StateLozenge>
      </h3>
      <p className="muted small">{description}</p>

      <ul className="departure-list__items">
        {departures.map((departure) => {
          const time = departure.expectedTime ?? departure.scheduledTime;
          const minutes = time
            ? Math.max(0, Math.round((new Date(time).getTime() - now.getTime()) / 60000))
            : null;
          return (
            <li key={departure.id} className="departure-list__item surface">
              <span className="route-badge route-badge--inline">
                {departure.serviceRoutePublicName}
              </span>
              <span className="departure-list__destination">{departure.destinationName}</span>
              <span className="departure-list__time">
                {time ? (
                  <>
                    <strong>{minutes === 0 ? "Due" : `${minutes} min`}</strong>
                    <span className="muted small"> {formatLondonTime(new Date(time))}</span>
                  </>
                ) : (
                  <span className="muted">Time unavailable</span>
                )}
              </span>
              <span className="departure-list__confidence">
                <ConfidenceChip confidence={departure.confidence} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export { walkingMinutes };
