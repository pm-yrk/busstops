import type { CSSProperties, ReactNode } from "react";
import { ART } from "./sprites/generated.js";
import "./PixelMasthead.css";

/**
 * The strip of street that puts a page somewhere.
 *
 * Every page but the home page opened with a heading on white and went straight into data, so the
 * product had one illustration on it and seventeen spreadsheets. This is the cheapest honest way
 * to fix that: the same repeating kerb tile the hero already paints its street with, drawn as a
 * sliver under the title, with one or two things standing on it.
 *
 * It is deliberately *not* a new illustration. Reusing `edgeWide` and the existing props means
 * every page is standing on literally the same pavement as the hero, at the same whole-number
 * scale, so the site reads as one place rather than as a set of pages that each had art added to
 * them. Nothing here is generated per page; the only thing that varies is which props stand on it.
 *
 * Decorative throughout — `aria-hidden` on the art, and the heading is a real `h1` that carries
 * the page. A screen reader hears a title and a sentence, which is all this is.
 */

/** What can stand on the kerb, keyed so a page names a thing rather than a sprite. */
const PROPS = {
  shelter: ART.shelter!,
  tree: ART.tree!,
  bin: ART.bin!,
  stopFlag: ART.stopFlag!,
  person: ART.personWaiting!,
  bus: ART.busMid!,
} as const;

export type MastheadProp = keyof typeof PROPS;

/**
 * The art-pixel scale.
 *
 * Whole numbers only, for the reason the rest of the art system gives: a pixel that is sometimes
 * two screen pixels and sometimes three is the difference between pixel art and a photograph of
 * pixel art. Two is enough to read at a masthead's size without the band dominating the page.
 */
const SCALE = 2;

/**
 * Where the street's surfaces are inside the 200-pixel edge tile.
 *
 * These are `tools/pixel-art/scene.mjs`'s own numbers for the wide composition —
 * `{ pavement: 132, kerb: 154, road: 160 }` — not measurements taken off a screenshot. The kerb
 * is the line things stand on; below it is gutter and then carriageway.
 *
 * The first version of this band ignored them and stood everything on the bottom of the box,
 * which put the stop flag, the tree and the person six pixels into the road. It looked exactly
 * like what it was.
 */
const STREET = { kerb: 154, road: 160 } as const;

/** How much carriageway shows under the kerb: enough to read as a street, not as a car park. */
const ROAD_SHOWING = 6;

/**
 * The top of the painted strip: the pavement, and nothing above it.
 *
 * Painting the whole height of the box sliced the terrace through the middle of its windows,
 * which is the same awkward crop the hero was criticised for. The strip stops at the pavement, so
 * the band is a clean horizontal run of paving, kerb and gutter with no cut masonry in it. What
 * stands on the pavement is taller than the strip and rises into the transparent air above it —
 * which is what a stop flag does on a real street.
 */
const STREET_TOP_ROW = 132;

/** The tile row that sits on the band's bottom edge. */
const BAND_BOTTOM_ROW = STREET.road + ROAD_SHOWING;

/** How tall a slice of the kerb tile to show — the pavement and a little of the road. */
const KERB_ART_HEIGHT = 26;

/** How far the last prop stands from the end of the content column. */
const PROP_INSET = 12;

/**
 * Space between two things standing on the pavement.
 *
 * Generous, because the alternative reads as a pile rather than as a street: a stop flag, someone
 * waiting and a tree with no room between them is a cluster of sprites, and with room between them
 * it is a pavement with things on it.
 */
const PROP_GAP = 24;

/**
 * How tall the band's box is, which is not the same as how much kerb is painted.
 *
 * A stop flag is 52 art pixels tall and the kerb is 26, so at first the flags stood a full
 * flag's height *above* the band and overlapped the heading — measured at 104px of prop in a
 * 52px box. The fix is not to shrink the art, because a stop flag taller than the kerb it is
 * planted in is simply what a stop flag looks like. The box grows to hold whatever is standing
 * on it, and the kerb stays painted along the bottom of it, so the props have their own air and
 * nothing collides with the title.
 */
function bandArtHeight(standing: readonly MastheadProp[]): number {
  const tallest = standing.reduce((max, name) => Math.max(max, PROPS[name].h), 0);
  /*
   * The gutter below the kerb is the box's bottom padding, and `box-sizing: border-box` means
   * padding comes out of the height — so it has to be added back, or the tallest prop is clipped
   * by exactly the depth of the gutter.
   */
  const kerbUp = BAND_BOTTOM_ROW - STREET.kerb;
  return Math.max(BAND_BOTTOM_ROW - STREET_TOP_ROW, KERB_ART_HEIGHT, tallest + 2) + kerbUp;
}

export interface PixelMastheadProps {
  title: string;
  /** One sentence under the title. Optional: some pages say enough in their heading. */
  standfirst?: ReactNode;
  /**
   * What stands on the pavement, left to right.
   *
   * Two or three. A crowd on a decorative band stops being a detail and starts being a scene,
   * and a scene competes with whatever the page is actually for.
   */
  props?: readonly MastheadProp[];
  /** Anything the page wants beside the title — a badge, an age, a save button. */
  children?: ReactNode;
  className?: string;
}

export function PixelMasthead({
  title,
  standfirst,
  props: standing = ["stopFlag", "person"],
  children,
  className,
}: PixelMastheadProps) {
  return (
    <header className={className ? `pixel-masthead ${className}` : "pixel-masthead"}>
      <div className="pixel-masthead__text">
        <h1>{title}</h1>
        {standfirst ? <p className="pixel-masthead__standfirst">{standfirst}</p> : null}
      </div>

      {children ? <div className="pixel-masthead__aside">{children}</div> : null}

      <PixelKerb props={standing} />
    </header>
  );
}

/**
 * The band on its own, for a page that already has a header it does not want rebuilt.
 *
 * Pro is the case this exists for: it has an eyebrow, a title, an intro and a nav, and it is
 * deliberately calmer than Live. Replacing all that to gain a strip of pavement would be a
 * redesign; dropping the strip underneath it is the whole of what is wanted.
 */
export function PixelKerb({
  props: standing = ["stopFlag", "person"],
  className,
}: {
  props?: readonly MastheadProp[];
  className?: string;
}) {
  return (
    <div
      className={className ? `pixel-masthead__band ${className}` : "pixel-masthead__band"}
      aria-hidden="true"
      style={
        {
          "--px": SCALE,
          "--band-h": bandArtHeight(standing),
          "--edge": `url(${ART.edgeWide!.src})`,
          "--edge-w": ART.edgeWide!.w,
          "--edge-h": ART.edgeWide!.h,
          /* How tall the painted strip is, and how far up the tile it starts. */
          "--strip-h": BAND_BOTTOM_ROW - STREET_TOP_ROW,
          "--strip-offset": STREET_TOP_ROW,
          /* Where a prop's feet go: the kerb line, measured up from the band's bottom. */
          "--kerb-up": BAND_BOTTOM_ROW - STREET.kerb,
          "--prop-gap": PROP_GAP,
          "--prop-inset": PROP_INSET,
        } as CSSProperties
      }
    >
      {/* The paving itself: a fixed strip along the floor, under whatever is standing on it. */}
      <span className="pixel-masthead__paving" />

      {standing.map((name, index) => {
        const art = PROPS[name];
        return (
          <img
            // The same prop may legitimately appear twice on one band.
            key={`${name}-${String(index)}`}
            className="pixel-masthead__prop"
            src={art.src}
            alt=""
            width={art.w * SCALE}
            height={art.h * SCALE}
          />
        );
      })}
    </div>
  );
}
