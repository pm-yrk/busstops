import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { StopDeparturesResponse } from "@busstops/contracts";
import { AccessibilityCard } from "../components/AccessibilityCard.js";
import { ArrivalBoard } from "../components/ArrivalBoard.js";
import { OfficialNotices } from "../components/OfficialNotices.js";
import { LoadingBus } from "../components/LoadingBus.js";
import {
  ConfidenceChip,
  DataAge,
  EmptyState,
  ErrorState,
  ServiceBanner,
  StateLozenge,
} from "../components/primitives.js";
import { PixelSectionHeading } from "../components/pixel/PixelSectionHeading.js";
import { WeatherVignette } from "../components/WeatherVignette.js";
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

  const ageSeconds = useMemo(() => {
    if (!response?.meta.observedAt) return null;
    return Math.max(0, (now.getTime() - new Date(response.meta.observedAt).getTime()) / 1000);
  }, [response, now]);

  const stop = response?.data.stop;

  /*
   * Favourites are keyed on the ATCO code, which is the stop's canonical public identity and the
   * only key that is stable whichever form of URL the visitor arrived by. Reading and writing must
   * use the same key: keying the write on the ATCO code while reading by the URL parameter meant a
   * saved stop silently never showed as saved.
   *
   * The key is only known once the stop has loaded, so the flag is derived from the loaded stop
   * rather than seeded from the URL, with a counter to re-read storage after a toggle.
   */
  const [favouriteState, setFavouriteState] = useState<{
    atcoCode: string | null;
    favourited: boolean;
  }>({ atcoCode: null, favourited: false });

  // Derived during render with the ATCO code as the reset key, rather than through an effect that
  // would render twice on every navigation.
  if (stop && favouriteState.atcoCode !== stop.atcoCode) {
    setFavouriteState({ atcoCode: stop.atcoCode, favourited: isFavourited("stop", stop.atcoCode) });
  }
  const favourited = favouriteState.favourited;

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
            art="bus"
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
    setFavouriteState({ atcoCode: stop.atcoCode, favourited: isFavourited("stop", stop.atcoCode) });
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

      {response.data.disruptions.length > 0 ? (
        <OfficialNotices
          notices={response.data.disruptions}
          sourcesQueried={[]}
          collectedAt={response.meta.observedAt}
          headingId="stop-official-now"
        />
      ) : null}

      <div className="stop-page__actions">
        <button
          type="button"
          onClick={handleFavourite}
          aria-pressed={favourited}
          className={favourited ? "button-primary" : ""}
        >
          {favourited ? "Saved" : "Save this stop"}
        </button>

        {/* Carries the stop through to the planner, which is how a destination chosen on the
            map or from a stop reaches it. */}
        <Link
          className="stop-page__plan"
          to={`/journey?toLat=${stop.locationCoordinate.lat.toFixed(5)}&toLon=${stop.locationCoordinate.lon.toFixed(5)}&toLabel=${encodeURIComponent(stop.name)}`}
        >
          Plan a journey here
        </Link>

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
        <PixelSectionHeading mark="clock" id="all-departures-heading">
          All departures
        </PixelSectionHeading>

        {departures.length === 0 ? (
          <EmptyState
            art="bus"
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

      {/*
       * What it is like standing here — the stop page's picture, and this is where it belongs.
       *
       * It was briefly in the map's click panel as well. That panel is a board: somebody who taps
       * a stop on a map wants the next bus, and a 384-pixel illustration above the fold pushes
       * the one thing they came for underneath it. The full page is where there is room to be
       * generous, and it is what "Everything about this stop" promises.
       *
       * Always drawn, never gated on there being a reading. The weather job publishes a degree
       * square at a time and a square it has not reached has none — but hiding the section then
       * leaves a hole where the page's only illustration should be, which reads as broken rather
       * than as unmeasured. The vignette draws the shelter and the person in a neutral state and
       * says so in words. Nothing about the sky is invented.
       */}
      <section className="stop-page__weather" aria-labelledby="stop-weather-heading">
        <PixelSectionHeading mark="weather" id="stop-weather-heading">
          At the stop
        </PixelSectionHeading>
        <WeatherVignette
          weather={response.data.weather ?? null}
          atcoCode={stop.atcoCode}
          now={now}
          /*
           * Drawn only when a bus genuinely is due. `expectedTime` is the live or estimated time,
           * so a bus inside the quarter hour is one a passenger can expect to see — and a bus in
           * the picture when none is coming would be the artwork telling a lie the rest of the
           * page is careful not to.
           */
          busApproaching={departures.some((departure) => {
            if (!departure.expectedTime) return false;
            const minutes = (Date.parse(departure.expectedTime) - now.getTime()) / 60_000;
            return minutes >= 0 && minutes <= 15;
          })}
        />
      </section>

      <AccessibilityCard accessibility={response.data.accessibility} />

      <section className="stop-page__details" aria-labelledby="stop-details-heading">
        <PixelSectionHeading mark="stop" id="stop-details-heading">
          About this stop
        </PixelSectionHeading>
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
      <PixelSectionHeading
        level={3}
        mark={heading === "Live" ? "bus" : "clock"}
        className="departure-list__heading"
        aside={
          <StateLozenge tone={heading === "Live" ? "live" : "neutral"}>
            {departures.length}
          </StateLozenge>
        }
      >
        {heading}
      </PixelSectionHeading>
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
