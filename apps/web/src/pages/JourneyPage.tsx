import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { JourneyPlanOption, JourneyPlanResponse, SearchResult } from "@busstops/contracts";
import { JourneyStrip } from "../components/JourneyStrip.js";
import { PixelVista } from "../components/pixel/PixelVista.js";
import { LoadingBus } from "../components/LoadingBus.js";
import {
  ConfidenceChip,
  EmptyState,
  ErrorState,
  ServiceBanner,
  StateLozenge,
} from "../components/primitives.js";
import { apiClient, ApiError } from "../lib/api.js";
import { formatLondonTime, minutesLabel } from "../lib/format.js";
import { savedPlatform, suggestPlatform, walkingUrlFor } from "../lib/navigation-handoff.js";
import "./JourneyPage.css";

/**
 * Journey planner (docs/03_SITE_MAP_AND_UX.md "Journey", docs/11_JOURNEY_ENGINE.md).
 *
 * Arrival is shown as a range, not a time. A planner that says "arrives 09:14" is claiming to
 * know something about traffic, boarding and a driver's break that nobody knows, and people plan
 * badly around false precision. The range and its confidence are the honest answer.
 *
 * Locations stay in this component. They are sent with the request and are neither logged by the
 * server nor persisted here.
 */

type Endpoint = { label: string; lat: number; lon: number } | null;

/**
 * Reads an endpoint seeded in the URL, which is how a destination tapped on the map or opened
 * from a stop page arrives here. Anything malformed is ignored rather than half-applied.
 */
function endpointFromParams(params: URLSearchParams, prefix: "from" | "to"): Endpoint {
  const lat = Number(params.get(`${prefix}Lat`));
  const lon = Number(params.get(`${prefix}Lon`));
  const label = params.get(`${prefix}Label`);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !label) return null;
  return { label, lat, lon };
}

