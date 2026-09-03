import { useCallback } from "react";
import type { ReportResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { EmptyState, ErrorState } from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";
import { formatLondonDate } from "../lib/format.js";
import { DataModeBanner, ProMetricTile } from "./ProPrimitives.js";

/**
 * The Daily Brief browser view (docs/12_DAILY_BRIEF.md).
 *
 * This view and the email are rendered from the same frozen snapshot, and that is the point: if a
 * recipient opens the link in their email an hour later and sees different figures, they have no
 * reason to trust either. The browser view therefore reads the snapshot rather than recomputing.
 */

export function DailyBriefPage() {
  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.proReport("daily", {}, signal),
    [],
  );
  const { data, error, loading, timedOut, reload } = useFetch<{ data: ReportResponse }>(fetcher, {
    timeoutMs: 8000,
  });

  if (loading && !data) return <LoadingBus label="Loading the Daily Brief" timedOut={timedOut} />;
  if (error || !data) {
    return (
      <ErrorState
        title="We could not load the Daily Brief"
        description={error?.message ?? "The Daily Brief could not be loaded."}
        onRetry={reload}
      />
    );
  }

  const brief = data.data;

  return (
    <>
      <DataModeBanner provenance={brief.provenance} />

      <section className="pro-section" aria-labelledby="brief-heading">
        <h2 id="brief-heading">Daily Brief</h2>
        <p className="muted small">
          For {formatLondonDate(new Date(brief.periodStart))}. This page and the email are built
          from the same frozen snapshot, so the figures cannot drift apart between them.
        </p>
      </section>

      {brief.sections.length > 0 ? (
        <>
          <section className="pro-section" aria-labelledby="brief-yesterday">
            <h2 id="brief-yesterday">Yesterday</h2>
            {brief.sections.map((section) => (
              <div key={section.title} className="pro-card">
                <h3>{section.title}</h3>
                <div className="pro-grid">
                  {section.metrics.map((metric) => (
                    <ProMetricTile key={metric.key} metric={metric} />
                  ))}
                </div>
                <p>{section.narrative}</p>
              </div>
            ))}
          </section>

          <section className="pro-section" aria-labelledby="brief-today">
            <h2 id="brief-today">Today</h2>
            <p>
              Today&apos;s outlook is published once the morning peak has produced enough
              observations to say anything useful. Until then this section stays empty rather than
              repeating yesterday as though it were a forecast.
            </p>
          </section>
        </>
      ) : (
        <EmptyState
          title="No brief for this period"
          description="No snapshot has been produced for this period yet."
        />
      )}

      <section className="pro-section" aria-labelledby="brief-caveats">
        <h2 id="brief-caveats">Coverage</h2>
        <ul>
          {brief.coverageCaveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
