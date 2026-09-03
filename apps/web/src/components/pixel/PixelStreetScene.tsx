import "./PixelStreetScene.css";

/**
 * The hero street scene (docs/02_DESIGN_SYSTEM.md "Pixel art").
 *
 * One composed illustration on a single grid, not a row of independent sprites. That distinction
 * is the whole point: sprites side by side read as an icon strip, where a scene drawn on one
 * canvas has a horizon, a road that runs the full width, and things that sit in front of and
 * behind each other.
 *
 * **Two compositions, not one cropped one.** The hero is a wide band on a desktop and very nearly
 * a square on a phone, and no single canvas fills both. Cropping one to fit was measured and it
 * is not a recomposition: at 390px a 4:1 canvas scaled to the height throws away three quarters
 * of its width, which took both buses, the terrace and the trees off the street and left a phone
 * looking at a shelter and half a bench. So the street is drawn twice — wide and upright — and
 * each is shown at the shape it was drawn for. The parts are shared, so the two stay the same
 * street.
 *
 * Colours come from the design tokens, so the scene follows the warm-white / black / red
 * direction rather than restating it — and stays correct if the palette moves.
 *
 * The buses animate along the road. Motion is opt-out at the CSS layer, not conditionally
 * rendered, so a reduced-motion reader still gets the whole picture, simply still.
 */

const INK = "var(--colour-ink)";
const RED = "var(--colour-red)";
const RED_DARK = "var(--colour-red-dark)";
const BLUE = "var(--colour-blue)";
const SURFACE = "var(--colour-surface)";
const HAIRLINE = "var(--colour-hairline)";
const MUTED = "var(--colour-muted)";

interface At {
  x: number;
  y: number;
}

/** A side-on bus, with a livery colour so the two buses read as different vehicles. */
function Bus({ x, y, body, roof }: At & { body: string; roof: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="0" y="0" width="30" height="13" fill={body} />
      <rect x="0" y="0" width="30" height="2" fill={roof} />
      {/* Windows: a clear rhythm of light against the livery is what makes a bus a bus. */}
      <rect x="2" y="4" width="5" height="4" fill={SURFACE} />
      <rect x="9" y="4" width="5" height="4" fill={SURFACE} />
      <rect x="16" y="4" width="5" height="4" fill={SURFACE} />
      <rect x="23" y="4" width="4" height="4" fill={SURFACE} />
      {/* Destination blind. */}
      <rect x="23" y="1" width="6" height="2" fill={INK} />
      {/* Door seam and skirt. */}
      <rect x="14" y="4" width="1" height="9" fill={roof} />
      <rect x="0" y="11" width="30" height="2" fill={roof} />
      <rect x="4" y="13" width="4" height="3" fill={INK} />
      <rect x="22" y="13" width="4" height="3" fill={INK} />
      <rect x="5" y="14" width="2" height="1" fill={MUTED} />
      <rect x="23" y="14" width="2" height="1" fill={MUTED} />
    </g>
  );
}

/** Stepped canopy: a silhouette with corners reads as foliage where a rounded mass reads as a blob. */
function Tree({ x, y, height = 9, far = false }: At & { height?: number; far?: boolean }) {
  const opacity = far ? 0.85 : 1;
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="6" y="0" width="8" height="3" fill={INK} opacity={opacity} />
      <rect x="2" y="3" width="16" height="4" fill={INK} opacity={opacity} />
      <rect x="0" y="7" width="20" height="5" fill={INK} opacity={opacity} />
      <rect x="2" y="12" width="16" height="4" fill={INK} opacity={opacity} />
      <rect x="6" y="16" width="8" height="3" fill={INK} opacity={opacity} />
      <rect x="8" y="19" width="4" height={height} fill={MUTED} />
      <rect x="5" y={19 + height} width="10" height="1" fill={MUTED} />
    </g>
  );
}

/** The most recognisable object on any street, drawn with the things people actually use. */
function Shelter({ x, y }: At) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="0" y="0" width="38" height="3" fill={INK} />
      <rect x="0" y="3" width="3" height="21" fill={INK} />
      <rect x="35" y="3" width="3" height="21" fill={INK} />
      <rect x="3" y="3" width="32" height="17" fill={HAIRLINE} opacity="0.55" />
      <rect x="19" y="3" width="1" height="17" fill={INK} opacity="0.5" />
      {/* The timetable case people stand and read. */}
      <rect x="5" y="6" width="9" height="12" fill={SURFACE} />
      <rect x="5" y="6" width="9" height="2" fill={RED} />
      <rect x="6" y="10" width="7" height="1" fill={MUTED} />
      <rect x="6" y="12" width="7" height="1" fill={MUTED} />
      <rect x="6" y="14" width="5" height="1" fill={MUTED} />
      {/* Bench inside the shelter. */}
      <rect x="22" y="16" width="11" height="2" fill={INK} />
      <rect x="23" y="18" width="2" height="4" fill={INK} />
      <rect x="30" y="18" width="2" height="4" fill={INK} />
    </g>
  );
}

