import { useState } from "react";
import type { ProMetric, ProProvenance } from "@busstops/contracts";
import { StateLozenge } from "../components/primitives.js";
import { PixelClock, PixelWarning } from "../components/pixel/PixelArt.js";
import { SECTION_MARKS, type SectionMark } from "../components/pixel/PixelSectionHeading.js";
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

/**
 * A mark per figure, from the same sixteen-unit vocabulary the section headings use.
 *
 * Pro's tiles were a bordered box with a number in it, which is the one place on this site where
 * nothing said which design system it belonged to. These are chosen from the metric's own key —
 * a bus for the vehicles observed, a route for the segments, a clock for a duration — so the
 * mark is a property of what is being counted rather than decoration applied on top.
 *
 * Unknown keys get no mark rather than a generic one. A shape that means nothing in particular
 * is worse than none: it reads as a category the reader is failing to recognise.
 */
const METRIC_MARKS: Record<string, SectionMark> = {
  network_health: "chart",
  active_vehicles: "bus",
  punctuality: "clock",
  reliability: "chart",
  median_delay: "clock",
  median_segment_traversal: "clock",
  segments_measured: "route",
  abnormal_disruptions: "warning",
};

/**
 * The value split from its unit, so the number is the thing you read first.
 *
 * "613" set large with "buses" small beside it is a figure; "613" alone is a number in a box,
 * and the unit crammed into the same type size competes with the digits for the same glance.
 */
