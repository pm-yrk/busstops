import type { Coordinate } from "@busstops/contracts";

/**
 * OSGB36 (British National Grid) easting/northing to WGS84 latitude/longitude.
 *
 * NaPTAN publishes both a grid reference and WGS84 coordinates, but rows exist where the
 * WGS84 pair is missing or zeroed. Converting the grid reference ourselves keeps those stops
 * usable instead of discarding them, and never silently invents a position.
 *
 * Method: inverse Transverse Mercator onto the Airy 1830 ellipsoid, then a Helmert
 * transformation to WGS84. Accurate to a few metres, well inside bus-stop tolerance.
 */

// Airy 1830 ellipsoid and the National Grid projection parameters.
const AIRY_A = 6377563.396;
const AIRY_B = 6356256.909;
const WGS84_A = 6378137.0;
const WGS84_B = 6356752.3142;

const F0 = 0.9996012717; // central meridian scale factor
const LAT0 = (49 * Math.PI) / 180; // true origin latitude
const LON0 = (-2 * Math.PI) / 180; // true origin longitude
const N0 = -100000; // northing of true origin
const E0 = 400000; // easting of true origin

/** OSGB36 -> WGS84 Helmert parameters (metres, arc-seconds, ppm). */
const HELMERT = {
  tx: 446.448,
  ty: -125.157,
  tz: 542.06,
  rx: 0.1502,
  ry: 0.247,
  rz: 0.8421,
  s: -20.4894,
};

export function osgb36ToWgs84(easting: number, northing: number): Coordinate | null {
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  // Outside the National Grid extent the conversion is meaningless.
  if (easting < 0 || easting > 800_000 || northing < 0 || northing > 1_400_000) return null;

  const e2 = 1 - (AIRY_B * AIRY_B) / (AIRY_A * AIRY_A);
  const n = (AIRY_A - AIRY_B) / (AIRY_A + AIRY_B);
  const n2 = n * n;
  const n3 = n2 * n;

  let lat = LAT0;
  let m = 0;

  do {
    lat = (northing - N0 - m) / (AIRY_A * F0) + lat;
    const dLat = lat - LAT0;
    const sLat = lat + LAT0;
    const ma = (1 + n + 1.25 * n2 + 1.25 * n3) * dLat;
    const mb = (3 * n + 3 * n2 + 2.625 * n3) * Math.sin(dLat) * Math.cos(sLat);
    const mc = (1.875 * n2 + 1.875 * n3) * Math.sin(2 * dLat) * Math.cos(2 * sLat);
    const md = (35 / 24) * n3 * Math.sin(3 * dLat) * Math.cos(3 * sLat);
    m = AIRY_B * F0 * (ma - mb + mc - md);
  } while (Math.abs(northing - N0 - m) >= 0.00001);

  const cosLat = Math.cos(lat);
  const sinLat = Math.sin(lat);
  const tanLat = Math.tan(lat);
  const tan2 = tanLat * tanLat;
  const tan4 = tan2 * tan2;
  const tan6 = tan4 * tan2;

  const nu = (AIRY_A * F0) / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = (AIRY_A * F0 * (1 - e2)) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;

  const secLat = 1 / cosLat;
  const vii = tanLat / (2 * rho * nu);
  const viii = (tanLat / (24 * rho * nu ** 3)) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const ix = (tanLat / (720 * rho * nu ** 5)) * (61 + 90 * tan2 + 45 * tan4);
  const x = secLat / nu;
  const xi = (secLat / (6 * nu ** 3)) * (nu / rho + 2 * tan2);
  const xii = (secLat / (120 * nu ** 5)) * (5 + 28 * tan2 + 24 * tan4);
  const xiia = (secLat / (5040 * nu ** 7)) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);

  const dE = easting - E0;
  const dE2 = dE * dE;

  const latAiry = lat - vii * dE2 + viii * dE2 * dE2 - ix * dE2 * dE2 * dE2;
  const lonAiry =
    LON0 + x * dE - xi * dE * dE2 + xii * dE * dE2 * dE2 - xiia * dE * dE2 * dE2 * dE2;

  return helmertAiryToWgs84(latAiry, lonAiry);
}

function helmertAiryToWgs84(latRad: number, lonRad: number): Coordinate {
  const e2Airy = 1 - (AIRY_B * AIRY_B) / (AIRY_A * AIRY_A);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);
  const nu = AIRY_A / Math.sqrt(1 - e2Airy * sinLat * sinLat);

  // Geodetic -> geocentric cartesian (height assumed 0; stops are at ground level).
  const x1 = nu * cosLat * cosLon;
  const y1 = nu * cosLat * sinLon;
  const z1 = (1 - e2Airy) * nu * sinLat;

  const arcSecToRad = Math.PI / (180 * 3600);
  const rx = HELMERT.rx * arcSecToRad;
  const ry = HELMERT.ry * arcSecToRad;
  const rz = HELMERT.rz * arcSecToRad;
  const s = HELMERT.s / 1e6;

  const x2 = HELMERT.tx + x1 * (1 + s) - y1 * rz + z1 * ry;
  const y2 = HELMERT.ty + x1 * rz + y1 * (1 + s) - z1 * rx;
  const z2 = HELMERT.tz - x1 * ry + y1 * rx + z1 * (1 + s);

  // Geocentric cartesian -> geodetic on WGS84, iterating on latitude.
  const e2Wgs = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let latOut = Math.atan2(z2, p * (1 - e2Wgs));
  let latPrev = 2 * Math.PI;
  let nuOut = WGS84_A;
  let iterations = 0;

  while (Math.abs(latOut - latPrev) > 1e-12 && iterations < 20) {
    nuOut = WGS84_A / Math.sqrt(1 - e2Wgs * Math.sin(latOut) * Math.sin(latOut));
    latPrev = latOut;
    latOut = Math.atan2(z2 + e2Wgs * nuOut * Math.sin(latOut), p);
    iterations += 1;
  }

  return {
    lat: (latOut * 180) / Math.PI,
    lon: (Math.atan2(y2, x2) * 180) / Math.PI,
  };
}
