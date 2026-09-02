import type { Coordinate, Operator, ServiceRoute, Stop } from "@busstops/contracts";
import { haversineMetres } from "@busstops/pipeline-core";

/**
 * National search index (docs/03_SITE_MAP_AND_UX.md "Search/Nearby").
 *
 * Built once per static rebuild and served from a prebuilt artifact, so a search never scans a
 * national table at request time. Matching tolerates the ways people actually search: a stop
 * code, part of a name, a route number, or a place.
 */

export interface SearchIndexEntry {
  kind: "stop" | "route" | "operator" | "area";
  id: string;
  title: string;
  subtitle?: string;
  coordinate?: Coordinate;
  /** Lowercased tokens used for prefix and substring matching. */
  tokens: string[];
  /** Exact-match keys such as an ATCO code or a route number. */
  codes: string[];
  hasLiveCoverage: boolean;
  /** Higher ranks first when scores tie; interchanges outrank single stops. */
  prominence: number;
}

export interface SearchIndex {
  entries: SearchIndexEntry[];
  builtAt: string;
}

const STOP_WORDS = new Set(["the", "of", "and", "at", "on", "in", "to", "opp", "adj", "nr"]);

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/[\s'-]+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

export function buildSearchIndex(
  network: {
    stops: readonly Stop[];
    services: readonly ServiceRoute[];
    operators: readonly Operator[];
  },
  options: { builtAt: string; liveCoverageAtcoPrefixes?: readonly string[] },
): SearchIndex {
  const entries: SearchIndexEntry[] = [];
  const livePrefixes = options.liveCoverageAtcoPrefixes ?? [];

  for (const stop of network.stops) {
    const hasLiveCoverage =
      livePrefixes.length === 0 || livePrefixes.some((p) => stop.atcoCode.startsWith(p));

    entries.push({
      kind: "stop",
      id: stop.id,
      title: stop.name,
      ...(stop.indicator === undefined ? {} : { subtitle: stop.indicator }),
      coordinate: stop.locationCoordinate,
      tokens: [...new Set([...tokenize(stop.name), ...tokenize(stop.indicator ?? "")])],
      codes: [stop.atcoCode, stop.naptanCode].filter((c): c is string => c !== undefined),
      hasLiveCoverage,
      // A bus station bay is a more useful search result than one of many on-street poles.
      prominence: stop.stopType === "bus_station_bay" ? 2 : 1,
    });
  }

  const operatorsById = new Map(network.operators.map((o) => [o.id, o]));

  for (const service of network.services) {
    const operator = operatorsById.get(service.operatorId);
    entries.push({
      kind: "route",
      id: service.id,
      title: service.publicName,
      ...(operator === undefined ? {} : { subtitle: operator.name }),
      tokens: [
        ...new Set([...tokenize(service.publicName), ...tokenize(service.description ?? "")]),
      ],
      codes: [service.publicName.toLowerCase()],
      hasLiveCoverage: true,
      prominence: 3,
    });
  }

  for (const operator of network.operators) {
    entries.push({
      kind: "operator",
      id: operator.id,
      title: operator.name,
      tokens: tokenize(operator.name),
      codes: operator.licenceRegistryIds.map((c) => c.toLowerCase()),
      hasLiveCoverage: true,
      prominence: 2,
    });
  }

  return { entries, builtAt: options.builtAt };
}

export interface SearchOptions {
  limit?: number;
  /** When present, results are ranked partly by distance from here. */
  near?: Coordinate;
  kinds?: ReadonlyArray<SearchIndexEntry["kind"]>;
}

export interface SearchHit {
  entry: SearchIndexEntry;
  score: number;
  distanceMetres?: number;
}

/**
 * Ranks by match quality first, then proximity. An exact stop code always wins: a passenger
 * who types the code on the pole in front of them wants that stop, not a fuzzy name match.
 */
export function searchIndex(
  index: SearchIndex,
  rawQuery: string,
  options: SearchOptions = {},
): SearchHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) return [];

  const limit = options.limit ?? 20;
  const queryTokens = tokenize(query);
  const hits: SearchHit[] = [];

  for (const entry of index.entries) {
    if (options.kinds && !options.kinds.includes(entry.kind)) continue;

    let score = 0;

    if (entry.codes.some((code) => code.toLowerCase() === query)) {
      score += 100;
    } else if (entry.codes.some((code) => code.toLowerCase().startsWith(query))) {
      score += 40;
    }

    const title = entry.title.toLowerCase();
    if (title === query) score += 60;
    else if (title.startsWith(query)) score += 30;
    else if (title.includes(query)) score += 15;

    if (queryTokens.length > 0) {
      let matchedTokens = 0;
      for (const queryToken of queryTokens) {
        if (entry.tokens.some((token) => token === queryToken)) matchedTokens += 1;
        else if (entry.tokens.some((token) => token.startsWith(queryToken))) matchedTokens += 0.5;
      }
      // Require every query token to contribute, so "leeds bus" does not match every Leeds stop.
      if (matchedTokens > 0) score += (matchedTokens / queryTokens.length) * 25;
    }

    if (score === 0) continue;

    score += entry.prominence;

    let distanceMetres: number | undefined;
    if (options.near && entry.coordinate) {
      distanceMetres = haversineMetres(options.near, entry.coordinate);
      // Within 2km proximity adds up to 20 points; beyond that it adds nothing.
      score += Math.max(0, 20 * (1 - distanceMetres / 2000));
    }

    hits.push({ entry, score, ...(distanceMetres === undefined ? {} : { distanceMetres }) });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.distanceMetres !== undefined && b.distanceMetres !== undefined) {
      return a.distanceMetres - b.distanceMetres;
    }
    return a.entry.title.localeCompare(b.entry.title);
  });

  return hits.slice(0, limit);
}

/** Nearby stops for the "stops near me" surface, ordered by true distance. */
export function nearbyStops(
  index: SearchIndex,
  coordinate: Coordinate,
  options: { radiusMetres?: number; limit?: number } = {},
): SearchHit[] {
  const radiusMetres = options.radiusMetres ?? 800;
  const limit = options.limit ?? 20;

  const hits: SearchHit[] = [];
  for (const entry of index.entries) {
    if (entry.kind !== "stop" || !entry.coordinate) continue;
    const distanceMetres = haversineMetres(coordinate, entry.coordinate);
    if (distanceMetres > radiusMetres) continue;
    hits.push({ entry, score: -distanceMetres, distanceMetres });
  }

  hits.sort((a, b) => (a.distanceMetres ?? 0) - (b.distanceMetres ?? 0));
  return hits.slice(0, limit);
}
