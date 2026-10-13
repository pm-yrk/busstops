import { Link } from "react-router-dom";
import type { DeparturePrediction, StopDeparturesResponse } from "@busstops/contracts";
import { EXTERNAL_LINK_ATTRIBUTES } from "../lib/tickets.js";
import "./WaitingHelp.css";

/**
 * "My bus hasn't come" — practical help for somebody standing at a stop.
 *
 * `BusStoppedPanel` answers a related question and only exists on the vehicle page, which is
 * reached by clicking a bus on the live map. A passenger whose bus has not arrived is not looking
 * at a bus; they are looking at a board, and until now the stop page offered them nothing at all.
 * This is that page's version, and it is deliberately not a second copy of the same logic: there
 * is no vehicle here to explain, so the question is not "why has that marker stopped" but "what
 * can I do now".
 *
 * Everything it offers comes from what the board already fetched — the departures, the official
 * notices, the routes that call here, the stop's own coordinate. It makes no new claim about the
 * buses and it predicts nothing. The one thing it must never do is imply a service is cancelled:
 * the data cannot show that, and a passenger who walks away on our say-so misses a bus that turns
 * up two minutes later.
 */

export interface WaitingHelpProps {
  stop: StopDeparturesResponse["data"]["stop"];
  departures: readonly DeparturePrediction[];
  routes: StopDeparturesResponse["data"]["routes"];
  disruptions: StopDeparturesResponse["data"]["disruptions"];
  /** Whether the response carried live observation or only the timetable. */
  degradation: string;
  /**
   * The current moment, from the page's own ticker.
   *
   * Taken as a prop rather than read with `Date.now()` during render — which is impure, and which
   * the lint rule caught — and it is the better answer anyway: the minutes here then count down in
   * step with the board above rather than drifting a second away from it.
   */
  now: Date;
  /** Age of the data behind the board, in seconds. Null when nothing is known. */
  ageSeconds: number | null;
  /** Whether a timetable for today was published at all; absent on an older artifact. */
  timetableCoverage?: { read: number; missing: number; serviceDates: string[] } | undefined;
  /** Nearby stops, already excluding this one. Null while the lookup is in flight. */
  nearby: ReadonlyArray<{ id: string; title: string; distanceMetres?: number | undefined }> | null;
  nearbyFailed: boolean;
  walkingUrl: string | null;
}

/** Minutes to a departure, floored, so "in 0 minutes" reads as "due". */
function minutesUntil(departure: DeparturePrediction, now: number): number | null {
  const when = departure.expectedTime ?? departure.scheduledTime;
  if (!when) return null;
  const at = Date.parse(when);
  if (Number.isNaN(at)) return null;
  return Math.floor((at - now) / 60_000);
}

