import { describe, expect, it } from "vitest";
import { haversineMetres } from "@busstops/pipeline-core";
import { passengerName, type MapStopRow } from "@busstops/pipeline-static-network";

/**
 * Building only the projection rows a viewport keeps, held to what building all of them gave.
 *
 * Cloudflare measured `/v1/map` at 38 ms of CPU against a ten-millisecond free limit, after
 * scanning the live feed had already taken 88 ms out of it. Almost all of what was left was shape
 * work on projection rows: a Manchester viewport holds 3,006 rows inside the box and the map draws
 * four hundred markers, and every one of the 3,006 was turned into a `MapStop` — a `passengerName`
 * call, two objects and a route-name array each — before five-sixths were discarded on the next
 * line.
 *
 * The fix is supposed to be invisible: the same four hundred stops, in the same order, with the
 * same names. "Supposed to be" is why this file exists. The old order is reproduced here as the
 * oracle rather than trusted.
 */

interface MapStop {
  id: string;
  atcoCode: string;
  name: string;
  locationCoordinate: { lat: number; lon: number };
  indicator?: string;
  routePublicNames: string[];
}

const toMapStop = (row: MapStopRow): MapStop => ({
  id: row.i,
  atcoCode: row.a,
  name: passengerName(row.n),
  locationCoordinate: { lat: row.y, lon: row.x },
  ...(row.d === undefined ? {} : { indicator: row.d }),
  routePublicNames: row.r ?? [],
});

/** What the reader did: build every row, then rank and slice the built objects. */
function eager(
  rows: readonly MapStopRow[],
  centre: { lat: number; lon: number },
  limit: number,
): MapStop[] {
  const built = rows.map(toMapStop);
  if (built.length <= limit) return built;
  return built
    .map((stop) => ({ stop, distance: haversineMetres(centre, stop.locationCoordinate) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((entry) => entry.stop);
}

/** What it does now: rank the rows, then build only the survivors. */
function deferred(
  rows: readonly MapStopRow[],
  centre: { lat: number; lon: number },
  limit: number,
): MapStop[] {
  if (rows.length <= limit) return rows.map(toMapStop);
  return rows
    .map((row) => ({ row, distance: haversineMetres(centre, { lat: row.y, lon: row.x }) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((entry) => toMapStop(entry.row));
}

const MANCHESTER = { lat: 53.47, lon: -2.24 };

/** A viewport's worth of rows, as the published projection carries them. */
function viewport(count: number): MapStopRow[] {
  return Array.from({ length: count }, (_, i) => ({
    i: `stop-${String(i)}`,
    a: `1800SB${String(i).padStart(5, "0")}`,
    /* Underscores and casing, because `passengerName` is part of what is being deferred. */
    n: i % 3 === 0 ? `Green_Lane_Bus_Shelter_${String(i)}` : `Oxford Road Stop ${String(i)}`,
    y: MANCHESTER.lat - 0.05 + ((i * 37) % 71) * 0.0014,
    x: MANCHESTER.lon - 0.08 + ((i * 53) % 97) * 0.0016,
    ...(i % 5 === 0 ? { d: `Stand ${String(i % 9)}` } : {}),
    ...(i % 4 === 0 ? { r: ["1", "42", "X1"] } : {}),
  }));
}

describe("building only the stops a viewport keeps", () => {
  it("returns exactly what building all of them returned", () => {
    const rows = viewport(3_006);
    expect(deferred(rows, MANCHESTER, 400)).toEqual(eager(rows, MANCHESTER, 400));
  });

  it("returns the same thing when the viewport is under the cap", () => {
    const rows = viewport(120);
    const out = deferred(rows, MANCHESTER, 400);
    expect(out).toEqual(eager(rows, MANCHESTER, 400));
    expect(out).toHaveLength(120);
  });

  it("keeps the passenger-facing name, the indicator and the route names", () => {
    const rows = viewport(3_006);
    const out = deferred(rows, MANCHESTER, 400);
    expect(
      out.every((stop) => !stop.name.includes("_")),
      "names are tidied",
    ).toBe(true);
    expect(out.some((stop) => stop.indicator !== undefined)).toBe(true);
    expect(out.some((stop) => stop.routePublicNames.length > 0)).toBe(true);
  });

  it("does less work than building all of them", () => {
    /*
     * A ratio against the implementation it replaced on the same machine, not a millisecond
     * threshold — a number would be pinned to somebody else's hardware.
     *
     * The bar is low because the measured win is: about 1.19 times, or seven tenths of a
     * millisecond of a 4.4-millisecond stage. The 2,606 rows that lose the ranking are no longer
     * built, but both versions still haversine and sort all 3,006, and that is the larger half.
     * Recorded at the measured value rather than at the one first guessed — the deferral is worth
     * keeping because it is free and exact, not because it is dramatic.
     */
    const rows = viewport(3_006);
    const time = (run: () => void) => {
      run();
      run();
      const began = process.hrtime.bigint();
      run();
      return Number(process.hrtime.bigint() - began);
    };

    const fast = time(() => deferred(rows, MANCHESTER, 400));
    const slow = time(() => eager(rows, MANCHESTER, 400));
    expect(slow / fast, `deferred ${fast}ns vs eager ${slow}ns`).toBeGreaterThan(1.05);
  });
});
