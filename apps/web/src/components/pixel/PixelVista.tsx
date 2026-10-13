import type { CSSProperties, ReactNode } from "react";
import { ART } from "./sprites/generated.js";
import "./PixelVista.css";

/**
 * A page title with its own small world beside it.
 *
 * This replaces `PixelMasthead`'s strip of pavement. That strip was the same drawing on every
 * page — a kerb, a stop flag, a person — which cost a lot of vertical space and told you nothing
 * about where you were. A scene that belongs to its page does the opposite: the disruptions page
 * opens on a road being dug up, Pro on the room the product is watched from, the journey planner
 * on a street you would actually wait on.
 *
 * Everything here is decoration and nothing in it states a fact. The roadworks board says ROAD
 * WORKS AHEAD and never a real closure; the bus in Pro's window is not a bus that is running.
 * Whatever has to be true is drawn by the page from its data, in type, where it can carry its
 * source and its age.
 *
 * Scaling is by whole numbers only. The art is authored at one height and the stylesheet picks
 * the largest integer multiple that fits, so a pixel is never one and a half screen pixels.
 */

const VISTAS = {
  route: ART.vistaRoute!,
  journey: ART.vistaJourney!,
  roadworks: ART.vistaRoadworks!,
  controlRoom: ART.vistaControlRoom!,
  depot: ART.vistaDepot!,
} as const;

export type VistaName = keyof typeof VISTAS;

/** What each scene is, for anybody who cannot see it. Written as a picture, not as data. */
const DESCRIPTIONS: Record<VistaName, string> = {
  route: "A red city bus at a stop, with a tree, someone waiting and a stop flag.",
  journey:
    "A parade of shops, a tree, a glass bus shelter with two people waiting, and a red bus arriving.",
  roadworks:
    "A road being dug up: a matrix sign reading road works ahead, a barrier, cones, a worker in a hi-vis jacket, a bus going past and a diversion arrow.",
  controlRoom:
    "An operations desk: a window onto the city, three screens showing a map, a chart and a status list, and somebody watching them.",
  depot: "A bus depot: two buses on the apron in front of the shed, and a member of staff.",
};

export interface PixelVistaProps {
  title: string;
  vista: VistaName;
  /** One sentence under the title. */
  standfirst?: ReactNode;
  /** Anything that belongs beside the title — a badge, a data age, a save button. */
  children?: ReactNode;
  className?: string;
}

/**
 * The scene on its own, for a page that already has a header it does not want rebuilt.
 *
 * Pro is the case this exists for: it has an eyebrow, a title, an intro and a nav, all of them
 * deliberately calmer than Live. Replacing that to gain a picture would be a redesign; dropping
 * the picture into it is the whole of what is wanted.
 */
export function PixelVistaScene({ vista, className }: { vista: VistaName; className?: string }) {
  const art = VISTAS[vista];
  return (
    <div
      className={className ? `pixel-vista__scene ${className}` : "pixel-vista__scene"}
      role="img"
      aria-label={DESCRIPTIONS[vista]}
      style={{ "--art-w": art.w, "--art-h": art.h } as CSSProperties}
    >
      <img src={art.src} alt="" width={art.w} height={art.h} draggable={false} />
    </div>
  );
}

export function PixelVista({ title, vista, standfirst, children, className }: PixelVistaProps) {
  const art = VISTAS[vista];
  return (
    <header className={className ? `pixel-vista ${className}` : "pixel-vista"}>
      <div className="pixel-vista__text">
        <h1>{title}</h1>
        {standfirst ? <p className="pixel-vista__standfirst">{standfirst}</p> : null}
        {children ? <div className="pixel-vista__aside">{children}</div> : null}
      </div>

      {/*
       * `role="img"` with a label rather than an `alt` on the image, because the scene is one
       * picture even though the browser is loading it as one file. A screen reader gets a
       * sentence describing a street, which is all this is.
       */}
      <div
        className="pixel-vista__scene"
        role="img"
        aria-label={DESCRIPTIONS[vista]}
        style={
          {
            "--art-w": art.w,
            "--art-h": art.h,
          } as CSSProperties
        }
      >
        <img src={art.src} alt="" width={art.w} height={art.h} draggable={false} />
      </div>
    </header>
  );
}
