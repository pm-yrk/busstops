/**
 * Walking navigation handoff to Apple and Google Maps (docs/11_JOURNEY_ENGINE.md).
 *
 * These are URL handoffs, never paid embedded API calls. Coordinates and labels are validated
 * and encoded here so a malformed stop name can never break out of the URL.
 */

export interface HandoffTarget {
  lat: number;
  lon: number;
  label?: string;
}

export type MapsPlatform = "apple" | "google";

function isValidCoordinate(target: HandoffTarget): boolean {
  return (
    Number.isFinite(target.lat) &&
    Number.isFinite(target.lon) &&
    target.lat >= -90 &&
    target.lat <= 90 &&
    target.lon >= -180 &&
    target.lon <= 180
  );
}

/** Coordinates are fixed to 6 decimals: about 0.1m, well beyond what a stop position needs. */
function coordinatePair(target: HandoffTarget): string {
  return `${target.lat.toFixed(6)},${target.lon.toFixed(6)}`;
}

export function googleMapsWalkingUrl(target: HandoffTarget, origin?: HandoffTarget): string | null {
  if (!isValidCoordinate(target)) return null;

  const params = new URLSearchParams({
    api: "1",
    destination: coordinatePair(target),
    travelmode: "walking",
  });
  if (origin && isValidCoordinate(origin)) params.set("origin", coordinatePair(origin));

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function appleMapsWalkingUrl(target: HandoffTarget, origin?: HandoffTarget): string | null {
  if (!isValidCoordinate(target)) return null;

  const params = new URLSearchParams({ daddr: coordinatePair(target), dirflg: "w" });
  if (origin && isValidCoordinate(origin)) params.set("saddr", coordinatePair(origin));
  if (target.label) params.set("q", target.label);

  return `https://maps.apple.com/?${params.toString()}`;
}

/** Platform suggestion from the user agent, which a saved preference may override. */
export function suggestPlatform(userAgent: string): MapsPlatform {
  return /iphone|ipad|ipod|macintosh/i.test(userAgent) ? "apple" : "google";
}

export function walkingUrlFor(
  platform: MapsPlatform,
  target: HandoffTarget,
  origin?: HandoffTarget,
): string | null {
  return platform === "apple"
    ? appleMapsWalkingUrl(target, origin)
    : googleMapsWalkingUrl(target, origin);
}

const PLATFORM_PREFERENCE_KEY = "busstops.mapsPlatform.v1";

export function savedPlatform(): MapsPlatform | null {
  try {
    const value = globalThis.localStorage?.getItem(PLATFORM_PREFERENCE_KEY);
    return value === "apple" || value === "google" ? value : null;
  } catch {
    return null;
  }
}

export function savePlatform(platform: MapsPlatform): void {
  try {
    globalThis.localStorage?.setItem(PLATFORM_PREFERENCE_KEY, platform);
  } catch {
    // A saved preference is a convenience; failing to store it must not break the handoff.
  }
}
