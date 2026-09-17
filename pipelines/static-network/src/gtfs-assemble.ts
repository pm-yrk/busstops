import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Coordinate, RoutePattern, Stop } from "@busstops/contracts";
import { normalizeNaptanCsv } from "@busstops/adapters";
import { tileIdFor } from "@busstops/pipeline-core";
import type { BuiltNetwork } from "./build-network.js";
import { buildNetworkFromGtfs, type GtfsBuildCounts } from "./gtfs-network.js";
import { TileSpill } from "./gtfs-spill.js";
import {
  departureBucketFor,
  departureShardDataset,
  departureWindowFor,
  patternTripsDataset,
  type DepartureRow,
  type PatternTripRow,
} from "./departures-index.js";
import { PATTERN_TILE_DEGREES } from "./shards.js";

/**
 * Assembles everything the publish path needs from a GTFS archive and the NaPTAN register.
 *
 * The split is the point. Stops, operators, services and patterns do not scale with how many
 * buses run each day — there are a few hundred thousand stops and a few hundred thousand
 * patterns whatever the timetable says — so they are assembled in memory, exactly as before.
 * Journeys do scale that way, by every trip on every service date, and they go straight to disk.
 *
 * The returned network therefore carries no journeys at all. That is not an omission: a journey
 * is never published whole any more. It is decomposed as it streams past into the two shapes the
 * edge actually reads — a departure row per boardable call, and a trip's times against its
 * pattern — and then forgotten. `journeyCount` says how many went by.
 */

export interface AssembleOptions {
  naptanCsv: string;
  archivePath: string;
  serviceDates: readonly string[];
  retrievedAt: string;
  /** Where the departure-index spill lives. A temporary directory by default. */
  departureSpillDirectory?: string;
  /** Where the pattern-trip spill lives. A temporary directory by default. */
  patternTripSpillDirectory?: string;
  sourceVersion?: string;
}

export interface AssembledGtfsNetwork {
  /** Everything but the journeys, ready for the existing publish path. */
  network: BuiltNetwork;
  /**
   * The departure index, on disk, already sorted into the shards a board reads.
   *
   * A second spill rather than a second pass over the first: the rows are derived from a journey
   * at the moment it is emitted, and the journey is forgotten immediately afterwards, so deriving
   * them later would mean reading the whole national timetable back off disk to do it.
   */
  departureSpill: TileSpill;
  departureRowCount: number;
  /**
   * The planner's trips, on disk, on the same tile grid the patterns are published on.
   *
   * Separate from the departure index because the two queries want opposite shapes: a board wants
   * one stop's calls across every route, a plan wants one route's whole call sequence. Serving
   * both from one record is what produced a 281 MiB tile.
   */
  patternTripSpill: TileSpill;
  patternTripCount: number;
  journeyCount: number;
  gtfsCounts: GtfsBuildCounts;
  tables: Array<{ name: string; compressedBytes: number; uncompressedBytes: number }>;
}

