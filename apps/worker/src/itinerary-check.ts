import type { JourneyPlanLeg, JourneyPlanOption } from "@busstops/contracts";

/**
 * Whether an itinerary is a journey, as opposed to a shape that satisfies the schema.
 *
 * Run 41's planner returned three legs and the first of them could not say where it went. Nothing
 * was missing as far as the type system was concerned: the leg had a mode, two names and two
 * offsets into the service day, and it was still not something a person could act on. A count of
 * options cannot catch that, and neither can a schema that makes the interesting fields optional,
 * so the check is here — at the edge of the API, applied to what is about to be sent — and it
 * asks the questions a passenger asks.
 *
 * The rule when it fails is to drop the whole option. There is no partial repair: an itinerary
 * with a leg removed still claims a departure time and an arrival time, and those were computed
 * from the leg that is no longer in it. A plan we cannot vouch for is one we do not offer.
 */

/** The longest walk the planner will ever propose, with room for the egress walk on top. */
const MAX_WALK_MINUTES = 60;
/** Beyond this a "bus leg" is a data fault rather than a long ride. */
const MAX_RIDE_MINUTES = 240;

export interface ItineraryFault {
  /** 1-based, so it reads the way the failure was reported: "leg 1 of 3". */
  leg: number | null;
  reason: string;
}

type CheckableLeg = JourneyPlanLeg;
type CheckableOption = Pick<JourneyPlanOption, "legs" | "changeCount">;

function placed(coordinate: { lat: number; lon: number } | undefined): boolean {
  return (
    coordinate !== undefined &&
    Number.isFinite(coordinate.lat) &&
    Number.isFinite(coordinate.lon) &&
    // England, generously. A zeroed coordinate is the shape a missing one usually takes.
    coordinate.lat !== 0 &&
    coordinate.lon !== 0
  );
}

function faultsInLeg(leg: CheckableLeg, at: number, total: number): ItineraryFault[] {
  const faults: ItineraryFault[] = [];
  const where = (reason: string): ItineraryFault => ({ leg: at + 1, reason });
  void total;

  if (leg.mode !== "walk" && leg.mode !== "bus") faults.push(where(`has mode "${leg.mode}"`));
  if (!leg.fromName.trim() || !leg.toName.trim()) faults.push(where("does not name both ends"));
  if (!placed(leg.fromCoordinate) || !placed(leg.toCoordinate)) {
    faults.push(where("does not say where it goes"));
  }

  const departs = Date.parse(leg.departAtExpected);
  const arrives = Date.parse(leg.arriveAtExpected);
  if (!Number.isFinite(departs) || !Number.isFinite(arrives)) {
    faults.push(where("has unreadable times"));
    return faults;
  }
  if (arrives < departs) faults.push(where("arrives before it departs"));

  const minutes = (arrives - departs) / 60_000;
  if (leg.mode === "walk") {
    if (minutes > MAX_WALK_MINUTES) faults.push(where(`is a ${Math.round(minutes)}-minute walk`));
    return faults;
  }

  /*
   * A bus leg has to identify its bus, and by its published identifier rather than by the number
   * on the front. Several operators run a 36; a link built from the public name opens somebody
   * else's route, and a leg that cannot be opened is a leg a passenger cannot check.
   */
  if (!leg.routeId) faults.push(where("is a bus leg with no service identity"));
  if (!leg.routeName?.trim()) faults.push(where("is a bus leg with no route number"));
  if (!leg.fromStopId || !leg.toStopId) faults.push(where("is a bus leg not between two stops"));
  if (minutes > MAX_RIDE_MINUTES) faults.push(where(`is a ${Math.round(minutes)}-minute ride`));
  return faults;
}

/** Every reason this option is not offerable. Empty means it is. */
export function itineraryFaults(option: CheckableOption): ItineraryFault[] {
  const legs = option.legs;
  if (legs.length === 0) return [{ leg: null, reason: "has no legs" }];

  const faults: ItineraryFault[] = [];
  for (const [at, leg] of legs.entries()) faults.push(...faultsInLeg(leg, at, legs.length));

  for (let at = 1; at < legs.length; at += 1) {
    const previous = legs[at - 1]!;
    const leg = legs[at]!;
    const previousArrives = Date.parse(previous.arriveAtExpected);
    const departs = Date.parse(leg.departAtExpected);
    if (Number.isFinite(previousArrives) && Number.isFinite(departs) && departs < previousArrives) {
      faults.push({ leg: at + 1, reason: "departs before the previous leg arrives" });
    }
    /*
     * And it starts where the last one finished. A plan whose legs are each individually valid
     * but do not meet is the most convincing wrong answer this planner can produce: every time is
     * plausible, and the passenger is told to get on a bus in a place they were never taken to.
     */
    if (previous.toStopId && leg.fromStopId && previous.toStopId !== leg.fromStopId) {
      faults.push({ leg: at + 1, reason: "does not start where the previous leg ended" });
    }
  }

  const rides = legs.filter((leg) => leg.mode !== "walk").length;
  if (rides > 0 && option.changeCount !== Math.max(0, rides - 1)) {
    faults.push({
      leg: null,
      reason: `claims ${option.changeCount} change(s) across ${rides} ride(s)`,
    });
  }

  return faults;
}

export function isCoherentItinerary(option: CheckableOption): boolean {
  return itineraryFaults(option).length === 0;
}

/** One line naming what was wrong, for diagnostics. Never shown to a passenger. */
export function describeFaults(faults: readonly ItineraryFault[]): string {
  return faults
    .map((fault) =>
      fault.leg === null ? `option ${fault.reason}` : `leg ${fault.leg} ${fault.reason}`,
    )
    .join("; ");
}
