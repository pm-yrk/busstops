import { useCallback, useState } from "react";
import type { CongestionHotspot, CongestionResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { EmptyState, ErrorState, StateLozenge } from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";
import { CompareBar, DataModeBanner, RankBar, ScopeFilters } from "./ProPrimitives.js";

/**
 * Congestion (docs/10_BUS_STOPS_PRO.md).
 *
 * "Biggest delays" and "most abnormal" are separate tabs rather than one sorted table. A road that
 * is slow every weekday at eight is not news; a road that is rarely slow and is slow now is what
 * an operations team needs. Combining them into a single score would bury the second beneath the
 * first, permanently.
 */

type Ranking = "delays" | "abnormal";

export function CongestionPage() {
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [ranking, setRanking] = useState<Ranking>("delays");

  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.proCongestion({ windowMinutes }, signal),
    [windowMinutes],
  );

  const { data, error, loading, timedOut, reload } = useFetch<{ data: CongestionResponse }>(
    fetcher,
    { timeoutMs: 8000, refreshMs: 60_000 },
  );

  if (loading && !data) return <LoadingBus label="Loading congestion" timedOut={timedOut} />;
  if (error || !data) {
    return (
      <ErrorState
        title="We could not load congestion analysis"
        description={error?.message ?? "Congestion analysis could not be loaded."}
        onRetry={reload}
      />
    );
  }

  const congestion = data.data;
  const hotspots = ranking === "delays" ? congestion.biggestDelays : congestion.mostAbnormal;
  /*
   * The scale the ranked bars share, taken from the list on screen rather than from a constant.
   *
   * A fixed maximum would make a quiet hour look like an empty chart and a bad one like a wall of
   * full bars. Scaled to its own list, the first bar is always full and the rest say how far
   * behind it they are, which is the comparison the ranking is claiming to have made.
   */
  const rankMax = hotspots.reduce((largest, hotspot) => {
    const value = rankValue(hotspot, ranking);
    return value !== null && value > largest ? value : largest;
  }, 0);

  return (
    <>
      <DataModeBanner provenance={congestion.provenance} />
      <ScopeFilters windowMinutes={windowMinutes} onWindowChange={setWindowMinutes} />

      <div className="pro-layout__nav" role="tablist" aria-label="Congestion ranking">
        <button
          type="button"
          role="tab"
          aria-selected={ranking === "delays"}
          className={ranking === "delays" ? "pro-layout__link is-active" : "pro-layout__link"}
          onClick={() => setRanking("delays")}
        >
          Biggest delays
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={ranking === "abnormal"}
          className={ranking === "abnormal" ? "pro-layout__link is-active" : "pro-layout__link"}
          onClick={() => setRanking("abnormal")}
        >
          Most abnormal
        </button>
      </div>

      <p className="muted small">
        {ranking === "delays"
          ? "Ranked by excess vehicle-minutes: the total additional time buses spent on the segment against its baseline."
          : "Ranked by rarity: how seldom conditions are this bad on this segment at this time of day."}
      </p>

      <section className="pro-section" aria-labelledby="congestion-heading">
        <h2 id="congestion-heading">Hotspots</h2>
        {hotspots.length > 0 ? (
          <ul className="pro-list">
            {hotspots.map((hotspot) => (
              <HotspotCard
                key={hotspot.segmentId}
                hotspot={hotspot}
                ranking={ranking}
                rankMax={rankMax}
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No congestion hotspots published"
            description="No segment-level congestion analysis has been published for this scope and window."
          />
        )}
      </section>

      <p className="pro-note">{congestion.causationNotice}</p>
    </>
  );
}

/**
 * The number this tab is ranking by, or null when the segment does not carry it.
 *
 * "Most abnormal" ranks by rarity, so the bar has to grow as the frequency falls — a segment that
 * is this bad on 2% of comparable periods is the more abnormal of a pair, not the smaller.
 */
function rankValue(hotspot: CongestionHotspot, ranking: Ranking): number | null {
  if (ranking === "delays") return hotspot.excessVehicleMinutes;
  if (hotspot.occurrenceFrequency === null) return null;
  return 1 - hotspot.occurrenceFrequency;
}

function HotspotCard({
  hotspot,
  ranking,
  rankMax,
}: {
  hotspot: CongestionHotspot;
  ranking: Ranking;
  rankMax: number;
}) {
  const rank = rankValue(hotspot, ranking);

  return (
    <li className="pro-card">
      <h3>
        {hotspot.name}
        {hotspot.direction ? <span className="muted small"> · {hotspot.direction}</span> : null}
      </h3>

      {/*
        The ranking made visible, then the measurement made visible.

        The card listed six figures as equal spans, which is a table cell's worth of information
        arranged as a sentence — so the one thing it was ordered by, and the one comparison that
        says whether this is a bad road or a bad hour, were both invisible.
      */}
      {rank !== null ? (
        <RankBar
          value={rank}
          max={rankMax}
          label={
            ranking === "delays"
              ? `${hotspot.excessVehicleMinutes!.toFixed(1)} excess bus-minutes`
              : `this bad on ${(hotspot.occurrenceFrequency! * 100).toFixed(0)}% of comparable periods`
          }
        />
      ) : null}

      {hotspot.currentSeconds !== null && hotspot.typicalSeconds !== null ? (
        <CompareBar
          nowSeconds={hotspot.currentSeconds}
          typicalSeconds={hotspot.typicalSeconds}
          label={`Time on ${hotspot.name} now against typical`}
        />
      ) : null}

      <div className="pro-card__meta">
        <span>{hotspot.timeWindow}</span>
        <span>{hotspot.affectedVehicleCount} buses</span>
        {hotspot.affectedRouteNames.length > 0 ? (
          <span>routes {hotspot.affectedRouteNames.join(", ")}</span>
        ) : null}
        {hotspot.confidence ? (
          <StateLozenge tone={hotspot.confidence.level === "high" ? "success" : "info"}>
            {hotspot.confidence.level} confidence
          </StateLozenge>
        ) : null}
      </div>

      <p className="muted small">
        {hotspot.occurrenceFrequency === null
          ? "No comparable history for this segment and time."
          : `Conditions at least this bad occur on ${(hotspot.occurrenceFrequency * 100).toFixed(0)}% of comparable periods (${hotspot.occurrenceSample} observed).`}
      </p>

      {hotspot.corroboration.length > 0 ? (
        <>
          <p className="muted small">Active nearby at the same time:</p>
          <ul className="muted small">
            {hotspot.corroboration.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted small">
          Nothing official corroborates this. It is what the buses show, and nothing more.
        </p>
      )}
    </li>
  );
}
