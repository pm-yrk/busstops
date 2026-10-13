import { useCallback, useMemo, useState } from "react";
import type { LiveOperationsResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { EmptyState, ErrorState, StateLozenge } from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";
import { DataModeBanner, ScopeFilters } from "./ProPrimitives.js";
import { PixelSectionHeading } from "../components/pixel/PixelSectionHeading.js";

/**
 * Live Operations (docs/10_BUS_STOPS_PRO.md).
 *
 * This page shows what is happening and refuses to pretend it can change it. There are no dispatch
 * controls, no "hold this bus" buttons and no acknowledgement workflow: simulating operational
 * control someone does not have is worse than showing nothing, because it invites a decision on
 * the basis of a lever that is not connected to anything.
 */

export function LiveOperationsPage() {
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [severity, setSeverity] = useState<string>("");
  const [eventType, setEventType] = useState<string>("");

  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.proLiveOperations({ windowMinutes, operatorId }, signal),
    [windowMinutes, operatorId],
  );

  const { data, error, loading, timedOut, reload } = useFetch<{ data: LiveOperationsResponse }>(
    fetcher,
    { timeoutMs: 8000, refreshMs: 30_000 },
  );

  const filtered = useMemo(() => {
    const items = data?.data.items ?? [];
    return items.filter(
      (item) =>
        (severity === "" || item.incident.severity === severity) &&
        (eventType === "" || item.incident.type === eventType),
    );
  }, [data, severity, eventType]);

  if (loading && !data) return <LoadingBus label="Loading live operations" timedOut={timedOut} />;
  if (error || !data) {
    return (
      <ErrorState
        title="We could not load live operations"
        description={error?.message ?? "Live operations could not be loaded."}
        onRetry={reload}
      />
    );
  }

  const operations = data.data;

  return (
    <>
      <DataModeBanner provenance={operations.provenance} />

      <div className="pro-filters">
        <ScopeFilters
          windowMinutes={windowMinutes}
          onWindowChange={setWindowMinutes}
          operators={operations.availableFilters.operators}
          operatorId={operatorId}
          onOperatorChange={setOperatorId}
        />
        <label>
          <span>Severity</span>
          <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
            <option value="">Any severity</option>
            {operations.availableFilters.severities.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Event</span>
          <select value={eventType} onChange={(event) => setEventType(event.target.value)}>
            <option value="">Any event</option>
            {operations.availableFilters.eventTypes.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
      </div>

      {operations.feedProblems.length > 0 ? (
        <section className="pro-section" aria-labelledby="lo-feeds">
          <PixelSectionHeading mark="warning" id="lo-feeds">
            Feed problems
          </PixelSectionHeading>
          <p className="muted small">
            A feed that has stopped reporting is an operational exception in its own right: the
            services behind it are unmeasured, not running normally.
          </p>
          <ul className="pro-list">
            {operations.feedProblems.map((problem) => (
              <li key={problem.source} className="pro-card">
                <h3>
                  {problem.source} <StateLozenge tone="warning">{problem.status}</StateLozenge>
                </h3>
                <p>{problem.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="pro-section" aria-labelledby="lo-exceptions">
        <PixelSectionHeading mark="bus" id="lo-exceptions">
          Current exceptions
        </PixelSectionHeading>
        {filtered.length > 0 ? (
          <ul className="pro-list">
            {filtered.map((item) => (
              <li key={item.incident.id} className="pro-card">
                <h3>{item.incident.narrative}</h3>
                <div className="pro-card__meta">
                  <StateLozenge tone="neutral">
                    {item.incident.type.replace(/_/g, " ")}
                  </StateLozenge>
                  <StateLozenge
                    tone={item.incident.severity === "highly_abnormal" ? "critical" : "neutral"}
                  >
                    {item.incident.severity.replace(/_/g, " ")}
                  </StateLozenge>
                  <StateLozenge tone="info">{item.incident.lifecycle}</StateLozenge>
                  <span>{item.recoveryTrend}</span>
                  {item.freshnessSeconds !== null ? (
                    <span>seen {Math.round(item.freshnessSeconds / 60)} min ago</span>
                  ) : null}
                  {item.affectedRouteNames.length > 0 ? (
                    <span>routes {item.affectedRouteNames.join(", ")}</span>
                  ) : null}
                </div>
                {item.incident.confidence.reasons.length > 0 ? (
                  <p className="muted small">
                    Evidence: {item.incident.confidence.reasons.join("; ")}.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No exceptions match these filters"
            description="Nothing in the current window meets both the evidence threshold and the filters you have set."
          />
        )}
      </section>

      <p className="pro-note">
        This is a view, not a control desk. Bus Stops does not send instructions to vehicles or
        drivers, and showing controls that do nothing would be worse than showing none.
      </p>
    </>
  );
}
