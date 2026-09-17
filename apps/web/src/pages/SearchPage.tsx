import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { SearchResult } from "@busstops/contracts";
import { apiClient } from "../lib/api.js";
import { distanceLabel } from "../lib/format.js";
import { EmptyState, ErrorState, StateLozenge } from "../components/primitives.js";
import { Skeleton } from "../components/primitives.js";
import "./SearchPage.css";

/**
 * Search and nearby (docs/03_SITE_MAP_AND_UX.md "Search/Nearby").
 *
 * Fully keyboard operable, tolerant of stop codes as well as names, and honest about live
 * coverage per result. Results announce their count politely rather than on every keystroke.
 */

const DEBOUNCE_MS = 250;

/**
 * Where a search result goes.
 *
 * `id` is the published identifier for its kind — a stop's, a service's, an operator's — and each
 * page takes exactly that. An `area` has no page of its own yet, so it opens the map where it is
 * rather than pretending to be somewhere to visit.
 */
function resultHref(result: SearchResult): string {
  switch (result.kind) {
    case "stop":
      return `/stops/${encodeURIComponent(result.id)}`;
    case "route":
      return `/routes/${encodeURIComponent(result.id)}`;
    case "operator":
      return `/operators/${encodeURIComponent(result.id)}`;
    default: {
      /*
       * A place is somewhere to go, not a departure board.
       *
       * York Minster has no ATCO code and no next bus; what a passenger wants from it is a
       * journey to it, with the planner choosing the boarding and alighting stops. So a place
       * result opens the planner with the destination already filled in — which is also why the
       * gazetteer exists rather than a hard-coded special case for York Minster.
       */
      if (!result.coordinate) return `/live?q=${encodeURIComponent(result.title)}`;
      const query = new URLSearchParams({
        toLat: String(result.coordinate.lat),
        toLon: String(result.coordinate.lon),
        toLabel: result.title,
      });
      return `/journey?${query.toString()}`;
    }
  }
}

/** The kind, as a passenger reads it. `rail_station` is a tag, not a word. */
function kindLabel(kind: SearchResult["kind"]): string {
  switch (kind) {
    case "stop":
      return "Stop";
    case "route":
      return "Route";
    case "operator":
      return "Operator";
    case "place":
      return "Place";
    default:
      return "Area";
  }
}

export function SearchPage() {
  /*
   * `?q=` is read, which it was not.
   *
   * The page always started empty, so every `/search?q=...` link — including the ones this page
   * used to generate for its own route and operator results — arrived at a blank search box. Half
   * of "the search result loop" was the wrong link; this is the other half.
   */
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nearbyState, setNearbyState] = useState<"idle" | "loading" | "denied" | "done">("idle");
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(async (value: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (value.trim().length === 0) {
      setResults(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const response = await apiClient.search(value, undefined, controller.signal);
      setResults(response.data.results);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught : new Error("Search failed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void runSearch(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  const findNearby = () => {
    if (!globalThis.navigator?.geolocation) {
      setNearbyState("denied");
      return;
    }
    setNearbyState("loading");
    globalThis.navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const response = await apiClient.nearby({
            lat: position.coords.latitude,
            lon: position.coords.longitude,
          });
          setResults(response.data.results);
          setNearbyState("done");
        } catch (caught) {
          setError(caught instanceof Error ? caught : new Error("Nearby search failed"));
          setNearbyState("idle");
        }
      },
      () => setNearbyState("denied"),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  };

  return (
    <div className="page search-page">
      <h1>Search</h1>
      <p className="muted">
        Search for a stop, route, operator or place. Stop codes work too — try the number printed on
        the pole.
      </p>

      <form
        className="search-page__form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(query);
        }}
      >
        <label htmlFor="search-input" className="search-page__label">
          Search stops, routes, operators and places
        </label>
        <input
          id="search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Leeds City Bus Station, 72, 450010001"
          autoComplete="off"
          enterKeyHint="search"
        />
        <div className="search-page__form-actions">
          <button type="submit" className="button-primary">
            Search
          </button>
          <button type="button" className="button-quiet" onClick={findNearby}>
            Stops near me
          </button>
        </div>
      </form>

      {nearbyState === "loading" && <p role="status">Finding stops near you…</p>}
      {nearbyState === "denied" && (
        <p className="muted" role="status">
          Location is unavailable, so nearby stops cannot be listed. Searching by name or code still
          works.
        </p>
      )}

      {error && (
        <ErrorState
          description="We could not run that search."
          onRetry={() => void runSearch(query)}
        />
      )}

      {loading && <Skeleton rows={4} label="Searching" />}

      {!loading && results !== null && (
        <section aria-labelledby="results-heading">
          <h2 id="results-heading" className="search-page__results-heading">
            Results
          </h2>
          {/* One polite announcement of the count, not one per keystroke. */}
          <p className="visually-hidden" role="status">
            {results.length} {results.length === 1 ? "result" : "results"}
          </p>

          {results.length === 0 ? (
            <EmptyState
              art="shelter"
              title="Nothing matched that search"
              description="Try a shorter search, a stop code, or a route number. Coverage is England-wide, so a place name usually works."
            />
          ) : (
            <ul className="search-page__results">
              {results.map((result) => (
                <li key={`${result.kind}-${result.id}`} className="search-page__result surface">
                  {/*
                    Every result goes to the thing it is.

                    Only a stop did. A route and an operator went to
                    `/search?q=<their own title>` — back to this page, with the same query, for
                    the same results: a loop that looked like a broken link and was in fact a link
                    to where you already were. The index carries the published identifier for each
                    kind, which is exactly what each page takes.
                  */}
                  <Link to={resultHref(result)} className="search-page__result-link">
                    <span className="search-page__result-title">{result.title}</span>
                    {result.subtitle && <span className="muted small"> {result.subtitle}</span>}
                  </Link>
                  <span className="search-page__result-meta">
                    <StateLozenge tone="neutral">{kindLabel(result.kind)}</StateLozenge>
                    {result.distanceMetres !== undefined && (
                      <span className="muted small">{distanceLabel(result.distanceMetres)}</span>
                    )}
                    {result.hasLiveCoverage === false && (
                      <StateLozenge tone="warning">Timetable only</StateLozenge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
