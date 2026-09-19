import { useCallback, useState } from "react";
import type { ControlTowerResponse, PriorityException } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { EmptyState, ErrorState, StateLozenge } from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";
import {
  BandStrip,
  CoverageWarning,
  DataModeBanner,
  ProMetricTile,
  ScopeFilters,
} from "./ProPrimitives.js";
import { PixelSectionHeading } from "../components/pixel/PixelSectionHeading.js";

/**
 * Control Tower (docs/10_BUS_STOPS_PRO.md).
 *
 * The order on this page is an argument. Coverage weakness comes first, before any headline
 * figure, because a network health score of 71 computed from 40% of the network is a different
 * statement from the same score computed from 95% — and the reader who scrolls no further should
 * still have seen the more important of the two.
 */

export function ControlTowerPage() {
  const [windowMinutes, setWindowMinutes] = useState(60);
  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.proControlTower({ windowMinutes }, signal),
    [windowMinutes],
  );

  const { data, error, loading, timedOut, reload } = useFetch<{ data: ControlTowerResponse }>(
    fetcher,
    { timeoutMs: 8000, refreshMs: 60_000 },
  );

  if (loading && !data) return <LoadingBus label="Loading the control tower" timedOut={timedOut} />;
  if (error || !data) {
    return (
      <ErrorState
        title="We could not load the control tower"
        description={error?.message ?? "The dashboard could not be loaded."}
        onRetry={reload}
      />
    );
  }

  const tower = data.data;

  return (
    <>
      <DataModeBanner provenance={tower.provenance} />
      <CoverageWarning message={tower.coverageWarning} />

      <ScopeFilters windowMinutes={windowMinutes} onWindowChange={setWindowMinutes} />

      <section className="pro-section" aria-labelledby="ct-headline">
        <PixelSectionHeading mark="chart" id="ct-headline">
          Network at a glance
        </PixelSectionHeading>
        <div className="pro-grid">
          {tower.headline.map((metric) => (
            <ProMetricTile key={metric.key} metric={metric} />
          ))}
        </div>
      </section>

      <section className="pro-section" aria-labelledby="ct-sources">
        <PixelSectionHeading mark="warning" id="ct-sources">
          Source health
        </PixelSectionHeading>
        {/*
          The same strip the exception inbox uses for severity, because this is the same kind of
          question: what is this total made of. Four sources down out of six and four out of
          forty were the same sentence before, read at the same speed.
        */}
        <BandStrip
          label="Sources by health"
          bands={[
            { tone: "healthy", label: "healthy", count: tower.sourceHealth.healthy },
            { tone: "elevated", label: "degraded", count: tower.sourceHealth.degraded },
            { tone: "abnormal", label: "stale", count: tower.sourceHealth.stale },
            { tone: "highly_abnormal", label: "down", count: tower.sourceHealth.down },
          ]}
        />
        <p className="pro-note">
          Where a source is not reporting, the network is unmeasured rather than clear.
        </p>
        {tower.sourceHealth.problems.length > 0 ? (
          <ul className="pro-list">
            {tower.sourceHealth.problems.map((problem) => (
              <li key={problem.source} className="pro-card">
                <h3>
                  {problem.source} <StateLozenge tone="warning">{problem.status}</StateLozenge>
                </h3>
                <p>{problem.detail}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Every source is reporting normally.</p>
        )}
      </section>

      <section className="pro-section" aria-labelledby="ct-exceptions">
        <PixelSectionHeading mark="works" id="ct-exceptions">
          Priority exceptions
        </PixelSectionHeading>
        {tower.priorityExceptions.length > 0 ? (
          <ul className="pro-list">
            {tower.priorityExceptions.map((exception) => (
              <ExceptionCard key={exception.incident.id} exception={exception} />
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No exceptions above the evidence threshold"
            description="Nothing currently meets the materiality and persistence gates. That is not a statement about parts of the network we cannot see."
          />
        )}
      </section>

      <div className="pro-two-up">
        <section className="pro-section" aria-labelledby="ct-burden">
          <PixelSectionHeading mark="clock" id="ct-burden">
            Biggest delay burden
          </PixelSectionHeading>
          <p className="muted small">Where the most passenger time is being lost.</p>
          <RankingList items={tower.biggestDelayBurden} emptyLabel="No measured delay burden." />
        </section>

        <section className="pro-section" aria-labelledby="ct-abnormal">
          <PixelSectionHeading mark="chart" id="ct-abnormal">
            Most abnormal
          </PixelSectionHeading>
          <p className="muted small">Where conditions are furthest from normal for this time.</p>
          <RankingList items={tower.mostAbnormal} emptyLabel="Nothing outside the normal range." />
        </section>
      </div>

      {/*
        The one section on this page that used to disappear when it had nothing to say.
 
        Every other one states its empty case — the exception inbox has an `EmptyState`, both
        ranking lists have an `emptyLabel`, source health says "every source is reporting
        normally". A dashboard where most sections answer and one silently goes missing reads as
        a page that failed to load part of itself, and "no route needs attention" is the answer an
        operations team most wants at a glance.
      */}
      <section className="pro-section" aria-labelledby="ct-routes">
        <PixelSectionHeading mark="route" id="ct-routes">
          Routes requiring attention
        </PixelSectionHeading>
        {tower.routesRequiringAttention.length > 0 ? (
          <ul className="pro-list">
            {tower.routesRequiringAttention.map((route) => (
              <li key={route.routeId} className="pro-card">
                <h3>
                  {route.routeName} · {route.operatorName}
                </h3>
                <p>{route.reason}</p>
                <p className="pro-card__meta">
                  <span>{route.metric.denominator} observations</span>
                  <span>{route.metric.window}</span>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">
            No route in this scope crossed the attention threshold in this window. That is a
            statement about the routes we can measure, not about the whole network.
          </p>
        )}
      </section>

      <section className="pro-section" aria-labelledby="ct-outlook">
        <PixelSectionHeading mark="clock" id="ct-outlook">
          Outlook
        </PixelSectionHeading>
        <p>{tower.outlook}</p>
        <ul className="pro-list">
          {tower.intelligenceSummary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="muted small">
          This summary is assembled from the figures above by a fixed rule. No model writes it, and
          it says nothing the numbers do not support.
        </p>
      </section>
    </>
  );
}

function RankingList({
  items,
  emptyLabel,
}: {
  items: readonly PriorityException[];
  emptyLabel: string;
}) {
  if (items.length === 0) return <p className="muted small">{emptyLabel}</p>;
  return (
    <ul className="pro-list">
      {items.map((item) => (
        <ExceptionCard key={`${item.surfacedBy}-${item.incident.id}`} exception={item} />
      ))}
    </ul>
  );
}

export function ExceptionCard({ exception }: { exception: PriorityException }) {
  return (
    <li className="pro-card">
      <h3>{exception.incident.narrative}</h3>
      <div className="pro-card__meta">
        <StateLozenge tone={exception.incident.officialStatus === "official" ? "info" : "neutral"}>
          {exception.incident.officialStatus === "official" ? "Official" : "Observed"}
        </StateLozenge>
        <StateLozenge tone={exception.recoveryTrend === "worsening" ? "warning" : "neutral"}>
          {exception.recoveryTrend}
        </StateLozenge>
        <span>{exception.incident.severity.replace(/_/g, " ")}</span>
        {exception.impactVehicleMinutes !== null ? (
          <span>{exception.impactVehicleMinutes.toFixed(1)} bus-minutes lost</span>
        ) : null}
        {exception.abnormalityPercentile !== null ? (
          <span>
            worse than {(exception.abnormalityPercentile * 100).toFixed(0)}% of comparable periods
          </span>
        ) : null}
        {exception.affectedRouteNames.length > 0 ? (
          <span>routes {exception.affectedRouteNames.join(", ")}</span>
        ) : null}
      </div>
      {exception.incident.confidence.reasons.length > 0 ? (
        <p className="muted small">Evidence: {exception.incident.confidence.reasons.join("; ")}.</p>
      ) : null}
    </li>
  );
}
