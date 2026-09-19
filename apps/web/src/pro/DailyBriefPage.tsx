import { useCallback } from "react";
import type { ReportResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { EmptyState, ErrorState } from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";
import { formatLondonDate } from "../lib/format.js";
import { DataModeBanner, ProMetricTile } from "./ProPrimitives.js";
import { PixelSectionHeading } from "../components/pixel/PixelSectionHeading.js";

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

      {/*
        A masthead, because this is an edition rather than a screen.

        The Brief is the one Pro surface that is published — frozen, dated, and sent to people who
        read it away from the product — and it was presented as another `pro-section` with an h2.
        The date is the largest thing on it: a reader's first question about a brief is always
        which one they are looking at.
      */}
      <header className="pro-brief" aria-labelledby="brief-heading">
        <p className="pro-brief__kicker">Bus Stops Pro · Daily Brief</p>
        <h2 id="brief-heading" className="pro-brief__date">
          {formatLondonDate(new Date(brief.periodStart))}
        </h2>
        <p className="pro-brief__standfirst">
          This page and the email are built from the same frozen snapshot, so the figures cannot
          drift apart between them.
        </p>
      </header>

      {brief.sections.length > 0 ? (
        <>
          <section className="pro-section" aria-labelledby="brief-yesterday">
            <PixelSectionHeading mark="clock" id="brief-yesterday">
              Yesterday
            </PixelSectionHeading>
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
            <PixelSectionHeading mark="clock" id="brief-today">
              Today
            </PixelSectionHeading>
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
        <PixelSectionHeading mark="warning" id="brief-caveats">
          Coverage
        </PixelSectionHeading>
        <ul>
          {brief.coverageCaveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
