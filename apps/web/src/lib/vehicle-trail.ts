import { haversineMetresBrowser, type LatLon } from "./geo.js";

/**
 * Turning a list of observations into a line that does not lie.
 *
 * A live feed is not a GPS track. It arrives out of order, it repeats itself, it reports the depot
 * when a unit reboots, and it goes quiet for ten minutes in a tunnel or behind a failed poll. Join
 * all of that up with one confident polyline and you draw a bus straight across the middle of
 * Leeds through buildings it was never near — which is worse than drawing nothing, because the
 * line looks like evidence.
 *
 * So the trail is *segments*. A gap in time or an impossible jump in space ends one run and starts
 * another, and the map draws each run separately: the passenger sees where the bus has been and a
 * visible break where we stopped knowing.
 *
 * This is deliberately not a map-matching or smoothing exercise. It is the minimum that makes an
 * observed path honest, and it runs in the browser on at most a few dozen points.
 */

export interface TraceObservation {
  coordinate: LatLon;
  observedAt: string;
}

/**
 * Faster than a bus, slow enough to be a real bus on a dual carriageway.
 *
 * 30 m/s is 108 km/h. A city bus does not sustain it; a coach on a motorway can touch it. Anything
 * implying more than this between two observations is a jump rather than a journey — a reboot
 * reporting a depot, a mis-parsed coordinate, or two different vehicles sharing a reference — and
 * the line breaks there.
 */
const MAX_PLAUSIBLE_SPEED_METRES_PER_SECOND = 30;

/**
 * Two observations more than this far apart in time are not a path between each other.
 *
 * The collector polls every couple of minutes at best, and a bus covers a lot of ground in four
 * minutes of silence. Drawing a straight line across that gap claims a route through streets we
 * never saw it on; a break says "we lost it here", which is true.
 */
const MAX_GAP_SECONDS = 240;

/** England, generously. A coordinate outside this is not a bus in this product. */
function isPlausibleCoordinate(point: LatLon): boolean {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return false;
  if (point.lat === 0 && point.lon === 0) return false;
  return point.lat > 49 && point.lat < 61 && point.lon > -9 && point.lon < 3;
}

/**
 * Jitter small enough to be the same place.
 *
 * A stationary bus reports a position that wanders a few metres as satellites come and go, and
 * every one of those is a vertex in the drawn line. Ten metres is below the width of a bus stop and
 * well under the length of the vehicle.
 */
const MIN_SEPARATION_METRES = 10;

/**
 * Observations in, drawable runs out.
 *
 * Ordered by the source's own timestamp rather than by arrival, deduplicated, filtered for
 * coordinates that cannot be real, thinned of jitter, and split wherever the next point cannot
 * honestly be joined to the last. Runs of a single point are dropped: one position is a position,
 * not a path, and the bus marker already shows it.
 */
export function traceSegments(
  observations: readonly TraceObservation[],
  options: { maxPoints?: number } = {},
): LatLon[][] {
  const maxPoints = options.maxPoints ?? 60;

  const usable = observations
    .filter((entry) => isPlausibleCoordinate(entry.coordinate))
    .map((entry) => ({ ...entry, at: Date.parse(entry.observedAt) }))
    .filter((entry) => Number.isFinite(entry.at))
    /* By the source's clock. Arrival order is our network's accident, not the bus's history. */
    .sort((a, b) => a.at - b.at);

  /*
   * Deduplicated on the timestamp, which is the identity of an observation: the same reading
   * delivered twice is one moment, and keeping both puts a zero-length segment in the line.
   */
  const seen = new Set<number>();
  const unique = usable.filter((entry) => {
    if (seen.has(entry.at)) return false;
    seen.add(entry.at);
    return true;
  });

  /* Newest first matters most, so the cap drops the oldest rather than the most recent. */
  const bounded = unique.slice(-maxPoints);

  const runs: LatLon[][] = [];
  let run: LatLon[] = [];
  let previous: (typeof bounded)[number] | null = null;

  for (const entry of bounded) {
    if (previous === null) {
      run = [entry.coordinate];
      previous = entry;
      continue;
    }

    const seconds = (entry.at - previous.at) / 1000;
    const metres = haversineMetresBrowser(previous.coordinate, entry.coordinate);

    if (metres < MIN_SEPARATION_METRES) {
      /*
       * The same place. Skipped rather than ending the run: a bus waiting at a stand is still the
       * same journey, and breaking the line there would litter the map with gaps that mean nothing.
       * `previous` is deliberately not advanced, so a long wait cannot creep away a metre at a time.
       */
      continue;
    }

    const tooLate = seconds > MAX_GAP_SECONDS;
    const tooFast = seconds > 0 && metres / seconds > MAX_PLAUSIBLE_SPEED_METRES_PER_SECOND;
    /* Same instant, different place: one of the two is wrong, and we cannot tell which. */
    const impossible = seconds <= 0;

    if (tooLate || tooFast || impossible) {
      if (run.length > 1) runs.push(run);
      run = [entry.coordinate];
      previous = entry;
      continue;
    }

    run.push(entry.coordinate);
    previous = entry;
  }

  if (run.length > 1) runs.push(run);
  return runs;
}
