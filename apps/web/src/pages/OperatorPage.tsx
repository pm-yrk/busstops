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
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";
import "./OperatorPage.css";

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

  const { operator, routes, metrics, rankingEligible, rankingIneligibleReason, coverageCaveats } =
    response.data;

  return (
    <article className="page operator-page">
      <ServiceBanner meta={response.meta} />

      <header className="operator-page__header">
        <h1>{operator.name}</h1>
        {operator.contactUrl ? (
          <p>
            <a href={operator.contactUrl} rel="noreferrer noopener" target="_blank">
              Operator website
            </a>
          </p>
        ) : null}
      </header>

      <section aria-labelledby="operator-metrics-heading" className="operator-page__section">
        <h2 id="operator-metrics-heading">Performance</h2>

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
        <h2 id="operator-routes-heading">Routes</h2>
        {routes.length > 0 ? (
          <ul className="operator-page__routes">
            {routes.map((route) => (
              <li key={route.id}>
                <Link to={`/routes/${route.id}`}>
                  <RouteBadge name={route.publicName} />
                  <span>{route.description ?? "No description published"}</span>
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
      </section>

      <section aria-labelledby="operator-coverage-heading" className="operator-page__section">
        <h2 id="operator-coverage-heading">What we can and cannot see</h2>
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
