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

/**
 * How much ground the map shows when it opens around the passenger.
 *
 * A neighbourhood rather than a street or a county: wide enough that the stops either side of a
 * junction are both on screen and a bus two minutes away is visible coming, tight enough that the
 * dot is recognisably *here* rather than somewhere in this city. About 2.2 km across and 1.1 km
 * top to bottom at England's latitudes, which is the same order as the box "Use my location"
 * already used and an order of magnitude inside the API's maximum query area.
 *
 * Longitude and latitude get different numbers on purpose: a degree of longitude at 53°N is about
 * 0.6 of a degree of latitude, so equal numbers would frame a tall thin box on a wide screen.
 */
const AROUND_ME_HALF_WIDTH_DEGREES = 0.017;
const AROUND_ME_HALF_HEIGHT_DEGREES = 0.005;

export function boundsAroundMe(coordinate: LatLon): Bounds {
  return {
    west: coordinate.lon - AROUND_ME_HALF_WIDTH_DEGREES,
    east: coordinate.lon + AROUND_ME_HALF_WIDTH_DEGREES,
    south: coordinate.lat - AROUND_ME_HALF_HEIGHT_DEGREES,
    north: coordinate.lat + AROUND_ME_HALF_HEIGHT_DEGREES,
  };
}

/**
 * The widest accuracy halo worth drawing.
 *
 * A browser that has fallen back to an IP lookup reports accuracy in the tens of kilometres, and
 * drawing that honestly fills the screen with a translucent disc — which tells the passenger
 * nothing except that the map has gone blue. Beyond this the halo is omitted and the dot stands
 * alone: still "roughly here", without pretending to a precision the device does not have and
 * without covering the stops it is meant to sit among.
 */
export const MAX_ACCURACY_HALO_METRES = 2_000;

/**
 * A circle on the ground, as a GeoJSON ring.
 *
 * MapLibre's `circle-radius` is in screen pixels, so a circle drawn that way is a fixed-size blob
 * that means a different distance at every zoom — the one thing an accuracy halo must not be. A
 * polygon is in real coordinates, so it grows and shrinks with the map exactly as the ground does.
 *
 * Returns null where there is nothing honest to draw: no accuracy from the browser, a
 * non-finite or non-positive number, or a radius so large that the halo would be a tint over the
 * whole screen rather than information.
 */
export function accuracyRing(
  centre: LatLon,
  radiusMetres: number | null | undefined,
  steps = 48,
): [number, number][] | null {
  if (radiusMetres === null || radiusMetres === undefined) return null;
  if (!Number.isFinite(radiusMetres) || radiusMetres <= 0) return null;
  if (radiusMetres > MAX_ACCURACY_HALO_METRES) return null;

  const latitudeDegrees = radiusMetres / EARTH_RADIUS_METRES / DEG_TO_RAD;
  /*
   * Longitude degrees shrink with the cosine of latitude, so the same radius is more degrees of
   * longitude the further north you are. Clamped away from zero because at a pole the division is
   * unbounded, and a halo of infinite width is worse than a slightly wrong one nobody will ever
   * see.
   */
  const longitudeDegrees = latitudeDegrees / Math.max(0.01, Math.cos(centre.lat * DEG_TO_RAD));

  const ring: [number, number][] = [];
  for (let step = 0; step < steps; step += 1) {
    const angle = (step / steps) * 2 * Math.PI;
    ring.push([
      centre.lon + Math.cos(angle) * longitudeDegrees,
      centre.lat + Math.sin(angle) * latitudeDegrees,
    ]);
  }
  // A GeoJSON linear ring is explicitly closed: the last position repeats the first.
  ring.push(ring[0]!);
  return ring;
}

/**
 * A scheduled route split at the point the bus has actually reached.
 *
 * The whole pattern shape arrives with the vehicle detail, and drawing all of it as "where this
 * bus is going" would show a passenger the streets it came down twenty minutes ago with exactly
 * the same emphasis as the ones it is about to. `progressAlongShapeMetres` is the Worker's
 * projection of the vehicle onto this line, so the split is a walk along the shape accumulating
 * distance until that value is reached.
 *
 * Both halves are returned because both are drawn, at very different weights: the remaining
 * section is the point of the feature, and the travelled section is context that must not compete
 * with it.
 *
 * The join coordinate is interpolated rather than snapped to the nearest vertex, so the line meets
 * the bus marker instead of stopping short of it — on a long straight segment the nearest vertex
 * can be hundreds of metres away, which reads as the route not quite reaching the bus.
 */
export interface SplitShape {
  travelled: LatLon[];
  remaining: LatLon[];
}

export function splitShapeAtProgress(
  shape: readonly LatLon[],
  progressMetres: number | null,
): SplitShape {
  if (shape.length < 2) return { travelled: [], remaining: [] };

  /*
   * Without a projection there is no "ahead" to draw, so the whole shape is the remaining route.
   * That is the honest reading: we know the pattern and not the position, and the alternative —
   * guessing a split — would put the bus somewhere it is not.
   */
  if (progressMetres === null || !Number.isFinite(progressMetres) || progressMetres <= 0) {
    return { travelled: [], remaining: [...shape] };
  }

  const travelled: LatLon[] = [shape[0]!];
  let covered = 0;

  for (let i = 1; i < shape.length; i += 1) {
    const from = shape[i - 1]!;
    const to = shape[i]!;
    const segment = haversineMetresBrowser(from, to);

    if (covered + segment < progressMetres) {
      covered += segment;
      travelled.push(to);
      continue;
    }

    // The split falls inside this segment: interpolate to the exact point.
    const into = segment === 0 ? 0 : (progressMetres - covered) / segment;
    const at: LatLon = {
      lat: from.lat + (to.lat - from.lat) * into,
      lon: from.lon + (to.lon - from.lon) * into,
    };
    travelled.push(at);
    return { travelled, remaining: [at, ...shape.slice(i)] };
  }

  /*
   * Past the end of the shape. A bus at its terminus has no route ahead, and returning the last
   * point alone would be a one-point line that draws nothing — which is the correct amount of
   * route to draw for a journey that is over.
   */
  return { travelled: [...shape], remaining: [] };
}

/** The box containing a line, for fitting a route into the viewport. Null for nothing to fit. */
export function boundsOfPath(path: readonly LatLon[]): Bounds | null {
  if (path.length === 0) return null;
  let west = path[0]!.lon;
  let east = path[0]!.lon;
  let south = path[0]!.lat;
  let north = path[0]!.lat;
  for (const point of path) {
    if (point.lon < west) west = point.lon;
    if (point.lon > east) east = point.lon;
    if (point.lat < south) south = point.lat;
    if (point.lat > north) north = point.lat;
  }
  /*
   * A degenerate box — a route that doubles back to one point, or a single coordinate — cannot be
   * fitted: MapLibre needs two distinct corners. Padded by about 150 metres so "fit this" always
   * has something to fit.
   */
  const pad = 0.0015;
  if (east - west < pad) {
    west -= pad;
    east += pad;
  }
  if (north - south < pad) {
    south -= pad;
    north += pad;
  }
  return { west, south, east, north };
}
