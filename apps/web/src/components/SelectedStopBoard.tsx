import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { StopDeparturesResponse } from "@busstops/contracts";
import { apiClient, ApiError } from "../lib/api.js";
import { useTicker } from "../lib/use-fetch.js";
import { ArrivalBoard } from "./ArrivalBoard.js";
import { WeatherVignette } from "./WeatherVignette.js";
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
  /**
   * Where the stop turned out to be, once it is known.
   *
   * Only a deep link needs this. `/live/stops/:stopId` names a stop and not a camera, so the page
   * opens on its default view with the board showing a stop that may be a county away and not on
   * screen at all. The board is the thing that fetches the stop, so it is the thing that learns
   * the coordinate, and the page uses it to move the map there — once, on arrival.
   */
  onResolved?: (stop: { atcoCode: string; coordinate: { lat: number; lon: number } }) => void;
}

export function SelectedStopBoard({ atcoCode, onClose, onResolved }: SelectedStopBoardProps) {
  const [response, setResponse] = useState<StopDeparturesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const now = useTicker(10_000);

  const resolvedRef = useRef(onResolved);
  useEffect(() => {
    resolvedRef.current = onResolved;
  }, [onResolved]);

  useEffect(() => {
    const controller = new AbortController();

    apiClient
      .stop(atcoCode, controller.signal)
      .then((loaded) => {
        setResponse(loaded);
        resolvedRef.current?.({
          atcoCode: loaded.data.stop.atcoCode,
          coordinate: loaded.data.stop.locationCoordinate,
        });
      })
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
          {/*
            Real weather for this stop, under the next bus.

            It was only on the full stop page, so the panel a passenger actually opens — the one
            over the map, at the stop they are standing at — said nothing about whether they were
            about to get wet. The board already fetches it: `/v1/stops/:atco` carries the weather
            in the same response as the departures, so this costs no extra request. Null is a real
            answer where the weather job has not published that degree square yet, and nothing is
            drawn rather than a placeholder implying it is calm.
          */}
          {response.data.weather && (
            <div className="selected-stop__weather">
              <WeatherVignette
                weather={response.data.weather}
                atcoCode={response.data.stop.atcoCode}
                now={now}
                compact
              />
            </div>
          )}

          <Link to={`/stops/${response.data.stop.atcoCode}`} className="selected-stop__more">
            Everything about this stop
          </Link>
        </>
      )}
    </aside>
  );
}