export function JourneyPage() {
  const [searchParams] = useSearchParams();
  const [origin, setOrigin] = useState<Endpoint>(() => endpointFromParams(searchParams, "from"));
  const [destination, setDestination] = useState<Endpoint>(() =>
    endpointFromParams(searchParams, "to"),
  );
  const [plan, setPlan] = useState<JourneyPlanResponse | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [geolocationDenied, setGeolocationDenied] = useState(false);

  const runPlan = useCallback(async (from: Endpoint, to: Endpoint) => {
    if (!from || !to) return;
    setPlanning(true);
    setError(null);
    try {
      const response = await apiClient.journey(
        { lat: from.lat, lon: from.lon },
        { lat: to.lat, lon: to.lon },
      );
      setPlan(response);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "The journey could not be planned just now.",
      );
    } finally {
      setPlanning(false);
    }
  }, []);

  /*
   * A journey that arrives with both ends already on it is a journey somebody has asked for.
   *
   * `/journey?fromLat=…&toLat=…` is how a destination tapped on the map, or opened from a stop
   * page, gets here — and the page seeded the two fields from the URL and then did nothing, so
   * what a passenger saw was a form they had already filled in, waiting for them to press the
   * button again. The deployed sweep caught it at all three widths: the planner answers this
   * corridor in under two seconds through the API, and the page showed forty-eight words and no
   * itinerary.
   *
   * Once, on arrival, and only for endpoints that came from the URL. A ref rather than a
   * dependency list because the point is that it does not run again: re-planning as somebody
   * edits an endpoint would fire a request per keystroke and fight the form.
   */
  const planned = useRef(false);
  useEffect(() => {
    if (planned.current) return;
    const from = endpointFromParams(searchParams, "from");
    const to = endpointFromParams(searchParams, "to");
    if (!from || !to) return;
    planned.current = true;

    /*
     * On the next tick, not in the effect's own body. `runPlan` sets "planning" before it awaits
     * anything, and setting state synchronously inside an effect makes React render twice for one
     * arrival. The timer also gives this a cleanup: a passenger who navigates away before the
     * request is even sent does not get a state update on an unmounted page.
     */
    const timer = setTimeout(() => void runPlan(from, to), 0);
    return () => clearTimeout(timer);
  }, [searchParams, runPlan]);

  const useMyLocation = useCallback(() => {
    if (!globalThis.navigator?.geolocation) {
      setGeolocationDenied(true);
      return;
    }
    globalThis.navigator.geolocation.getCurrentPosition(
      (position) =>
        setOrigin({
          label: "Where you are now",
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        }),
      () => setGeolocationDenied(true),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  }, []);

  const walkingUrl = useMemo(() => {
    if (!destination) return null;
    const platform = savedPlatform() ?? suggestPlatform(globalThis.navigator?.userAgent ?? "");
    return walkingUrlFor(platform, {
      lat: destination.lat,
      lon: destination.lon,
      label: destination.label,
    });
  }, [destination]);

  return (
    <article className="page journey-page">
      {plan ? <ServiceBanner meta={plan.meta} /> : null}

      <PixelVista
        title="Plan a journey"
        standfirst="We show when you are likely to arrive as a range, not a single time, because that is what the data actually supports."
        vista="journey"
      />

      <form
        className="journey-page__form"
        onSubmit={(event) => {
          event.preventDefault();
          void runPlan(origin, destination);
        }}
      >
        <EndpointPicker
          id="journey-origin"
          label="From"
          value={origin}
          onChange={setOrigin}
          onUseLocation={useMyLocation}
        />
        <EndpointPicker
          id="journey-destination"
          label="To"
          value={destination}
          onChange={setDestination}
        />
        <button type="submit" disabled={!origin || !destination || planning}>
          {planning ? "Planning…" : "Plan journey"}
        </button>
      </form>

      {geolocationDenied ? (
        <p className="journey-page__notice">
          We could not use your location, which is fine — search for a starting point instead.
        </p>
      ) : null}

      {planning && !plan ? <LoadingBus label="Planning your journey" /> : null}

      {error ? (
        <ErrorState
          title="We could not plan this journey"
          description={error}
          onRetry={() => void runPlan(origin, destination)}
        />
      ) : null}

      {plan && !planning ? (
        plan.data.options.length > 0 ? (
          <ol className="journey-page__options">
            {plan.data.options.map((option, index) => (
              <JourneyOptionCard
                key={`${option.ranking}-${index}`}
                option={option}
                serviceDate={plan.data.serviceDate}
              />
            ))}
          </ol>
        ) : (
          <EmptyState
            art="front"
            title="No bus journey found"
            description={
              plan.data.unavailableReason ??
              "We could not find a bus journey between these points at this time."
            }
            action={
              walkingUrl ? (
                <a href={walkingUrl} rel="noreferrer noopener" target="_blank">
                  Open walking directions instead
                </a>
              ) : undefined
            }
          />
        )
      ) : null}

      {plan?.data.explanation ? (
        <p className="journey-page__explanation">{plan.data.explanation}</p>
      ) : null}

      <p className="muted small">
        Your start and end points are used to plan this journey and are not stored.{" "}
        <Link to="/privacy">How we handle location</Link>.
      </p>
    </article>
  );
}

