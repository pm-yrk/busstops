import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { StopDeparturesResponse } from "@busstops/contracts";
import { apiClient, ApiError } from "../lib/api.js";
import { useTicker } from "../lib/use-fetch.js";
import { ArrivalBoard } from "./ArrivalBoard.js";
import { LoadingBus } from "./LoadingBus.js";
import "./SelectedStopBoard.css";

/**
 * The arrival board for the stop selected on the live map.
 *
 * Selecting a stop used to navigate to its page with a full document load, which threw away the
 * map and the viewport someone had just panned to. Opening the board in place keeps that context
 * — the point of a map is that you are looking at somewhere — while the link to the full stop
 * page stays, because everything on it is still worth reaching.
 *
 * The caller keys this component by stop, so selecting a different one remounts it and its state
 * starts clean. Clearing the previous stop's departures inside an effect instead would render
 * them, briefly, under the new stop's name.
 */

export interface SelectedStopBoardProps {
  atcoCode: string;
  onClose: () => void;
}

export function SelectedStopBoard({ atcoCode, onClose }: SelectedStopBoardProps) {
  const [response, setResponse] = useState<StopDeparturesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const now = useTicker(10_000);

  useEffect(() => {
    const controller = new AbortController();

    apiClient
      .stop(atcoCode, controller.signal)
      .then(setResponse)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof ApiError
            ? cause.message
            : "This stop could not be loaded. The map is still usable.",
        );
      });

    return () => controller.abort();
  }, [atcoCode]);

  // Escape closes it, because it behaves like a panel over the map and that is what people try.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Ticks, so a board left open on screen keeps telling the truth about how old it is.
  const ageSeconds = response
    ? Math.max(0, Math.round((now.getTime() - Date.parse(response.meta.generatedAt)) / 1000))
    : null;

  return (
    <aside className="selected-stop" aria-live="polite">
      <button
        type="button"
        className="selected-stop__close"
        onClick={onClose}
        aria-label="Close the arrival board"
      >
        ×
      </button>

      {error !== null && <p className="selected-stop__error">{error}</p>}

      {error === null && response === null && (
        <LoadingBus label="Loading arrivals for this stop" compact />
      )}

      {response && (
        <>
          <ArrivalBoard
            stopName={response.data.stop.name}
            stopCode={response.data.stop.atcoCode}
            departures={response.data.departures}
            now={now}
            ageSeconds={ageSeconds}
            degraded={response.meta.degradation !== "normal"}
          />
          <Link to={`/stops/${response.data.stop.atcoCode}`} className="selected-stop__more">
            Everything about this stop
          </Link>
        </>
      )}
    </aside>
  );
}
