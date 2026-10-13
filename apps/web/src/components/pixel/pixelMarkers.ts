import { MARKERS } from "./sprites/generated.js";

/**
 * Markers for the live map.
 *
 * These are not separate icons that happen to look like the hero artwork: they are the hero
 * artwork, reduced until only what survives reduction is left — the silhouette, the glasshouse,
 * two wheels and the blind. A bus on the map at ordinary zoom still reads as this bus.
 *
 * MapLibre markers are DOM elements built imperatively rather than React trees, so these are
 * markup strings. They contain nothing but a generated data URI and fixed numbers; anything
 * derived from a stop or a vehicle is set on the element as text or an attribute instead.
 *
 * Each state is a different drawing at a whole-number scale rather than the same drawing under a
 * CSS transform, because a marker scaled by 1.25 stops being pixel art.
 */

function img(name: keyof typeof MARKERS, scale: number): string {
  const sprite = MARKERS[name]!;
  return (
    `<img class="map-marker__art" src="${sprite.src}" width="${sprite.w * scale}" ` +
    `height="${sprite.h * scale}" alt="" aria-hidden="true" draggable="false">`
  );
}

/**
 * A bus, facing right. The marker element rotates it to the reported bearing and mirrors it when
 * it is heading west, so the bus never drives backwards.
 */
export const PIXEL_BUS_MARKER = img("busMarkerRed", 2);

/** Enlarged, for a vehicle under the pointer or keyboard focus. */
export const PIXEL_BUS_MARKER_LARGE = img("busMarkerRed", 3);

/**
 * A vehicle whose position is old. A different livery, not the same bus faded: colour alone is
 * never the signal, and the marker also carries a dashed ring and reduced opacity.
 */
export const PIXEL_BUS_MARKER_STALE = img("busMarkerAmber", 2);

/**
 * A stop: the flag on its pole, which is how a stop is signed on an actual street. The pole gives
 * the marker a definite point on the ground, so it reads as attached to a place rather than
 * floating over one.
 */
export const PIXEL_STOP_MARKER = img("stopMarker", 2);
export const PIXEL_STOP_MARKER_SELECTED = img("stopMarker", 3);
