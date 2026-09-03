import { PixelBusSide } from "./pixel/PixelArt.js";
import "./LoadingBus.css";

/**
 * The signature loading moment: a small pixel bus travels along a road.
 *
 * Two rules from docs/02_DESIGN_SYSTEM.md are enforced here rather than left to callers:
 * it must respect prefers-reduced-motion (the CSS stops the travel entirely), and it must not
 * block content indefinitely — callers pass `timedOut` once their own deadline passes, and the
 * component then yields to a plain message instead of animating forever.
 */

export interface LoadingBusProps {
  label?: string;
  /** Set once the caller's loading deadline has passed. */
  timedOut?: boolean;
  compact?: boolean;
}

export function LoadingBus({
  label = "Loading",
  timedOut = false,
  compact = false,
}: LoadingBusProps) {
  if (timedOut) {
    return (
      <div className="loading-bus loading-bus--timed-out" role="status">
        <p className="muted">
          This is taking longer than usual. The data may be delayed — you can keep waiting or try
          again.
        </p>
      </div>
    );
  }

  return (
    <div className={`loading-bus ${compact ? "loading-bus--compact" : ""}`} role="status">
      {/* One polite announcement, not a stream of updates. */}
      <span className="visually-hidden">{label}</span>
      <div className="loading-bus__scene" aria-hidden="true">
        <div className="loading-bus__vehicle">
          <PixelBusSide size={compact ? 20 : 32} />
        </div>
        <div className="loading-bus__road" />
      </div>
      {!compact && <p className="loading-bus__label muted small">{label}</p>}
    </div>
  );
}
