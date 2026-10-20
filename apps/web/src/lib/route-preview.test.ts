import { describe, expect, it } from "vitest";
import { boundsOfPath, haversineMetresBrowser, splitShapeAtProgress } from "./geo.js";
import { traceSegments } from "./vehicle-trail.js";

/**
 * The two pieces of geometry behind the selected-bus preview.
 *
 * Both are pure, which is the point: jsdom has no WebGL, so a component test of the canvas proves
 * nothing about whether the right line was drawn. What can be proved here is that the line is cut
 * in the right place and that an unreliable feed cannot be turned into a confident path.
 */

/** A straight northbound line, 1km between each pair: 0.009° of latitude is almost exactly 1km. */
const northbound = [
  { lat: 53.79, lon: -1.55 },
  { lat: 53.799, lon: -1.55 },
  { lat: 53.808, lon: -1.55 },
  { lat: 53.817, lon: -1.55 },
];

describe("splitting a scheduled route at the bus", () => {
  it("draws nothing for a shape that is not a line", () => {
    expect(splitShapeAtProgress([], 100)).toEqual({ travelled: [], remaining: [] });
    expect(splitShapeAtProgress([northbound[0]!], 100)).toEqual({ travelled: [], remaining: [] });
  });

  /*
   * The whole point of the feature: what is drawn as "where this bus is going" must not include
   * the streets it came down twenty minutes ago.
   */
  it("keeps only what is in front of the bus as the route ahead", () => {
    const { travelled, remaining } = splitShapeAtProgress(northbound, 1500);

    // Half way along the second segment: the remaining line starts there, not at the route's start.
    expect(remaining[0]!.lat).toBeGreaterThan(northbound[1]!.lat);
    expect(remaining[0]!.lat).toBeLessThan(northbound[2]!.lat);
    expect(remaining[remaining.length - 1]).toEqual(northbound[3]);
    // And the travelled half ends at the same point, so the two meet rather than overlap or gap.
    expect(travelled[travelled.length - 1]).toEqual(remaining[0]);
    expect(travelled[0]).toEqual(northbound[0]);
  });

  /*
   * Interpolated rather than snapped to the nearest vertex. On a long straight segment the nearest
   * vertex can be hundreds of metres from the bus, which reads as the route not reaching it.
   */
  it("meets the bus rather than the nearest vertex", () => {
    const { remaining } = splitShapeAtProgress(northbound, 1200);
    const fromStart = haversineMetresBrowser(northbound[0]!, remaining[0]!);
    expect(fromStart).toBeGreaterThan(1150);
    expect(fromStart).toBeLessThan(1250);
  });

  it("treats a bus at the start as having the whole route ahead", () => {
    const { travelled, remaining } = splitShapeAtProgress(northbound, 0);
    expect(travelled).toEqual([]);
    expect(remaining).toEqual(northbound);
  });

  /*
   * No projection is not a reason to guess a split. We know the pattern and not the position, so
   * the honest drawing is the whole pattern as route — and `nextStopsState` says why.
   */
  it("draws the whole pattern when the bus cannot be placed on it", () => {
    expect(splitShapeAtProgress(northbound, null).remaining).toEqual(northbound);
    expect(splitShapeAtProgress(northbound, Number.NaN).remaining).toEqual(northbound);
  });

  it("leaves no route ahead for a bus past the end of its shape", () => {
    const { travelled, remaining } = splitShapeAtProgress(northbound, 99_000);
    expect(travelled).toEqual(northbound);
    // A one-point line draws nothing, which is the right amount of route for a finished journey.
    expect(remaining).toEqual([]);
  });

  /*
   * A route that returns along its own outward leg. The split is by distance travelled along the
   * line, not by proximity, so the bus on the way back is placed on the way back.
   */
  it("places a bus on the return leg of a route that doubles back", () => {
    const outAndBack = [
      { lat: 53.79, lon: -1.55 },
      { lat: 53.808, lon: -1.55 },
      { lat: 53.79, lon: -1.5501 },
    ];
    const { remaining } = splitShapeAtProgress(outAndBack, 2500);
    // Past the turn, so what is left heads south again rather than north.
    expect(remaining[remaining.length - 1]!.lat).toBeLessThan(remaining[0]!.lat);
  });
});

describe("fitting a route into the viewport", () => {
  it("has nothing to fit for an empty route", () => {
    expect(boundsOfPath([])).toBeNull();
  });

  it("covers every point of the route", () => {
    const box = boundsOfPath(northbound)!;
    expect(box.south).toBeLessThanOrEqual(53.79);
    expect(box.north).toBeGreaterThanOrEqual(53.817);
    expect(box.west).toBeLessThanOrEqual(-1.55);
    expect(box.east).toBeGreaterThanOrEqual(-1.55);
  });

  /* MapLibre cannot fit a box with no area, and a route can legitimately be one point wide. */
  it("pads a degenerate route into something fittable", () => {
    const box = boundsOfPath([northbound[0]!, northbound[0]!])!;
    expect(box.east).toBeGreaterThan(box.west);
    expect(box.north).toBeGreaterThan(box.south);
  });
});

