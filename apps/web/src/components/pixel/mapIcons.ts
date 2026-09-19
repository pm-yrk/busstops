import { MARKERS } from "./sprites/generated.js";

/**
 * The map's artwork, handed to MapLibre as textures rather than to the DOM as elements.
 *
 * A marker per vehicle is a DOM element per vehicle, and a city viewport holds hundreds of them:
 * every one is a node the browser lays out, composites and moves on every frame of a pan. The
 * same drawings as map images cost one texture each however many buses are on screen.
 *
 * Scaled here rather than by `icon-size`, and scaled by drawing into a canvas with smoothing
 * turned off. MapLibre filters its textures linearly, so an icon asked for at twice its size comes
 * back soft — which is the one thing pixel art cannot survive. Pre-scaling by a whole number and
 * then asking for it at its natural size keeps every pixel square.
 */

export interface PixelIcon {
  name: string;
  scale: number;
  src: string;
  /**
   * Draw the sprite mirrored left-to-right.
   *
   * The bus marker is a side view with its destination blind at the right-hand end, so it is a bus
   * driving east. A symbol layer can rotate an icon but cannot mirror one, and rotating a side
   * view is worse than leaving it alone — a westbound bus would be drawn upside down. Two
   * textures cost two uploads once and give every bus on the street a direction it is facing.
   */
  flip?: boolean;
}

export const MAP_ICONS: PixelIcon[] = [
  { name: "bus-red", scale: 2, src: MARKERS.busMarkerRed!.src },
  { name: "bus-red-west", scale: 2, src: MARKERS.busMarkerRed!.src, flip: true },
  { name: "bus-red-large", scale: 3, src: MARKERS.busMarkerRed!.src },
  { name: "bus-amber", scale: 2, src: MARKERS.busMarkerAmber!.src },
  { name: "bus-amber-west", scale: 2, src: MARKERS.busMarkerAmber!.src, flip: true },
  { name: "stop-flag", scale: 2, src: MARKERS.stopMarker!.src },
  { name: "stop-flag-large", scale: 3, src: MARKERS.stopMarker!.src },
];

/**
 * Draws one sprite at a whole-number scale with no interpolation.
 *
 * Returns null when the browser cannot give a 2D context — a headless environment, or a canvas
 * the page is not allowed to allocate. The caller treats that as "this icon is unavailable" and
 * the layer that wanted it simply does not draw, rather than the map failing to load.
 */
export async function rasterise(icon: PixelIcon): Promise<ImageData | null> {
  const image = new Image();
  image.src = icon.src;
  try {
    await image.decode();
  } catch {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = image.width * icon.scale;
  canvas.height = image.height * icon.scale;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.imageSmoothingEnabled = false;
  if (icon.flip) {
    // Mirrored about the sprite's own centre, so the drawing occupies the same box either way and
    // a bus does not jump sideways at the moment it turns around.
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}
