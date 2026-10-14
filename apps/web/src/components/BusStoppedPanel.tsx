import { Link } from "react-router-dom";
import {
  ACCESSIBILITY_NOTE,
  EMERGENCY_GUIDANCE,
  assessBusStopped,
  type BusStoppedInput,
} from "../lib/bus-stopped.js";
import { formatLondonTime } from "../lib/format.js";
import { EmptyState, StateLozenge } from "./primitives.js";
import "./BusStoppedPanel.css";

/**
 * "Bus Stopped?" (docs/09_BUS_STOPS_LIVE.md, docs/03_SITE_MAP_AND_UX.md).
 *
 * The panel exists because the honest answer to "where is my bus?" is usually "here is what we
 * can see, and here are the things that would explain it". It therefore lists plausible states
 * rather than picking one, and never says a bus has broken down or been cancelled — the data
 * cannot show that, and a wrong claim would send someone walking away from a bus that arrives
 * two minutes later.
 *
 * The practical help is the point: the next useful service, an alternative stop, and a handoff
 * to the user's own maps app.
 */

/**
 * Whether the surrounding context has actually been gathered.
 *
 * The panel used to take `otherVehiclesObserved={0}`, `otherVehiclesMoving={null}` and
 * `nextServices={[]}` whether the lookup had finished, failed, or genuinely found nothing — three
 * different facts rendered as one sentence. "No other departures to suggest" over a lookup that
 * never returned is the empty-state lie this product is not allowed to tell, so the state travels
 * with the numbers and only `ready` licences a statement about the world.
 */
export type BusStoppedContextState = "loading" | "ready" | "unavailable";

export interface BusStoppedPanelProps extends BusStoppedInput {
  /** Next departures at the stop the user is waiting at, already filtered to useful ones. */
  nextServices: ReadonlyArray<{
    routeName: string;
    destination: string;
    expectedTime: string;
    live: boolean;
  }>;
  /**
   * The coordinate is carried as well as the name, because the planner takes a position.
   *
   * `/journey` reads `fromLat`/`fromLon`/`fromLabel` and nothing else — a stop id in the query
   * does nothing — so a replanning link without these would look right and arrive at an empty
   * form, which is the kind of dead end this panel exists to avoid.
   */
  alternativeStop: {
    id: string;
    name: string;
    walkingMinutes: number;
    lat: number;
    lon: number;
  } | null;
  walkingUrl: string | null;
  operatorContactUrl: string | null;
  operatorName: string | null;
  /** Defaults to `ready` so a caller that genuinely has the facts need not say so. */
  contextState?: BusStoppedContextState;
  /** Offered when the context lookup failed, so the passenger can ask again. */
  onRetryContext?: () => void;
  onDismiss?: () => void;
}

