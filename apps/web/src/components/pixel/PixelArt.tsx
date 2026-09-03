import type { CSSProperties, ReactNode } from "react";

/**
 * Original pixel-art library on a fixed 16-unit grid (docs/02_DESIGN_SYSTEM.md).
 *
 * Every sprite is drawn from `<rect>` units so edges stay crisp at any size, uses a limited
 * palette drawn from the design tokens, and is decorative-by-default: sprites are hidden from
 * assistive technology unless given a `title`, because a decorative bus announced on every row
 * is noise, not information.
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
  /** Accessible name. When omitted the sprite is decorative and hidden from screen readers. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

interface CanvasProps extends SpriteProps {
  viewBox: string;
  children: ReactNode;
}

function PixelCanvas({ viewBox, size = 24, title, className, style, children }: CanvasProps) {
  const decorative = title === undefined;
  return (
    <svg
      viewBox={viewBox}
      width={size}
      height={size}
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

/** Side-on bus: the workhorse sprite for rows, loading and the road scene. */
export function PixelBusSide(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="1" y="4" width="14" height="7" fill={RED} />
      <rect x="1" y="4" width="14" height="1" fill={RED_DARK} />
      <rect x="2" y="6" width="3" height="2" fill={SURFACE} />
      <rect x="6" y="6" width="3" height="2" fill={SURFACE} />
      <rect x="10" y="6" width="3" height="2" fill={SURFACE} />
      <rect x="1" y="11" width="14" height="1" fill={RED_DARK} />
      <rect x="3" y="12" width="2" height="2" fill={INK} />
      <rect x="11" y="12" width="2" height="2" fill={INK} />
      <rect x="14" y="8" width="1" height="1" fill={SURFACE} />
    </PixelCanvas>
  );
}

/** Front-facing bus, used in the wordmark full stop and map markers. */
export function PixelBusFront(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="3" y="2" width="10" height="11" fill={RED} />
      <rect x="4" y="4" width="8" height="4" fill={SURFACE} />
      <rect x="4" y="9" width="2" height="2" fill={INK} />
      <rect x="10" y="9" width="2" height="2" fill={INK} />
      <rect x="3" y="13" width="2" height="1" fill={INK} />
      <rect x="11" y="13" width="2" height="1" fill={INK} />
      <rect x="7" y="9" width="2" height="1" fill={RED_DARK} />
    </PixelCanvas>
  );
}

export function PixelStopPole(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="7" y="4" width="2" height="10" fill={MUTED} />
      <rect x="4" y="2" width="8" height="4" fill={RED} />
      <rect x="5" y="3" width="6" height="2" fill={SURFACE} />
      <rect x="5" y="14" width="6" height="1" fill={INK} />
    </PixelCanvas>
  );
}

export function PixelShelter(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="2" y="4" width="12" height="1" fill={INK} />
      <rect x="2" y="5" width="1" height="8" fill={MUTED} />
      <rect x="13" y="5" width="1" height="8" fill={MUTED} />
      <rect x="3" y="5" width="10" height="5" fill={BLUE} opacity="0.15" />
      <rect x="3" y="11" width="10" height="2" fill={HAIRLINE} />
    </PixelCanvas>
  );
}

export function PixelRoad(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="0" y="6" width="16" height="6" fill={HAIRLINE} />
      <rect x="1" y="9" width="3" height="1" fill={SURFACE} />
      <rect x="6" y="9" width="3" height="1" fill={SURFACE} />
      <rect x="11" y="9" width="3" height="1" fill={SURFACE} />
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

export function PixelTree(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="7" y="9" width="2" height="5" fill={MUTED} />
      <rect x="4" y="3" width="8" height="6" fill="var(--colour-success)" />
      <rect x="5" y="2" width="6" height="1" fill="var(--colour-success)" />
    </PixelCanvas>
  );
}

export function PixelBench(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="2" y="7" width="12" height="2" fill={MUTED} />
      <rect x="3" y="9" width="1" height="4" fill={INK} />
      <rect x="12" y="9" width="1" height="4" fill={INK} />
      <rect x="2" y="5" width="12" height="1" fill={HAIRLINE} />
    </PixelCanvas>
  );
}

export function PixelStreetLamp(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="7" y="4" width="2" height="11" fill={MUTED} />
      <rect x="5" y="2" width="6" height="2" fill={INK} />
      <rect x="6" y="4" width="4" height="1" fill="var(--colour-amber)" />
    </PixelCanvas>
  );
}

export function PixelShops(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="1" y="5" width="6" height="9" fill={SURFACE} stroke={HAIRLINE} strokeWidth="0.5" />
      <rect x="9" y="3" width="6" height="11" fill={SURFACE} stroke={HAIRLINE} strokeWidth="0.5" />
      <rect x="2" y="7" width="4" height="2" fill={BLUE} opacity="0.2" />
      <rect x="10" y="5" width="4" height="2" fill={BLUE} opacity="0.2" />
      <rect x="2" y="11" width="2" height="3" fill={INK} />
      <rect x="11" y="10" width="2" height="4" fill={INK} />
    </PixelCanvas>
  );
}

export function PixelWalkingPerson(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="7" y="2" width="2" height="2" fill={INK} />
      <rect x="6" y="4" width="4" height="5" fill={INK} />
      <rect x="5" y="9" width="2" height="4" fill={INK} />
      <rect x="9" y="9" width="2" height="4" fill={INK} />
      <rect x="4" y="13" width="2" height="1" fill={INK} />
      <rect x="10" y="13" width="2" height="1" fill={INK} />
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

export function PixelCloud(props: SpriteProps) {
  return (
    <PixelCanvas viewBox="0 0 16 16" {...props}>
      <rect x="4" y="6" width="8" height="3" fill={HAIRLINE} />
      <rect x="3" y="7" width="10" height="3" fill={HAIRLINE} />
      <rect x="6" y="4" width="5" height="2" fill={HAIRLINE} />
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

export function PixelSkyline(props: SpriteProps) {
  return (
    <PixelCanvas
      viewBox="0 0 32 16"
      {...props}
      style={{ width: "100%", height: "auto", ...props.style }}
    >
      <rect x="0" y="8" width="5" height="8" fill={HAIRLINE} />
      <rect x="6" y="5" width="4" height="11" fill={HAIRLINE} />
      <rect x="11" y="10" width="6" height="6" fill={HAIRLINE} />
      <rect x="18" y="3" width="4" height="13" fill={HAIRLINE} />
      <rect x="23" y="7" width="4" height="9" fill={HAIRLINE} />
      <rect x="28" y="9" width="4" height="7" fill={HAIRLINE} />
      <rect x="7" y="7" width="1" height="1" fill="var(--colour-amber)" />
      <rect x="19" y="6" width="1" height="1" fill="var(--colour-amber)" />
      <rect x="24" y="9" width="1" height="1" fill="var(--colour-amber)" />
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
