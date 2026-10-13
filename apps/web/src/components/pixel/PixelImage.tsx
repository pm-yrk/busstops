import type { CSSProperties } from "react";
import { ART, MARKERS, type PixelImage as PixelImageData } from "./sprites/generated.js";

/**
 * Renders one piece of the pixel-art library.
 *
 * The artwork is authored on a fixed art-pixel grid (tools/pixel-art) and shipped as images, so
 * the only two rules here are the ones the idiom depends on: scale by whole numbers, and never
 * let the browser interpolate. A sprite asked for at a size that is not a multiple of its native
 * size is drawn at the nearest whole multiple instead of being stretched to fit — a half pixel
 * is what makes pixel art look like a photograph of pixel art.
 *
 * Decorative by default: a bus announced on every row is noise, not information.
 */

export interface PixelImageProps {
  /** Target height in CSS pixels. Rounded to the nearest whole multiple of the native height. */
  size?: number;
  /** Explicit integer scale, when the caller knows the grid it is working on. */
  scale?: number;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function integerScale(nativeHeight: number, target: number): number {
  return Math.max(1, Math.round(target / nativeHeight));
}

export function PixelSprite({
  image,
  size,
  scale,
  title,
  className,
  style,
}: PixelImageProps & { image: PixelImageData }) {
  const factor = scale ?? integerScale(image.h, size ?? image.h);
  const decorative = title === undefined;
  return (
    <img
      src={image.src}
      width={image.w * factor}
      height={image.h * factor}
      alt={decorative ? "" : title}
      role={decorative ? "presentation" : "img"}
      aria-hidden={decorative ? true : undefined}
      draggable={false}
      className={className}
      style={{ display: "block", imageRendering: "pixelated", ...style }}
    />
  );
}

/** Named helpers, so callers name artwork rather than file paths. */
export const art = ART;
export const markers = MARKERS;

export function makeSprite(name: keyof typeof ART) {
  return function Sprite(props: PixelImageProps) {
    return <PixelSprite image={ART[name]!} {...props} />;
  };
}
