import { describe, expect, it } from "vitest";
import { haversineMetres } from "@busstops/pipeline-core";
import { NearestLines, tileFloorMetres } from "./nearest-lines.js";

const CENTRE = { lat: 53.4808, lon: -2.2426 };

/** The ranking this replaces: build every candidate, sort it, cut. */
function oracle(
  points: readonly { lat: number; lon: number; text: string }[],
  centre: { lat: number; lon: number },
  limit: number,
): { metres: number; text: string }[] {
  return points
    .map((point) => ({ metres: haversineMetres(centre, point), text: point.text }))
    .sort((a, b) => (a.metres === b.metres ? (a.text < b.text ? -1 : 1) : a.metres - b.metres))
    .slice(0, limit);
}

function scatter(count: number, seed: number): { lat: number; lon: number; text: string }[] {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  return Array.from({ length: count }, (_, i) => ({
    lat: CENTRE.lat + (next() - 0.5) * 0.2,
    lon: CENTRE.lon + (next() - 0.5) * 0.3,
    text: `row-${String(i).padStart(5, "0")}`,
  }));
}

function select(
  points: readonly { lat: number; lon: number; text: string }[],
  limit: number,
): { heap: NearestLines; sliced: number } {
  const heap = new NearestLines(limit, CENTRE);
  for (const point of points) {
    heap.offer(heap.distanceTo(point.lat, point.lon), point.text, 0, point.text.length);
  }
  return { heap, sliced: heap.slicedCount };
}

describe("NearestLines", () => {
  it("returns exactly what sorting every candidate and cutting would", () => {
    for (const seed of [1, 7, 99, 4_242]) {
      const points = scatter(3_006, seed);
      const { heap } = select(points, 400);
      expect(heap.drain()).toEqual(oracle(points, CENTRE, 400));
    }
  });

  it("agrees with the oracle when there are fewer candidates than the cap", () => {
    const points = scatter(37, 11);
    const { heap } = select(points, 400);
    expect(heap.full).toBe(false);
    expect(heap.drain()).toEqual(oracle(points, CENTRE, 400));
  });

  it("slices far fewer lines than it is offered", () => {
    const points = scatter(3_006, 5);
    const { sliced } = select(points, 400);
    /* The heap churns while it fills; what matters is that it is a fraction of the candidates. */
    expect(sliced).toBeLessThan(points.length / 2);
    expect(sliced).toBeGreaterThanOrEqual(400);
  });

  it("never slices a line it will not keep once the price is set", () => {
    const heap = new NearestLines(2, CENTRE);
    heap.offer(100, "a", 0, 1);
    heap.offer(200, "b", 0, 1);
    const before = heap.slicedCount;
    const kept = heap.offer(500, "c", 0, 1);
    expect(kept).toBe(false);
    expect(heap.slicedCount).toBe(before);
  });

  it("breaks an exact tie on the line, not on the order it was offered", () => {
    const forwards = new NearestLines(2, CENTRE);
    for (const text of ["c", "a", "b"]) forwards.offer(500, text, 0, text.length);
    const backwards = new NearestLines(2, CENTRE);
    for (const text of ["b", "a", "c"]) backwards.offer(500, text, 0, text.length);
    expect(forwards.drain().map((entry) => entry.text)).toEqual(["a", "b"]);
    expect(backwards.drain().map((entry) => entry.text)).toEqual(["a", "b"]);
  });

  it("reports the admission price only once it is full", () => {
    const heap = new NearestLines(2, CENTRE);
    expect(heap.admissionMetres).toBe(Infinity);
    heap.offer(100, "a", 0, 1);
    expect(heap.admissionMetres).toBe(Infinity);
    heap.offer(300, "b", 0, 1);
    expect(heap.admissionMetres).toBe(300);
    heap.offer(200, "c", 0, 1);
    expect(heap.admissionMetres).toBe(200);
  });

  it("counts every candidate, not just the keepers, so truncation is knowable", () => {
    const points = scatter(1_000, 3);
    const { heap } = select(points, 400);
    expect(heap.offeredCount).toBe(1_000);
    expect(heap.size).toBe(400);
  });
});

describe("tileFloorMetres", () => {
  const SIZE = 0.03125;

  it("is zero for the tile the point is in", () => {
    const tile = `${String(Math.floor(CENTRE.lat / SIZE))}_${String(Math.floor(CENTRE.lon / SIZE))}`;
    expect(tileFloorMetres(tile, SIZE, CENTRE)).toBe(0);
  });

  it("never exceeds the distance to any point inside the tile", () => {
    const baseLat = Math.floor(CENTRE.lat / SIZE);
    const baseLon = Math.floor(CENTRE.lon / SIZE);
    for (let dLat = -6; dLat <= 6; dLat++) {
      for (let dLon = -6; dLon <= 6; dLon++) {
        const tile = `${String(baseLat + dLat)}_${String(baseLon + dLon)}`;
        const floor = tileFloorMetres(tile, SIZE, CENTRE);
        for (let fLat = 0; fLat <= 1; fLat += 0.25) {
          for (let fLon = 0; fLon <= 1; fLon += 0.25) {
            const inside = {
              lat: (baseLat + dLat + fLat) * SIZE,
              lon: (baseLon + dLon + fLon) * SIZE,
            };
            expect(floor).toBeLessThanOrEqual(haversineMetres(CENTRE, inside) + 1e-9);
          }
        }
      }
    }
  });

  it("grows with distance, so nearest-first tile order is worth having", () => {
    const baseLat = Math.floor(CENTRE.lat / SIZE);
    const baseLon = Math.floor(CENTRE.lon / SIZE);
    const near = tileFloorMetres(`${String(baseLat + 1)}_${String(baseLon)}`, SIZE, CENTRE);
    const far = tileFloorMetres(`${String(baseLat + 8)}_${String(baseLon)}`, SIZE, CENTRE);
    expect(far).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(0);
  });

  it("is zero rather than wrong for a tile id it cannot read", () => {
    expect(tileFloorMetres("not-a-tile", SIZE, CENTRE)).toBe(0);
    expect(tileFloorMetres("103", SIZE, CENTRE)).toBe(0);
  });
});