function JourneyOptionCard({
  option,
  serviceDate,
}: {
  option: JourneyPlanOption;
  serviceDate: string;
}) {
  const rankingLabel = {
    fastest: "Fastest",
    least_walking: "Least walking",
    fewest_changes: "Fewest changes",
  }[option.ranking];

  const uncertaintySeconds = option.arrivalHighSeconds - option.arrivalLowSeconds;

  return (
    <li className="journey-option">
      <header>
        <StateLozenge tone="info">{rankingLabel}</StateLozenge>
        <p className="journey-option__arrival">
          Arrive between {clockLabel(option.arrivalLowSeconds, serviceDate)} and{" "}
          {clockLabel(option.arrivalHighSeconds, serviceDate)}
        </p>
        <ConfidenceChip confidence={option.confidence} />
      </header>

      <p className="journey-option__summary">
        {option.changeCount === 0
          ? "Direct"
          : `${option.changeCount} change${option.changeCount === 1 ? "" : "s"}`}
        {" · "}
        {minutesLabel(option.totalWalkSeconds)} walking
        {uncertaintySeconds > 0 ? ` · ${minutesLabel(uncertaintySeconds)} of uncertainty` : ""}
      </p>

      {/*
        The legs as a journey rather than as sentences about one. Every value passed is the
        planner's own: no leg is summarised, merged or invented on the way to the picture.
      */}
      <JourneyStrip
        legs={option.legs.map((leg) => ({
          mode: leg.mode === "walk" ? "walk" : "bus",
          fromName: leg.fromName,
          toName: leg.toName,
          routeName: leg.routeName ?? null,
          headsign: leg.headsign ?? null,
          departureLabel: clockLabel(leg.departureSeconds, serviceDate),
          arrivalLabel: clockLabel(leg.arrivalSeconds, serviceDate),
          minutes: Math.max(0, (leg.arrivalSeconds - leg.departureSeconds) / 60),
        }))}
      />

      {option.explanation ? (
        <p className="journey-option__explanation">{option.explanation}</p>
      ) : null}
    </li>
  );
}

/**
 * Seconds into the service day, rendered as the clock a passenger is looking at.
 *
 * This used to be arithmetic — take the seconds modulo a day and divide — and the unused
 * `_serviceDate` parameter was the tell that something was wrong. The seconds are counted from
 * `${serviceDate}T00:00:00.000Z`, so dividing them up produces a **UTC** clock face. Every other
 * time in this product goes through `formatLondonTime`; this one did not, so from late March to
 * late October it showed every journey an hour behind the clock on the passenger's wall. A bus
 * leaving at 09:14 read 08:14, which is not merely wrong, it is in the past — which is exactly
 * what it looked like.
 *
 * Rebuilding the instant and formatting it in Europe/London fixes the offset and the day boundary
 * at once: 25:10 is a real moment after midnight, and the formatter renders it 01:10 without the
 * modulo, in whichever of GMT or BST applies on that date.
 */
export function clockLabel(secondsIntoServiceDay: number, serviceDate: string): string {
  const dayStart = Date.parse(`${serviceDate}T00:00:00.000Z`);
  if (!Number.isFinite(dayStart)) return "--:--";
  return formatLondonTime(new Date(dayStart + secondsIntoServiceDay * 1000));
}

function EndpointPicker({
  id,
  label,
  value,
  onChange,
  onUseLocation,
}: {
  id: string;
  label: string;
  value: Endpoint;
  onChange: (endpoint: Endpoint) => void;
  onUseLocation?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const search = useCallback(async (text: string) => {
    if (text.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const response = await apiClient.search(text);
      setResults(response.data.results.filter((result) => result.coordinate).slice(0, 6));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  return (
    <div className="endpoint-picker">
      <label htmlFor={id}>{label}</label>
      {value ? (
        <div className="endpoint-picker__chosen">
          <span>{value.label}</span>
          <button type="button" onClick={() => onChange(null)}>
            Change
          </button>
        </div>
      ) : (
        <>
          <div className="endpoint-picker__input-row">
            <input
              id={id}
              type="search"
              value={query}
              autoComplete="off"
              placeholder="Search for a stop or place"
              onChange={(event) => {
                setQuery(event.target.value);
                void search(event.target.value);
              }}
            />
            {onUseLocation ? (
              <button type="button" onClick={onUseLocation}>
                Use my location
              </button>
            ) : null}
          </div>
          {searching ? <p className="muted small">Searching…</p> : null}
          {results.length > 0 ? (
            <ul className="endpoint-picker__results">
              {results.map((result) => (
                <li key={`${result.kind}-${result.id}`}>
                  <button
                    type="button"
                    onClick={() =>
                      onChange({
                        label: result.title,
                        lat: result.coordinate!.lat,
                        lon: result.coordinate!.lon,
                      })
                    }
                  >
                    <strong>{result.title}</strong>
                    {result.subtitle ? (
                      <span className="muted small">{result.subtitle}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
