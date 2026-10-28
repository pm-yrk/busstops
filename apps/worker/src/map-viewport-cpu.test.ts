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

  it("builds only the stops it returns, and not the ones that lose", () => {
    /*
     * Counted, not timed.
     *
     * This asserted a ratio of wall-clock times — 1.05, against a measured win of about 1.19 —
     * and it passed on its own and failed inside the full suite, because a five per cent margin
     * on three runs of a sub-millisecond function is noise once a hundred other test files are
     * competing for the machine. A flaky test is worse than no test: it teaches you to re-run.
     *
     * What the change actually claims is structural and exact: the 2,606 rows that lose the
     * ranking are never turned into a `MapStop`. That is countable, so it is counted. The timing
     * figure it was standing in for lives in ADR 0007 beside the deployed measurement, which is
     * where a figure that depends on a machine belongs.
     */
    const rows = viewport(3_006);
    let built = 0;
    const counting = (row: MapStopRow): MapStop => {
      built += 1;
      return toMapStop(row);
    };

    built = 0;
    const deferredOut =
      rows.length <= 400
        ? rows.map(counting)
        : rows
            .map((row) => ({
              row,
              distance: haversineMetres(MANCHESTER, { lat: row.y, lon: row.x }),
            }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 400)
            .map((entry) => counting(entry.row));
    const deferredBuilds = built;

    built = 0;
    const eagerOut = rows
      .map(counting)
      .map((stop) => ({ stop, distance: haversineMetres(MANCHESTER, stop.locationCoordinate) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 400)
      .map((entry) => entry.stop);
    const eagerBuilds = built;

    expect(deferredBuilds).toBe(400);
    expect(eagerBuilds).toBe(3_006);
    /* And the same four hundred markers either way, which is the point of doing less. */
    expect(deferredOut.map((stop) => stop.id)).toEqual(eagerOut.map((stop) => stop.id));
  });
});
