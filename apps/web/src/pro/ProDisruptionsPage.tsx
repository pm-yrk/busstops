import { useCallback, useMemo, useState } from "react";
import type { LiveOperationsItem, LiveOperationsResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { EmptyState, ErrorState, StateLozenge } from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch, useTicker } from "../lib/use-fetch.js";
import { BandStrip, DataModeBanner, ScopeFilters } from "./ProPrimitives.js";
import { PixelSectionHeading } from "../components/pixel/PixelSectionHeading.js";

/**
 * The priority exception inbox (docs/10_BUS_STOPS_PRO.md "Disruptions and reports").
 *
 * An inbox rather than a feed: each item carries its severity, how abnormal it is, what it is
 * affecting, how confident we are, where it came from and where it is in its lifecycle. Sorting
 * defaults to severity because that is what an operations team scans for, but abnormality is one
 * click away — the two disagree often, and that disagreement is usually the interesting part.
 *
 * Nothing here can be acknowledged or dismissed. This is a view of what the data shows, and a
 * button that made an item disappear without changing anything on the road would be a lie about
 * what the reader had done.
 */

type SortKey = "severity" | "abnormality" | "recency";

const SEVERITY_RANK: Record<string, number> = {
  highly_abnormal: 3,
  abnormal: 2,
  elevated: 1,
  typical: 0,
};

export function ProDisruptionsPage() {
  const [windowMinutes, setWindowMinutes] = useState(180);
  const [sortKey, setSortKey] = useState<SortKey>("severity");
  const [officialOnly, setOfficialOnly] = useState(false);
  const [lifecycle, setLifecycle] = useState("");
  // Ticks so "for 42 min" keeps being true on a screen left open on a wall.
  const now = useTicker(30_000).getTime();

  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.proLiveOperations({ windowMinutes }, signal),
    [windowMinutes],
  );

  const { data, error, loading, timedOut, reload } = useFetch<{ data: LiveOperationsResponse }>(
    fetcher,
    { timeoutMs: 8000, refreshMs: 60_000 },
  );

  const items = useMemo(() => {
    const all = data?.data.items ?? [];
    const filtered = all.filter(
      (item) =>
        (!officialOnly || item.incident.officialStatus === "official") &&
        (lifecycle === "" || item.incident.lifecycle === lifecycle),
    );

    return [...filtered].sort((a, b) => {
      if (sortKey === "recency") {
        return b.incident.startedAt.localeCompare(a.incident.startedAt);
      }
      if (sortKey === "abnormality") {
        // Confidence breaks ties, so a well-evidenced item outranks a marginal one of equal
        // severity rather than being ordered arbitrarily.
        return (
          (SEVERITY_RANK[b.incident.severity] ?? 0) - (SEVERITY_RANK[a.incident.severity] ?? 0) ||
          b.incident.confidence.score - a.incident.confidence.score
        );
      }
      return (
        (SEVERITY_RANK[b.incident.severity] ?? 0) - (SEVERITY_RANK[a.incident.severity] ?? 0) ||
        b.incident.startedAt.localeCompare(a.incident.startedAt)
      );
    });
  }, [data, sortKey, officialOnly, lifecycle]);

  if (loading && !data) return <LoadingBus label="Loading disruptions" timedOut={timedOut} />;
  if (error || !data) {
    return (
      <ErrorState
        title="We could not load disruptions"
        description={error?.message ?? "The exception inbox could not be loaded."}
        onRetry={reload}
      />
    );
  }

  const operations = data.data;

  return (
    <>
      <DataModeBanner provenance={operations.provenance} />

      <div className="pro-filters">
        <ScopeFilters windowMinutes={windowMinutes} onWindowChange={setWindowMinutes} />
        <label>
          <span>Sort by</span>
          <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
            <option value="severity">Severity</option>
            <option value="abnormality">Abnormality and evidence</option>
            <option value="recency">Most recent</option>
          </select>
        </label>
        <label>
          <span>Status</span>
          <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value)}>
            <option value="">Any status</option>
            <option value="emerging">Emerging</option>
            <option value="active">Active</option>
            <option value="recovering">Recovering</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>
        <label>
          <span>Source</span>
          <select
            value={officialOnly ? "official" : "any"}
            onChange={(event) => setOfficialOnly(event.target.value === "official")}
          >
            <option value="any">Any source</option>
            <option value="official">Officially corroborated only</option>
          </select>
        </label>
      </div>

      <section className="pro-section" aria-labelledby="disruptions-heading">
        <PixelSectionHeading mark="works" id="disruptions-heading">
          Exception inbox
        </PixelSectionHeading>
        <p className="muted small">
          {items.length} of {operations.items.length} shown. An item marked <em>emerging</em> has
          been detected once and is not yet confirmed; it is shown rather than hidden so nothing
          appears without warning, but it should not be acted on alone.
        </p>

        <SeveritySummary items={items} />

        {items.length > 0 ? (
          <div className="pro-table-wrap">
            <table className="pro-table">
              <caption className="visually-hidden">
                Current exceptions with severity, status, confidence and source
              </caption>
              <thead>
                <tr>
                  <th scope="col">What is happening</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Status</th>
                  <th scope="col">Trend</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">Source</th>
                  <th scope="col" className="numeric">
                    Affecting
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <ExceptionRow key={item.incident.id} item={item} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="Nothing in the inbox"
            description="No exception in this window meets the evidence threshold and your filters. That is not a statement about parts of the network we cannot see."
          />
        )}
      </section>

      {operations.feedProblems.length > 0 ? (
        <section className="pro-section" aria-labelledby="disruptions-feeds">
          <PixelSectionHeading mark="warning" id="disruptions-feeds">
            Feeds not reporting
          </PixelSectionHeading>
          <p className="muted small">
            These are exceptions too. Where a feed is down, the services behind it are unmeasured
            rather than running normally, and no item above can speak for them.
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

      <p className="pro-note">
        Nothing here can be acknowledged or cleared. Bus Stops reports what the data shows; an item
        disappears when the conditions do, not when someone reads it.
      </p>
    </>
  );
}

