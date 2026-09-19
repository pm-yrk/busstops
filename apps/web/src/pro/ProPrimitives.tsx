import { useState } from "react";
import type { ProMetric, ProProvenance } from "@busstops/contracts";
import { StateLozenge } from "../components/primitives.js";
import { PixelClock, PixelWarning } from "../components/pixel/PixelArt.js";
import "./ProPrimitives.css";

/**
 * Shared Pro building blocks.
 *
 * The metric tile is the important one. It cannot render a value without also carrying the
 * definition, denominator, window, freshness and coverage, because a number on an operations
 * dashboard gets acted on — someone reschedules a driver or calls an operator — and a figure from
 * eleven journeys looks exactly like one from nine hundred unless the component refuses to let it.
 */

export function DataModeBanner({ provenance }: { provenance: ProProvenance }) {
  if (provenance.dataMode === "live") return null;

  return (
    <div
      className={`pro-mode pro-mode--${provenance.dataMode}`}
      role="status"
      data-testid="pro-data-mode"
    >
      {/*
       * Pro is restrained rather than plain. The two shared notices are where a pixel detail
       * earns its place — they appear on every section, so one mark each is the whole product
       * carrying the language without any page having to decorate itself.
       */}
      <PixelClock size={18} className="pro-mode__mark" />
      <strong>
        {provenance.dataMode === "demo_snapshot"
          ? `Demonstration snapshot — ${provenance.snapshotDate ?? "undated"}`
          : "Data unavailable"}
      </strong>
      {provenance.notice ? <p>{provenance.notice}</p> : null}
    </div>
  );
}

export function formatMetricValue(metric: ProMetric): string {
  if (metric.value === null) return "—";
  switch (metric.unit) {
    case "percent":
      return `${(metric.value * 100).toFixed(metric.value < 0.1 ? 1 : 0)}%`;
    case "seconds":
      return `${Math.round(metric.value)}s`;
    case "minutes":
      return `${Math.round(metric.value)} min`;
    case "vehicle_minutes":
      return `${metric.value.toFixed(1)} bus-min`;
    case "points":
      return `${Math.round(metric.value)}`;
    case "count":
      return metric.value.toLocaleString("en-GB");
  }
}

function comparisonText(metric: ProMetric): string | null {
  if (metric.value === null || metric.baselineValue === null || metric.suppressed) return null;
  const difference = metric.value - metric.baselineValue;
  if (difference === 0) return "the same as its baseline";
  const direction = difference > 0 ? "above" : "below";
  const magnitude =
    metric.unit === "percent"
      ? `${Math.abs(difference * 100).toFixed(1)} points`
      : `${Math.abs(difference).toFixed(metric.unit === "vehicle_minutes" ? 1 : 0)}`;
  return `${magnitude} ${direction} its baseline of ${formatMetricValue({ ...metric, value: metric.baselineValue })}`;
}

export function ProMetricTile({ metric }: { metric: ProMetric }) {
  const [showDefinition, setShowDefinition] = useState(false);
  const comparison = comparisonText(metric);

  return (
    <article className="pro-metric" data-testid={`metric-${metric.key}`}>
      <header>
        <h3>{metric.label}</h3>
        {metric.confidence ? (
          <StateLozenge
            tone={
              metric.confidence.level === "high"
                ? "success"
                : metric.confidence.level === "medium"
                  ? "info"
                  : "warning"
            }
          >
            {metric.confidence.level} confidence
          </StateLozenge>
        ) : null}
      </header>

      <p className="pro-metric__value">{formatMetricValue(metric)}</p>

      {metric.suppressed ? (
        <p className="pro-metric__suppressed">{metric.suppressionReason}</p>
      ) : (
        <p className="pro-metric__comparison">
          {metric.value !== null && metric.baselineValue !== null ? (
            <span
              className="pro-metric__delta"
              data-direction={
                metric.value > metric.baselineValue
                  ? "up"
                  : metric.value < metric.baselineValue
                    ? "down"
                    : "flat"
              }
            >
              {/*
                A direction and a word, not a colour on its own. Whether up is good depends on the
                metric — a rise in "buses running" and a rise in "average delay" are opposite news
                — so the arrow states the change and the sentence beside it states the baseline.
              */}
              {metric.value > metric.baselineValue
                ? "▲"
                : metric.value < metric.baselineValue
                  ? "▼"
                  : "■"}
            </span>
          ) : null}
          {comparison ?? "No comparable baseline yet."}
        </p>
      )}

      {/*
        Coverage as a bar as well as a number.

        The share of the requested scope with usable data is the figure that decides how much of
        the rest of the tile to believe, and it was a percentage in the fourth row of a definition
        list. One thin bar, one hue, anchored to its baseline — magnitude, so sequential rather
        than a status colour, because "87% of the network" is not good news or bad news on its own.

        `aria-hidden`, because the same number is announced from the facts list below and a screen
        reader does not need it twice.
      */}
      <div
        className="pro-metric__coverage"
        aria-hidden="true"
        title={`${(metric.coverage * 100).toFixed(0)}% of this scope had usable data`}
      >
        <span
          className="pro-metric__coverage-fill"
          style={{ width: `${Math.max(2, Math.round(metric.coverage * 100))}%` }}
        />
      </div>

      <dl className="pro-metric__facts">
        <div>
          <dt>Denominator</dt>
          <dd>{metric.denominator.toLocaleString("en-GB")}</dd>
        </div>
        <div>
          <dt>Window</dt>
          <dd>{metric.window}</dd>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd>{(metric.coverage * 100).toFixed(0)}%</dd>
        </div>
        <div>
          <dt>Freshness</dt>
          <dd>
            {metric.freshnessSeconds === null
              ? "not applicable"
              : `${Math.round(metric.freshnessSeconds)}s`}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        className="pro-metric__definition-toggle"
        aria-expanded={showDefinition}
        onClick={() => setShowDefinition((value) => !value)}
      >
        {showDefinition ? "Hide definition" : "How this is measured"}
      </button>

      {showDefinition ? (
        <div className="pro-metric__definition">
          <p>{metric.definition}</p>
          {metric.confidence && metric.confidence.reasons.length > 0 ? (
            <ul>
              {metric.confidence.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {metric.evidence.length > 0 ? (
            <p className="muted small">Built from: {metric.evidence.join(", ")}.</p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function CoverageWarning({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="pro-coverage-warning" role="status">
      <PixelWarning size={18} className="pro-coverage-warning__mark" />
      <strong>Read this first</strong>
      <p>{message}</p>
    </div>
  );
}

export function ScopeFilters({
  windowMinutes,
  onWindowChange,
  operators,
  operatorId,
  onOperatorChange,
}: {
  windowMinutes: number;
  onWindowChange: (minutes: number) => void;
  operators?: ReadonlyArray<{ id: string; name: string }>;
  operatorId?: string | null;
  onOperatorChange?: (id: string | null) => void;
}) {
  return (
    <div className="pro-filters">
      <label>
        <span>Window</span>
        <select
          value={windowMinutes}
          onChange={(event) => onWindowChange(Number(event.target.value))}
        >
          <option value={60}>Last hour</option>
          <option value={180}>Last 3 hours</option>
          <option value={720}>Last 12 hours</option>
          <option value={1440}>Last 24 hours</option>
        </select>
      </label>

      {operators && onOperatorChange ? (
        <label>
          <span>Operator</span>
          <select
            value={operatorId ?? ""}
            onChange={(event) => onOperatorChange(event.target.value || null)}
          >
            <option value="">All operators</option>
            {operators.map((operator) => (
              <option key={operator.id} value={operator.id}>
                {operator.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
