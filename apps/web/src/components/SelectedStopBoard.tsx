import { useEffect, useRef, useState } from "react";
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

/**
 * What is true about this stop, once the bus and the sky have been dealt with.
 *
 * The panel was a board and then a link, which read as two technical components stacked rather
 * than as one thing a passenger uses. This is the third movement: which routes call here, what
 * the stop physically is, and what it has — a shelter to stand under matters quite a lot to
 * somebody looking at a weather picture directly above it.
 *
 * Only sourced facts. A stop with no amenities recorded says nothing rather than implying none.
 */
function StopFacts({
  stop,
  routes,
}: {
  stop: StopDeparturesResponse["data"]["stop"];
  routes: StopDeparturesResponse["data"]["routes"];
}) {
  const label: Record<string, string> = {
    shelter: "Shelter",
    seating: "Seating",
    lighting: "Lighting",
    real_time_display: "Live display",
    step_free: "Step-free",
    tactile_paving: "Tactile paving",
  };
  /*
   * `value: false` means recorded as absent, which is a different fact from not recorded at all
   * and must not be listed as though the stop had it. Only what is there is named.
   */
  const shown = (stop.amenities ?? [])
    .filter((amenity) => amenity.value && label[amenity.key])
    .map((amenity) => label[amenity.key]!);

  if (routes.length === 0 && shown.length === 0 && !stop.indicator) return null;

  return (
    <section className="stop-facts" aria-label="About this stop">
      {routes.length > 0 ? (
        <div className="stop-facts__routes">
          {routes.slice(0, 8).map((route) => (
            <Link
              key={route.id}
              to={`/routes/${encodeURIComponent(route.id)}`}
              className="route-badge route-badge--inline"
            >
              {route.publicName}
            </Link>
          ))}
          {routes.length > 8 ? (
            <span className="muted small">and {routes.length - 8} more</span>
          ) : null}
        </div>
      ) : null}

      {stop.indicator || shown.length > 0 ? (
        <p className="stop-facts__detail small muted">
          {[stop.indicator, ...shown.map((amenity) => label[amenity])].filter(Boolean).join(" · ")}
        </p>
      ) : null}
    </section>
  );
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
            No weather scene here, deliberately.

            It lived in this panel for a while and it was the wrong place for it. Somebody who
            taps a stop on a map is asking one question — when is my bus — and a 384-pixel
            illustration between the board and the rest pushed the answer under the fold on a
            phone. The panel is a board; the picture belongs on the full stop page, which is what
            the link below promises and where there is room to be generous with it.
          */}

          <StopFacts stop={response.data.stop} routes={response.data.routes} />

          <Link to={`/stops/${response.data.stop.atcoCode}`} className="selected-stop__more">
            Everything about this stop
          </Link>
        </>
      )}
    </aside>
  );
}