/**
 * How long this has been going on, from its own start time.
 *
 * An inbox sorted by severity hides the time dimension entirely: a highly abnormal item detected
 * four minutes ago and one that has been running for three hours sit next to each other looking
 * identical, and they are completely different operational situations.
 */
function elapsedLabel(startedAt: string, now: number): string | null {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  const minutes = Math.floor((now - started) / 60_000);
  if (minutes < 0) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const SEVERITY_ORDER = ["highly_abnormal", "abnormal", "elevated", "typical"] as const;

/** What the inbox is made of, before anybody reads a row of it. */
function SeveritySummary({ items }: { items: readonly LiveOperationsItem[] }) {
  return (
    <BandStrip
      label="Exceptions by severity"
      bands={SEVERITY_ORDER.map((severity) => ({
        tone: severity,
        label: severity.replace(/_/g, " "),
        count: items.filter((item) => item.incident.severity === severity).length,
      }))}
    />
  );
}

function ExceptionRow({ item, now }: { item: LiveOperationsItem; now: number }) {
  return (
    <tr>
      <th scope="row">{item.incident.narrative}</th>
      <td>
        <StateLozenge
          tone={
            item.incident.severity === "highly_abnormal"
              ? "critical"
              : item.incident.severity === "abnormal"
                ? "warning"
                : "neutral"
          }
        >
          {item.incident.severity.replace(/_/g, " ")}
        </StateLozenge>
      </td>
      <td>
        {item.incident.lifecycle}
        {elapsedLabel(item.incident.startedAt, now) ? (
          <>
            <br />
            <span className="muted small">for {elapsedLabel(item.incident.startedAt, now)}</span>
          </>
        ) : null}
      </td>
      <td>{item.recoveryTrend}</td>
      <td>
        {item.incident.confidence.level}
        {item.incident.confidence.reasons.length > 0 ? (
          <>
            <br />
            <span className="muted small">{item.incident.confidence.reasons[0]}</span>
          </>
        ) : null}
      </td>
      <td>
        <StateLozenge tone={item.incident.officialStatus === "official" ? "info" : "neutral"}>
          {item.incident.officialStatus === "official" ? "Official" : "Observed"}
        </StateLozenge>
      </td>
      <td className="numeric">
        {item.affectedRouteNames.length > 0 ? item.affectedRouteNames.join(", ") : "—"}
      </td>
    </tr>
  );
}
