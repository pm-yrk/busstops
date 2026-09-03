import type { Coordinate, Operator, RoutePattern, ServiceRoute, Stop } from "@busstops/contracts";
import {
  ArtifactStore,
  type ObjectStore,
  haversineMetres,
  pathLengthMetres,
} from "@busstops/pipeline-core";
import {
  DATASETS,
  type SearchIndex,
  type SearchIndexEntry,
} from "@busstops/pipeline-static-network";
import type { PatternGeometry } from "@busstops/matching";

/**
 * Reads the published static network from object storage.
 *
 * Artifacts are loaded once per isolate and reused: a Worker isolate serves many requests, so
 * re-reading the national stop set per request would waste both CPU time and R2 read
 * operations, both of which are metered on the free tier.
 */

export interface NetworkSnapshot {
  stops: Stop[];
  stopsById: Map<string, Stop>;
  stopsByAtco: Map<string, Stop>;
  operators: Map<string, Operator>;
  services: Map<string, ServiceRoute>;
  patterns: RoutePattern[];
  patternsById: Map<string, RoutePattern>;
  shapes: Map<string, Coordinate[]>;
  searchIndex: SearchIndex;
  version: string;
  publishedAt: string;
  partialCoverage: boolean;
}

interface ShapeRecord {
  shapeRef: string;
  points: Coordinate[];
}

export class NetworkRepository {
  private snapshot: NetworkSnapshot | null = null;
  private loadedAt = 0;
  private inFlight: Promise<NetworkSnapshot | null> | null = null;

  constructor(
    private readonly store: ObjectStore,
    /** How long a loaded snapshot is reused before the isolate re-reads storage. */
    private readonly ttlMs = 15 * 60 * 1000,
  ) {}

  async load(now: number = Date.now()): Promise<NetworkSnapshot | null> {
    if (this.snapshot && now - this.loadedAt < this.ttlMs) return this.snapshot;
    // Coalesce concurrent loads so a cold isolate does not read every dataset twice.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.read(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async read(now: number): Promise<NetworkSnapshot | null> {
    const artifacts = new ArtifactStore(this.store);

    const stopsResult = await artifacts.readCurrent<Stop>(DATASETS.stops);
    if (!stopsResult.manifest) {
      // Nothing published yet: the caller degrades rather than inventing data.
      return null;
    }

    const [operators, services, patterns, shapes, searchEntries] = await Promise.all([
      artifacts.readCurrent<Operator>(DATASETS.operators),
      artifacts.readCurrent<ServiceRoute>(DATASETS.services),
      artifacts.readCurrent<RoutePattern>(DATASETS.patterns),
      artifacts.readCurrent<ShapeRecord>(DATASETS.shapes),
      artifacts.readCurrent<SearchIndexEntry>(DATASETS.searchIndex),
    ]);

    const snapshot: NetworkSnapshot = {
      stops: stopsResult.records,
      stopsById: new Map(stopsResult.records.map((s) => [s.id, s])),
      stopsByAtco: new Map(stopsResult.records.map((s) => [s.atcoCode, s])),
      operators: new Map(operators.records.map((o) => [o.id, o])),
      services: new Map(services.records.map((s) => [s.id, s])),
      patterns: patterns.records,
      patternsById: new Map(patterns.records.map((p) => [p.id, p])),
      shapes: new Map(shapes.records.map((s) => [s.shapeRef, s.points])),
      searchIndex: { entries: searchEntries.records, builtAt: stopsResult.manifest.publishedAt },
      version: stopsResult.manifest.version,
      publishedAt: stopsResult.manifest.publishedAt,
      partialCoverage: stopsResult.manifest.partialCoverage,
    };

    this.snapshot = snapshot;
    this.loadedAt = now;
    return snapshot;
  }

  /** Stops inside a bounding box, capped. Uses the loaded snapshot, never a storage scan. */
  static stopsInBoundingBox(
    snapshot: NetworkSnapshot,
    bbox: { west: number; south: number; east: number; north: number },
    limit: number,
  ): { stops: Stop[]; truncated: boolean } {
    const inside: Stop[] = [];
    for (const stop of snapshot.stops) {
      const { lat, lon } = stop.locationCoordinate;
      if (lat < bbox.south || lat > bbox.north || lon < bbox.west || lon > bbox.east) continue;
      inside.push(stop);
      // Collect a little beyond the cap so the "most central" selection below is meaningful.
      if (inside.length > limit * 4) break;
    }

    if (inside.length <= limit) return { stops: inside, truncated: false };

    // When capped, keep the stops nearest the viewport centre: they are what the user is
    // looking at, and an arbitrary slice would drop the middle of the screen.
    const centre = {
      lat: (bbox.north + bbox.south) / 2,
      lon: (bbox.east + bbox.west) / 2,
    };
    const ranked = inside
      .map((stop) => ({ stop, distance: haversineMetres(centre, stop.locationCoordinate) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit)
      .map((entry) => entry.stop);

    return { stops: ranked, truncated: true };
  }

  /** Pattern geometries for matching, with along-path stop distances precomputed. */
  static patternGeometries(
    snapshot: NetworkSnapshot,
    patternIds?: readonly string[],
  ): PatternGeometry[] {
    const patterns = patternIds
      ? patternIds
          .map((id) => snapshot.patternsById.get(id))
          .filter((p): p is RoutePattern => p !== undefined)
      : snapshot.patterns;

    const geometries: PatternGeometry[] = [];
    for (const pattern of patterns) {
      const shape = snapshot.shapes.get(pattern.shapeRef);
      if (!shape || shape.length < 2) continue;
      geometries.push({
        pattern,
        shape,
        stopDistancesMetres: stopDistancesAlongShape(pattern, shape, snapshot),
      });
    }
    return geometries;
  }
}

/**
 * Along-path distance of each stop in a pattern. Computed by projecting each stop onto the
 * shape in order, so a route that passes near a stop twice (loops, circulars) still yields a
 * monotonically increasing sequence.
 */
export function stopDistancesAlongShape(
  pattern: RoutePattern,
  shape: readonly Coordinate[],
  snapshot: NetworkSnapshot,
): number[] {
  const cumulative: number[] = [0];
  for (let i = 1; i < shape.length; i++) {
    cumulative.push(cumulative[i - 1]! + haversineMetres(shape[i - 1]!, shape[i]!));
  }
  const total = cumulative[cumulative.length - 1] ?? pathLengthMetres(shape);

  const distances: number[] = [];
  let searchFrom = 0;

  for (const stopId of pattern.stopSequence) {
    const stop = snapshot.stopsById.get(stopId);
    if (!stop) {
      distances.push(searchFrom);
      continue;
    }

    let bestDistance = Number.POSITIVE_INFINITY;
    let bestAlong = searchFrom;

    for (let i = 0; i < shape.length; i++) {
      if (cumulative[i]! < searchFrom) continue;
      const metres = haversineMetres(stop.locationCoordinate, shape[i]!);
      if (metres < bestDistance) {
        bestDistance = metres;
        bestAlong = cumulative[i]!;
      }
    }

    distances.push(bestAlong);
    // Monotonic: the next stop cannot be behind this one.
    searchFrom = Math.min(bestAlong, total);
  }

  return distances;
}
