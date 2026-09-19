import type { CSSProperties, ReactNode } from "react";
import { PixelSprite } from "./PixelImage.js";
import { ART } from "./sprites/generated.js";

/**
 * The pixel-art library (docs/02_DESIGN_SYSTEM.md).
 *
 * Two kinds of thing live here. The vehicles and the street furniture are the real artwork,
 * drawn on the art-pixel grid in tools/pixel-art and shipped as images; a bus in a row is the
 * same bus that drives across the home page and the same bus that appears on the map, because
 * it is literally the same drawing reduced. The small interface marks — a clock, a warning, the
 * weather — stay as a handful of `<rect>` units on a 16-unit grid, because at 16 to 24 pixels
 * there is nothing to draw that a few squares cannot say.
 *
 * Everything is decorative by default: a bus announced on every row is noise, not information.
 */

const INK = "var(--colour-ink)";
const RED = "var(--colour-red)";
const RED_DARK = "var(--colour-red-dark)";
const SURFACE = "var(--colour-surface)";
const HAIRLINE = "var(--colour-hairline)";
const MUTED = "var(--colour-muted)";
const BLUE = "var(--colour-blue)";

export interface SpriteProps {
  size?: number;
  /** Explicit whole-number scale, for artwork whose shape makes a target height meaningless. */
  scale?: number;
  /** Accessible name. When omitted the sprite is decorative and hidden from screen readers. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

interface CanvasProps extends SpriteProps {
  viewBox: string;
  children: ReactNode;
}

function PixelCanvas({
  viewBox,
  size = 24,
  scale,
  title,
  className,
  style,
  children,
}: CanvasProps) {
  const rendered = scale ? 16 * scale : size;
  const decorative = title === undefined;
  return (
    <svg
      viewBox={viewBox}
      width={rendered}
      height={rendered}
      className={className}
      style={{ display: "block", imageRendering: "pixelated", ...style }}
      role={decorative ? "presentation" : "img"}
      aria-hidden={decorative ? true : undefined}
      {...(decorative ? {} : { "aria-label": title })}
      focusable="false"
    >
      {!decorative && <title>{title}</title>}
      {children}
    </svg>
  );
}

/** Side-on bus: the workhorse sprite for rows, loading and anywhere a vehicle is named. */
export function PixelBusSide({ frame = "a", ...props }: SpriteProps & { frame?: "a" | "b" }) {
  return <PixelSprite image={(frame === "b" ? ART.busMidB : ART.busMid)!} {...props} />;
}

/** The same vehicle head on. */
export function PixelBusFront(props: SpriteProps) {
  return <PixelSprite image={ART.busFront!} {...props} />;
}

/** A stop flag on its pole, which is how a stop is signed on an actual street. */
export function PixelStopPole(props: SpriteProps) {
  return <PixelSprite image={ART.stopFlag!} {...props} />;
}

export function PixelShelter(props: SpriteProps) {
  return <PixelSprite image={ART.shelter!} {...props} />;
}

export function PixelTree(props: SpriteProps) {
  return <PixelSprite image={ART.tree!} {...props} />;
}

export function PixelWalkingPerson(props: SpriteProps) {
  return <PixelSprite image={ART.personWaiting!} {...props} />;
}

export function PixelBin(props: SpriteProps) {
  return <PixelSprite image={ART.bin!} {...props} />;
}

export function PixelCloudDrift(props: SpriteProps) {
  return <PixelSprite image={ART.cloud!} {...props} />;
}

/*
 * Interface marks for the things the artwork draws at full size.
 *
 * A heading wants a bus at sixteen units, not the ninety-six-pixel sprite that drives across the
 * home page: asked for at 24px, `PixelSprite` rounds to the nearest whole multiple of the native
 * height, which for a 33-pixel-tall bus is one — so the "small" mark would have come out 96 pixels
 * wide and pushed the heading off its line. These are the same vehicle, the same flag and the same
 * person said in a few squares, which is what the rest of the mark set does.
 */
export function PixelBusMark(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="2" y="3" width="12" height="8" fill={RED} />
      <rect x="2" y="3" width="12" height="2" fill={RED_DARK} />
      <rect x="3" y="6" width="4" height="3" fill={SURFACE} />
      <rect x="9" y="6" width="4" height="3" fill={SURFACE} />
      <rect x="2" y="11" width="12" height="1" fill={INK} />
      <rect x="4" y="12" width="2" height="2" fill={INK} />
      <rect x="10" y="12" width="2" height="2" fill={INK} />
    </PixelCanvas>
  );
}

export function PixelStopMark(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="4" y="2" width="8" height="6" fill={RED} />
      <rect x="5" y="4" width="6" height="1" fill={SURFACE} />
      <rect x="5" y="6" width="4" height="1" fill={SURFACE} />
      <rect x="7" y="8" width="2" height="6" fill={INK} />
      <rect x="4" y="14" width="8" height="1" fill={HAIRLINE} />
    </PixelCanvas>
  );
}

export function PixelPersonMark(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="6" y="2" width="4" height="3" fill={INK} />
      <rect x="5" y="6" width="6" height="5" fill={BLUE} />
      <rect x="3" y="7" width="2" height="3" fill={BLUE} />
      <rect x="11" y="7" width="2" height="3" fill={BLUE} />
      <rect x="5" y="11" width="2" height="4" fill={INK} />
      <rect x="9" y="11" width="2" height="4" fill={INK} />
    </PixelCanvas>
  );
}

export function PixelTrafficLights(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="6" y="1" width="4" height="9" fill={INK} />
      <rect x="7" y="2" width="2" height="2" fill={RED} />
      <rect x="7" y="5" width="2" height="2" fill="var(--colour-amber)" />
      <rect x="7" y="8" width="2" height="1" fill="var(--colour-success)" />
      <rect x="7" y="10" width="2" height="5" fill={MUTED} />
    </PixelCanvas>
  );
}

