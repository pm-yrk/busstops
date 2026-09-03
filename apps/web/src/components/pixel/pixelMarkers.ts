/**
 * Pixel markers for the live map.
 *
 * MapLibre markers are DOM elements built imperatively, not React trees, so these are SVG source
 * strings rather than components. They are static and contain no interpolated data, which is what
 * makes assigning them with innerHTML safe here; anything derived from a stop or vehicle goes on
 * the element as an attribute instead.
 *
 * The shapes deliberately match the hero scene's idiom — same 16-unit grid, same token colours —
 * so a bus on the map is recognisably the same bus as the one driving across the homepage.
 */

/**
 * A miniature side-on bus. Drawn facing right; the marker element rotates it to the reported
 * bearing, and flips it when it is heading left so the bus never drives backwards.
 */
export const PIXEL_BUS_MARKER = `
<svg viewBox="0 0 16 16" width="28" height="28" aria-hidden="true" focusable="false"
     style="display:block;image-rendering:pixelated;shape-rendering:crispEdges">
  <rect x="1" y="5" width="14" height="6" fill="var(--marker-body)"/>
  <rect x="1" y="5" width="14" height="1" fill="var(--marker-roof)"/>
  <rect x="2" y="7" width="3" height="2" fill="var(--colour-surface)"/>
  <rect x="6" y="7" width="3" height="2" fill="var(--colour-surface)"/>
  <rect x="10" y="7" width="2" height="2" fill="var(--colour-surface)"/>
  <rect x="13" y="6" width="2" height="2" fill="var(--colour-ink)"/>
  <rect x="1" y="10" width="14" height="1" fill="var(--marker-roof)"/>
  <rect x="3" y="11" width="2" height="2" fill="var(--colour-ink)"/>
  <rect x="11" y="11" width="2" height="2" fill="var(--colour-ink)"/>
</svg>`.trim();

/**
 * A stop: the flag on its pole, which is how a stop is signed on an actual street. The pole gives
 * the marker a definite point on the ground, so it reads as attached to a place rather than
 * floating over one.
 */
export const PIXEL_STOP_MARKER = `
<svg viewBox="0 0 16 16" width="24" height="24" aria-hidden="true" focusable="false"
     style="display:block;image-rendering:pixelated;shape-rendering:crispEdges">
  <rect x="7" y="6" width="2" height="9" fill="var(--colour-ink)"/>
  <rect x="3" y="2" width="10" height="5" fill="var(--marker-flag)"/>
  <rect x="4" y="3" width="8" height="3" fill="var(--colour-surface)"/>
  <rect x="5" y="4" width="2" height="1" fill="var(--marker-flag)"/>
  <rect x="8" y="4" width="3" height="1" fill="var(--marker-flag)"/>
  <rect x="5" y="14" width="6" height="1" fill="var(--colour-ink)"/>
</svg>`.trim();
