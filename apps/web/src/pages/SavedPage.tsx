import { useState } from "react";
import { Link } from "react-router-dom";
import {
  clearFavourites,
  exportFavourites,
  listFavourites,
  removeFavourite,
  type Favourite,
} from "../lib/favourites.js";
import { EmptyState } from "../components/primitives.js";
import "./SavedPage.css";

/**
 * Saved stops and routes (docs/03_SITE_MAP_AND_UX.md "Saved").
 *
 * Local-first: nothing here requires an account and nothing leaves the device. Removal and
 * export are first-class controls, not buried, because that is what makes local-first honest.
 */

/** Where a saved item opens. */
function savedHref(favourite: { kind: string; id: string }): string {
  switch (favourite.kind) {
    case "stop":
      return `/stops/${encodeURIComponent(favourite.id)}`;
    case "route":
      return `/routes/${encodeURIComponent(favourite.id)}`;
    default:
      // A saved journey is a pair of points rather than a page; the planner is where it belongs.
      return "/journey";
  }
}

export function SavedPage() {
  // Read once during initialisation: favourites live in this browser, so there is nothing to
  // synchronise with and no reason to render twice.
  const [favourites, setFavourites] = useState<Favourite[]>(() => listFavourites());
  const [exported, setExported] = useState<string | null>(null);

  const remove = (favourite: Favourite) => {
    removeFavourite(favourite.kind, favourite.id);
    setFavourites(listFavourites());
  };

  const removeAll = () => {
    clearFavourites();
    setFavourites(listFavourites());
  };

  return (
    <div className="page saved-page">
      <h1>Saved</h1>
      <p className="muted">
        Saved stops and routes are stored on this device only. We do not have a copy, and there is
        no account to create.
      </p>

      {favourites.length === 0 ? (
        <EmptyState
          art="stop"
          title="Nothing saved yet"
          description="Save a stop from its page and it will appear here, ready for next time."
          action={
            <Link to="/search" className="button-primary">
              Find a stop
            </Link>
          }
        />
      ) : (
        <>
          <ul className="saved-page__list">
            {favourites.map((favourite) => (
              <li key={`${favourite.kind}-${favourite.id}`} className="saved-page__item surface">
                {/*
                  A saved thing opens the thing.

                  A saved route went to `/search` — not to a search *for it*, just to the search
                  page — which is the same dead end the search results themselves used to have.
                  The id stored is the published identifier for its kind, which is what each page
                  takes.
                */}
                <Link to={savedHref(favourite)} className="saved-page__link">
                  <span className="saved-page__title">{favourite.title}</span>
                  {favourite.subtitle && <span className="muted small"> {favourite.subtitle}</span>}
                </Link>
                <button type="button" className="button-quiet" onClick={() => remove(favourite)}>
                  Remove
                  <span className="visually-hidden"> {favourite.title}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className="saved-page__controls">
            <button
              type="button"
              className="button-quiet"
              onClick={() => setExported(exportFavourites())}
            >
              Export my saved items
            </button>
            <button type="button" className="button-quiet" onClick={removeAll}>
              Remove everything
            </button>
          </div>

          {exported && (
            <div className="saved-page__export">
              <label htmlFor="export-output">Your saved items, as JSON</label>
              <textarea id="export-output" readOnly rows={8} value={exported} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
