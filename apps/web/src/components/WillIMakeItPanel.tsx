import { useMemo, useState } from "react";
import type { DeparturePrediction, Stop } from "@busstops/contracts";
import { haversineMetresBrowser } from "../lib/geo.js";
import { walkingMinutes } from "../lib/format.js";
import {
  arrivalIntervalSeconds,
  nextUsefulService,
  willIMakeIt,
  type WillIMakeItResult,
} from "../lib/will-i-make-it.js";
import { ConfidenceChip, StateLozenge } from "./primitives.js";
import "./WillIMakeItPanel.css";

/**
 * "Will I make it?" panel.
 *
 * Location is requested with contextual consent, used in the browser only, and never sent to
 * the server: the walk is computed here from the device position and the stop's own published
 * coordinate. Declining is a first-class path, not a dead end.
 */

export interface WillIMakeItPanelProps {
  departures: readonly DeparturePrediction[];
  stop: Stop;
  now: Date;
}

type LocationState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "granted"; coordinate: { lat: number; lon: number } }
  | { status: "denied" }
  | { status: "unavailable" };

export function WillIMakeItPanel({ departures, stop, now }: WillIMakeItPanelProps) {
  const [location, setLocation] = useState<LocationState>({ status: "idle" });

  const target = useMemo(
    () =>
      departures.find((d) => d.liveState !== "cancelled" && (d.expectedTime ?? d.scheduledTime)),
    [departures],
  );

  const result: WillIMakeItResult | null = useMemo(() => {
    if (location.status !== "granted" || !target) return null;

    const interval = arrivalIntervalSeconds(target, now);
    if (!interval) return null;

    const metres = haversineMetresBrowser(location.coordinate, stop.locationCoordinate);
    return willIMakeIt({
      walkingSeconds: walkingMinutes(metres) * 60,
      arrivalLowSeconds: interval.low,
      arrivalHighSeconds: interval.high,
      confidence: target.confidence,
    });
  }, [location, target, stop, now]);

  const next = useMemo(
    () => (target ? nextUsefulService(departures, target) : null),
    [departures, target],
  );

  if (!target) return null;

  const requestLocation = () => {
    if (!globalThis.navigator?.geolocation) {
      setLocation({ status: "unavailable" });
      return;
    }
    setLocation({ status: "requesting" });
    globalThis.navigator.geolocation.getCurrentPosition(
      (position) =>
        setLocation({
          status: "granted",
          coordinate: { lat: position.coords.latitude, lon: position.coords.longitude },
        }),
      () => setLocation({ status: "denied" }),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 30_000 },
    );
  };

  return (
    <section className="wimi surface" aria-labelledby="wimi-heading">
      <h2 id="wimi-heading" className="wimi__heading">
        Will I make it?
      </h2>

      {location.status === "idle" && (
        <>
          <p className="muted">
            Compare your walking time with the next {target.serviceRoutePublicName}. Your location
            stays on this device — we do not send it anywhere or store it.
          </p>
          <button type="button" className="button-primary" onClick={requestLocation}>
            Use my location
          </button>
        </>
      )}

      {location.status === "requesting" && <p role="status">Checking your location…</p>}

      {location.status === "denied" && (
        <p className="muted" role="status">
          No problem — without your location we cannot estimate the walk. The next{" "}
          {target.serviceRoutePublicName} is still shown on the board above.
        </p>
      )}

      {location.status === "unavailable" && (
        <p className="muted" role="status">
          This browser cannot provide a location, so the walking estimate is unavailable.
        </p>
      )}

      {result && (
        <div className="wimi__result">
          <p className="wimi__verdict">
            <StateLozenge
              tone={
                result.verdict === "should_make_it"
                  ? "success"
                  : result.verdict === "tight"
                    ? "warning"
                    : "critical"
              }
            >
              {result.headline}
            </StateLozenge>
          </p>
          <p>{result.detail}</p>
          <ConfidenceChip confidence={result.confidence} />

          {result.verdict !== "should_make_it" && next && (
            <p className="wimi__next">
              Next useful service: <strong>{next.serviceRoutePublicName}</strong> to{" "}
              {next.destinationName}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
