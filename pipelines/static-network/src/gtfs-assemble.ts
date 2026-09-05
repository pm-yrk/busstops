import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Coordinate, RoutePattern, Stop } from "@busstops/contracts";
import { normalizeNaptanCsv } from "@busstops/adapters";
import { tilesForCoordinates } from "@busstops/pipeline-core";
import type { BuiltNetwork } from "./build-network.js";
import { buildNetworkFromGtfs, type GtfsBuildCounts } from "./gtfs-network.js";
import { TileSpill } from "./gtfs-spill.js";

/**
 * Assembles everything the publish path needs from a GTFS archive and the NaPTAN register.
 *
 * The split is the point. Stops, operators, services and patterns do not scale with how many
 * buses run each day — there are a few hundred thousand stops and a few hundred thousand
 * patterns whatever the timetable says — so they are assembled in memory, exactly as before.
 * Journeys do scale that way, by every trip on every service date, and they go straight to disk.
 *
 * The returned network therefore carries no journeys at all. That is not an omission: they are in
 * the spill, `journeyCount` says how many, and `publishSpilledJourneyTiles` writes them.
 */

export interface AssembleOptions {
  naptanCsv: string;
  archivePath: string;
  serviceDates: readonly string[];
  retrievedAt: string;
  /** Where the journey spill lives. A temporary directory by default. */
  spillDirectory?: string;
  sourceVersion?: string;
}

export interface AssembledGtfsNetwork {
  /** Everything but the journeys, ready for the existing publish path. */
  network: BuiltNetwork;
  /** The journeys, on disk, sorted into the tiles the edge reads. */
  spill: TileSpill;
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

  const spill = new TileSpill(
    options.spillDirectory ?? mkdtempSync(join(tmpdir(), "busstops-journeys-")),
  );

  const patterns: RoutePattern[] = [];
  const shapes = new Map<string, Coordinate[]>();
  let journeyCount = 0;
  let journeysWithoutGeometry = 0;

  const result = await buildNetworkFromGtfs({
    archivePath: options.archivePath,
    serviceDates: options.serviceDates,
    retrievedAt: options.retrievedAt,
    naptanByAtco,
    onPattern: (pattern, shape) => {
      patterns.push(pattern);
      shapes.set(pattern.shapeRef, [...shape]);
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

      const line = JSON.stringify(journey);
      // A journey spanning tiles is written to each, so a plan touching either end finds it.
      for (const tile of tilesForCoordinates(coordinates)) spill.append(tile, line);
      journeyCount += 1;
    },
  });

  spill.flush();

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
    spill,
    journeyCount,
    gtfsCounts: result.counts,
    tables: result.tables,
  };
}