export function BusStoppedPanel(props: BusStoppedPanelProps) {
  const contextState = props.contextState ?? "ready";
  const contextKnown = contextState === "ready";

  /*
   * An unfinished lookup is not an observation.
   *
   * `otherVehiclesMoving: false` with `otherVehiclesObserved: 0` reads to `assessBusStopped` as
   * "nothing nearby is moving", which is a claim about the road. Until the lookup lands there is
   * no such claim to make, so the peer counts go in as null and the assessment reasons without
   * them. Only the peers are withheld: freshness, the end of the route and the official incidents
   * all arrive with the vehicle itself, and an announced closure is the one thing here that can
   * explain a stationary bus outright.
   */
  const assessment = assessBusStopped(
    contextKnown ? props : { ...props, otherVehiclesMoving: null, otherVehiclesObserved: 0 },
  );

  return (
    <section className="bus-stopped" aria-labelledby="bus-stopped-heading">
      <header className="bus-stopped__header">
        <h2 id="bus-stopped-heading">Bus stopped?</h2>
        {props.onDismiss ? (
          <button type="button" className="bus-stopped__dismiss" onClick={props.onDismiss}>
            Close
          </button>
        ) : null}
      </header>

      <p className="bus-stopped__summary">{assessment.summary}</p>

      <div className="bus-stopped__block">
        <h3>What we can see</h3>
        {assessment.lastReliableObservationAt ? (
          <p className="bus-stopped__observation">
            Last reliable position at{" "}
            <time dateTime={assessment.lastReliableObservationAt}>
              {formatLondonTime(new Date(assessment.lastReliableObservationAt))}
            </time>
            {assessment.freshnessSeconds !== null
              ? `, ${Math.round(assessment.freshnessSeconds / 60)} minutes ago`
              : ""}
            .
          </p>
        ) : (
          <p className="bus-stopped__observation">
            We have no recent position for this bus, so we cannot say where it is.
          </p>
        )}

        {!contextKnown ? (
          <p className="bus-stopped__pending">
            {contextState === "loading"
              ? "Checking what else is moving nearby\u2026"
              : "We could not check what else is moving nearby just now."}
          </p>
        ) : props.otherVehiclesMoving === null ? (
          <p>We cannot tell whether other buses nearby are moving.</p>
        ) : props.otherVehiclesMoving ? (
          <p>
            Other buses nearby are moving ({props.otherVehiclesObserved} observed), so this looks
            specific to this vehicle.
          </p>
        ) : (
          <p>
            Other buses nearby are also stationary ({props.otherVehiclesObserved} observed), which
            usually means traffic rather than a problem with this bus.
          </p>
        )}
      </div>

      <div className="bus-stopped__block">
        <h3>What could explain it</h3>
        <ul className="bus-stopped__states">
          {assessment.plausibleStates.map((state) => (
            <li key={state.explanation}>
              <div className="bus-stopped__state-label">
                <span>{state.label}</span>
                <StateLozenge tone={state.official ? "info" : "neutral"}>
                  {state.official ? "Official evidence" : "Possible"}
                </StateLozenge>
              </div>
              <p>{state.supportedBy}</p>
            </li>
          ))}
        </ul>
      </div>

      <div className="bus-stopped__block">
        <h3>What you can do now</h3>
        {!contextKnown ? (
          <EmptyState
            title={
              contextState === "loading"
                ? "Looking for another way on"
                : "We could not look up other departures"
            }
            description={
              contextState === "loading"
                ? "Reading the board at the stop this bus is heading for."
                : "The departure board and the stops nearby could not be read just now, so we cannot say whether there is another service."
            }
          />
        ) : props.nextServices.length > 0 ? (
          <ul className="bus-stopped__services">
            {props.nextServices.slice(0, 3).map((service) => (
              <li key={`${service.routeName}-${service.expectedTime}`}>
                <strong>{service.routeName}</strong> to {service.destination} at{" "}
                <time dateTime={service.expectedTime}>
                  {formatLondonTime(new Date(service.expectedTime))}
                </time>{" "}
                <StateLozenge tone={service.live ? "live" : "neutral"}>
                  {service.live ? "Live" : "Timetable"}
                </StateLozenge>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No other departures to suggest"
            description="We do not have another useful service at this stop right now."
          />
        )}

        {contextState === "unavailable" && props.onRetryContext ? (
          <p>
            <button type="button" className="bus-stopped__retry" onClick={props.onRetryContext}>
              Try again
            </button>
          </p>
        ) : null}

        {contextKnown && props.alternativeStop ? (
          <p>
            <Link to={`/stops/${props.alternativeStop.id}`}>{props.alternativeStop.name}</Link> is
            about {props.alternativeStop.walkingMinutes} minutes' walk and may be served sooner.
          </p>
        ) : null}

        {contextKnown && props.walkingUrl ? (
          <p>
            <a href={props.walkingUrl} rel="noreferrer noopener" target="_blank">
              Open walking directions
            </a>
          </p>
        ) : null}

        {props.operatorContactUrl && props.operatorName ? (
          <p>
            <a href={props.operatorContactUrl} rel="noreferrer noopener" target="_blank">
              {props.operatorName} travel information
            </a>
          </p>
        ) : null}

        {/*
          Last, and the one thing this panel could not do: give up on the bus.
          <br />
          The stop page's own help has offered "plan a different journey from this stop" for a
          while; this panel, which is the page somebody reaches by tapping a bus that is not
          moving, offered a board, a neighbour and a phone number but no way to find another way
          home. The planner needs a starting point and the alternative stop is the best one we
          have — it is a real stop, it is walkable, and the passenger is being pointed at it
          anyway. Where there is no alternative stop there is nothing honest to put in the link,
          so it is not shown.
        */}
        {contextKnown && props.alternativeStop ? (
          <p>
            <Link
              to={
                `/journey?fromLat=${props.alternativeStop.lat.toFixed(5)}` +
                `&fromLon=${props.alternativeStop.lon.toFixed(5)}` +
                `&fromLabel=${encodeURIComponent(props.alternativeStop.name)}`
              }
            >
              Plan a different journey from {props.alternativeStop.name}
            </Link>
          </p>
        ) : null}
      </div>

      <p className="bus-stopped__note">{ACCESSIBILITY_NOTE}</p>
      <p className="bus-stopped__emergency">{EMERGENCY_GUIDANCE}</p>
    </section>
  );
}
