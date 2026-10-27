/**
 * One corridor slice, read from the published artifact the way the planner reads it.
 *
 * Two scripts need the same slice for different reasons — one profiles how long a search over it
 * takes, the other records what the current planner answers so a replacement can be held against
 * it — and a corpus measured against a slightly different slice than the profile is not a corpus.
 * So the loading lives here once and both ask for it the same way.
 *
 * It reads and writes nothing else: no deploys, no publishes, no mutation of the artifact.
 */

import { objectKeyFor, type ObjectStore } from "@busstops/pipeline-core";
import {
  mapStopTilesForBoundingBox,
  mapStopsDataset,
  patternIndexTileDataset,
  patternTilesForBoundingBox,
  patternTripsDataset,
  tripTilesForBoundingBox,
  tripWindowsFor,
  type MapStopRow,
  type NetworkIndexRecord,
  type PatternIndexRow,
  type PatternTripRow,
} from "@busstops/pipeline-static-network";
import type { JourneyStop, Trip } from "@busstops/journey";

export interface CorridorQuery {
  readonly name: string;
  readonly from: { readonly lat: number; readonly lon: number };
  readonly to: { readonly lat: number; readonly lon: number };
}

export interface CorridorSlice {
  stops: JourneyStop[];
  trips: Trip[];
  /** Characters of trip text the slice cost, which is the figure the CPU budget is spent on. */
  tripChars: number;
  /** The box the slice was taken from, so a report can say how wide the question was. */
  box: { west: number; east: number; south: number; north: number };
  /** Midnight of the service date in epoch seconds, which every time here is relative to. */
  midnightSeconds: number;
}

/**
 * Half the width of the box a plan is allowed to look in, in degrees.
 *
 * A parameter rather than a constant because it decides how much timetable a journey opens, and
 * therefore most of what it costs: a Birmingham corridor at this width holds 2,737 stops and
 * 13,793 trips. A narrower one is cheaper and can lose a journey that goes round rather than
 * through, so the corpus is recorded at each width and the comparison says which.
 */
const CORRIDOR_MARGIN_DEGREES = 0.05;

/** Caps matching the Worker's own per-request tile bounds, so the slice is a servable one. */
const STOP_TILES = 24;
const PATTERN_TILES = 8;
const TRIP_TILES = 8;

function walkLines<T>(body: string, keep: (line: string) => boolean): T[] {
  const rows: T[] = [];
  for (let start = 0; start < body.length;) {
    const newline = body.indexOf("\n", start);
    const end = newline < 0 ? body.length : newline;
    if (end > start) {
      const line = body.slice(start, end);
      if (keep(line)) rows.push(JSON.parse(line) as T);
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return rows;
}

export function corridorBox(
  query: CorridorQuery,
  marginDegrees = CORRIDOR_MARGIN_DEGREES,
): CorridorSlice["box"] {
  return {
    west: Math.min(query.from.lon, query.to.lon) - marginDegrees,
    east: Math.max(query.from.lon, query.to.lon) + marginDegrees,
    south: Math.min(query.from.lat, query.to.lat) - marginDegrees,
    north: Math.max(query.from.lat, query.to.lat) + marginDegrees,
  };
}

export async function loadCorridor(
  store: ObjectStore,
  index: NetworkIndexRecord,
  query: CorridorQuery,
  serviceDate: string,
  departAtSeconds: number,
  windowHours = 4,
  marginDegrees = CORRIDOR_MARGIN_DEGREES,
): Promise<CorridorSlice> {
  const grid = index.layout?.mapStopTileDegrees;
  const box = corridorBox(query, marginDegrees);
  const midnightSeconds = Date.parse(`${serviceDate}T00:00:00Z`) / 1000;
  const from = midnightSeconds + departAtSeconds;

  /* The corridor's stops, from the projection the planner itself reads. */
  const stops: JourneyStop[] = [];
  for (const tile of mapStopTilesForBoundingBox(box, grid).slice(0, STOP_TILES)) {
    const body = await store.get(objectKeyFor(mapStopsDataset(tile), index.version));
    if (body === null) continue;
    for (const row of walkLines<MapStopRow>(body, () => true)) {
      if (row.y >= box.south && row.y <= box.north && row.x >= box.west && row.x <= box.east) {
        stops.push({ id: row.i, name: row.n, coordinate: { lat: row.y, lon: row.x } });
      }
    }
  }

  /* The corridor's patterns, so a trip's stop sequence is the real one. */
  const stopSequenceByPattern = new Map<string, string[]>();
  for (const tile of patternTilesForBoundingBox(box).slice(0, PATTERN_TILES)) {
    const body = await store.get(objectKeyFor(patternIndexTileDataset(tile), index.version));
    if (body === null) continue;
    for (const row of walkLines<[string, PatternIndexRow]>(body, (line) => line.startsWith("["))) {
      stopSequenceByPattern.set(row[1].id, row[1].stopSequence);
    }
  }

  /* The corridor's trips, in the windows this plan spans. */
  const trips: Trip[] = [];
  let tripChars = 0;
  const windows = tripWindowsFor(from, from + windowHours * 3600, serviceDate);
  for (const tile of tripTilesForBoundingBox(box).slice(0, TRIP_TILES)) {
    for (const window of windows) {
      const body = await store.get(
        objectKeyFor(patternTripsDataset(serviceDate, tile, window), index.version),
      );
      if (body === null) continue;
      tripChars += body.length;
      for (const row of walkLines<PatternTripRow>(body, () => true)) {
        const sequence = stopSequenceByPattern.get(row.p);
        /*
         * A trip whose pattern is not in this slice, or whose stop count disagrees with it, is
         * dropped rather than guessed at: pairing a time with the wrong stop would put a bus at a
         * place it never calls, which is a worse answer than one option fewer.
         */
        if (!sequence || sequence.length !== row.t.length) continue;
        trips.push({
          id: row.j,
          routeId: row.p,
          stopTimes: row.t.map((seconds, i) => ({
            stopId: sequence[i]!,
            arrivalSeconds: seconds - midnightSeconds,
            departureSeconds: seconds - midnightSeconds,
          })),
        } as unknown as Trip);
      }
    }
  }

  return { stops, trips, tripChars, box, midnightSeconds };
}
