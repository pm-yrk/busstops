import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RouteDetailResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
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

  const { route, operator, variants, activeVehicles, headwaySummary, reliability, incidents } =
    response.data;
  const variant = variants[Math.min(selectedVariant, Math.max(0, variants.length - 1))];

  return (
    <article className="route-page">
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

      <section aria-labelledby="route-live-heading" className="route-page__section">
        <h2 id="route-live-heading">Buses running now</h2>
        {activeVehicles.length > 0 ? (
          <ul className="route-page__vehicles">
            {activeVehicles.map((vehicle) => (
              <li key={vehicle.vehicleRef}>
                <Link to={`/vehicles/${encodeURIComponent(vehicle.vehicleRef)}`}>
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
                  <Link to={`/stops/${stop.stopId}`}>{stop.name}</Link>
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
    </article>
  );
}