export async function assembleGtfsNetwork(options: AssembleOptions): Promise<AssembledGtfsNetwork> {
  const naptan = normalizeNaptanCsv(options.naptanCsv, {
    retrievedAt: options.retrievedAt,
    ...(options.sourceVersion === undefined ? {} : { sourceVersion: options.sourceVersion }),
  });
  const naptanByAtco = new Map(naptan.stops.map((stop) => [stop.atcoCode, stop]));
  const stopsById = new Map<string, Stop>(naptan.stops.map((stop) => [stop.id, stop]));

  const departureSpill = new TileSpill(
    options.departureSpillDirectory ?? mkdtempSync(join(tmpdir(), "busstops-departures-")),
  );
  const patternTripSpill = new TileSpill(
    options.patternTripSpillDirectory ?? mkdtempSync(join(tmpdir(), "busstops-trips-")),
  );
  let patternTripCount = 0;

  /*
   * The number on the front of the bus, by pattern.
   *
   * Every departure row carries it, and a pattern knows only its service's id. Held here rather
   * than looked up later because a row is written the moment its journey arrives and the journey
   * is then forgotten: there is no later.
   */
  const routeNameByPattern = new Map<string, string>();
  let departureRowCount = 0;

  const patterns: RoutePattern[] = [];
  const shapes = new Map<string, Coordinate[]>();
  let journeyCount = 0;
  let journeysWithoutGeometry = 0;

  const result = await buildNetworkFromGtfs({
    archivePath: options.archivePath,
    serviceDates: options.serviceDates,
    retrievedAt: options.retrievedAt,
    naptanByAtco,
    onPattern: (pattern, shape, service) => {
      patterns.push(pattern);
      shapes.set(pattern.shapeRef, [...shape]);
      routeNameByPattern.set(pattern.id, service.publicName);
    },
    onJourney: (journey) => {
      const coordinates = journey.stopTimes
        .map((call) => stopsById.get(call.stopId)?.locationCoordinate)
        .filter((coordinate): coordinate is Coordinate => coordinate !== undefined);

      if (coordinates.length === 0) {
        // A journey whose stops cannot be located cannot be placed in a tile, and binning it
        // silently would make it unplannable with no record of why.
        journeysWithoutGeometry += 1;
        return;
      }

      journeyCount += 1;

      /*
       * And one departure row per boardable call.
       *
       * The destination is the last stop's name, which is what the front of the bus says. A call
       * you cannot board is not a departure and is left out entirely rather than published and
       * filtered at the edge — the whole point of this index is that the edge reads only rows it
       * is going to show.
       */
      const route = routeNameByPattern.get(journey.routePatternId);
      const lastCall = journey.stopTimes[journey.stopTimes.length - 1];
      const destination = lastCall ? (stopsById.get(lastCall.stopId)?.name ?? "") : "";

      for (const call of journey.stopTimes) {
        if (!call.pickupAllowed) continue;
        // The last call is where the bus finishes; nobody boards there for anywhere.
        if (call === lastCall) continue;
        const stop = stopsById.get(call.stopId);
        if (!stop || !route) continue;

        const epochSeconds = Math.floor(Date.parse(call.scheduledDeparture) / 1000);
        if (!Number.isFinite(epochSeconds)) continue;

        const row: DepartureRow = {
          s: stop.atcoCode,
          t: epochSeconds,
          r: route,
          d: destination,
          j: journey.tripId,
          p: journey.routePatternId,
          ...(call.isTimingPoint ? { k: 1 as const } : {}),
        };
        departureSpill.append(
          departureShardDataset(
            journey.serviceDate,
            departureBucketFor(stop.atcoCode),
            departureWindowFor(epochSeconds, journey.serviceDate),
          ),
          JSON.stringify(row),
        );
        departureRowCount += 1;
      }

      /*
       * And the trip, for the planner: the pattern it runs on plus its times.
       *
       * Filed on the pattern grid under the window its first call falls in, and placed by the
       * first call's coordinate so a corridor search reads the tiles it actually crosses.
       */
      const departures = journey.stopTimes.map((call) =>
        Math.floor(Date.parse(call.scheduledDeparture) / 1000),
      );
      const arrivals = journey.stopTimes.map((call, at) =>
        call.scheduledArrival
          ? Math.floor(Date.parse(call.scheduledArrival) / 1000)
          : departures[at]!,
      );
      if (departures.every((seconds) => Number.isFinite(seconds))) {
        const trip: PatternTripRow = {
          p: journey.routePatternId,
          j: journey.tripId,
          t: departures,
          // Only when a trip genuinely waits somewhere; otherwise the array says nothing twice.
          ...(arrivals.some((seconds, at) => seconds !== departures[at]) ? { a: arrivals } : {}),
        };
        const first = coordinates[0]!;
        patternTripSpill.append(
          patternTripsDataset(
            journey.serviceDate,
            tileIdFor(first, PATTERN_TILE_DEGREES),
            departureWindowFor(departures[0]!, journey.serviceDate),
          ),
          JSON.stringify(trip),
        );
        patternTripCount += 1;
      }
    },
  });

  departureSpill.flush();
  patternTripSpill.flush();

  const network: BuiltNetwork = {
    stops: naptan.stops,
    operators: result.operators,
    services: result.services,
    patterns,
    // Deliberately empty: they are in the spill. `journeyCount` is what the publish guard reads.
    journeys: [],
    shapes,
    counts: {
      stops: naptan.stops.length,
      operators: result.operators.length,
      services: result.services.length,
      patterns: patterns.length,
      journeys: journeyCount,
      stopsRejected: naptan.rejected.length,
      stopsWithdrawn: naptan.withdrawnAtcoCodes.length,
      journeysSkipped: result.counts.journeysTooShort + journeysWithoutGeometry,
      danglingStopReferences: result.counts.danglingStopReferences,
      // A GTFS archive either parses or does not; an out-of-order trip is the equivalent fault.
      parseErrors: result.counts.outOfOrderTrips,
    },
    warnings: result.warnings,
  };

  return {
    network,
    departureSpill,
    departureRowCount,
    patternTripSpill,
    patternTripCount,
    journeyCount,
    gtfsCounts: result.counts,
    tables: result.tables,
  };
}
