import { useCallback, useState } from "react";
import type { OperatorsResponse } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import { EmptyState, ErrorState, StateLozenge } from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";
import { DataModeBanner, ProMetricTile, ScopeFilters } from "./ProPrimitives.js";

/**
 * Operator scorecards (docs/10_BUS_STOPS_PRO.md).
 *
 * Raw and context-adjusted figures appear side by side and neither can be viewed alone. The raw
 * figure ignores that one operator runs through a city centre and another along a bypass; the
 * adjusted figure hides what passengers actually experienced. Publishing either on its own would
 * be a different, and wrong, claim.
 *
 * An operator below the comparison threshold is shown with its reason instead of a rank. It is
 * not sorted into the list and marked "provisional": a number in a ranked column is read as a
 * rank whatever the caveat says.
 */

export function OperatorsPage() {
  const [windowMinutes, setWindowMinutes] = useState(1440);
  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.proOperators({ windowMinutes }, signal),
    [windowMinutes],
  );

  const { data, error, loading, timedOut, reload } = useFetch<{ data: OperatorsResponse }>(
    fetcher,
    {
      timeoutMs: 8000,
    },
  );

  if (loading && !data) return <LoadingBus label="Loading operators" timedOut={timedOut} />;
  if (error || !data) {
    return (
      <ErrorState
        title="We could not load operator scorecards"
        description={error?.message ?? "Operator scorecards could not be loaded."}
        onRetry={reload}
      />
    );
  }

  const operators = data.data;
  const comparable = operators.scorecards.filter((card) => card.rankingEligible);
  const notComparable = operators.scorecards.filter((card) => !card.rankingEligible);

  return (
    <>
      <DataModeBanner provenance={operators.provenance} />
      <ScopeFilters windowMinutes={windowMinutes} onWindowChange={setWindowMinutes} />

      {operators.comparabilityWarning ? (
        <p className="pro-note">{operators.comparabilityWarning}</p>
      ) : null}

      <section className="pro-section" aria-labelledby="ops-comparable">
        <h2 id="ops-comparable">Scorecards</h2>
        {comparable.length > 0 ? (
          <ul className="pro-list">
            {comparable.map((card) => (
              <li key={card.operatorId} className="pro-card">
                <h3>{card.operatorName}</h3>
                <div className="pro-grid">
                  {[...card.raw, ...card.contextAdjusted].map((metric) => (
                    <ProMetricTile key={`${card.operatorId}-${metric.key}`} metric={metric} />
                  ))}
                </div>
                {card.contextFactors.length > 0 ? (
                  <>
                    <p className="muted small">What the adjustment accounts for:</p>
                    <ul>
                      {card.contextFactors.map((factor) => (
                        <li key={factor}>{factor}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <ul className="muted small">
                  {card.coverageCaveats.map((caveat) => (
                    <li key={caveat}>{caveat}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No comparable operators"
            description="No operator in this scope has enough published observations to be compared."
          />
        )}
      </section>

      {notComparable.length > 0 ? (
        <section className="pro-section" aria-labelledby="ops-not-comparable">
          <h2 id="ops-not-comparable">Not comparable</h2>
          <p className="muted small">
            These operators are shown separately rather than ranked. Their figures describe the
            small part of their service we can see, and placing them in the list above would invite
            a comparison the data cannot support.
          </p>
          <ul className="pro-list">
            {notComparable.map((card) => (
              <li key={card.operatorId} className="pro-card">
                <h3>
                  {card.operatorName} <StateLozenge tone="warning">Not comparable</StateLozenge>
                </h3>
                <p>{card.rankingIneligibleReason}</p>
                <ul className="muted small">
                  {card.coverageCaveats.map((caveat) => (
                    <li key={caveat}>{caveat}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