export function WaitingHelp(props: WaitingHelpProps) {
  const now = props.now.getTime();
  const stop = props.stop;

  /*
   * What we can actually say about the board, which is the first thing somebody wants.
   *
   * Three different facts, and the old board collapsed two of them: no timetable published for
   * today is a gap of ours, nothing due in the window is a statement about buses, and a feed we
   * could not reach is neither.
   */
  const noTimetable =
    props.timetableCoverage !== undefined &&
    props.timetableCoverage.read === 0 &&
    props.timetableCoverage.missing > 0;

  const soonest = props.departures
    .map((departure) => ({ departure, minutes: minutesUntil(departure, now) }))
    .filter(
      (entry): entry is { departure: DeparturePrediction; minutes: number } =>
        entry.minutes !== null && entry.minutes >= 0,
    )
    .sort((a, b) => a.minutes - b.minutes)
    .slice(0, 3);

  const journeyFromHere =
    `/journey?fromLat=${stop.locationCoordinate.lat.toFixed(5)}` +
    `&fromLon=${stop.locationCoordinate.lon.toFixed(5)}` +
    `&fromLabel=${encodeURIComponent(stop.name)}`;

  /** One operator per id, because a stop's routes repeat them. */
  const operators = [
    ...new Map(
      props.routes
        .filter((route) => route.operatorId && route.operatorName !== "Unknown operator")
        .map((route) => [route.operatorId!, route.operatorName]),
    ),
  ];

  return (
    <section className="waiting-help" aria-labelledby="waiting-help-heading">
      <h2 id="waiting-help-heading">Bus not come?</h2>

      <p className="waiting-help__state">
        {noTimetable
          ? "We have no timetable published for today at this stop, so this board cannot tell you what is due. That is a gap on our side, not a statement that nothing runs."
          : props.degradation === "normal"
            ? props.ageSeconds !== null && props.ageSeconds < 120
              ? "This board is from a live observation in the last couple of minutes."
              : "This board is live, but the observation behind it is not fresh. Treat the times as approximate."
            : "Live tracking is not available for this stop right now, so these are timetabled times rather than observed ones."}
      </p>

      {soonest.length > 0 ? (
        <div className="waiting-help__block">
          <h3>What is due next</h3>
          <ul className="waiting-help__due">
            {soonest.map(({ departure, minutes }) => (
              <li key={`${departure.id}-${departure.scheduledTime}`}>
                <span className="route-badge route-badge--inline">
                  {departure.serviceRoutePublicName}
                </span>{" "}
                to {departure.destinationName ?? "destination not published"} —{" "}
                {minutes === 0 ? "due now" : `${minutes} min`}
                {departure.liveState === "scheduled_only" ? " (timetabled)" : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {props.disruptions.length > 0 ? (
        <div className="waiting-help__block">
          <h3>There is a notice about this stop</h3>
          <p>
            {props.disruptions.length === 1
              ? "One official notice covers this stop or a route that calls here."
              : `${props.disruptions.length} official notices cover this stop or the routes that call here.`}{" "}
            They are listed above, as the operator or highway authority published them.
          </p>
        </div>
      ) : null}

      {props.routes.length > 1 ? (
        <div className="waiting-help__block">
          <h3>Other routes from this stop</h3>
          <ul className="waiting-help__routes">
            {props.routes.slice(0, 8).map((route) => (
              <li key={route.id}>
                <Link to={`/routes/${encodeURIComponent(route.id)}`}>
                  <span className="route-badge route-badge--inline">{route.publicName}</span>{" "}
                  {route.operatorName}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="waiting-help__block">
        <h3>Somewhere else to try</h3>
        {props.nearby === null && !props.nearbyFailed ? (
          <p className="muted">Looking for stops nearby…</p>
        ) : props.nearbyFailed ? (
          <p className="muted">
            We could not look up nearby stops just now, so we cannot suggest one. That is a fault on
            our side rather than there being none.
          </p>
        ) : props.nearby && props.nearby.length > 0 ? (
          <ul className="waiting-help__nearby">
            {props.nearby.slice(0, 4).map((candidate) => (
              <li key={candidate.id}>
                <Link to={`/stops/${encodeURIComponent(candidate.id)}`}>{candidate.title}</Link>
                {candidate.distanceMetres === undefined
                  ? null
                  : ` — ${Math.round(candidate.distanceMetres)} m away`}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">There is no other stop within a few minutes' walk of this one.</p>
        )}
      </div>

      <div className="waiting-help__block">
        <h3>Other ways to get there</h3>
        <ul className="waiting-help__actions">
          <li>
            <Link to={journeyFromHere}>Plan a different journey from this stop</Link>
          </li>
          {props.walkingUrl ? (
            <li>
              <a href={props.walkingUrl} {...EXTERNAL_LINK_ATTRIBUTES}>
                Walking directions to this stop
              </a>
            </li>
          ) : null}
          {operators.map(([id, name]) => (
            <li key={id}>
              <Link to={`/operators/${encodeURIComponent(id)}`}>
                {name} — who runs this service
              </Link>
            </li>
          ))}
        </ul>
      </div>

      {/*
        Said once, at the end, because everything above is an offer of help and this is the limit
        of it. We do not know that a bus has been cancelled and we will not imply it.
      */}
      <p className="waiting-help__limit small muted">
        We can only show what the operators publish. A bus missing from this board has not
        necessarily been cancelled, and one that is listed is not guaranteed to run.
      </p>
    </section>
  );
}
