/**
 * Local-first favourites (docs/09_BUS_STOPS_LIVE.md "Favourites and notifications").
 *
 * Favourites work with no account and never leave the device by default. Storage failures
 * (private mode, disabled site data) degrade to an empty list rather than breaking the page.
 */

const STORAGE_KEY = "busstops.favourites.v1";

export type FavouriteKind = "stop" | "route" | "journey";

export interface Favourite {
  kind: FavouriteKind;
  id: string;
  title: string;
  subtitle?: string;
  addedAt: string;
}

function readStorage(): Favourite[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isFavourite);
  } catch {
    return [];
  }
}

function writeStorage(favourites: readonly Favourite[]): boolean {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(favourites));
    return true;
  } catch {
    // Storage may be unavailable or full; the caller is told so it can explain, not crash.
    return false;
  }
}

function isFavourite(value: unknown): value is Favourite {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    (candidate.kind === "stop" || candidate.kind === "route" || candidate.kind === "journey")
  );
}

export function listFavourites(): Favourite[] {
  return readStorage().sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

export function isFavourited(kind: FavouriteKind, id: string): boolean {
  return readStorage().some((f) => f.kind === kind && f.id === id);
}

export function addFavourite(favourite: Omit<Favourite, "addedAt">): boolean {
  const existing = readStorage();
  if (existing.some((f) => f.kind === favourite.kind && f.id === favourite.id)) return true;
  return writeStorage([...existing, { ...favourite, addedAt: new Date().toISOString() }]);
}

export function removeFavourite(kind: FavouriteKind, id: string): boolean {
  return writeStorage(readStorage().filter((f) => !(f.kind === kind && f.id === id)));
}

export function toggleFavourite(favourite: Omit<Favourite, "addedAt">): boolean {
  return isFavourited(favourite.kind, favourite.id)
    ? removeFavourite(favourite.kind, favourite.id)
    : addFavourite(favourite);
}

/** Export for the user's own records; part of the promised removal/export controls. */
export function exportFavourites(): string {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), favourites: listFavourites() },
    null,
    2,
  );
}

export function clearFavourites(): boolean {
  return writeStorage([]);
}