/** Someone waiting, looking down the road the bus comes from. */
function Waiting({ x, y }: At) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="1" y="0" width="4" height="4" fill={INK} />
      <rect x="0" y="4" width="6" height="7" fill={RED_DARK} />
      <rect x="0" y="11" width="2" height="3" fill={INK} />
      <rect x="4" y="11" width="2" height="3" fill={INK} />
    </g>
  );
}

/** What tells you this is a stop and not a bench. */
function StopFlag({ x, y, poleHeight }: At & { poleHeight: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="6" y="2" width="3" height={poleHeight} fill={INK} />
      <rect x="0" y="0" width="16" height="10" fill={RED} />
      <rect x="2" y="3" width="12" height="4" fill={SURFACE} />
      <rect x="4" y="4" width="2" height="2" fill={RED_DARK} />
      <rect x="7" y="4" width="5" height="2" fill={RED_DARK} />
    </g>
  );
}

function Bench({ x, y }: At) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="0" y="4" width="14" height="2" fill={INK} />
      <rect x="1" y="6" width="2" height="6" fill={INK} />
      <rect x="11" y="6" width="2" height="6" fill={INK} />
      <rect x="0" y="0" width="14" height="2" fill={INK} opacity="0.6" />
    </g>
  );
}

/** A shop terrace: the street has a side, not a backdrop. */
function Shops({ x, y }: At) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="0" y="2" width="46" height="26" fill={SURFACE} />
      <rect x="0" y="2" width="46" height="2" fill={INK} />
      <rect x="0" y="0" width="46" height="2" fill={RED} />
      <rect x="4" y="7" width="11" height="8" fill={HAIRLINE} />
      <rect x="19" y="7" width="11" height="8" fill={HAIRLINE} />
      <rect x="34" y="7" width="8" height="8" fill={HAIRLINE} />
      <rect x="8" y="9" width="3" height="3" fill={RED} opacity="0.35" />
      <rect x="4" y="18" width="12" height="10" fill={INK} />
      <rect x="20" y="18" width="10" height="10" fill={HAIRLINE} />
      {/* Awning stripes: the one place a little colour rhythm is worth the ink. */}
      <rect x="18" y="16" width="14" height="2" fill={RED} />
      <rect x="18" y="16" width="4" height="2" fill={SURFACE} />
      <rect x="26" y="16" width="3" height="2" fill={SURFACE} />
    </g>
  );
}

/** A lower frontage, so the terrace does not repeat itself. */
function Frontage({ x, y, width }: At & { width: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="0" y="0" width={width} height="20" fill={SURFACE} />
      <rect x="0" y="0" width={width} height="2" fill={INK} />
      <rect x="4" y="5" width="9" height="7" fill={HAIRLINE} />
      <rect x="17" y="5" width="9" height="7" fill={HAIRLINE} />
      {width > 34 ? <rect x="30" y="5" width="6" height="7" fill={HAIRLINE} /> : null}
      <rect x="4" y="14" width="10" height="6" fill={INK} />
    </g>
  );
}

function Lamp({ x, y, height }: At & { height: number }) {
  return (
    <g className="street-scene__lamp" transform={`translate(${x} ${y})`}>
      <rect x="8" y="0" width="3" height={height} fill={INK} />
      <rect x="1" y="0" width="10" height="2" fill={INK} />
      {/* The light hangs under the arm. Beside it, it reads as a stray pixel, not a lamp. */}
      <rect x="1" y="2" width="4" height="3" fill={RED} opacity="0.85" />
    </g>
  );
}

function Cloud({ x, y, width }: At & { width: number }) {
  return (
    <g fill={HAIRLINE} transform={`translate(${x} ${y})`}>
      <rect x="0" y="3" width={width} height="4" />
      <rect x={Math.round(width / 4)} y="0" width={Math.round(width / 2)} height="3" />
    </g>
  );
}

function Sun({ x, y }: At) {
  return (
    <g fill={RED} opacity="0.9" transform={`translate(${x} ${y})`}>
      <rect x="2" y="0" width="10" height="10" />
      <rect x="0" y="2" width="14" height="6" />
    </g>
  );
}

