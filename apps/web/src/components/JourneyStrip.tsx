import { RouteBadge } from "./primitives.js";
import { ART } from "./pixel/sprites/generated.js";
import "./JourneyStrip.css";

/**
 * An itinerary drawn as a journey rather than described as one.
 *
 * The legs were a list of sentences — "Walk / Leeds City Bus Station → Bramhope / 09:12–09:41" —
 * which is accurate and reads like a log file. A passenger scanning a plan wants the shape first:
 * how far they walk, what they get on, where it is going, whether they change, and when they
 * arrive. So the shape is what is drawn, with the times attached to it.
 *
 * Nothing here is invented. Every name, time, route number and headsign comes from the leg the
 * planner produced; a leg with no headsign simply does not show one.
 */

export interface JourneyStripLeg {
  mode: "walk" | "bus";
  fromName: string;
  toName: string;
  routeName?: string | null;
  headsign?: string | null;
  departureLabel: string;
  arrivalLabel: string;
  minutes: number;
}

function minutesLabel(minutes: number): string {
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function JourneyStrip({ legs }: { legs: readonly JourneyStripLeg[] }) {
  if (legs.length === 0) return null;

  return (
    <ol className="journey-strip">
      {legs.map((leg, index) => {
        const isLast = index === legs.length - 1;
        /*
         * A change is where one ride ends and the next begins. The walk between them is already a
         * leg of its own, so the marker goes on the boarding point rather than being invented.
         */
        const isChange =
          leg.mode === "bus" && index > 0 && legs.slice(0, index).some((l) => l.mode === "bus");

        return (
          <li
            key={`${leg.fromName}-${leg.toName}-${index}`}
            className={`journey-strip__leg journey-strip__leg--${leg.mode}`}
          >
            <div className="journey-strip__rail" aria-hidden="true">
              <span className="journey-strip__node" />
              {isLast ? null : <span className="journey-strip__line" />}
            </div>

            <div className="journey-strip__body">
              <p className="journey-strip__place">
                {leg.fromName}
                {isChange ? <span className="journey-strip__change">Change</span> : null}
              </p>

              <div className="journey-strip__action">
                {leg.mode === "walk" ? (
                  <>
                    <img
                      className="journey-strip__art"
                      src={ART.personWaiting!.src}
                      width={ART.personWaiting!.w * 2}
                      height={ART.personWaiting!.h * 2}
                      alt=""
                    />
                    <span className="journey-strip__what">Walk {minutesLabel(leg.minutes)}</span>
                  </>
                ) : (
                  <>
                    <img
                      className="journey-strip__art journey-strip__art--bus"
                      src={ART.busMid!.src}
                      width={ART.busMid!.w * 2}
                      height={ART.busMid!.h * 2}
                      alt=""
                    />
                    <span className="journey-strip__what">
                      <RouteBadge name={leg.routeName ?? "Bus"} />
                      {leg.headsign ? (
                        <span className="journey-strip__towards">towards {leg.headsign}</span>
                      ) : null}
                      <span className="muted small">{minutesLabel(leg.minutes)} on board</span>
                    </span>
                  </>
                )}
                <time className="journey-strip__time">{leg.departureLabel}</time>
              </div>

              {isLast ? (
                <p className="journey-strip__place journey-strip__place--end">
                  {leg.toName}
                  <time className="journey-strip__time">{leg.arrivalLabel}</time>
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
