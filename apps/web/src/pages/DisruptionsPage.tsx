import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import type { DisruptionItem, DisruptionsResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { PixelMasthead } from "../components/pixel/PixelMasthead.js";
import {
  ComparisonBar,
  EmptyState,
  ErrorState,
  ServiceBanner,
  StateLozenge,
} from "../components/primitives.js";
import { OfficialNotices } from "../components/OfficialNotices.js";
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";
import { minutesLabel, percentLabel } from "../lib/format.js";
import "./DisruptionsPage.css";
import { PixelSectionHeading } from "../components/pixel/PixelSectionHeading.js";

/**
 * Disruptions (docs/03_SITE_MAP_AND_UX.md "Disruptions/detail").
 *
 * Two rankings, deliberately not merged. "Largest delay burden" finds where the most passenger
 * time is being lost, which is usually a busy corridor behaving slightly badly. "Most abnormal"
 * finds where conditions are furthest from normal, which is usually a quiet road behaving very
 * badly. A single combined list would answer neither question.
 */

const REFRESH_INTERVAL_MS = 60_000;
const LOADING_TIMEOUT_MS = 8_000;

type RankingKey = "burden" | "abnormal";

export function DisruptionsPage() {
  const fetcher = useCallback((signal: AbortSignal) => apiClient.disruptions(signal), []);
  const {
    data: response,
    error,
    loading,
    timedOut,
    reload,
  } = useFetch<DisruptionsResponse>(fetcher, {
    timeoutMs: LOADING_TIMEOUT_MS,
    refreshMs: REFRESH_INTERVAL_MS,
  });

  const [ranking, setRanking] = useState<RankingKey>("burden");

  if (loading && !response) return <LoadingBus label="Loading disruptions" timedOut={timedOut} />;

  if (error || !response) {
    return (
      <ErrorState
        title="We could not load disruptions"
        description={error?.message ?? "Disruption analysis could not be loaded."}
        onRetry={reload}
      />
    );
  }

  const items = ranking === "burden" ? response.data.byDelayBurden : response.data.byAbnormality;

  return (
    <article className="page disruptions-page">
      <ServiceBanner meta={response.meta} />

      <PixelMasthead
        title="Disruption"
        standfirst="What operators have announced, and what we have observed. They are different claims, so they are shown separately."
        props={["bin", "stopFlag"]}
      />

      <OfficialNotices
        notices={response.data.official}
        sourcesQueried={response.data.sourcesQueried}
        collectedAt={response.data.officialCollectedAt}
      />

      <section className="disruptions-page__observed" aria-labelledby="observed-heading">
        <header className="disruptions-page__header">
          <PixelSectionHeading mark="chart" id="observed-heading">
            Observed by Bus Stops
          </PixelSectionHeading>
          <p className="muted">
            Worked out from watching buses, not announced by anyone. Two ways of asking what is
            wrong: they rarely agree, and both are worth reading.
          </p>
        </header>

        <div className="disruptions-page__tabs" role="tablist" aria-label="Ranking">
          <button
            type="button"
            role="tab"
            aria-selected={ranking === "burden"}
            className={ranking === "burden" ? "is-selected" : ""}
            onClick={() => setRanking("burden")}
          >
            Largest delay burden
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={ranking === "abnormal"}
            className={ranking === "abnormal" ? "is-selected" : ""}
            onClick={() => setRanking("abnormal")}
          >
            Most abnormal
          </button>
        </div>

        <p className="disruptions-page__explainer muted small">
          {ranking === "burden"
            ? "Ranked by total passenger time lost. A busy corridor running slightly late usually outranks a quiet road running very late."
            : "Ranked by how far conditions are from normal for this time and place. A quiet road behaving unusually badly usually outranks a busy one behaving as it always does."}
        </p>

        {items.length > 0 ? (
          <ul className="disruptions-page__list">
            {items.map((item) => (
              <DisruptionCard key={item.incident.id} item={item} />
            ))}
          </ul>
        ) : (
          <EmptyState
            art="stop"
            title="Nothing to report from this ranking"
            description="No disruption meets the evidence threshold right now. That is not the same as everywhere running well — see the coverage note below."
          />
        )}
      </section>

      <section aria-labelledby="coverage-heading" className="disruptions-page__coverage">
        <PixelSectionHeading mark="warning" id="coverage-heading">
          What this does not cover
        </PixelSectionHeading>
        {response.data.uncoveredAreas.length > 0 ? (
          <ul>
            {response.data.uncoveredAreas.map((area) => (
              <li key={area}>{area}</li>
            ))}
          </ul>
        ) : (
          <p className="muted small">All analysed areas have published coverage.</p>
        )}
        <p className="muted small">
          An empty list above means nothing met the threshold where we can see. It does not mean
          nothing is wrong where we cannot. <Link to="/methodology">How this is measured</Link>.
        </p>
      </section>
    </article>
  );
}

function DisruptionCard({ item }: { item: DisruptionItem }) {
  const trendLabel = {
    improving: "Improving",
    steady: "Steady",
    worsening: "Worsening",
    unknown: "Trend not known",
  }[item.recoveryTrend];

  return (
    <li className="disruption-card">
      <header>
        <h3>{item.incident.narrative}</h3>
        <div className="disruption-card__lozenges">
          <StateLozenge tone={item.incident.officialStatus === "official" ? "info" : "neutral"}>
            {item.incident.officialStatus === "official" ? "Official" : "Observed"}
          </StateLozenge>
          <StateLozenge tone={item.recoveryTrend === "worsening" ? "warning" : "neutral"}>
            {trendLabel}
          </StateLozenge>
        </div>
      </header>

      {item.currentValueSeconds !== null && item.baselineValueSeconds !== null ? (
        <ComparisonBar
          label="Now against normal"
          value={item.currentValueSeconds}
          comparison={item.baselineValueSeconds}
          max={Math.max(item.currentValueSeconds, item.baselineValueSeconds) * 1.2}
          unit="s"
        />
      ) : (
        <p className="muted small">
          There is no comparable baseline for this place and time, so we cannot say how unusual this
          is.
        </p>
      )}

      <dl className="disruption-card__facts">
        <div>
          <dt>How often this happens</dt>
          <dd>
            {item.occurrenceFrequency === null
              ? "Not enough history"
              : `${percentLabel(item.occurrenceFrequency)} of comparable periods (${item.occurrenceSample} observed)`}
          </dd>
        </div>
        <div>
          <dt>Going on for</dt>
          <dd>{minutesLabel(item.durationSeconds)}</dd>
        </div>
        <div>
          <dt>Buses affected</dt>
          <dd>{item.affectedVehicleCount}</dd>
        </div>
        <div>
          <dt>Time lost</dt>
          <dd>
            {item.delayBurdenVehicleMinutes === null
              ? "Not measured"
              : `${Math.round(item.delayBurdenVehicleMinutes)} bus-minutes`}
          </dd>
        </div>
      </dl>

      {item.affectedRouteNames.length > 0 ? (
        <p className="disruption-card__routes">Routes: {item.affectedRouteNames.join(", ")}</p>
      ) : null}

      {item.officialContext.length > 0 ? (
        <ul className="disruption-card__context">
          {item.officialContext.map((context) => (
            <li key={context}>{context}</li>
          ))}
        </ul>
      ) : (
        <p className="muted small">
          No official road, works or flood notice corroborates this. It is what the buses show, and
          nothing more.
        </p>
      )}
    </li>
  );
}
