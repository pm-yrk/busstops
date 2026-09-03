import { useCallback, useState } from "react";
import type { AnalyticsResponse, AnalyticsSection } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { EmptyState, ErrorState } from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";
import { DataModeBanner, ProMetricTile, ScopeFilters } from "./ProPrimitives.js";

/**
 * Analytics (docs/10_BUS_STOPS_PRO.md).
 *
 * Each section carries wording the interface must reproduce verbatim rather than paraphrase.
 * "Association, not a demonstrated cause" and "these are properties of a road segment, not
 * statements about any driver" are not garnish — they are the difference between a defensible
 * finding and an accusation, and a summariser that tightened them would change the claim.
 */

export function AnalyticsPage() {
  const [windowMinutes, setWindowMinutes] = useState(1440);
  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.proAnalytics({ windowMinutes }, signal),
    [windowMinutes],
  );

  const { data, error, loading, timedOut, reload } = useFetch<{ data: AnalyticsResponse }>(
    fetcher,
    {
      timeoutMs: 8000,
    },
  );

  if (loading && !data) return <LoadingBus label="Loading analytics" timedOut={timedOut} />;
  if (error || !data) {
    return (
      <ErrorState
        title="We could not load analytics"
        description={error?.message ?? "Analytics could not be loaded."}
        onRetry={reload}
      />
    );
  }

  const analytics = data.data;

  return (
    <>
      <DataModeBanner provenance={analytics.provenance} />
      <ScopeFilters windowMinutes={windowMinutes} onWindowChange={setWindowMinutes} />

      {analytics.sections.length > 0 ? (
        analytics.sections.map((section) => <Section key={section.key} section={section} />)
      ) : (
        <EmptyState
          title="No analysis published"
          description="No analytical output has been published for this scope and window yet."
        />
      )}

      <p className="pro-note">{analytics.exportNotice}</p>
    </>
  );
}

function Section({ section }: { section: AnalyticsSection }) {
  return (
    <section className="pro-section" aria-labelledby={`analytics-${section.key}`}>
      <h2 id={`analytics-${section.key}`}>{section.title}</h2>
      <p>{section.description}</p>

      {section.metrics.length > 0 ? (
        <div className="pro-grid">
          {section.metrics.map((metric) => (
            <ProMetricTile key={metric.key} metric={metric} />
          ))}
        </div>
      ) : null}

      {section.columns.length > 0 && section.rows.length > 0 ? (
        <div className="pro-table-wrap">
          <table className="pro-table">
            <caption className="visually-hidden">{section.title}</caption>
            <thead>
              <tr>
                {section.columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.label}>
                  {row.values.map((value, index) => (
                    <td key={`${row.label}-${index}`}>{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Rendered verbatim. Paraphrasing these sentences would change what is being claimed. */}
      {section.requiredWording ? <p className="pro-note">{section.requiredWording}</p> : null}
    </section>
  );
}
