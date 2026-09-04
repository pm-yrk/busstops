import type { DeparturePrediction } from "@busstops/contracts";
import { countdownLabel, formatLondonTime, freshnessLabel } from "../lib/format.js";
import { PixelBusSide } from "./pixel/PixelArt.js";
import "./ArrivalBoard.css";

/**
 * The pixel digital arrival board — the first surface a selected stop shows
 * (docs/09_BUS_STOPS_LIVE.md "Stop arrival board").
 *
 * The board distinguishes live predictions from timetable-only departures, never shows a
 * negative countdown, and states its own age. It is a table, not a decorative panel: screen
 * reader users get the same rows in the same order.
 */

export interface ArrivalBoardProps {
  stopName: string;
  stopCode: string;
  departures: readonly DeparturePrediction[];
  now: Date;
  /** Age of the underlying data in seconds; drives the freshness line. */
  ageSeconds: number | null;
  maxRows?: number;
  onViewAll?: () => void;
  degraded?: boolean;
}

export function ArrivalBoard({
  stopName,
  stopCode,
  departures,
  now,
  ageSeconds,
  maxRows = 4,
  onViewAll,
  degraded = false,
}: ArrivalBoardProps) {
  const rows = departures.slice(0, maxRows);

  return (
    <section className="arrival-board" aria-labelledby="arrival-board-heading">
      {/* The bezel: a printed label on the housing, not part of the display. */}
      <header className="arrival-board__header">
        <div className="arrival-board__plate">
          <PixelBusSide size={22} className="arrival-board__mark" />
          <p className="arrival-board__next">NEXT BUS</p>
        </div>
        <div>
          <h2 id="arrival-board-heading" className="arrival-board__stop">
            {stopName}
          </h2>
          <p className="arrival-board__code">Stop {stopCode}</p>
        </div>
      </header>

      {/* The screen. Everything inside it is under the dot matrix. */}
      <div className="arrival-board__screen">
        {rows.length === 0 ? (
          <p className="arrival-board__empty">
            {degraded
              ? "No live departures available right now. Timetabled departures are shown below where we have them."
              : "No departures in the next hour."}
          </p>
        ) : (
          <table className="arrival-board__table">
            <caption className="visually-hidden">
              Next departures from {stopName}, stop {stopCode}
            </caption>
            <thead>
              <tr>
                <th scope="col">Route</th>
                <th scope="col">Destination</th>
                <th scope="col">Due</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((departure) => (
                <ArrivalRow key={departure.id} departure={departure} now={now} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="arrival-board__footer">
        <p className="arrival-board__freshness micro">
          {ageSeconds === null ? "Timetable only" : `Updated ${freshnessLabel(ageSeconds)}`}
        </p>
        {onViewAll && (
          <button
            type="button"
            className="button-quiet arrival-board__view-all"
            onClick={onViewAll}
          >
            View all departures
          </button>
        )}
      </footer>
    </section>
  );
}

function ArrivalRow({ departure, now }: { departure: DeparturePrediction; now: Date }) {
  const time = departure.expectedTime ?? departure.scheduledTime;
  const state = describeState(departure);

  return (
    <tr className="arrival-board__row">
      <td className="arrival-board__route">
        <span className="route-badge">{departure.serviceRoutePublicName}</span>
      </td>
      <td className="arrival-board__destination">{departure.destinationName}</td>
      <td className="arrival-board__due">
        <span className="arrival-board__countdown">
          {departure.liveState === "cancelled"
            ? "Cancelled"
            : time
              ? countdownLabel(new Date(time), now)
              : "—"}
        </span>
        {/* Status is never colour alone: a lamp, and the word beside it. */}
        <span className={`arrival-board__state arrival-board__state--${state.tone}`}>
          <span className="arrival-board__lamp" aria-hidden="true" />
          {state.label}
        </span>
        {time && (
          <span className="arrival-board__clock micro">{formatLondonTime(new Date(time))}</span>
        )}
      </td>
    </tr>
  );
}

interface StateDescription {
  label: string;
  tone: "live" | "scheduled" | "cancelled" | "stale";
}

export function describeState(departure: DeparturePrediction): StateDescription {
  if (departure.liveState === "cancelled") return { label: "Cancelled", tone: "cancelled" };
  if (departure.qualityFlags.includes("stale")) return { label: "Last known", tone: "stale" };
  if (departure.liveState === "live") return { label: "Live", tone: "live" };
  if (departure.liveState === "estimated") return { label: "Estimated", tone: "live" };
  if (departure.liveState === "no_service") return { label: "No service", tone: "scheduled" };
  return { label: "Timetable", tone: "scheduled" };
}
