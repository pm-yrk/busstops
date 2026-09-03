import "./PixelStreetScene.css";

/**
 * The hero street scene (docs/02_DESIGN_SYSTEM.md "Pixel art").
 *
 * One composed illustration on a single grid, not a row of independent sprites. That distinction
 * is the whole point: sprites side by side read as an icon strip, where a scene drawn on one
 * canvas has a horizon, a road that runs the full width, and things that sit in front of and
 * behind each other. Everything is laid out on a 160×80 unit grid so the pixels stay square and
 * the composition scales as one piece rather than drifting apart at different widths.
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

/** A side-on bus drawn at scene scale, with a livery colour so the two buses read as different. */
function Bus({ x, y, body, roof }: { x: number; y: number; body: string; roof: string }) {
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

export function PixelStreetScene({ className }: { className?: string }) {
  return (
    <div className={`street-scene ${className ?? ""}`.trim()} aria-hidden="true">
      <svg
        viewBox="0 0 320 80"
        className="street-scene__canvas"
        role="presentation"
        focusable="false"
        /*
         * "slice" rather than "meet": the scene always fills the width of the hero, cropping
         * whatever does not fit rather than shrinking into a letterboxed rectangle floating in
         * the middle of the page. Anchored to the bottom centre, so a wide screen loses a sliver
         * of sky and a phone crops to the middle of the street — where the shelter and the stop
         * are — which is the responsive recomposition rather than hiding things.
         */
        preserveAspectRatio="xMidYMax slice"
      >
        {/* ---------------------------------------------------------------- sky */}
        <g className="street-scene__sky">
          <rect x="268" y="8" width="10" height="10" fill={RED} opacity="0.9" />
          <rect x="266" y="10" width="14" height="6" fill={RED} opacity="0.9" />

          <g fill={HAIRLINE}>
            <rect x="30" y="14" width="20" height="4" />
            <rect x="35" y="11" width="11" height="3" />
            <rect x="120" y="8" width="16" height="4" />
            <rect x="125" y="5" width="8" height="3" />
            <rect x="196" y="16" width="14" height="3" />
            <rect x="200" y="13" width="7" height="3" />
            <rect x="86" y="20" width="12" height="3" />
          </g>
        </g>

        {/* ------------------------------------------------------- background row */}
        {/* Shop terrace on the left: the street has a side, not a backdrop. */}
        <g className="street-scene__shops">
          <rect x="10" y="26" width="46" height="26" fill={SURFACE} />
          <rect x="10" y="26" width="46" height="2" fill={INK} />
          <rect x="10" y="24" width="46" height="2" fill={RED} />
          <rect x="14" y="31" width="11" height="8" fill={HAIRLINE} />
          <rect x="29" y="31" width="11" height="8" fill={HAIRLINE} />
          <rect x="44" y="31" width="8" height="8" fill={HAIRLINE} />
          <rect x="18" y="33" width="3" height="3" fill={RED} opacity="0.35" />
          <rect x="14" y="42" width="12" height="10" fill={INK} />
          <rect x="30" y="42" width="10" height="10" fill={HAIRLINE} />
          {/* Awning stripes: the one place a little colour rhythm is worth the ink. */}
          <rect x="28" y="40" width="14" height="2" fill={RED} />
          <rect x="28" y="40" width="4" height="2" fill={SURFACE} />
          <rect x="36" y="40" width="3" height="2" fill={SURFACE} />
        </g>

        <g className="street-scene__tree">
          {/* Stepped canopy: a silhouette with corners reads as foliage where a rounded mass
              reads as a blob. */}
          <rect x="71" y="24" width="8" height="3" fill={INK} />
          <rect x="67" y="27" width="16" height="4" fill={INK} />
          <rect x="65" y="31" width="20" height="5" fill={INK} />
          <rect x="67" y="36" width="16" height="4" fill={INK} />
          <rect x="71" y="40" width="8" height="3" fill={INK} />
          <rect x="73" y="43" width="4" height="9" fill={MUTED} />
          <rect x="70" y="51" width="10" height="1" fill={MUTED} />
        </g>

        {/* Shelter, centred: the most recognisable object on any street, drawn in detail. */}
        <g className="street-scene__shelter">
          <rect x="120" y="28" width="38" height="3" fill={INK} />
          <rect x="120" y="31" width="3" height="21" fill={INK} />
          <rect x="155" y="31" width="3" height="21" fill={INK} />
          <rect x="123" y="31" width="32" height="17" fill={HAIRLINE} opacity="0.55" />
          <rect x="139" y="31" width="1" height="17" fill={INK} opacity="0.5" />
          {/* The timetable case people actually stand and read. */}
          <rect x="125" y="34" width="9" height="12" fill={SURFACE} />
          <rect x="125" y="34" width="9" height="2" fill={RED} />
          <rect x="126" y="38" width="7" height="1" fill={MUTED} />
          <rect x="126" y="40" width="7" height="1" fill={MUTED} />
          <rect x="126" y="42" width="5" height="1" fill={MUTED} />
          {/* Bench inside the shelter. */}
          <rect x="142" y="44" width="11" height="2" fill={INK} />
          <rect x="143" y="46" width="2" height="4" fill={INK} />
          <rect x="150" y="46" width="2" height="4" fill={INK} />
        </g>

        {/* Someone waiting. One figure, at the shelter, looking down the road the bus comes from. */}
        <g className="street-scene__waiting">
          <rect x="161" y="38" width="4" height="4" fill={INK} />
          <rect x="160" y="42" width="6" height="7" fill={RED_DARK} />
          <rect x="160" y="49" width="2" height="3" fill={INK} />
          <rect x="164" y="49" width="2" height="3" fill={INK} />
        </g>

        {/* Stop flag on its pole: what tells you this is a stop and not a bench. */}
        <g className="street-scene__stop">
          <rect x="172" y="24" width="3" height="28" fill={INK} />
          <rect x="166" y="22" width="16" height="10" fill={RED} />
          <rect x="168" y="25" width="12" height="4" fill={SURFACE} />
          <rect x="170" y="26" width="2" height="2" fill={RED_DARK} />
          <rect x="173" y="26" width="5" height="2" fill={RED_DARK} />
        </g>

        {/* Bench and a second tree, so the right of the street is not empty. */}
        <g className="street-scene__bench">
          <rect x="192" y="44" width="14" height="2" fill={INK} />
          <rect x="193" y="46" width="2" height="6" fill={INK} />
          <rect x="203" y="46" width="2" height="6" fill={INK} />
          <rect x="192" y="40" width="14" height="2" fill={INK} opacity="0.6" />
        </g>

        <g className="street-scene__tree street-scene__tree--far">
          <rect x="220" y="29" width="7" height="3" fill={INK} opacity="0.85" />
          <rect x="217" y="32" width="13" height="4" fill={INK} opacity="0.85" />
          <rect x="219" y="36" width="9" height="3" fill={INK} opacity="0.85" />
          <rect x="222" y="39" width="3" height="13" fill={MUTED} />
        </g>

        {/* A second frontage on the right, lower, so the terrace does not repeat itself. */}
        <g className="street-scene__building">
          <rect x="244" y="32" width="40" height="20" fill={SURFACE} />
          <rect x="244" y="32" width="40" height="2" fill={INK} />
          <rect x="248" y="37" width="9" height="7" fill={HAIRLINE} />
          <rect x="261" y="37" width="9" height="7" fill={HAIRLINE} />
          <rect x="274" y="37" width="6" height="7" fill={HAIRLINE} />
          <rect x="248" y="46" width="10" height="6" fill={INK} />
        </g>

        <g className="street-scene__lamp">
          <rect x="300" y="20" width="3" height="32" fill={INK} />
          <rect x="294" y="20" width="9" height="2" fill={INK} />
          <rect x="292" y="21" width="4" height="3" fill={RED} opacity="0.85" />
        </g>

        {/* ---------------------------------------------------------- pavement */}
        <rect x="0" y="52" width="320" height="4" fill={SURFACE} />
        <rect x="0" y="52" width="320" height="1" fill={HAIRLINE} />
        <rect x="0" y="56" width="320" height="2" fill={MUTED} opacity="0.5" />

        {/* -------------------------------------------------------------- road */}
        <rect x="0" y="58" width="320" height="22" fill={INK} />
        <g className="street-scene__markings" fill={SURFACE} opacity="0.85">
          {Array.from({ length: 18 }, (_, index) => (
            <rect key={index} x={4 + index * 18} y="68" width="10" height="1.5" />
          ))}
        </g>

        {/* Buses. Two liveries, two lanes, two speeds, so the street feels in use. */}
        <g className="street-scene__bus street-scene__bus--red">
          <Bus x={0} y={44} body={RED} roof={RED_DARK} />
        </g>
        <g className="street-scene__bus street-scene__bus--blue">
          <Bus x={0} y={62} body={BLUE} roof={INK} />
        </g>
      </svg>
    </div>
  );
}
