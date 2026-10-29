import { describe, expect, it } from "vitest";
import {
  buildGraph,
  callCount,
  departureAt,
  effectiveStopTimes,
  groupRoutes,
  stopIdAt,
  type JourneyStop,
  type Trip,
  type TripCallSource,
} from "./graph.js";
import { plan } from "./planner.js";

/**
 * A trip read in place must be the same trip.
 *
 * The published shard holds a tile's departures and arrivals as typed arrays, and the planner used
 * to turn every call of every trip into `{ stopId, arrivalSeconds, departureSeconds }` before it
 * could search them — four hundred thousand objects for a Manchester corridor, to express numbers
 * that were already integers. A trip now carries a window into those arrays instead.
 *
 * That is only worth having if it is the *same answer*. So every timetable here is built twice over
 * identical numbers — once as objects, once as windows — and the two are required to produce the
 * same grouping and the same itinerary, field for field. The shapes that make this hard are the
 * ones the generator produces on purpose: trips cut short, several patterns, expresses that
 * overtake, ties on the first departure, live delays, cancellations, and corridors that drop a
 * stop from the middle of a sequence.
 */

const MIN = 60;
const DEPART_AT = 8 * 3600;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Generated {
  /** Stops, laid out along a line so that walking transfers exist between neighbours. */
  stops: JourneyStop[];
  /** One row per trip: the pattern it runs, its calls' positions, and its times. */
  rows: Array<{
    id: string;
    pattern: number;
    sequence: string[];
    /** Positions in `sequence` this trip calls at, which a cut makes non-contiguous. */
    positions: number[];
    departures: number[];
    arrivals: number[];
    delaySeconds?: number;
    cancelled?: boolean;
  }>;
}

function timetable(seed: number): Generated {
  const random = mulberry32(seed);
  const stops: JourneyStop[] = [];
  const rows: Generated["rows"] = [];
  const patterns = 2 + Math.floor(random() * 4);

  for (let p = 0; p < patterns; p += 1) {
    const length = 4 + Math.floor(random() * 5);
    const sequence: string[] = [];
    for (let at = 0; at < length; at += 1) {
      const id = `p${String(p)}-s${String(at)}`;
      sequence.push(id);
      stops.push({
        id,
        name: `Stop ${id}`,
        /* A few hundred metres apart along one line, so a transfer is plausible. */
        coordinate: { lat: 53.8 + at * 0.003, lon: -1.55 + p * 0.004 },
      });
    }

    const tripCount = 2 + Math.floor(random() * 6);
    const headway = (3 + Math.floor(random() * 10)) * MIN;
    const first = DEPART_AT + Math.floor(random() * 10) * MIN;
    for (let t = 0; t < tripCount; t += 1) {
      /* One in five runs fast enough to overtake the one in front. */
      const hop = random() < 0.2 ? 1 * MIN : (3 + Math.floor(random() * 5)) * MIN;
      /* One in six is cut short: a different sequence on the same pattern. */
      const calls = random() < 0.167 ? Math.max(2, length - 1 - Math.floor(random() * 2)) : length;
      /* One in eight departs at exactly the same minute as the trip before it. */
      const tie = random() < 0.125 && t > 0;
      let clock = first + (tie ? t - 1 : t) * headway;

      const positions: number[] = [];
      const departures: number[] = [];
      const arrivals: number[] = [];
      for (let at = 0; at < calls; at += 1) {
        if (at > 0) clock += hop;
        positions.push(at);
        departures.push(clock);
        /* One in four waits somewhere, so the arrival is its own number. */
        arrivals.push(random() < 0.25 && at > 0 ? clock - 60 : clock);
      }

      const delayed = random() < 0.2;
      rows.push({
        id: `s${String(seed)}-p${String(p)}-t${String(t)}`,
        pattern: p,
        sequence,
        positions,
        departures,
        arrivals,
        ...(delayed ? { delaySeconds: Math.floor(random() * 6) * 60 } : {}),
        ...(random() < 0.08 ? { cancelled: true } : {}),
      });
    }
  }
  return { stops, rows };
}

/** The same rows as trips carrying objects, which is what the planner used to be handed. */
function asObjects(generated: Generated): Trip[] {
  return generated.rows.map((row) => ({
    id: row.id,
    routeId: `route-${String(row.pattern)}`,
    patternId: `pattern-${String(row.pattern)}`,
    routeName: `R${String(row.pattern)}`,
    headsign: "Test",
    ...(row.delaySeconds === undefined ? {} : { delaySeconds: row.delaySeconds }),
    ...(row.cancelled === undefined ? {} : { cancelled: row.cancelled }),
    wholePatternSequence: row.positions.length === row.sequence.length,
    stopTimes: row.positions.map((at, call) => ({
      stopId: row.sequence[at]!,
      arrivalSeconds: row.arrivals[call]!,
      departureSeconds: row.departures[call]!,
    })),
  }));
}

