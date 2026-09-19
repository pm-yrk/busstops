import { useCallback, useState } from "react";
import type { RoutesResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { EmptyState, ErrorState, RouteBadge } from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";
import { DataModeBanner, ScopeFilters, formatMetricValue } from "./ProPrimitives.js";

/**
 * Route comparison (docs/10_BUS_STOPS_PRO.md "Routes and operators").
 *
 * A suppressed cell shows a dash and its reason on hover, never a blank that reads as zero and
 * never a number the sample cannot support. The comparability warning sits above the table rather
 * than beneath it, because a reader who has already compared two rows has already been misled.
 */

export function RoutesPage() {
  const [windowMinutes, setWindowMinutes] = useState(1440);
  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.proRoutes({ windowMinutes }, signal),
    [windowMinutes],
  );

  const { data, error, loading, timedOut, reload } = useFetch<{ data: RoutesResponse }>(fetcher, {
    timeoutMs: 8000,
  });

  if (loading && !data) return <LoadingBus label="Loading routes" timedOut={timedOut} />;
  if (error || !data) {
    return (
      <ErrorState
        title="We could not load route comparison"
        description={error?.message ?? "Route comparison could not be loaded."}
        onRetry={reload}
      />
    );
  }

  const routes = data.data;
  const metricLabels = routes.rows[0]?.metrics.map((metric) => metric.label) ?? [];

  return (
    <>
      <DataModeBanner provenance={routes.provenance} />
      <ScopeFilters windowMinutes={windowMinutes} onWindowChange={setWindowMinutes} />

      {routes.comparabilityWarning ? (
        <p className="pro-note">{routes.comparabilityWarning}</p>
      ) : null}

      <section className="pro-section" aria-labelledby="routes-heading">
        <h2 id="routes-heading">Route comparison</h2>
        {routes.rows.length > 0 ? (
          <div className="pro-table-wrap">
            <table className="pro-table">
              <caption className="visually-hidden">
                Route performance, with denominators and suppression reasons
              </caption>
              <thead>
                <tr>
                  <th scope="col">Route</th>
                  <th scope="col">Operator</th>
                  {metricLabels.map((label) => (
                    <th key={label} scope="col" className="numeric">
                      {label}
                    </th>
                  ))}
                  <th scope="col">Worst corridor</th>
                  <th scope="col">Worst window</th>
                </tr>
              </thead>
              <tbody>
                {routes.rows.map((row) => (
                  <tr key={row.routeId}>
                    {/*
                      The same badge the passenger side draws, so a route is the same object in
                      both products. A comparison table whose first column is plain text makes the
                      reader find the row they came for by reading; a badge is found by shape.
                    */}
                    <th scope="row">
                      <RouteBadge name={row.routeName} ariaLabel={`Route ${row.routeName}`} />
                    </th>
                    <td>{row.operatorName}</td>
                    {row.metrics.map((metric) => (
                      <td key={metric.key} className="numeric">
                        <span title={metric.suppressionReason ?? metric.definition}>
                          {formatMetricValue(metric)}
                        </span>
                        <br />
                        <span className="muted small">
                          {metric.suppressed
                            ? `${metric.denominator} obs — too few`
                            : `${metric.denominator} obs`}
                        </span>
                      </td>
                    ))}
                    <td>{row.worstCorridor ?? "—"}</td>
                    <td>{row.worstTimeWindow ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No route analysis published"
            description="No route-level analysis has been published for this scope and window yet."
          />
        )}
      </section>

      {routes.rows.some((row) => row.weatherSensitivity) ? (
        <section className="pro-section" aria-labelledby="routes-weather">
          <h2 id="routes-weather">Weather sensitivity</h2>
          <ul className="pro-list">
            {routes.rows
              .filter((row) => row.weatherSensitivity)
              .map((row) => (
                <li key={row.routeId} className="pro-card">
                  <h3>
                    <RouteBadge name={row.routeName} ariaLabel={`Route ${row.routeName}`} />
                  </h3>
                  <p>{row.weatherSensitivity}</p>
                </li>
              ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
