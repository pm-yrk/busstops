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

export interface BusStoppedPanelProps extends BusStoppedInput {
  /** Next departures at the stop the user is waiting at, already filtered to useful ones. */
  nextServices: ReadonlyArray<{
    routeName: string;
    destination: string;
    expectedTime: string;
    live: boolean;
  }>;
  alternativeStop: { id: string; name: string; walkingMinutes: number } | null;
  walkingUrl: string | null;
  operatorContactUrl: string | null;
  operatorName: string | null;
  onDismiss?: () => void;
}

export function BusStoppedPanel(props: BusStoppedPanelProps) {
  const assessment = assessBusStopped(props);

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

        {props.otherVehiclesMoving === null ? (
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
        {props.nextServices.length > 0 ? (
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

        {props.alternativeStop ? (
          <p>
            <Link to={`/stops/${props.alternativeStop.id}`}>{props.alternativeStop.name}</Link> is
            about {props.alternativeStop.walkingMinutes} minutes' walk and may be served sooner.
          </p>
        ) : null}

        {props.walkingUrl ? (
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
      </div>

      <p className="bus-stopped__note">{ACCESSIBILITY_NOTE}</p>
      <p className="bus-stopped__emergency">{EMERGENCY_GUIDANCE}</p>
    </section>
  );
}
