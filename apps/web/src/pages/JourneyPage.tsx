import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { JourneyPlanOption, JourneyPlanResponse, SearchResult } from "@busstops/contracts";
import { LoadingBus } from "../components/LoadingBus.js";
import {
  ConfidenceChip,
  EmptyState,
  ErrorState,
  RouteBadge,
  ServiceBanner,
  StateLozenge,
} from "../components/primitives.js";
import { apiClient, ApiError } from "../lib/api.js";
import { minutesLabel } from "../lib/format.js";
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
    <article className="journey-page">
      {plan ? <ServiceBanner meta={plan.meta} /> : null}

      <header className="journey-page__header">
        <h1>Plan a journey</h1>
        <p className="muted">
          We show when you are likely to arrive as a range, not a single time, because that is what
          the data actually supports.
        </p>
      </header>

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

      <ol className="journey-option__legs">
        {option.legs.map((leg, index) => (
          <li key={`${leg.fromName}-${leg.toName}-${index}`}>
            {leg.mode === "walk" ? (
              <span className="journey-option__leg-mode">Walk</span>
            ) : (
              <RouteBadge name={leg.routeName ?? "Bus"} />
            )}
            <span>
              {leg.fromName} → {leg.toName}
              {leg.headsign ? <span className="muted small"> towards {leg.headsign}</span> : null}
            </span>
            <span className="muted small">
              {clockLabel(leg.departureSeconds, serviceDate)}–
              {clockLabel(leg.arrivalSeconds, serviceDate)}
            </span>
          </li>
        ))}
      </ol>

      {option.explanation ? (
        <p className="journey-option__explanation">{option.explanation}</p>
      ) : null}
    </li>
  );
}

/** Seconds into the service day rendered as a clock time; 25:10 becomes 01:10 the next day. */
export function clockLabel(secondsIntoServiceDay: number, _serviceDate: string): string {
  const wrapped = ((secondsIntoServiceDay % 86_400) + 86_400) % 86_400;
  const hours = Math.floor(wrapped / 3600);
  const minutes = Math.floor((wrapped % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
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
