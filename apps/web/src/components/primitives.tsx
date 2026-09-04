import type { ReactNode } from "react";
import type { Confidence, ResponseMeta } from "@busstops/contracts";
import { confidenceLabel, degradationMessage, freshnessLabel } from "../lib/format.js";
import {
  PixelBusFront,
  PixelBusSide,
  PixelShelter,
  PixelStopPole,
  PixelWarning,
} from "./pixel/PixelArt.js";
import "./primitives.css";

/**
 * Shared primitives (docs/02_DESIGN_SYSTEM.md "Components").
 *
 * Two rules run through all of them: status is never communicated by colour alone, and any
 * claim carries its evidence — freshness, coverage, denominator or confidence — alongside it.
 */

export type Tone = "neutral" | "live" | "info" | "success" | "warning" | "critical";

export function StateLozenge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`lozenge lozenge--${tone}`}>{children}</span>;
}

export function RouteBadge({ name, ariaLabel }: { name: string; ariaLabel?: string }) {
  return (
    <span className="route-badge route-badge--inline" aria-label={ariaLabel ?? `Route ${name}`}>
      {name}
    </span>
  );
}

/** Confidence is always shown with its reason, so a low score is explainable rather than opaque. */
export function ConfidenceChip({ confidence }: { confidence: Confidence }) {
  const reason = confidence.reasons[0];
  return (
    <span className={`confidence confidence--${confidence.level}`}>
      <span className="confidence__dot" aria-hidden="true" />
      <span>{confidenceLabel(confidence.level)}</span>
      {reason && <span className="confidence__reason muted small"> — {reason}</span>}
    </span>
  );
}

export function DataAge({
  seconds,
  prefix = "Updated",
}: {
  seconds: number | null;
  prefix?: string;
}) {
  if (seconds === null) return <span className="muted small">Timetable only</span>;
  const stale = seconds > 180;
  return (
    <span className={`data-age ${stale ? "data-age--stale" : ""}`}>
      {prefix} {freshnessLabel(seconds)}
      {stale && <span className="visually-hidden"> (older than usual)</span>}
    </span>
  );
}

/** Provenance chip: which source a fact came from, shown wherever a fact is shown. */
export function SourceChip({ source, area }: { source: string; area?: string }) {
  const label =
    { bods: "BODS", tfl: "TfL", naptan: "NaPTAN", osm: "OpenStreetMap" }[source] ?? source;
  return (
    <span className="source-chip">
      {label}
      {area ? ` · ${area}` : ""}
    </span>
  );
}

export function MetricTile({
  label,
  value,
  unit,
  denominator,
  window,
  confidence,
  children,
}: {
  label: string;
  value: string;
  unit?: string;
  denominator?: string;
  window?: string;
  confidence?: Confidence;
  children?: ReactNode;
}) {
  return (
    <div className="metric-tile surface">
      <p className="metric-tile__label micro muted">{label}</p>
      <p className="metric-tile__value">
        {value}
        {unit && <span className="metric-tile__unit"> {unit}</span>}
      </p>
      {/* A metric without its denominator and window is KPI theatre, so both are shown. */}
      {(denominator || window) && (
        <p className="metric-tile__detail micro muted">
          {[denominator, window].filter(Boolean).join(" · ")}
        </p>
      )}
      {confidence && (
        <p className="metric-tile__confidence micro">
          <ConfidenceChip confidence={confidence} />
        </p>
      )}
      {children}
    </div>
  );
}

/** The service banner: how degradation and quota pressure reach the user honestly. */
export function ServiceBanner({
  meta,
}: {
  meta: Pick<ResponseMeta, "degradation" | "governorState">;
}) {
  const message = degradationMessage(meta.degradation);
  if (!message) return null;

  return (
    <div className="service-banner" role="status">
      <PixelWarning size={20} />
      <p className="service-banner__text">{message}</p>
    </div>
  );
}

/**
 * The artwork an empty passenger surface may carry.
 *
 * Opt-in rather than automatic: an empty Pro table wants a sentence and nothing else, and a
 * drawing on every one of the two dozen empty states in the product would be decoration rather
 * than design. These are the same sprites as the hero and the map, at a small size.
 */
const EMPTY_ART = {
  // Each carries its own whole-number scale: the sprites are different shapes, and one shared
  // target height renders a tall thin stop flag at 1x and a wide bus at 3x.
  bus: [PixelBusSide, 3],
  front: [PixelBusFront, 2],
  stop: [PixelStopPole, 2],
  shelter: [PixelShelter, 2],
} as const;

export function EmptyState({
  title,
  description,
  action,
  art,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  art?: keyof typeof EMPTY_ART;
}) {
  const [Art, scale] = art ? EMPTY_ART[art] : [null, 1];
  return (
    <div className="state-block surface">
      {Art && <Art scale={scale} className="state-block__art" />}
      <h2 className="state-block__title">{title}</h2>
      <p className="muted">{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
}: {
  title?: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state-block surface state-block--error" role="alert">
      <h2 className="state-block__title">{title}</h2>
      <p className="muted">{description}</p>
      {onRetry && (
        <button type="button" className="button-primary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Skeleton({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton__row" aria-hidden="true" />
      ))}
    </div>
  );
}

/** Evidence list used wherever the product makes an inferred claim. */
export function EvidenceList({ items }: { items: readonly { label: string; detail: string }[] }) {
  if (items.length === 0) return null;
  return (
    <dl className="evidence-list">
      {items.map((item) => (
        <div key={item.label} className="evidence-list__item">
          <dt>{item.label}</dt>
          <dd className="muted">{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Accessible comparison bar. The value is in the text as well as the bar width, and the bar
 * itself is hidden from assistive technology because the number already says it.
 */
export function ComparisonBar({
  label,
  value,
  comparison,
  max,
  unit = "",
}: {
  label: string;
  value: number;
  comparison?: number;
  max: number;
  unit?: string;
}) {
  const safeMax = max > 0 ? max : 1;
  const width = Math.max(0, Math.min(100, (value / safeMax) * 100));
  const comparisonWidth =
    comparison === undefined ? null : Math.max(0, Math.min(100, (comparison / safeMax) * 100));

  return (
    <div className="comparison">
      <div className="comparison__labels">
        <span>{label}</span>
        <span className="comparison__value">
          {value.toFixed(1)}
          {unit}
          {comparison !== undefined && (
            <span className="muted small">
              {" "}
              vs {comparison.toFixed(1)}
              {unit} typical
            </span>
          )}
        </span>
      </div>
      <div className="comparison__track" aria-hidden="true">
        <div className="comparison__fill" style={{ width: `${width}%` }} />
        {comparisonWidth !== null && (
          <div className="comparison__marker" style={{ left: `${comparisonWidth}%` }} />
        )}
      </div>
    </div>
  );
}
