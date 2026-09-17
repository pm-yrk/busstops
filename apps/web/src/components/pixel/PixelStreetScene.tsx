import type { CSSProperties } from "react";
import { ART, SCENE_GEOMETRY } from "./sprites/generated.js";
import "./PixelStreetScene.css";

/**
 * The hero street (docs/02_DESIGN_SYSTEM.md "Pixel art").
 *
 * One composed illustration in three planes — sky and skyline behind, the terrace and everything
 * standing on the pavement in the middle, the carriageway and the buses in front — drawn on the
 * art-pixel grid in tools/pixel-art and shipped as an image. The buses are separate images laid
 * over it so they can be driven along the road.
 *
 * **Two compositions, not one cropped one.** The hero is a wide band on a desktop and very nearly
 * a portrait on a phone, and no single canvas fills both. The wide street is 320x144 art pixels
 * and the upright one 144x184, each drawn for the shape it is shown at, with the phone getting
 * fewer buildings and a bigger bus rather than the same picture shrunk.
 *
 * Everything is scaled by whole numbers. A pixel that is sometimes two screen pixels wide and
 * sometimes three is the difference between pixel art and a photograph of pixel art.
 */

const { WIDE, TALL } = SCENE_GEOMETRY;

/**
 * How much carriageway is left in front of the near bus.
 *
 * It used to be none: the bus was placed at `h - its height`, so its wheels ended on the last row
 * of the composition and it read as cut off by the frame rather than as standing on a road. The
 * phone composition had it worst, because the hero there is almost exactly as tall as the artwork
 * and there is nowhere for the eye to land underneath.
 *
 * A few rows of asphalt below the wheels is what makes the near lane the foreground rather than
 * the bottom edge. The upright street gets more of them because it has more road to spare.
 */
const NEAR_LANE_INSET = { wide: 3, tall: 7 } as const;

interface LaneProps {
  variant: "wide" | "tall";
}

/**
 * One street. Both are always in the DOM and CSS shows one, so there is never a first paint with
 * the wrong composition in it and no layout depends on a resize listener.
 */
function Street({ variant }: LaneProps) {
  const geometry = variant === "wide" ? WIDE : TALL;
  const ground = variant === "wide" ? ART.streetWide! : ART.streetTall!;
  return (
    <div
      className={`street-scene__street street-scene__street--${variant}`}
      style={
        {
          "--art-w": geometry.w,
          "--art-h": geometry.h,
        } as CSSProperties
      }
    >
      <img className="street-scene__ground" src={ground.src} alt="" aria-hidden="true" />

      {/* A cloud that drifts, slowly enough to be noticed only if you are looking for it. */}
      <img
        className="street-scene__cloud"
        src={ART.cloud!.src}
        alt=""
        aria-hidden="true"
        style={{ "--art-x": variant === "wide" ? 60 : 20, "--art-y": 6 } as CSSProperties}
      />
    </div>
  );
}

/**
 * The traffic, over the whole visible street rather than over the composition.
 *
 * The lanes used to live inside `.street-scene__street`, which is exactly as wide as the artwork
 * and clips what overflows it. The artwork is 320 art pixels; a desktop window is wider than that
 * at any whole-number scale, and the rest of the street is painted by a repeating edge tile. So a
 * bus drove about two thirds of the way across the page and then vanished into thin air at a
 * boundary with nothing visible at it — which is exactly what it looked like.
 *
 * The traffic is a sibling of the compositions now, spanning the full width of the scene, and the
 * drive keyframes are expressed in viewport width rather than in art pixels. A bus enters from
 * beyond one edge of the window and leaves beyond the other. The lane's height still comes from
 * the active composition, because that is what decides where the road is.
 */
function Traffic({ variant }: LaneProps) {
  const geometry = variant === "wide" ? WIDE : TALL;
  const near = ART.busNear!;
  const far = ART.busFar!;
  return (
    <div className={`street-scene__traffic street-scene__traffic--${variant}`}>
      {/* Far carriageway: a smaller bus, because a hero-sized one up the street covers the pavement. */}
      <div
        className="street-scene__lane street-scene__lane--far"
        style={
          {
            "--art-y": geometry.h - 12 - far.h,
            "--bus-w": far.w,
          } as CSSProperties
        }
      >
        <div className="street-scene__vehicle">
          <img
            className="street-scene__frame street-scene__frame--a"
            src={far.src}
            alt=""
            aria-hidden="true"
          />
          <img
            className="street-scene__frame street-scene__frame--b"
            src={ART.busFarB!.src}
            alt=""
            aria-hidden="true"
          />
        </div>
      </div>

      <div
        className="street-scene__lane street-scene__lane--near"
        style={
          {
            "--art-y": geometry.h - near.h - NEAR_LANE_INSET[variant],
            "--bus-w": near.w,
          } as CSSProperties
        }
      >
        <div className="street-scene__vehicle">
          <img
            className="street-scene__frame street-scene__frame--a"
            src={near.src}
            alt=""
            aria-hidden="true"
          />
          <img
            className="street-scene__frame street-scene__frame--b"
            src={ART.busNearB!.src}
            alt=""
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}

export function PixelStreetScene({ className = "" }: { className?: string }) {
  return (
    <div
      className={`street-scene ${className}`.trim()}
      role="img"
      aria-label="A city street: shops and a bus shelter with people waiting, and two buses on the road."
      style={
        {
          "--edge-wide": `url(${ART.edgeWide!.src})`,
          "--edge-tall": `url(${ART.edgeTall!.src})`,
          "--wide-h": WIDE.h,
          "--tall-h": TALL.h,
        } as CSSProperties
      }
    >
      <Street variant="wide" />
      <Street variant="tall" />
      <Traffic variant="wide" />
      <Traffic variant="tall" />
    </div>
  );
}