/** The road surface, its centre markings and the pavement above it. */
function Ground({
  width,
  pavementTop,
  roadTop,
  height,
  markingY,
  markingCount,
}: {
  width: number;
  pavementTop: number;
  roadTop: number;
  height: number;
  markingY: number;
  markingCount: number;
}) {
  const gap = width / markingCount;
  return (
    <>
      <rect x="0" y={pavementTop} width={width} height={roadTop - pavementTop} fill={SURFACE} />
      {/* A whisper of a line where the buildings meet the ground. Anything stronger — a rule at
          full strength, or paving joins — reads at hero scale as railings across the street. */}
      <rect x="0" y={pavementTop} width={width} height="1" fill={INK} opacity="0.2" />
      {/* Kerb. */}
      <rect x="0" y={roadTop - 2} width={width} height="2" fill={MUTED} opacity="0.5" />
      <rect x="0" y={roadTop} width={width} height={height - roadTop} fill={INK} />
      <g className="street-scene__markings" fill={SURFACE} opacity="0.85">
        {Array.from({ length: markingCount }, (_, index) => (
          <rect
            key={index}
            x={Math.round(gap / 4 + index * gap)}
            y={markingY}
            width={Math.round(gap / 2)}
            height="1.5"
          />
        ))}
      </g>
    </>
  );
}

/**
 * The wide street: a terrace, a shelter half way along, and two lanes of traffic running off both
 * edges. Drawn on 320×98, which is the proportion of the hero band on a laptop and a tablet.
 */
function WideStreet() {
  return (
    <svg
      viewBox="0 0 320 100"
      className="street-scene__canvas street-scene__canvas--wide"
      role="presentation"
      focusable="false"
      /*
       * "slice", anchored bottom centre: the street runs off both edges rather than floating in a
       * letterbox. The container's aspect ratio matches this canvas, so in practice nothing is
       * cropped — and when a very tall window makes the max-height bite, what goes is sky.
       */
      preserveAspectRatio="xMidYMax slice"
    >
      <Sun x={266} y={8} />
      <Cloud x={30} y={11} width={20} />
      <Cloud x={120} y={5} width={16} />
      <Cloud x={196} y={13} width={14} />
      <Cloud x={86} y={17} width={12} />

      <Shops x={10} y={24} />
      <Tree x={65} y={24} height={9} />
      <Shelter x={120} y={28} />
      <Waiting x={160} y={38} />
      <StopFlag x={166} y={22} poleHeight={30} />
      <Bench x={192} y={40} />
      <Tree x={215} y={30} height={7} far />
      <Frontage x={244} y={32} width={40} />
      <Lamp x={292} y={20} height={32} />

      <Ground
        width={320}
        pavementTop={52}
        roadTop={64}
        height={100}
        markingY={82}
        markingCount={16}
      />

      {/* Two liveries, two lanes, two speeds, so the street feels in use rather than staged. */}
      <g className="street-scene__bus street-scene__bus--blue">
        <Bus x={0} y={65} body={BLUE} roof={INK} />
      </g>
      <g className="street-scene__bus street-scene__bus--red">
        <Bus x={0} y={83} body={RED} roof={RED_DARK} />
      </g>
    </svg>
  );
}

/**
 * The same street stood up for a phone: one shop, one tree, the shelter and the stop close
 * together, and a deeper road so both buses still have a lane. Drawn on 132×116, which is close
 * to the square the hero leaves on a handset.
 */
function UprightStreet() {
  return (
    <svg
      viewBox="0 0 132 116"
      className="street-scene__canvas street-scene__canvas--narrow"
      role="presentation"
      focusable="false"
      preserveAspectRatio="xMidYMax slice"
    >
      <Sun x={4} y={10} />
      <Cloud x={34} y={16} width={16} />
      <Cloud x={68} y={7} width={13} />
      <Cloud x={96} y={25} width={11} />

      <Shops x={-8} y={34} />
      <Tree x={38} y={32} height={12} />
      <Shelter x={60} y={40} />
      <Waiting x={100} y={52} />
      <StopFlag x={104} y={32} poleHeight={34} />
      {/* Right of the flag, arm out over the road, which is where a street lamp stands. */}
      <Lamp x={118} y={22} height={44} />

      <Ground
        width={132}
        pavementTop={66}
        roadTop={74}
        height={116}
        markingY={94}
        markingCount={6}
      />

      <g className="street-scene__bus street-scene__bus--blue">
        <Bus x={0} y={76} body={BLUE} roof={INK} />
      </g>
      <g className="street-scene__bus street-scene__bus--red">
        <Bus x={0} y={97} body={RED} roof={RED_DARK} />
      </g>
    </svg>
  );
}

export function PixelStreetScene({ className }: { className?: string }) {
  return (
    <div className={`street-scene ${className ?? ""}`.trim()} aria-hidden="true">
      <WideStreet />
      <UprightStreet />
    </div>
  );
}
