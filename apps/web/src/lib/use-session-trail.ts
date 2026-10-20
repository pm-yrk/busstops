import { useState } from "react";
import type { MapVehicleSummary } from "@busstops/contracts";
import type { TraceObservation } from "./vehicle-trail.js";

/**
 * The trail a passenger builds simply by watching.
 *
 * The server's `recentTrace` is good and it is not enough. A collection run takes three snapshots
 * two minutes apart and this project's schedules are delivered roughly four times a day, so for
 * most of the day a bucket is either empty or older than the thirty-minute window — which means a
 * passenger tapping a bus mostly sees no trail at all. That is honest but it is not the feature.
 *
 * So the map keeps what it is already being told. `/v1/map` refreshes every twenty seconds and
 * every response carries the selected bus's current position; holding on to those while the bus
 * stays selected produces a trail that starts empty and fills in as somebody watches, with no extra
 * request of any kind. The two sources merge: server history covers before the page was opened, the
 * session covers since.
 *
 * ## What this deliberately is not
 *
 * In memory, for as long as one bus is selected, and nowhere else. Not `localStorage`, not
 * `sessionStorage`, not a cookie, not a request body — a reload starts again from nothing, and
 * selecting a different bus discards the previous one's points rather than accumulating a
 * collection of buses somebody once looked at. It uses the same daily-rotating reference everything
 * else does, so it cannot follow a vehicle into tomorrow, and it never polls faster than the map
 * already does.
 *
 * ## Why this is state adjusted during render, and not an effect
 *
 * The points are derived from props — the latest map response — rather than subscribed from an
 * external system, and React's documented shape for that is to adjust state during render when the
 * props it depends on have changed. The first version accumulated into a ref and mutated it while
 * rendering, which happens to work today and is exactly what breaks under concurrent rendering: a
 * render that React discards would still have appended its point. `react-hooks` says so and it is
 * right.
 */

/** Roughly half an hour, matching the server trail's window so the merged line is one age. */
const MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Enough for half an hour of twenty-second refreshes with room to spare.
 *
 * A bound rather than a target: the segmentation drops jitter, so a bus standing at a terminus
 * contributes almost nothing and a moving bus contributes a point per refresh.
 */
const MAX_POINTS = 120;

interface SessionTrail {
  /** Which bus these belong to, so a stale set can never be shown under a new selection. */
  ref: string | null;
  points: TraceObservation[];
  /** The newest moment already recorded, so one reading is not kept twice. */
  lastAt: string | null;
}

const EMPTY: SessionTrail = { ref: null, points: [], lastAt: null };

/**
 * When the feed saw this bus, rather than when we received the response.
 *
 * `MapVehicleSummary` carries `freshnessSeconds` and no timestamp, and the response's own
 * `observedAt` is the newest reading across the whole viewport — so a bus whose position is a
 * minute stale would be recorded as being somewhere it had already left. The per-vehicle freshness
 * is the only thing that places this particular bus in time.
 *
 * Null when the response has no `observedAt`: without it there is no honest clock to place the
 * position on, and `Date.now()` is both a guess and an impure call in a render pass. A response
 * that cannot say when it saw something contributes nothing to a trail.
 */
function momentFor(vehicle: MapVehicleSummary, observedAt: string | null): string | null {
  if (observedAt === null) return null;
  const anchor = Date.parse(observedAt);
  if (!Number.isFinite(anchor)) return null;
  return new Date(anchor - vehicle.freshnessSeconds * 1000).toISOString();
}

export function useSessionTrail(
  vehicleRef: string | null,
  vehicles: readonly MapVehicleSummary[],
  observedAt: string | null,
): TraceObservation[] {
  const [trail, setTrail] = useState<SessionTrail>(EMPTY);

  if (trail.ref !== vehicleRef) {
    /*
     * A different bus, or none. Cleared immediately rather than on the next effect, so the array
     * handed to the renderer is never the previous bus's path under the new bus's number.
     */
    setTrail(vehicleRef === null ? EMPTY : { ref: vehicleRef, points: [], lastAt: null });
    return [];
  }

  if (vehicleRef !== null) {
    const seen = vehicles.find((vehicle) => vehicle.vehicleRef === vehicleRef);
    const at = seen ? momentFor(seen, observedAt) : null;
    /* The same reading again, which is what a refresh returns when the feed has not moved on. */
    if (seen && at !== null && at !== trail.lastAt) {
      /*
       * Aged against the data's own clock rather than the wall's.
       *
       * `Date.now()` in a render pass is an impure call — React's lint rule says so and is right —
       * and it is also the wrong clock: the points are stamped from the feed's `observedAt`, so
       * expiring them against anything else mixes two timebases for no benefit.
       */
      const cutoff = Date.parse(at) - MAX_AGE_MS;
      const points = [...trail.points, { coordinate: seen.coordinate, observedAt: at }]
        .filter((point) => Date.parse(point.observedAt) >= cutoff)
        .slice(-MAX_POINTS);
      setTrail({ ref: vehicleRef, points, lastAt: at });
      return points;
    }
  }

  return trail.points;
}
