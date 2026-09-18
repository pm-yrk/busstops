import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RouteDetailResponse } from "@busstops/contracts";
import { OfficialNotices } from "../components/OfficialNotices.js";
import { LoadingBus } from "../components/LoadingBus.js";
import { vehicleHref } from "../lib/geo.js";
import {
  DataAge,
  EmptyState,
  ErrorState,
  RouteBadge,
  ServiceBanner,
  StateLozenge,
} from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch, useTicker } from "../lib/use-fetch.js";
import { formatLondonTime } from "../lib/format.js";
import { isFavourited, toggleFavourite } from "../lib/favourites.js";
import "./RoutePage.css";

/**
 * Route page (docs/03_SITE_MAP_AND_UX.md "Route").
 *
 * Variants, the stop sequence, the vehicles currently running it, and the operator. Where the
 * data cannot support a claim — a frequency for a route with three journeys a day, a reliability
 * figure with no published observations — the page says so instead of showing a number.
 */

const REFRESH_INTERVAL_MS = 30_000;
const LOADING_TIMEOUT_MS = 8_000;

export function RoutePage() {
  const { routeId = "" } = useParams();
  const fetcher = useCallback((signal: AbortSignal) => apiClient.route(routeId, signal), [routeId]);

  const {
    data: response,
    error,
    loading,
    timedOut,
    reload,
  } = useFetch<RouteDetailResponse>(fetcher, {
    timeoutMs: LOADING_TIMEOUT_MS,
    refreshMs: REFRESH_INTERVAL_MS,
    enabled: routeId.length > 0,
  });

  const now = useTicker();
  const [selectedVariant, setSelectedVariant] = useState(0);
  /*
   * A route you can actually save.
   *
   * The Saved page said "Saved stops and routes" and only a stop could ever be saved — and a
   * saved route, had one existed, linked to `/search`. A promise the product cannot keep is worse
   * than a missing feature, so this is the feature rather than the removal of the sentence.
   */
  const [savedState, setSavedState] = useState<{ routeId: string | null; saved: boolean }>({
    routeId: null,
    saved: false,
  });
  const [storageBlocked, setStorageBlocked] = useState(false);
  /*
   * Adjusted during render rather than in an effect, the way the stop page does it.
   *
   * Local storage is not an external system to synchronise with — it is read synchronously and
   * the answer is known before the first paint. An effect would render "Save this route" for a
   * frame and then correct itself, which is a flicker on a route the reader has already saved.
   */
  if (routeId.length > 0 && savedState.routeId !== routeId) {
    setSavedState({ routeId, saved: isFavourited("route", routeId) });
  }
  const saved = savedState.saved;

  const ageSeconds = useMemo(() => {
    if (!response?.meta.observedAt) return null;
    return Math.max(0, (now.getTime() - new Date(response.meta.observedAt).getTime()) / 1000);
  }, [response, now]);

  if (loading && !response) {
    return <LoadingBus label="Loading route" timedOut={timedOut} />;
  }

  if (error || !response) {
    return (
      <ErrorState
        title="We could not load this route"
        description={error?.message ?? "The route could not be loaded."}
        onRetry={reload}
      />
    );
  }

  const {
    route,
    operator,
    variants,
    activeVehicles,
    headwaySummary,
    reliability,
    incidents,
    disruptions,
  } = response.data;
  const variant = variants[Math.min(selectedVariant, Math.max(0, variants.length - 1))];

  return (
    <article className="page route-page">
      <ServiceBanner meta={response.meta} />

      <header className="route-page__header">
        <RouteBadge name={route.publicName} ariaLabel={`Route ${route.publicName}`} />
        <div>
          <h1>{route.description ?? `Route ${route.publicName}`}</h1>
          {operator ? (
            <p className="muted">
              Operated by <Link to={`/operators/${operator.id}`}>{operator.name}</Link>
            </p>
          ) : (
            <p className="muted">The operator for this route is not recorded.</p>
          )}
        </div>
        <DataAge seconds={ageSeconds} />
      </header>

      <div className="route-page__actions">
        <button
          type="button"
          aria-pressed={saved}
          className={saved ? "button-primary" : ""}
          onClick={() => {
            const stored = toggleFavourite({
              kind: "route",
              // The published service id, so the Saved page can open the route rather than
              // searching for its number and hoping.
              id: route.id,
              title: `Route ${route.publicName}`,
              ...(operator ? { subtitle: operator.name } : {}),
            });
            setStorageBlocked(!stored);
            setSavedState({ routeId: route.id, saved: isFavourited("route", route.id) });
          }}
        >
          {saved ? "Saved" : "Save this route"}
        </button>
      </div>

      {storageBlocked && (
        <p className="route-page__storage-note small muted" role="status">
          We could not save this route on this device. Saving needs site data to be allowed, and
          nothing is sent to us either way.
        </p>
      )}

      <section aria-labelledby="route-live-heading" className="route-page__section">
        <h2 id="route-live-heading">Buses running now</h2>
        {activeVehicles.length > 0 ? (
          <ul className="route-page__vehicles">
            {activeVehicles.map((vehicle) => (
              <li key={vehicle.vehicleRef}>
                {/*
                  A link that works from here.

                  It was a bare `/vehicles/:ref`, and the vehicle page needs a viewport because
                  the live feeds are area-scoped — so every bus on every route page landed on
                  "This link needs a map area", which is a dead end presented as an explanation.
                  The route page has no map, but it does have the bus's position, and a position
                  is enough to build the box the lookup needs.
                */}
                <Link to={vehicleHref(vehicle.vehicleRef, { coordinate: vehicle.coordinate })}>
                  {vehicle.destinationName ?? "Destination not published"}
                </Link>
                <span className="muted small">
                  last seen{" "}
                  <time dateTime={vehicle.observedAt}>
                    {formatLondonTime(new Date(vehicle.observedAt))}
                  </time>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No buses currently observed"
            description={
              response.meta.degradation === "scheduled_only"
                ? "Live vehicle data is not available right now, so we cannot say which buses are running. The timetable below is unaffected."
                : "No buses on this route are reporting a position at the moment. That may mean none are running, or that this operator does not publish positions."
            }
          />
        )}
      </section>

      <section aria-labelledby="route-variants-heading" className="route-page__section">
        <h2 id="route-variants-heading">Where it goes</h2>

        {variants.length > 1 ? (
          <div className="route-page__variant-tabs" role="tablist" aria-label="Route directions">
            {variants.map((candidate, index) => (
              <button
                key={candidate.patternId}
                type="button"
                role="tab"
                aria-selected={index === selectedVariant}
                className={index === selectedVariant ? "is-selected" : ""}
                onClick={() => setSelectedVariant(index)}
              >
                {candidate.description}
              </button>
            ))}
          </div>
        ) : null}

        {variant ? (
          <>
            <p className="muted small">
              {variant.stops.length} stops, about {(variant.distanceMetres / 1000).toFixed(1)} km.
            </p>
            <ol className="route-page__stops">
              {variant.stops.map((stop) => (
                <li key={stop.stopId}>
                  {/*
                    By ATCO code, like every other stop link on the site.

                    This used the internal UUID. Both resolve, which is why it went unnoticed —
                    and it meant one page produced a different URL for the same stop than every
                    other page did, so a link shared from a route page looked nothing like a link
                    shared from the map.
                  */}
                  <Link to={`/stops/${encodeURIComponent(stop.atcoCode)}`}>{stop.name}</Link>
                  {stop.locality ? <span className="muted small">{stop.locality}</span> : null}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <EmptyState
            title="No stop sequence published"
            description="The timetable for this route does not include a stop sequence we can show."
          />
        )}
      </section>

      <section aria-labelledby="route-frequency-heading" className="route-page__section">
        <h2 id="route-frequency-heading">Frequency and reliability</h2>
        <p>
          {headwaySummary ??
            "This route's timetable does not support a meaningful frequency, so we do not show one."}
        </p>

        {reliability.length > 0 ? (
          <ul className="route-page__metrics">
            {reliability.map((metric) => (
              <li key={metric.label}>
                <span className="route-page__metric-label">{metric.label}</span>
                {metric.suppressed ? (
                  <span className="muted small">{metric.note}</span>
                ) : (
                  <span className="route-page__metric-value">
                    {metric.value}
                    {metric.unit === "percent" ? "%" : ""}
                    <span className="muted small"> from {metric.denominator} observations</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">
            No reliability observations have been published for this route yet.
          </p>
        )}
      </section>

      {incidents.length > 0 ? (
        <section aria-labelledby="route-incidents-heading" className="route-page__section">
          <h2 id="route-incidents-heading">Disruption</h2>
          <ul className="route-page__incidents">
            {incidents.map((incident) => (
              <li key={incident.id}>
                <StateLozenge tone={incident.officialStatus === "official" ? "info" : "neutral"}>
                  {incident.officialStatus === "official" ? "Official" : "Observed"}
                </StateLozenge>
                <p>{incident.narrative}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        What the operator has actually announced about this route.

        `incidents` above are derived from observation and the intelligence pipeline has published
        none yet, so this section was the whole of what a route page could say about disruption —
        which meant a route with a published closure on it showed nothing at all.
      */}
      {disruptions.length > 0 ? (
        <OfficialNotices
          notices={disruptions}
          sourcesQueried={[]}
          collectedAt={response.meta.observedAt}
          headingId="route-official-now"
        />
      ) : null}
    </article>
  );
}
