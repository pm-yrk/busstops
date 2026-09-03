import { ENGLAND_BOUNDS, type BoundingBox } from "@busstops/contracts";

/**
 * England is collected in bounded partitions (docs/07_DATA_PIPELINES.md "Live collection").
 *
 * The intelligence path must never pull a national feed in one unbounded request: it would be a
 * single enormous response on a free tier, it would fail entirely whenever one region's data is
 * malformed, and a retry would re-fetch everything. Partitioning gives per-partition failure
 * isolation, lets the governor drop resolution region by region instead of switching the country
 * off, and keeps each request inside the Worker/Actions time and memory limits.
 *
 * Partitions are a fixed grid rather than administrative boundaries so that the set is stable,
 * reproducible and independent of any boundary dataset licence.
 */

export interface CollectionPartition {
  key: string;
  bbox: BoundingBox;
  /** Relative service density, used to prioritise when the governor reduces the workload. */
  weight: number;
}

export const PARTITION_GRID = {
  columns: 4,
  rows: 6,
} as const;

/**
 * Rough weighting by population/service density. Exact figures do not matter; the ordering does,
 * because it decides which partitions keep their cadence when the budget tightens.
 */
const DENSITY_HINTS: ReadonlyArray<{ minLat: number; maxLat: number; weight: number }> = [
  { minLat: 51.2, maxLat: 51.8, weight: 3 }, // London and the South East
  { minLat: 52.3, maxLat: 53.9, weight: 2.5 }, // Midlands and the North West
  { minLat: 53.9, maxLat: 55.9, weight: 1.5 }, // North East and Cumbria
];

export function englandPartitions(): CollectionPartition[] {
  const latSpan = (ENGLAND_BOUNDS.north - ENGLAND_BOUNDS.south) / PARTITION_GRID.rows;
  const lonSpan = (ENGLAND_BOUNDS.east - ENGLAND_BOUNDS.west) / PARTITION_GRID.columns;

  const partitions: CollectionPartition[] = [];
  for (let row = 0; row < PARTITION_GRID.rows; row += 1) {
    for (let column = 0; column < PARTITION_GRID.columns; column += 1) {
      const south = ENGLAND_BOUNDS.south + row * latSpan;
      const west = ENGLAND_BOUNDS.west + column * lonSpan;
      const bbox: BoundingBox = {
        south,
        west,
        north: south + latSpan,
        east: west + lonSpan,
      };
      const centreLat = south + latSpan / 2;
      const hint = DENSITY_HINTS.find((h) => centreLat >= h.minLat && centreLat < h.maxLat);
      partitions.push({
        key: `p${row}-${column}`,
        bbox,
        weight: hint?.weight ?? 1,
      });
    }
  }
  return partitions;
}

/** Highest-value partitions first, so reducing the workload sheds the least useful work. */
export function partitionsByPriority(): CollectionPartition[] {
  return englandPartitions().sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
}

export function partitionForCoordinate(
  latitude: number,
  longitude: number,
): CollectionPartition | null {
  return (
    englandPartitions().find(
      (partition) =>
        latitude >= partition.bbox.south &&
        latitude <= partition.bbox.north &&
        longitude >= partition.bbox.west &&
        longitude <= partition.bbox.east,
    ) ?? null
  );
}
