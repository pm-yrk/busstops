import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import type { OperatorDetailResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import {
  EmptyState,
  ErrorState,
  MetricTile,
  RouteBadge,
  ServiceBanner,
} from "../components/primitives.js";
import { PixelVista } from "../components/pixel/PixelVista.js";
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";
import "./OperatorPage.css";
import { PixelSectionHeading } from "../components/pixel/PixelSectionHeading.js";

/**
 * Operator page (docs/03_SITE_MAP_AND_UX.md "Operator/network").
 *
 * Factual and deliberately not a league table. Where the sample cannot support a comparison the
 * page says so in place of a rank: an operator running forty buses in one town should not appear
 * to beat or lose to one running four thousand, and a table would imply exactly that.
 */

const LOADING_TIMEOUT_MS = 8_000;

export function OperatorPage() {
  const { operatorId = "" } = useParams();
  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.operator(operatorId, signal),
    [operatorId],
  );

  const {
    data: response,
    error,
    loading,
    timedOut,
    reload,
  } = useFetch<OperatorDetailResponse>(fetcher, {
    timeoutMs: LOADING_TIMEOUT_MS,
    enabled: operatorId.length > 0,
  });

  if (loading && !response) return <LoadingBus label="Loading operator" timedOut={timedOut} />;

  if (error || !response) {
    return (
      <ErrorState
        title="We could not load this operator"
        description={error?.message ?? "The operator could not be loaded."}
        onRetry={reload}
      />
    );
  }

  const {
    operator,
    routes,
    metrics,
    rankingEligible,
    rankingIneligibleReason,
    coverageCaveats,
    incidents,
  } = response.data;
  const undescribed = routes.filter((route) => !route.description).length;

  return (
    <article className="page operator-page">
      <ServiceBanner meta={response.meta} />

      <PixelVista
        title={operator.name}
        standfirst={
          operator.contactUrl ? (
            <a href={operator.contactUrl} rel="noreferrer noopener" target="_blank">
              Operator website
            </a>
          ) : undefined
        }
        vista="depot"
      />

      {/*
        What this operator is, in the fields the endpoint actually returns.
 
        The page went straight from a name into a performance grid that is mostly suppressed and
        then into a list of routes. None of that answers "how big is this operator and is anything
        wrong with it", which is the question somebody arriving from a bus has.
      */}
      <section className="operator-summary" aria-label="About this operator">
        <dl className="operator-summary__facts">
          <div>
            <dt>Routes published</dt>
            <dd>{routes.length}</dd>
          </div>
          <div>
            <dt>Disruption</dt>
            <dd>{incidents.length > 0 ? `${incidents.length} reported` : "none reported"}</dd>
          </div>
          <div>
            <dt>Comparable</dt>
            {/*
              Whether this operator's sample supports comparison at all, said once at the top
              rather than discovered by reading a grid of dashes.
            */}
            <dd>{rankingEligible ? "yes" : "not yet"}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="operator-metrics-heading" className="operator-page__section">
        <PixelSectionHeading mark="chart" id="operator-metrics-heading">
          Performance
        </PixelSectionHeading>

        {!rankingEligible && rankingIneligibleReason ? (
          <p className="operator-page__ranking-note">{rankingIneligibleReason}</p>
        ) : null}

        <div className="operator-page__metrics">
          {metrics.map((metric) => (
            <MetricTile
              key={metric.label}
              label={metric.label}
              value={
                metric.suppressed || metric.value === null
                  ? "—"
                  : `${metric.value}${metric.unit === "percent" ? "%" : ""}`
              }
              denominator={`${metric.denominator} observations`}
              {...(metric.confidence ? { confidence: metric.confidence } : {})}
            >
              {metric.note ? <p className="muted small">{metric.note}</p> : null}
            </MetricTile>
          ))}
        </div>
      </section>

      <section aria-labelledby="operator-routes-heading" className="operator-page__section">
        <PixelSectionHeading mark="route" id="operator-routes-heading">
          Routes
        </PixelSectionHeading>
        {routes.length > 0 ? (
          <ul className="operator-page__routes">
            {routes.map((route) => (
              <li key={route.id}>
                <Link to={`/routes/${route.id}`}>
                  <RouteBadge name={route.publicName} />
                  {/*
                    Nothing where there is nothing.
 
                    Every route without a published description printed "No description
                    published", so an operator with forty routes printed that sentence forty
                    times — a wall of the same absence, which reads as a broken page rather than
                    as a gap in the data. The badge is the route's name and is enough on its own;
                    the count of how many lack a description is stated once, below.
                  */}
                  {route.description ? <span>{route.description}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No routes published"
            description="No routes for this operator appear in the published timetable data."
          />
        )}
        {/* The absence, counted once, instead of printed once per route. */}
        {undescribed > 0 ? (
          <p className="muted small">
            {undescribed === routes.length
              ? "None of these routes has a description in the published data, so each is shown by its number."
              : `${undescribed} of these routes have no description in the published data.`}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="operator-coverage-heading" className="operator-page__section">
        <PixelSectionHeading mark="warning" id="operator-coverage-heading">
          What we can and cannot see
        </PixelSectionHeading>
        <ul className="operator-page__caveats">
          {coverageCaveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
        <p className="muted small">
          <Link to="/methodology">How these figures are produced</Link>.
        </p>
      </section>
    </article>
  );
}
