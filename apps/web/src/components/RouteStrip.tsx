import { ART } from "./pixel/sprites/generated.js";
import "./RouteStrip.css";

/**
 * The shape of a route, before the list of everywhere it stops.
 *
 * A stop sequence is two hundred place names, and a passenger looking at a route page first
 * wants the one fact that list buries: where it starts, where it ends, and how far apart those
 * are. This draws that — a line with a weighted circle at each end and the intermediate stops
 * marked along it — from the same `variant.stops` the list below is built from.
 *
 * It is not a map and does not pretend to be one. `/v1/routes/:id` returns each variant's stops
 * by name and sequence with no coordinates at all, so the spacing here is by position in the
 * sequence, not by distance on the ground. The caption says so.
 */

export interface RouteStripProps {
  stops: ReadonlyArray<{ stopId: string; name: string }>;
  distanceMetres: number;
  direction: string;
}

/**
 * How many intermediate marks to draw.
 *
 * Every stop on a 200-stop route is a solid bar, not a sequence. A fixed number of evenly
 * sampled marks reads as "a line with stops along it", which is what the drawing is for; the
 * count beside it carries the real number.
 */
const INTERMEDIATE_MARKS = 11;

export function RouteStrip({ stops, distanceMetres, direction }: RouteStripProps) {
  if (stops.length < 2) return null;
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;

  const inner = stops.slice(1, -1);
  const marks =
    inner.length <= INTERMEDIATE_MARKS
      ? inner
      : Array.from(
          { length: INTERMEDIATE_MARKS },
          (_, i) => inner[Math.round((i * (inner.length - 1)) / (INTERMEDIATE_MARKS - 1))]!,
        );

  return (
    <figure className="route-strip">
      <div className="route-strip__track" aria-hidden="true">
        {/*
          The line is drawn once, behind, rather than as segments between the circles.

          Segments were the first attempt and they bunched every intermediate mark into the
          middle: two flexible spans either side of a fixed row of circles put all the slack at
          the ends. One line across the track with the circles spaced along it is both simpler
          and the thing a transit diagram actually looks like.
        */}
        <span className="route-strip__end route-strip__end--start" />
        {marks.map((stop, index) => (
          <span key={`${stop.stopId}-${String(index)}`} className="route-strip__mark" />
        ))}
        <span className="route-strip__end route-strip__end--finish" />
        <img
          className="route-strip__bus"
          src={ART.busRow!.src}
          alt=""
          width={ART.busRow!.w}
          height={ART.busRow!.h}
        />
      </div>

      <div className="route-strip__labels">
        <span className="route-strip__place">{first.name}</span>
        <span className="route-strip__place route-strip__place--end">{last.name}</span>
      </div>

      <figcaption className="route-strip__caption muted small">
        {stops.length} stops
        {distanceMetres > 0 ? `, about ${(distanceMetres / 1000).toFixed(1)} km` : ""} · {direction}
        {". "}
        <span className="route-strip__disclaimer">
          Stops are drawn evenly along the line, in order. The timetable gives their sequence, not
          their positions, so this is the shape of the route and not a map of it.
        </span>
      </figcaption>
    </figure>
  );
}
