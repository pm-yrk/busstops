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

/**
 * How much ground a vehicle lookup asks for around a known position.
 *
 * Live feeds are area-based, so `/v1/vehicles/:ref` needs a viewport; that is a fact about the
 * upstream, not a design choice. What was a design choice — and a bad one — was requiring the
 * caller to have a *map* viewport, because the route page has vehicle coordinates and no map, so
 * every "buses running now" link landed on "This link needs a map area". A position is enough to
 * build a box from, and this is the box: about four kilometres by four, well inside the API's
 * maximum area, and wide enough that a bus which has moved since the page loaded is still in it.
 */
const VEHICLE_LOOKUP_HALF_HEIGHT_DEGREES = 0.02;
const VEHICLE_LOOKUP_HALF_WIDTH_DEGREES = 0.03;

export function boundsAroundVehicle(coordinate: LatLon): Bounds {
  return {
    west: coordinate.lon - VEHICLE_LOOKUP_HALF_WIDTH_DEGREES,
    east: coordinate.lon + VEHICLE_LOOKUP_HALF_WIDTH_DEGREES,
    south: coordinate.lat - VEHICLE_LOOKUP_HALF_HEIGHT_DEGREES,
    north: coordinate.lat + VEHICLE_LOOKUP_HALF_HEIGHT_DEGREES,
  };
}

export function boundsParam(bounds: Bounds): string {
  return `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`;
}

/**
 * The link to a bus, from wherever the bus was seen.
 *
 * Prefers the viewport the caller was actually looking at, because that is the box the vehicle
 * was returned in and the one most likely to still contain it. Falls back to a box around the
 * vehicle's own position, which is what makes a route page able to link to its own buses.
 */
export function vehicleHref(
  vehicleRef: string,
  context: { bounds?: Bounds | null; coordinate?: LatLon | null },
): string {
  const bounds =
    context.bounds ?? (context.coordinate ? boundsAroundVehicle(context.coordinate) : null);
  const query = bounds ? `?bbox=${encodeURIComponent(boundsParam(bounds))}` : "";
  return `/vehicles/${encodeURIComponent(vehicleRef)}${query}`;
}

/** A bbox written as the four numbers the API takes, or null when it is not four numbers. */
export function boundsFromParam(raw: string | null): Bounds | null {
  if (!raw) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  const [west, south, east, north] = parts as [number, number, number, number];
  if (west >= east || south >= north) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
  if (Math.abs(south) > 90 || Math.abs(north) > 90) return null;
  return { west, south, east, north };
}
