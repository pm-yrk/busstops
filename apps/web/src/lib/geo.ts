/**
 * Browser-side geometry. Kept separate from the pipeline's geo module so the app bundle does
 * not pull in the pipeline package, and so the walking calculation for "Will I make it?" can
 * run entirely on the device.
 */

const EARTH_RADIUS_METRES = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

export function haversineMetresBrowser(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLon = (b.lon - a.lon) * DEG_TO_RAD;
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function boundsArea(bounds: Bounds): number {
  return (bounds.east - bounds.west) * (bounds.north - bounds.south);
}

/**
 * Shrinks a viewport to the maximum area the API accepts, keeping the centre fixed. This is
 * what stops a zoomed-out map from producing a rejected request instead of a useful one.
 */
export function clampBoundsToMaxArea(bounds: Bounds, maxAreaSquareDegrees: number): Bounds {
  const area = boundsArea(bounds);
  if (area <= maxAreaSquareDegrees) return bounds;

  const scale = Math.sqrt(maxAreaSquareDegrees / area);
  const centreLat = (bounds.north + bounds.south) / 2;
  const centreLon = (bounds.east + bounds.west) / 2;
  const halfHeight = ((bounds.north - bounds.south) * scale) / 2;
  const halfWidth = ((bounds.east - bounds.west) * scale) / 2;

  return {
    west: centreLon - halfWidth,
    east: centreLon + halfWidth,
    south: centreLat - halfHeight,
    north: centreLat + halfHeight,
  };
}
