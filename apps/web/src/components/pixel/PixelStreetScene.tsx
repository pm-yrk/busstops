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
        viewBox="0 0 160 80"
        className="street-scene__canvas"
        role="presentation"
        focusable="false"
        preserveAspectRatio="xMidYMax meet"
      >
        {/* ---------------------------------------------------------------- sky */}
        <g className="street-scene__sky">
          <rect x="132" y="6" width="10" height="10" fill={RED} opacity="0.9" />
          <rect x="130" y="8" width="14" height="6" fill={RED} opacity="0.9" />

          <g fill={HAIRLINE}>
            <rect x="18" y="12" width="18" height="4" />
            <rect x="22" y="9" width="10" height="3" />
            <rect x="66" y="7" width="14" height="3" />
            <rect x="70" y="4" width="7" height="3" />
            <rect x="104" y="16" width="12" height="3" />
          </g>
        </g>

        {/* ------------------------------------------------------- background row */}
        {/* Shop frontage: a terrace, so the street has a side rather than a backdrop. */}
        <g className="street-scene__shops">
          <rect x="6" y="26" width="34" height="26" fill={SURFACE} />
          <rect x="6" y="26" width="34" height="2" fill={INK} />
          <rect x="6" y="24" width="34" height="2" fill={RED} />
          <rect x="9" y="31" width="9" height="8" fill={HAIRLINE} />
          <rect x="21" y="31" width="9" height="8" fill={HAIRLINE} />
          <rect x="33" y="31" width="4" height="8" fill={HAIRLINE} />
          <rect x="9" y="42" width="10" height="10" fill={INK} />
          <rect x="22" y="42" width="8" height="10" fill={HAIRLINE} />
          {/* Awning stripes, the one place a little colour rhythm is worth the ink. */}
          <rect x="20" y="40" width="12" height="2" fill={RED} />
          <rect x="20" y="40" width="3" height="2" fill={SURFACE} />
          <rect x="26" y="40" width="3" height="2" fill={SURFACE} />
        </g>

        {/* Tree, behind the pavement line so it sits back in the composition. */}
        <g className="street-scene__tree">
          <rect x="50" y="30" width="14" height="12" fill={INK} />
          <rect x="48" y="33" width="18" height="6" fill={INK} />
          <rect x="52" y="27" width="10" height="4" fill={INK} />
          <rect x="55" y="42" width="4" height="10" fill={MUTED} />
        </g>

        {/* Bus shelter: the most recognisable object on any street, so it is drawn in detail. */}
        <g className="street-scene__shelter">
          <rect x="76" y="28" width="34" height="3" fill={INK} />
          <rect x="76" y="31" width="3" height="21" fill={INK} />
          <rect x="107" y="31" width="3" height="21" fill={INK} />
          <rect x="79" y="31" width="28" height="17" fill={HAIRLINE} opacity="0.55" />
          {/* Glazing bars and the timetable case people actually stand and read. */}
          <rect x="92" y="31" width="1" height="17" fill={INK} opacity="0.5" />
          <rect x="81" y="34" width="8" height="11" fill={SURFACE} />
          <rect x="81" y="34" width="8" height="2" fill={RED} />
          <rect x="82" y="38" width="6" height="1" fill={MUTED} />
          <rect x="82" y="40" width="6" height="1" fill={MUTED} />
          <rect x="82" y="42" width="4" height="1" fill={MUTED} />
          {/* Bench inside the shelter. */}
          <rect x="95" y="44" width="10" height="2" fill={INK} />
          <rect x="96" y="46" width="2" height="4" fill={INK} />
          <rect x="102" y="46" width="2" height="4" fill={INK} />
        </g>

        {/* Stop flag: the pole and the roundel that says which stop this is. */}
        <g className="street-scene__stop">
          <rect x="118" y="24" width="3" height="28" fill={INK} />
          <rect x="112" y="24" width="15" height="10" fill={RED} />
          <rect x="114" y="27" width="11" height="4" fill={SURFACE} />
          <rect x="116" y="28" width="2" height="2" fill={RED_DARK} />
          <rect x="119" y="28" width="4" height="2" fill={RED_DARK} />
        </g>

        {/* Street lamp, leaning over the carriageway the way they actually do. */}
        <g className="street-scene__lamp">
          <rect x="140" y="20" width="3" height="32" fill={INK} />
          <rect x="134" y="20" width="9" height="2" fill={INK} />
          <rect x="132" y="21" width="4" height="3" fill={RED} opacity="0.85" />
        </g>

        {/* ---------------------------------------------------------- pavement */}
        <rect x="0" y="52" width="160" height="4" fill={SURFACE} />
        <rect x="0" y="52" width="160" height="1" fill={HAIRLINE} />
        {/* Kerb: one darker unit is all it takes to read as a step down to the road. */}
        <rect x="0" y="56" width="160" height="2" fill={MUTED} opacity="0.5" />

        {/* -------------------------------------------------------------- road */}
        <rect x="0" y="58" width="160" height="22" fill={INK} />
        <g className="street-scene__markings" fill={SURFACE} opacity="0.85">
          <rect x="4" y="68" width="10" height="1.5" />
          <rect x="22" y="68" width="10" height="1.5" />
          <rect x="40" y="68" width="10" height="1.5" />
          <rect x="58" y="68" width="10" height="1.5" />
          <rect x="76" y="68" width="10" height="1.5" />
          <rect x="94" y="68" width="10" height="1.5" />
          <rect x="112" y="68" width="10" height="1.5" />
          <rect x="130" y="68" width="10" height="1.5" />
          <rect x="148" y="68" width="10" height="1.5" />
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