/** And as windows into typed arrays, which is what a published shard hands it. */
function asColumnar(generated: Generated): Trip[] {
  /*
   * One source over every row, as a shard is one source over every trip in a tile — and indexed
   * by **position in the pattern's sequence**, which is how a published row is laid out: `t[at]`
   * pairs with `sequence[at]`. Writing the fixture the other way round, compacted by call, is
   * what first made this test fail: a trip missing the third stop of its pattern had every later
   * time shifted one stop earlier, and the overtaking split then put it in a route of its own.
   */
  const departures = generated.rows.map((row) => {
    const times = new Int32Array(row.sequence.length);
    row.positions.forEach((at, call) => (times[at] = row.departures[call]!));
    return times;
  });
  const arrivals = generated.rows.map((row) => {
    const times = new Int32Array(row.sequence.length);
    row.positions.forEach((at, call) => (times[at] = row.arrivals[call]!));
    return times;
  });
  const source: TripCallSource = {
    departure: (trip, call) => departures[trip]![call]!,
    arrival: (trip, call) => arrivals[trip]![call]!,
  };

  return generated.rows.map((row, trip) => {
    const contiguous =
      row.positions.length === row.sequence.length &&
      row.positions.every((at, call) => at === call);
    return {
      id: row.id,
      routeId: `route-${String(row.pattern)}`,
      patternId: `pattern-${String(row.pattern)}`,
      routeName: `R${String(row.pattern)}`,
      headsign: "Test",
      ...(row.delaySeconds === undefined ? {} : { delaySeconds: row.delaySeconds }),
      ...(row.cancelled === undefined ? {} : { cancelled: row.cancelled }),
      wholePatternSequence: row.positions.length === row.sequence.length,
      calls: {
        source,
        trip,
        sequence: row.sequence,
        /* Null is the cheap read: no positions array, index the sequence directly. */
        kept: contiguous ? null : Uint16Array.from(row.positions),
        count: row.positions.length,
        /* The source already holds seconds of the service day in this fixture. */
        dayStartSeconds: 0,
      },
    };
  });
}

/** A route grouping as a comparable shape: the sequence, and the trips on it in order. */
const shapeOf = (trips: readonly Trip[]): string[] =>
  groupRoutes(trips)
    .routes.map(
      (route) => `${route.stopIds.join(">")}|${route.trips.map((trip) => trip.id).join(",")}`,
    )
    .sort();

describe("a trip read in place against the same trip as objects", () => {
  const seeds = Array.from({ length: 40 }, (_, at) => at + 1);

  it("reads the same times, stop for stop", () => {
    for (const seed of seeds) {
      const generated = timetable(seed);
      const objects = asObjects(generated);
      const columnar = asColumnar(generated);
      for (let at = 0; at < objects.length; at += 1) {
        const left = objects[at]!;
        const right = columnar[at]!;
        expect(callCount(right), `seed ${String(seed)} trip ${right.id}`).toBe(callCount(left));
        for (let call = 0; call < callCount(left); call += 1) {
          expect(stopIdAt(right, call)).toBe(stopIdAt(left, call));
          expect(departureAt(right, call)).toBe(departureAt(left, call));
        }
        /* And materialising it, for the callers that genuinely need objects, agrees too. */
        expect(effectiveStopTimes(right)).toEqual(effectiveStopTimes(left));
      }
    }
  });

  it("groups into the same routes, in the same order", () => {
    for (const seed of seeds) {
      const generated = timetable(seed);
      expect(shapeOf(asColumnar(generated)), `seed ${String(seed)}`).toEqual(
        shapeOf(asObjects(generated)),
      );
    }
  });

  it("plans the same itinerary", () => {
    let planned = 0;
    for (const seed of seeds) {
      const generated = timetable(seed);
      const from = generated.stops[0]!;
      const to = generated.stops[generated.stops.length - 1]!;
      const query = {
        origin: from.coordinate,
        destination: to.coordinate,
        departAtSeconds: DEPART_AT,
      };
      const left = plan(buildGraph({ stops: generated.stops, trips: asObjects(generated) }), query);
      const right = plan(
        buildGraph({ stops: generated.stops, trips: asColumnar(generated) }),
        query,
      );
      expect(JSON.stringify(right), `seed ${String(seed)}`).toBe(JSON.stringify(left));
      if (left.options.length > 0) planned += 1;
    }
    /* A comparison over forty empty answers would prove nothing. */
    expect(planned, "seeds that produced an itinerary at all").toBeGreaterThan(10);
  });

  it("keeps a corridor that cut a stop out of the middle of a sequence", () => {
    /*
     * The case `kept` exists for. A corridor drops stops outside its box, and those can be in the
     * middle of a pattern — so the kept positions are not a prefix, and a reader that assumed they
     * were would put the bus at the wrong stop rather than at no stop.
     */
    const generated = timetable(7);
    for (const row of generated.rows) {
      if (row.positions.length < 4) continue;
      row.positions.splice(2, 1);
      row.departures.splice(2, 1);
      row.arrivals.splice(2, 1);
    }
    const objects = asObjects(generated);
    const columnar = asColumnar(generated);
    expect(columnar.some((trip) => trip.calls?.kept !== null)).toBe(true);
    expect(shapeOf(columnar)).toEqual(shapeOf(objects));
    for (let at = 0; at < objects.length; at += 1) {
      expect(effectiveStopTimes(columnar[at]!)).toEqual(effectiveStopTimes(objects[at]!));
    }
  });
});
