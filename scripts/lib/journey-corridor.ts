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
} from "@busstops/pipeline-static-network";
import type { JourneyStop, Trip, TripCallSource } from "@busstops/journey";
import { readTripShard, type ReadTripShard } from "./read-trip-shard.js";

export interface CorridorQuery {
  readonly name: string;
  readonly from: { readonly lat: number; readonly lon: number };
  readonly to: { readonly lat: number; readonly lon: number };
}

export interface CorridorSlice {
  stops: JourneyStop[];
  trips: Trip[];
  /**
   * The same trips as windows into typed arrays, which is the form the deployed reader builds.
   *
   * Both forms are kept so a profile can time the graph build and the search over each of them in
   * one process, against the same corridor. Two CI runs an hour apart disagreed by more than this
   * whole difference — 68.26 ms and 91.91 ms of graph build on an unchanged corridor — so a
   * controlled pair inside one process is the only honest way to measure it.
   */
  columnarTrips: Trip[];
  /** Characters of trip text the slice cost, which is the figure the CPU budget is spent on. */
  tripChars: number;
  /** The box the slice was taken from, so a report can say how wide the question was. */
  box: { west: number; east: number; south: number; north: number };
  /** Midnight of the service date in epoch seconds, which every time here is relative to. */
  midnightSeconds: number;
  /**
   * The shards the slice was cut from, kept so a profile can time trip preparation both ways.
   *
   * The published text form is gone from the bucket, so "what the old reader cost" can no longer
   * be measured by reading it. It can still be measured honestly against the same rows in the
   * same process: `text` on a converted shard is those rows re-serialised, which is the work the
   * old reader did, and `bytes` is what the new one opens.
   */
  shards: ReadTripShard[];
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
  /** Each accepted row's times, by position in its pattern's sequence, as a published row is. */
  const departures: Int32Array[] = [];
  const sequences: Array<readonly string[]> = [];
  const shards: ReadTripShard[] = [];
  let tripChars = 0;
  const windows = tripWindowsFor(from, from + windowHours * 3600, serviceDate);
  for (const tile of tripTilesForBoundingBox(box).slice(0, TRIP_TILES)) {
    for (const window of windows) {
      /* Either form: the shards are being converted in place, so a corridor can be half and
       * half, and a loader that only knew the old key would report a converted tile as a tile
       * with no buses in it. */
      const shard = await readTripShard(
        store,
        patternTripsDataset(serviceDate, tile, window),
        index.version,
      );
      if (shard === null) continue;
      shards.push(shard);
      tripChars += shard.text.length;
      for (const row of shard.rows) {
        const sequence = stopSequenceByPattern.get(row.p);
        /*
         * A trip whose pattern is not in this slice, or whose stop count disagrees with it, is
         * dropped rather than guessed at: pairing a time with the wrong stop would put a bus at a
         * place it never calls, which is a worse answer than one option fewer.
         */
        if (!sequence || sequence.length !== row.t.length) continue;
        const times = new Int32Array(sequence.length);
        for (let at = 0; at < sequence.length; at += 1) {
          times[at] = row.t[at]! - midnightSeconds;
        }
        departures.push(times);
        sequences.push(sequence);

        trips.push({
          id: row.j,
          routeId: row.p,
          /*
           * The pattern, named. It was missing, and with the whole-pattern flag set that put
           * every trip in the corridor into one group keyed `undefined` — sequences of different
           * lengths in one route, which the non-overtaking scan then read off the end of.
           */
          patternId: row.p,
          /*
           * Every trip this loader emits carries its pattern's whole sequence — the length test
           * above drops the ones that do not — so the flag the grouping reads is true here, and
           * the harness measures the path the deployed reader takes rather than its fallback.
           */
          wholePatternSequence: true,
          stopTimes: row.t.map((seconds, i) => ({
            stopId: sequence[i]!,
            arrivalSeconds: seconds - midnightSeconds,
            departureSeconds: seconds - midnightSeconds,
          })),
        } as unknown as Trip);
      }
    }
  }

  /*
   * And the columnar form over those same numbers.
   *
   * One source for the whole corridor, indexed by position in the pattern's sequence, which is how
   * a published row is laid out. Every trip here kept its pattern's whole sequence — the length
   * test above drops the rest — so no trip needs a kept-positions array, which is also the shape
   * the deployed reader sees for a corridor that cut nothing.
   */
  const source: TripCallSource = {
    departure: (trip, call) => departures[trip]![call]!,
    arrival: (trip, call) => departures[trip]![call]!,
  };
  const columnarTrips: Trip[] = trips.map((trip, at) => ({
    id: trip.id,
    routeId: trip.routeId,
    patternId: trip.patternId,
    routeName: trip.routeName,
    headsign: trip.headsign,
    wholePatternSequence: true,
    calls: {
      source,
      trip: at,
      sequence: sequences[at]!,
      kept: null,
      count: sequences[at]!.length,
      dayStartSeconds: 0,
    },
  }));

  return { stops, trips, columnarTrips, tripChars, box, midnightSeconds, shards };
}
