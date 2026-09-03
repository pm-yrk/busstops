import { useCallback, useState } from "react";
import type { ReportResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { EmptyState, ErrorState } from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";
import { formatLondonDate } from "../lib/format.js";
import { DataModeBanner, ProMetricTile } from "./ProPrimitives.js";

type Period = "daily" | "weekly" | "monthly";

/**
 * Reports (docs/10_BUS_STOPS_PRO.md "Disruptions and reports").
 *
 * Print is a first-class output here, not an afterthought: these reports get taken into meetings
 * on paper, and a page that loses its coverage caveats when printed would be a page that misleads
 * exactly where it matters most. The caveats print with the figures.
 */

export function ReportsPage() {
  const [period, setPeriod] = useState<Period>("daily");
  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.proReport(period, {}, signal),
    [period],
  );

  const { data, error, loading, timedOut, reload } = useFetch<{ data: ReportResponse }>(fetcher, {
    timeoutMs: 8000,
  });

  if (loading && !data) return <LoadingBus label="Loading report" timedOut={timedOut} />;
  if (error || !data) {
    return (
      <ErrorState
        title="We could not load this report"
        description={error?.message ?? "The report could not be loaded."}
        onRetry={reload}
      />
    );
  }

  const report = data.data;

  return (
    <>
      <DataModeBanner provenance={report.provenance} />

      <div className="pro-filters no-print">
        <label>
          <span>Period</span>
          <select value={period} onChange={(event) => setPeriod(event.target.value as Period)}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <button type="button" onClick={() => globalThis.print?.()}>
          Print or save as PDF
        </button>
      </div>

      <section className="pro-section" aria-labelledby="report-heading">
        <h2 id="report-heading">
          {period[0]!.toUpperCase()}
          {period.slice(1)} report
        </h2>
        <p className="muted small">
          {formatLondonDate(new Date(report.periodStart))} to{" "}
          {formatLondonDate(new Date(report.periodEnd))}, generated{" "}
          {formatLondonDate(new Date(report.generatedAt))}.
        </p>
      </section>

      {report.sections.length > 0 ? (
        report.sections.map((section) => (
          <section className="pro-section" key={section.title}>
            <h2>{section.title}</h2>
            <div className="pro-grid">
              {section.metrics.map((metric) => (
                <ProMetricTile key={metric.key} metric={metric} />
              ))}
            </div>
            <p>{section.narrative}</p>
          </section>
        ))
      ) : (
        <EmptyState
          title="No report data"
          description="No analysis has been published for this period."
        />
      )}

      <section className="pro-section" aria-labelledby="report-caveats">
        <h2 id="report-caveats">What this report does not cover</h2>
        <ul>
          {report.coverageCaveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