function splitMetricValue(metric: ProMetric): { value: string; unit: string | null } {
  if (metric.value === null) return { value: "—", unit: null };
  switch (metric.unit) {
    case "percent":
      return { value: `${(metric.value * 100).toFixed(metric.value < 0.1 ? 1 : 0)}`, unit: "%" };
    case "seconds":
      return { value: `${Math.round(metric.value)}`, unit: "sec" };
    case "minutes":
      return { value: `${Math.round(metric.value)}`, unit: "min" };
    case "vehicle_minutes":
      return { value: metric.value.toFixed(1), unit: "bus-min" };
    case "points":
      return { value: `${Math.round(metric.value)}`, unit: "/100" };
    case "count":
      return { value: metric.value.toLocaleString("en-GB"), unit: null };
  }
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

/**
 * How old the figure is, in the units a person thinks in.
 *
 * This said "900s", which is both unreadable and about to become the normal case: a segment
 * metric comes from a five-minute bucket that closes ten minutes after it ends, so every live
 * figure Pro can honestly publish is a quarter of an hour old or more. A number that large in
 * seconds reads as an error; in minutes it reads as what it is, which is a measurement that has
 * settled rather than one still being revised.
 */
export function freshnessLabel(seconds: number | null): string {
  if (seconds === null) return "not applicable";
  if (seconds < 90) return `${Math.round(seconds)} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(seconds / 3600);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
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
  const { value, unit } = splitMetricValue(metric);
  const mark = METRIC_MARKS[metric.key];
  const Mark = mark ? SECTION_MARKS[mark] : null;

  /*
   * Three states, not two.
   *
   * A figure can be measured, withheld because too few observations support it, or not measured
   * by this pipeline at all — and the third is permanent where the first two are not. They read
   * identically as "amber text under a dash", which tells a reader that waiting would help when
   * for one of them it never will. The state is on the element, so the stylesheet can make the
   * difference visible rather than leaving it to the sentence.
   */
  const state = !metric.suppressed
    ? "measured"
    : /does not read the timetable/.test(metric.suppressionReason ?? "")
      ? "unmeasured"
      : "withheld";

  return (
    <article className="pro-metric" data-state={state} data-testid={`metric-${metric.key}`}>
      <header>
        {Mark ? <Mark size={16} className="pro-metric__mark" /> : null}
        <h3>{metric.label}</h3>
      </header>

      <p className="pro-metric__value">
        {/*
          A dash is not a figure and must not be set like one. At heading size an em dash is a
          rule across the tile — it read as a loading skeleton, which is the one thing it is not:
          nothing further is coming for this metric right now.
        */}
        {metric.value === null ? (
          <span className="pro-metric__absent" aria-label="no figure">
            —
          </span>
        ) : (
          <>
            {value}
            {unit ? <span className="pro-metric__unit">{unit}</span> : null}
          </>
        )}
      </p>

      {/*
        Confidence sits under the figure it qualifies, not beside the label.
 
        In the header it competed with the label for one row and wrapped onto its own line at
        tile width, which pushed the number down and left the four tiles in a row with their
        figures at four different heights. It belongs with the number anyway: it is a statement
        about the value, not about what the value is called.
      */}
      {metric.confidence ? (
        <p className="pro-metric__confidence">
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
        </p>
      ) : null}

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
          {/*
            Named for what it answers. "Freshness: 900s" was a number nobody could act on; the
            question a reader actually has is when the thing being described happened.
          */}
          <dt>Measured</dt>
          <dd>{freshnessLabel(metric.freshnessSeconds)}</dd>
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

/**
 * Two measurements on one scale: what a segment is doing now against what it usually does.
 *
 * The numbers were there already — "142s now, 96s typical" in a row of spans — and nobody reads a
 * row of spans as "half as long again". Two bars sharing a maximum make the gap the thing you see
 * first, and the figures stay beside them because an operations team quotes numbers, not pictures.
 *
 * One hue, because this is magnitude. Whether the gap is bad is a judgement the card's confidence
 * and frequency lines make in words; a red bar would make it for them.
 */
export function CompareBar({
  nowSeconds,
  typicalSeconds,
  label,
}: {
  nowSeconds: number;
  typicalSeconds: number;
  label: string;
}) {
  const scale = Math.max(nowSeconds, typicalSeconds, 1);
  const rows: Array<{ name: string; value: number; kind: "now" | "typical" }> = [
    { name: "Now", value: nowSeconds, kind: "now" },
    { name: "Typical", value: typicalSeconds, kind: "typical" },
  ];

  return (
    <figure className="pro-compare" aria-label={label}>
      {rows.map((row) => (
        <div className="pro-compare__row" key={row.kind}>
          <span className="pro-compare__name">{row.name}</span>
          <span className="pro-compare__track">
            <span
              className={`pro-compare__fill pro-compare__fill--${row.kind}`}
              style={{ width: `${Math.max(2, Math.round((row.value / scale) * 100))}%` }}
            />
          </span>
          <span className="pro-compare__value">{Math.round(row.value)}s</span>
        </div>
      ))}
    </figure>
  );
}

/**
 * Where this row sits against the biggest in the list it is part of.
 *
 * A ranked list says which is worst and hides by how much: first and second can differ by a factor
 * of ten or by nothing at all, and an operations decision is different in each case. One thin bar
 * anchored to the baseline, scaled to the list's own maximum, with the value written out.
 */
export function RankBar({ value, max, label }: { value: number; max: number; label: string }) {
  if (max <= 0) return null;
  return (
    <div className="pro-rank" title={label}>
      <span className="pro-rank__track" aria-hidden="true">
        <span
          className="pro-rank__fill"
          style={{ width: `${Math.max(2, Math.round((value / max) * 100))}%` }}
        />
      </span>
      <span className="pro-rank__label">{label}</span>
    </div>
  );
}

/**
 * A count broken into named bands, drawn as one proportional bar.
 *
 * "Fourteen exceptions" and "fourteen exceptions, nine of them highly abnormal" are different
 * pieces of news, and a sentence of counts can only give the second by being read carefully. One
 * bar gives it at a glance — and because every band is named and counted in the legend beneath,
 * identity is never carried by colour alone.
 *
 * `tone` names the band's step in the CSS rather than carrying a colour, so severity and source
 * health look like the same product rather than two people's charts. A band with a count of zero
 * is left out entirely: a legend entry for something that is not there is a reader's time spent
 * on nothing.
 */
export interface Band {
  tone: string;
  label: string;
  count: number;
}

export function BandStrip({ bands, label }: { bands: readonly Band[]; label: string }) {
  const present = bands.filter((band) => band.count > 0);
  if (present.length === 0) return null;

  return (
    <figure className="pro-severity" aria-label={label}>
      <div className="pro-severity__bar" aria-hidden="true">
        {present.map((band) => (
          <span
            key={band.tone}
            className={`pro-severity__band pro-severity__band--${band.tone}`}
            style={{ flexGrow: band.count }}
          />
        ))}
      </div>
      <figcaption className="pro-severity__legend">
        {present.map((band) => (
          <span className="pro-severity__key" key={band.tone}>
            <span
              className={`pro-severity__swatch pro-severity__band--${band.tone}`}
              aria-hidden="true"
            />
            <strong>{band.count}</strong> {band.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
