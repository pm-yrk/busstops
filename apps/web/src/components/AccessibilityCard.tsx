import { useState } from "react";
import type {
  AccessibilityFact,
  AccessibilitySource,
  AccessibilityStatus,
  StopAccessibility,
} from "@busstops/contracts";
import "./AccessibilityCard.css";

/**
 * Accessibility at this stop, as facts with sources.
 *
 * Three decisions are load-bearing here, and all three are about not lying:
 *
 *   1. There is no score. A number that averages a bench against a step-free approach hides the
 *      one fact that decides whether the journey is possible.
 *   2. "Not recorded" is shown, not hidden. A passenger who cannot see whether there is a dropped
 *      kerb needs to know nobody has recorded one — otherwise an empty card reads as "fine".
 *   3. The stop and the bus are separate headings, because a step-free stop served by a bus with
 *      no ramp is not an accessible journey, and neither is the reverse.
 */

const FACT_LABEL: Record<string, string> = {
  wheelchair_boarding: "Wheelchair boarding",
  step_free: "Step-free access",
  tactile_paving: "Tactile paving",
  kerb: "Kerb",
  raised_kerb: "Raised kerb",
  surface: "Footway surface",
  shelter: "Shelter",
  covered: "Covered",
  seating: "Seating",
  lighting: "Lighting",
  real_time_display: "Departure display",
  audible_information: "Audible information",
  visual_information: "Visual information",
  assistance_available: "Staff assistance",
  wheelchair_accessible_service: "Wheelchair accessible bus",
};

const STATUS_LABEL: Record<AccessibilityStatus, string> = {
  yes: "Yes",
  no: "No",
  partial: "Partly",
  unknown: "Not recorded",
};

const SOURCE_LABEL: Record<AccessibilitySource, string> = {
  naptan: "NaPTAN, the national stop register",
  gtfs_stop: "the operator's timetable feed",
  gtfs_trip: "the operator's timetable feed",
  osm: "OpenStreetMap",
  tfl: "Transport for London",
  operator: "the operator",
};

/** Facts about the stop itself, in the order somebody planning a journey would want them. */
const STOP_ORDER = [
  "wheelchair_boarding",
  "step_free",
  "kerb",
  "raised_kerb",
  "tactile_paving",
  "surface",
  "shelter",
  "covered",
  "seating",
  "lighting",
  "real_time_display",
  "audible_information",
  "visual_information",
  "assistance_available",
];

const VEHICLE_KEYS = new Set(["wheelchair_accessible_service"]);

function FactRow({ fact }: { fact: AccessibilityFact }) {
  return (
    <li className={`a11y-fact a11y-fact--${fact.status}`}>
      <div className="a11y-fact__head">
        <span className="a11y-fact__label">{FACT_LABEL[fact.key] ?? fact.key}</span>
        <span className={`a11y-fact__status a11y-fact__status--${fact.status}`}>
          {STATUS_LABEL[fact.status]}
        </span>
      </div>
      {fact.detail ? <p className="a11y-fact__detail">{fact.detail}</p> : null}
      <p className="a11y-fact__source small muted">
        {SOURCE_LABEL[fact.source]}
        {fact.confidence === "medium" ? " (matched by position, not by identity)" : ""}
        {fact.sourceUpdatedAt
          ? `, updated ${new Date(fact.sourceUpdatedAt).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}`
          : ""}
      </p>
    </li>
  );
}

export interface AccessibilityCardProps {
  accessibility: StopAccessibility;
  /** Facts about the vehicles serving this stop, where a source has published any. */
  serviceFacts?: readonly AccessibilityFact[];
}

export function AccessibilityCard({ accessibility, serviceFacts = [] }: AccessibilityCardProps) {
  const [showUnknown, setShowUnknown] = useState(false);

  // Highest-priority fact per key: the merge already sorted them, so the first wins.
  const best = new Map<string, AccessibilityFact>();
  for (const fact of accessibility.facts) {
    if (VEHICLE_KEYS.has(fact.key)) continue;
    if (!best.has(fact.key)) best.set(fact.key, fact);
  }

  const ordered = STOP_ORDER.map((key) => best.get(key)).filter(
    (fact): fact is AccessibilityFact => fact !== undefined,
  );
  const known = ordered.filter((fact) => fact.status !== "unknown");
  const unknown = ordered.filter((fact) => fact.status === "unknown");
  const notRecorded = STOP_ORDER.filter((key) => !best.has(key));

  const notAvailable = accessibility.sourcesConsulted.filter(
    (source) => source.outcome === "not_available",
  );

  return (
    <section className="a11y-card" aria-labelledby="accessibility-heading">
      <header className="a11y-card__header">
        <h2 id="accessibility-heading">Accessibility at this stop</h2>
        <p className="muted small">
          What each source has published. Nothing here is assumed: a fact nobody has recorded is
          shown as not recorded, never as absent.
        </p>
      </header>

      {known.length > 0 ? (
        <ul className="a11y-card__facts">
          {known.map((fact) => (
            <FactRow key={`${fact.key}-${fact.source}`} fact={fact} />
          ))}
        </ul>
      ) : (
        <p className="a11y-card__empty">
          No source has published an accessibility fact about this stop. That is not the same as the
          stop being inaccessible — it means nobody has recorded it.
        </p>
      )}

      {unknown.length + notRecorded.length > 0 ? (
        <div className="a11y-card__unknown">
          <button
            type="button"
            className="a11y-card__toggle"
            aria-expanded={showUnknown}
            onClick={() => setShowUnknown((open) => !open)}
          >
            {showUnknown ? "Hide" : "Show"} what has not been recorded (
            {unknown.length + notRecorded.length})
          </button>
          {showUnknown ? (
            <>
              {unknown.length > 0 ? (
                <ul className="a11y-card__facts">
                  {unknown.map((fact) => (
                    <FactRow key={`${fact.key}-${fact.source}`} fact={fact} />
                  ))}
                </ul>
              ) : null}
              {notRecorded.length > 0 ? (
                <p className="small muted">
                  No source has said anything about:{" "}
                  {notRecorded.map((key) => FACT_LABEL[key] ?? key).join(", ")}.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <section className="a11y-card__vehicle" aria-labelledby="vehicle-accessibility-heading">
        <h3 id="vehicle-accessibility-heading">The buses that call here</h3>
        {serviceFacts.length > 0 ? (
          <ul className="a11y-card__facts">
            {serviceFacts.map((fact) => (
              <FactRow key={`${fact.key}-${fact.source}`} fact={fact} />
            ))}
          </ul>
        ) : (
          <p className="small muted">
            Whether a bus is wheelchair accessible is a fact about the vehicle, not about this stop,
            and no operator has published it for these services.
          </p>
        )}
      </section>

      {notAvailable.length > 0 ? (
        <p className="a11y-card__sources small muted">
          Not yet consulted on this deployment:{" "}
          {notAvailable.map((source) => SOURCE_LABEL[source.source]).join(", ")}.
        </p>
      ) : null}
    </section>
  );
}