describe("the recent observed trail", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 20, 9, minutes)).toISOString();

  /** A kilometre a minute is 60 km/h: a plausible bus on a clear road. */
  const walk = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      coordinate: { lat: 53.79 + index * 0.009, lon: -1.55 },
      observedAt: at(index),
    }));

  it("draws nothing from a single observation", () => {
    // One position is a position, not a path, and the bus marker already shows it.
    expect(traceSegments(walk(1))).toEqual([]);
    expect(traceSegments([])).toEqual([]);
  });

  it("joins a steady run into one line", () => {
    const runs = traceSegments(walk(4));
    expect(runs.length).toBe(1);
    expect(runs[0]!.length).toBe(4);
  });

  it("orders by the source's own clock rather than by arrival", () => {
    const shuffled = [walk(4)[2]!, walk(4)[0]!, walk(4)[3]!, walk(4)[1]!];
    const runs = traceSegments(shuffled);
    expect(runs.length).toBe(1);
    const latitudes = runs[0]!.map((point) => point.lat);
    expect([...latitudes].sort((a, b) => a - b)).toEqual(latitudes);
  });

  it("treats the same reading delivered twice as one moment", () => {
    const points = walk(3);
    const runs = traceSegments([...points, points[1]!, points[2]!]);
    expect(runs[0]!.length).toBe(3);
  });

  it("discards coordinates that cannot be a bus in England", () => {
    const runs = traceSegments([
      ...walk(3),
      { coordinate: { lat: 0, lon: 0 }, observedAt: at(4) },
      { coordinate: { lat: Number.NaN, lon: -1.55 }, observedAt: at(5) },
    ]);
    expect(runs.length).toBe(1);
    expect(runs[0]!.length).toBe(3);
  });

  /*
   * The failure this exists to prevent: a reboot reporting a depot, or two vehicles sharing a
   * reference, drawn as a confident straight line across half a city.
   */
  it("breaks the line rather than crossing a city in a minute", () => {
    const runs = traceSegments([
      ...walk(3),
      // 60km east in sixty seconds. Not a bus.
      { coordinate: { lat: 53.808, lon: -0.6 }, observedAt: at(3) },
      { coordinate: { lat: 53.808, lon: -0.59 }, observedAt: at(4) },
    ]);
    expect(runs.length).toBe(2);
    expect(runs[0]!.length).toBe(3);
  });

  it("breaks the line where the feed went quiet", () => {
    const runs = traceSegments([
      ...walk(3),
      // Twenty minutes later, a few streets away: we did not see what it did in between.
      { coordinate: { lat: 53.82, lon: -1.55 }, observedAt: at(23) },
      { coordinate: { lat: 53.829, lon: -1.55 }, observedAt: at(24) },
    ]);
    expect(runs.length).toBe(2);
  });

  it("ignores a bus shuffling at a stand instead of littering the line", () => {
    const standing = [
      { coordinate: { lat: 53.79, lon: -1.55 }, observedAt: at(0) },
      { coordinate: { lat: 53.79002, lon: -1.55 }, observedAt: at(1) },
      { coordinate: { lat: 53.79001, lon: -1.55001 }, observedAt: at(2) },
      { coordinate: { lat: 53.799, lon: -1.55 }, observedAt: at(3) },
    ];
    const runs = traceSegments(standing);
    expect(runs.length).toBe(1);
    // Two points: where it waited, and where it got to. The jitter in between is not drawn.
    expect(runs[0]!.length).toBe(2);
  });

  it("keeps the newest points when the trail is capped", () => {
    const runs = traceSegments(walk(40), { maxPoints: 10 });
    expect(runs[0]!.length).toBe(10);
    // The oldest are dropped, not the most recent: a trail is about where it has just been.
    expect(runs[0]![runs[0]!.length - 1]!.lat).toBeCloseTo(53.79 + 39 * 0.009, 5);
  });

  /*
   * Two observations stamped with the same instant in different places: one of them is wrong and
   * we cannot tell which, so they are not joined.
   */
  it("refuses to join two places reported at the same instant", () => {
    const runs = traceSegments([
      { coordinate: { lat: 53.79, lon: -1.55 }, observedAt: at(0) },
      { coordinate: { lat: 53.799, lon: -1.55 }, observedAt: at(1) },
      { coordinate: { lat: 53.81, lon: -1.56 }, observedAt: at(1) },
    ]);
    // The duplicate timestamp is dropped as a repeat of that moment, leaving one honest run.
    expect(runs.length).toBe(1);
    expect(runs[0]!.length).toBe(2);
  });
});
