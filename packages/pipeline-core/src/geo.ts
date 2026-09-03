import type { BoundingBox, Coordinate } from "@busstops/contracts";
import { ENGLAND_BOUNDS } from "@busstops/contracts";

/** Geospatial primitives shared by map matching, journey planning and analytics. */

const EARTH_RADIUS_METRES = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;

export function haversineMetres(a: Coordinate, b: Coordinate): number {
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLon = (b.lon - a.lon) * DEG_TO_RAD;
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north in [0, 360). */
export function bearingDegrees(a: Coordinate, b: Coordinate): number {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLon = (b.lon - a.lon) * DEG_TO_RAD;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / DEG_TO_RAD + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0..180. */
export function bearingDifference(a: number, b: number): number {
  const diff = Math.abs(((a - b + 540) % 360) - 180);
  return diff;
}

export interface PointOnSegment {
  point: Coordinate;
  distanceMetres: number;
  /** 0..1 position along the segment. */
  fraction: number;
}

/**
 * Perpendicular projection of p onto segment a→b, using a local equirectangular
 * approximation. Accurate to well under a metre at bus-stop scale in England.
 */
export function projectOntoSegment(p: Coordinate, a: Coordinate, b: Coordinate): PointOnSegment {
  const latRef = (a.lat + b.lat) / 2;
  const cosLat = Math.cos(latRef * DEG_TO_RAD);
  const toXy = (c: Coordinate) => ({
    x: c.lon * cosLat * DEG_TO_RAD * EARTH_RADIUS_METRES,
    y: c.lat * DEG_TO_RAD * EARTH_RADIUS_METRES,
  });
  const pa = toXy(a);
  const pb = toXy(b);
  const pp = toXy(p);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const lengthSquared = dx * dx + dy * dy;

  let fraction = 0;
  if (lengthSquared > 0) {
    fraction = ((pp.x - pa.x) * dx + (pp.y - pa.y) * dy) / lengthSquared;
    fraction = Math.max(0, Math.min(1, fraction));
  }
  const projected: Coordinate = {
    lat: a.lat + (b.lat - a.lat) * fraction,
    lon: a.lon + (b.lon - a.lon) * fraction,
  };
  return { point: projected, distanceMetres: haversineMetres(p, projected), fraction };
}

export interface PointOnPath {
  point: Coordinate;
  distanceMetres: number;
  /** Distance travelled along the path to reach the projection, in metres. */
  alongPathMetres: number;
  segmentIndex: number;
}

/** Nearest point on a polyline, with along-path distance used to order vehicles on a route. */
export function projectOntoPath(p: Coordinate, path: readonly Coordinate[]): PointOnPath | null {
  if (path.length === 0) return null;
  if (path.length === 1) {
    return {
      point: path[0]!,
      distanceMetres: haversineMetres(p, path[0]!),
      alongPathMetres: 0,
      segmentIndex: 0,
    };
  }

  let best: PointOnPath | null = null;
  let cumulative = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const segmentLength = haversineMetres(a, b);
    const projection = projectOntoSegment(p, a, b);
    if (!best || projection.distanceMetres < best.distanceMetres) {
      best = {
        point: projection.point,
        distanceMetres: projection.distanceMetres,
        alongPathMetres: cumulative + segmentLength * projection.fraction,
        segmentIndex: i,
      };
    }
    cumulative += segmentLength;
  }
  return best;
}

export function pathLengthMetres(path: readonly Coordinate[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += haversineMetres(path[i]!, path[i + 1]!);
  }
  return total;
}

export function withinBoundingBox(c: Coordinate, bbox: BoundingBox): boolean {
  return c.lat >= bbox.south && c.lat <= bbox.north && c.lon >= bbox.west && c.lon <= bbox.east;
}

/** Rejects coordinates that cannot plausibly be an England bus position. */
export function isPlausibleEnglandCoordinate(c: Coordinate): boolean {
  if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return false;
  if (c.lat === 0 && c.lon === 0) return false; // null island: a common feed default
  return withinBoundingBox(c, ENGLAND_BOUNDS);
}

export function boundingBoxAreaSquareDegrees(bbox: BoundingBox): number {
  return (bbox.east - bbox.west) * (bbox.north - bbox.south);
}

export function expandBoundingBox(bbox: BoundingBox, metres: number): BoundingBox {
  const latDelta = metres / 111_320;
  const midLat = (bbox.north + bbox.south) / 2;
  const lonDelta = metres / (111_320 * Math.max(0.1, Math.cos(midLat * DEG_TO_RAD)));
  return {
    west: bbox.west - lonDelta,
    south: bbox.south - latDelta,
    east: bbox.east + lonDelta,
    north: bbox.north + latDelta,
  };
}

/**
 * Douglas–Peucker simplification. Display traces are simplified separately from the
 * geometry used for analytical matching, so visual smoothing never affects a metric.
 */
export function simplifyPath(path: readonly Coordinate[], toleranceMetres: number): Coordinate[] {
  if (path.length <= 2) return [...path];

  let maxDistance = 0;
  let maxIndex = 0;
  const first = path[0]!;
  const last = path[path.length - 1]!;

  for (let i = 1; i < path.length - 1; i++) {
    const distance = projectOntoSegment(path[i]!, first, last).distanceMetres;
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }

  if (maxDistance <= toleranceMetres) return [first, last];

  const left = simplifyPath(path.slice(0, maxIndex + 1), toleranceMetres);
  const right = simplifyPath(path.slice(maxIndex), toleranceMetres);
  return [...left.slice(0, -1), ...right];
}

/** Geohash-style tile key used to partition artifacts and cache keys by area. */
export function tileKey(c: Coordinate, precisionDegrees = 0.05): string {
  const lat = Math.floor(c.lat / precisionDegrees) * precisionDegrees;
  const lon = Math.floor(c.lon / precisionDegrees) * precisionDegrees;
  return `${lat.toFixed(3)}_${lon.toFixed(3)}`;
}

/** Speed in m/s between two observations; null when the time gap is too small to be meaningful. */
export function derivedSpeedMetresPerSecond(
  from: { coordinate: Coordinate; observedAt: string },
  to: { coordinate: Coordinate; observedAt: string },
  minimumSeconds = 5,
): number | null {
  const seconds = (new Date(to.observedAt).getTime() - new Date(from.observedAt).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds < minimumSeconds) return null;
  return haversineMetres(from.coordinate, to.coordinate) / seconds;
}

/** A jump no road vehicle could make: used to quarantine bad GPS rather than ingest it. */
export function isImpossibleJump(
  from: { coordinate: Coordinate; observedAt: string },
  to: { coordinate: Coordinate; observedAt: string },
  maxSpeedMetresPerSecond = 45,
): boolean {
  const speed = derivedSpeedMetresPerSecond(from, to, 1);
  return speed !== null && speed > maxSpeedMetresPerSecond;
}