export function PixelCone(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="7" y="3" width="2" height="3" fill={RED} />
      <rect x="6" y="6" width="4" height="2" fill={SURFACE} />
      <rect x="5" y="8" width="6" height="3" fill={RED} />
      <rect x="3" y="11" width="10" height="2" fill={RED_DARK} />
    </PixelCanvas>
  );
}

export function PixelPin(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="5" y="1" width="6" height="7" fill={RED} />
      <rect x="4" y="2" width="1" height="5" fill={RED} />
      <rect x="11" y="2" width="1" height="5" fill={RED} />
      <rect x="7" y="3" width="2" height="2" fill={SURFACE} />
      <rect x="7" y="8" width="2" height="5" fill={RED_DARK} />
    </PixelCanvas>
  );
}

export function PixelClock(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="4" y="2" width="8" height="1" fill={INK} />
      <rect x="4" y="13" width="8" height="1" fill={INK} />
      <rect x="2" y="4" width="1" height="8" fill={INK} />
      <rect x="13" y="4" width="1" height="8" fill={INK} />
      <rect x="3" y="3" width="1" height="1" fill={INK} />
      <rect x="12" y="3" width="1" height="1" fill={INK} />
      <rect x="3" y="12" width="1" height="1" fill={INK} />
      <rect x="12" y="12" width="1" height="1" fill={INK} />
      <rect x="7" y="5" width="1" height="4" fill={RED} />
      <rect x="8" y="8" width="3" height="1" fill={RED} />
    </PixelCanvas>
  );
}

export function PixelWarning(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="7" y="1" width="2" height="2" fill="var(--colour-amber)" />
      <rect x="6" y="3" width="4" height="2" fill="var(--colour-amber)" />
      <rect x="5" y="5" width="6" height="2" fill="var(--colour-amber)" />
      <rect x="4" y="7" width="8" height="2" fill="var(--colour-amber)" />
      <rect x="3" y="9" width="10" height="3" fill="var(--colour-amber)" />
      <rect x="7" y="5" width="2" height="4" fill={INK} />
      <rect x="7" y="10" width="2" height="1" fill={INK} />
    </PixelCanvas>
  );
}

export function PixelSun(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="6" y="6" width="4" height="4" fill="var(--colour-amber)" />
      <rect x="7" y="2" width="2" height="2" fill="var(--colour-amber)" />
      <rect x="7" y="12" width="2" height="2" fill="var(--colour-amber)" />
      <rect x="2" y="7" width="2" height="2" fill="var(--colour-amber)" />
      <rect x="12" y="7" width="2" height="2" fill="var(--colour-amber)" />
    </PixelCanvas>
  );
}

/*
 * A cloud with an edge on it.
 *
 * It was three rectangles of `--colour-hairline`, which is the colour a divider is drawn in — on
 * the warm-white canvas the mark was very nearly invisible, and beside a heading it read as a
 * rendering fault rather than as a cloud. The body stays pale, because a cloud is pale; the
 * outline in muted ink is what makes it a shape.
 */
export function PixelCloud(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="5" y="3" width="6" height="1" fill={MUTED} />
      <rect x="4" y="4" width="8" height="1" fill={MUTED} />
      <rect x="2" y="6" width="3" height="1" fill={MUTED} />
      <rect x="1" y="7" width="2" height="4" fill={MUTED} />
      <rect x="13" y="5" width="2" height="6" fill={MUTED} />
      <rect x="2" y="11" width="12" height="1" fill={MUTED} />
      <rect x="4" y="5" width="9" height="1" fill={SURFACE} />
      <rect x="3" y="6" width="10" height="5" fill={SURFACE} />
      <rect x="2" y="7" width="1" height="4" fill={SURFACE} />
    </PixelCanvas>
  );
}

export function PixelRain(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="3" y="4" width="10" height="4" fill={HAIRLINE} />
      <rect x="4" y="10" width="1" height="3" fill={BLUE} />
      <rect x="7" y="9" width="1" height="4" fill={BLUE} />
      <rect x="11" y="10" width="1" height="3" fill={BLUE} />
    </PixelCanvas>
  );
}

export function PixelSnow(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="3" y="4" width="10" height="4" fill={HAIRLINE} />
      <rect x="4" y="10" width="2" height="2" fill={BLUE} opacity="0.5" />
      <rect x="7" y="11" width="2" height="2" fill={BLUE} opacity="0.5" />
      <rect x="11" y="10" width="2" height="2" fill={BLUE} opacity="0.5" />
    </PixelCanvas>
  );
}

export function PixelFlood(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="0" y="9" width="16" height="2" fill={BLUE} opacity="0.5" />
      <rect x="0" y="11" width="16" height="3" fill={BLUE} opacity="0.7" />
      <rect x="3" y="4" width="4" height="5" fill={MUTED} />
      <rect x="9" y="6" width="4" height="3" fill={MUTED} />
    </PixelCanvas>
  );
}

export function PixelChart(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="2" y="10" width="3" height="4" fill={INK} />
      <rect x="6" y="6" width="3" height="8" fill={RED} />
      <rect x="10" y="3" width="3" height="11" fill={INK} />
      <rect x="1" y="14" width="14" height="1" fill={HAIRLINE} />
    </PixelCanvas>
  );
}

export function PixelRouteMark(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="2" y="7" width="12" height="2" fill={RED} />
      <rect x="2" y="5" width="3" height="6" fill={INK} />
      <rect x="11" y="5" width="3" height="6" fill={INK} />
    </PixelCanvas>
  );
}
