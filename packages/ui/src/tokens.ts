/**
 * Design tokens for the approved warm-white / black / red editorial direction.
 * See docs/02_DESIGN_SYSTEM.md. Never scatter colour literals in components — import from here.
 */

export const colour = {
  canvas: "#F7F6F1",
  surface: "#FFFFFF",
  ink: "#111111",
  muted: "#66645F",
  hairline: "#DAD8D1",

  red: "#E5242A",
  redDark: "#B3161B",
  redPale: "#FCEBEB",

  /** Informational/geographic only. Never used in the wordmark. */
  blue: "#1557FF",
  bluePale: "#EAF0FF",

  /** Status colours chosen for >=4.5:1 on canvas; never the only status signal. */
  success: "#1F7A3D",
  successPale: "#E8F4EC",
  amber: "#8A5A00",
  amberPale: "#FBF1DC",
  critical: "#B3161B",
  criticalPale: "#FCEBEB",
} as const;
export type ColourToken = keyof typeof colour;

/** 4/8px spacing rhythm. */
export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 40,
  xxl: 64,
} as const;

export const radius = {
  none: 0,
  sm: 2,
  md: 4,
  lg: 8,
  pill: 999,
} as const;

export const border = {
  hairline: `1px solid ${colour.hairline}`,
  ink: `1px solid ${colour.ink}`,
  red: `1px solid ${colour.red}`,
} as const;

/** Shadow is reserved for floating map panels only. */
export const shadow = {
  none: "none",
  panel: "0 2px 12px rgba(17, 17, 17, 0.12)",
  sheet: "0 -2px 16px rgba(17, 17, 17, 0.14)",
} as const;

export const font = {
  sans: '"Inter", "Helvetica Neue", system-ui, -apple-system, "Segoe UI", Arial, sans-serif',
  /** Pixel/mono display face: boards, labels and micro-illustrations only, never body copy. */
  pixel: '"Silkscreen", "Courier New", ui-monospace, monospace',
  mono: 'ui-monospace, "SF Mono", "Menlo", "Consolas", monospace',
} as const;

export const fontSize = {
  micro: 11,
  small: 13,
  body: 15,
  lead: 18,
  h3: 22,
  h2: 30,
  h1: 44,
  hero: 72,
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

/** Minimum interactive target, per docs/02_DESIGN_SYSTEM.md responsive rules. */
export const MIN_TOUCH_TARGET_PX = 44;

export const breakpoint = {
  /** Narrowest supported width. */
  xs: 320,
  sm: 375,
  md: 768,
  lg: 1024,
  xl: 1440,
} as const;

export const duration = {
  fast: 120,
  base: 200,
  slow: 400,
  /** The pixel bus loop; suppressed entirely under prefers-reduced-motion. */
  busLoop: 2400,
} as const;

export const zIndex = {
  map: 0,
  mapOverlay: 10,
  sheet: 20,
  header: 30,
  banner: 40,
  modal: 50,
} as const;

/** Emits the token set as CSS custom properties for the app stylesheet. */
export function tokensToCssVariables(): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(colour)) {
    lines.push(`  --colour-${kebab(key)}: ${value};`);
  }
  for (const [key, value] of Object.entries(space)) {
    lines.push(`  --space-${key}: ${value}px;`);
  }
  for (const [key, value] of Object.entries(radius)) {
    lines.push(`  --radius-${key}: ${value}px;`);
  }
  for (const [key, value] of Object.entries(fontSize)) {
    lines.push(`  --font-size-${key}: ${value}px;`);
  }
  for (const [key, value] of Object.entries(font)) {
    lines.push(`  --font-${key}: ${value};`);
  }
  for (const [key, value] of Object.entries(shadow)) {
    lines.push(`  --shadow-${kebab(key)}: ${value};`);
  }
  lines.push(`  --min-touch-target: ${MIN_TOUCH_TARGET_PX}px;`);
  return `:root {\n${lines.join("\n")}\n}`;
}

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
