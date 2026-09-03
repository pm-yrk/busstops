import type { Incident, VehicleState } from "@busstops/contracts";

/**
 * "Bus Stopped?" recovery help (docs/03_SITE_MAP_AND_UX.md, docs/09_BUS_STOPS_LIVE.md).
 *
 * The central rule: a stationary marker is ambiguous. It may be a terminus, a layover,
 * congestion, a stale feed, a GPS problem or a stopped service. This module enumerates the
 * plausible states with what supports each, and never asserts a breakdown or cancellation
 * without official evidence.
 */

export type StoppedExplanation =
  | "terminus_or_layover"
  | "congestion"
  | "stale_feed"
  | "gps_problem"
  | "official_incident"
  | "service_stopped";

export interface PlausibleState {
  explanation: StoppedExplanation;
  label: string;
  supportedBy: string;
  /** Whether official evidence supports this, as opposed to it merely being possible. */
  official: boolean;
}

export interface BusStoppedInput {
  vehicle: VehicleState | null;
  /** Whether other vehicles nearby are moving, which distinguishes congestion from a single stop. */
  otherVehiclesMoving: boolean | null;
  otherVehiclesObserved: number;
  incidents: readonly Incident[];
  /** True when the vehicle is at or near the last stop of its pattern. */
  nearEndOfRoute: boolean;
  now: Date;
}

export interface BusStoppedAssessment {
  /** Deliberately never a single cause: the user sees the candidates and the evidence. */
  plausibleStates: PlausibleState[];
  /** When the vehicle was last observed, as an ISO instant. Null when nothing is known. */
  lastReliableObservationAt: string | null;
  freshnessSeconds: number | null;
  /** A suggestion to open the panel, not an automatic claim that something is wrong. */
  suggestPanel: boolean;
  summary: string;
}

export const STATIONARY_SUGGESTION_SECONDS = 240;
export const STALE_FEED_SECONDS = 180;

export function assessBusStopped(input: BusStoppedInput): BusStoppedAssessment {
  const states: PlausibleState[] = [];
  const vehicle = input.vehicle;
  const freshnessSeconds = vehicle?.freshnessSeconds ?? null;

  if (freshnessSeconds !== null && freshnessSeconds > STALE_FEED_SECONDS) {
    states.push({
      explanation: "stale_feed",
      label: "The feed may simply be behind",
      supportedBy: `The last position we have is ${Math.round(freshnessSeconds / 60)} minutes old, so the bus may have moved since.`,
      official: false,
    });
  }

  if (input.nearEndOfRoute) {
    states.push({
      explanation: "terminus_or_layover",
      label: "It may be waiting at a terminus or on a layover",
      supportedBy: "The vehicle is at or near the end of its route, where buses normally wait.",
      official: false,
    });
  }

  if (input.otherVehiclesMoving === false && input.otherVehiclesObserved > 0) {
    states.push({
      explanation: "congestion",
      label: "Traffic in the area may be holding it up",
      supportedBy: `${input.otherVehiclesObserved} other ${input.otherVehiclesObserved === 1 ? "bus is" : "buses are"} also stationary nearby.`,
      official: false,
    });
  }

  const officialIncident = input.incidents.find(
    (incident) => incident.officialStatus === "official",
  );
  if (officialIncident) {
    states.push({
      explanation: "official_incident",
      label: "There is an official incident nearby",
      supportedBy: officialIncident.narrative,
      official: true,
    });
  }

  if (input.otherVehiclesMoving === true) {
    states.push({
      explanation: "service_stopped",
      label: "This bus may have stopped while others keep moving",
      // Deliberately not "has broken down" or "is cancelled": nothing here shows that.
      supportedBy:
        "Other buses nearby are moving, so this looks specific to this vehicle. We cannot tell why from the data available.",
      official: false,
    });
  }

  if (states.length === 0) {
    states.push({
      explanation: "gps_problem",
      label: "The position may be unreliable",
      supportedBy: "We do not have enough recent, good-quality positions to say what is happening.",
      official: false,
    });
  }

  const stationaryLongEnough =
    vehicle?.motionState === "stationary" &&
    freshnessSeconds !== null &&
    freshnessSeconds >= STATIONARY_SUGGESTION_SECONDS;

  const confidenceCollapsed = vehicle?.matchConfidence.level === "low";

  return {
    plausibleStates: states,
    // Derived from the observation's age, because VehicleState carries freshness rather than an
    // absolute timestamp. The panel shows a time, so it needs one.
    lastReliableObservationAt:
      vehicle && freshnessSeconds !== null
        ? new Date(input.now.getTime() - freshnessSeconds * 1000).toISOString()
        : null,
    freshnessSeconds,
    suggestPanel: Boolean(stationaryLongEnough || confidenceCollapsed),
    summary:
      states.length === 1
        ? states[0]!.label
        : `${states.length} things could explain this. Here is what we can actually see.`,
  };
}

/** Emergency guidance is deliberately fixed, minimal and non-medical. */
export const EMERGENCY_GUIDANCE =
  "If you are in immediate danger, contact the emergency services on 999.";

/** Accessibility and safety note shown alongside alternatives, without collecting any status. */
export const ACCESSIBILITY_NOTE =
  "Some alternatives may involve a longer walk or a stop without a shelter. Check the walking route before setting off.";
