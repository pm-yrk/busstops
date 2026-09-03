import type { BoundingBox, Coordinate } from "@busstops/contracts";

/**
 * Spatial partitioning for artifacts that are too large to load nationally
 * (docs/07_DATA_PIPELINES.md "Storage discipline", docs/13_FREE_TIER_RULES.md).
 *
 * The scheduled-journey dataset is the clearest case: England's timetable is far too big to hold
 * in a Worker isolate, but a journey plan only ever needs the corridor between two points. So
 * journeys are published one object per tile, and the edge fetches the handful of tiles a request
 * actually spans instead of the whole country.
 *
 * Half a degree is roughly 55km north–south and 35km east–west at English latitudes: large enough
 * that a typical plan touches one or two tiles, small enough that a tile stays a manageable object.
 */
export const JOURNEY_TILE_DEGREES = 0.5;

export function tileIdFor(coordinate: Coordinate, sizeDegrees = JOURNEY_TILE_DEGREES): string {
  const lat = Math.floor(coordinate.lat / sizeDegrees);
  const lon = Math.floor(coordinate.lon / sizeDegrees);
  return `${lat}_${lon}`;
}

/** Every tile a bounding box touches, so nothing at an edge is silently dropped. */
export function tilesForBoundingBox(
  bbox: BoundingBox,
  sizeDegrees = JOURNEY_TILE_DEGREES,
): string[] {
  const minLat = Math.floor(bbox.south / sizeDegrees);
  const maxLat = Math.floor(bbox.north / sizeDegrees);
  const minLon = Math.floor(bbox.west / sizeDegrees);
  const maxLon = Math.floor(bbox.east / sizeDegrees);

  const tiles: string[] = [];
  for (let lat = minLat; lat <= maxLat; lat += 1) {
    for (let lon = minLon; lon <= maxLon; lon += 1) {
      tiles.push(`${lat}_${lon}`);
    }
  }
  return tiles;
}

/** All tiles touched by a set of coordinates; a journey spanning tiles belongs to each. */
export function tilesForCoordinates(
  coordinates: readonly Coordinate[],
  sizeDegrees = JOURNEY_TILE_DEGREES,
): string[] {
  const tiles = new Set<string>();
  for (const coordinate of coordinates) tiles.add(tileIdFor(coordinate, sizeDegrees));
  return [...tiles];
}

/**
 * Bounding box covering both ends of a journey request, expanded by the furthest the planner
 * will let someone walk. Without the margin a stop just outside the box would be invisible to
 * the search even though it is the obvious place to board.
 */
export function corridorBoundingBox(
  origin: Coordinate,
  destination: Coordinate,
  marginMetres: number,
): BoundingBox {
  const latMargin = marginMetres / 111_320;
  const midLat = (origin.lat + destination.lat) / 2;
  const lonMargin = marginMetres / (111_320 * Math.max(0.1, Math.cos((midLat * Math.PI) / 180)));

  return {
    south: Math.min(origin.lat, destination.lat) - latMargin,
    north: Math.max(origin.lat, destination.lat) + latMargin,
    west: Math.min(origin.lon, destination.lon) - lonMargin,
    east: Math.max(origin.lon, destination.lon) + lonMargin,
  };
}
