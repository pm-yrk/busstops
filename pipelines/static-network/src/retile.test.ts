import { describe, expect, it } from "vitest";
import { tileIdFor } from "@busstops/pipeline-core";
import { groupRefiled, refileLines } from "./retile.js";
import { MAP_STOP_TILE_DEGREES, STOP_TILE_DEGREES, type MapStopRow } from "./shards.js";

/**
 * Re-filing the published map projection onto a smaller square.
 *
 * This is the pure half of `run-retile-map-stops.ts`, and the half whose mistakes would be silent.
 * The script's own refusals catch an absent object or a write that did not land; what they cannot
 * catch is a repartition that puts a row in a tile no viewport asks for, because every count still
 * adds up and the map simply comes back short.
 */

const LEEDS = { lat: 53.7996, lon: -1.56 };

function line(id: string, coordinate: { lat: number; lon: number }, routes?: string[]): string {
  const row: MapStopRow = {
    i: id,
    a: `4500${id.slice(0, 5)}`,
    n: "Armley Road",
    y: coordinate.lat,
    x: coordinate.lon,
    ...(routes === undefined ? {} : { r: routes }),
  };
  return JSON.stringify(row);
}

/** Same-length ids, as the publisher writes them: every stop id is a UUID. */
function uuid(n: number): string {
  const tail = String(n).padStart(12, "0");
  return `00000000-0000-5000-8000-${tail}`;
}

describe("re-filing a published projection onto another grid", () => {
  it("puts every row in the tile its own coordinates name", () => {
    const lines = [
      line(uuid(1), { lat: 53.76, lon: -1.61 }),
      line(uuid(2), { lat: 53.79, lon: -1.55 }),
      line(uuid(3), { lat: 53.83, lon: -1.47 }),
      line(uuid(4), LEEDS),
    ];
    const { refiled, faults } = refileLines(lines, STOP_TILE_DEGREES / 4);

    expect(faults).toEqual([]);
    expect(refiled).toHaveLength(4);
    for (const entry of refiled) {
      const row = JSON.parse(entry.text) as MapStopRow;
      expect(entry.tile).toBe(tileIdFor({ lat: row.y, lon: row.x }, STOP_TILE_DEGREES / 4));
    }
  });

  it("conserves every row, and carries the line unchanged", () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      line(uuid(i), { lat: 53.7 + i * 0.004, lon: -1.7 + i * 0.006 }, ["1", "X11"]),
    );
    const { refiled } = refileLines(lines, STOP_TILE_DEGREES / 4);
    const grouped = groupRefiled(refiled);

    expect(grouped.reduce((total, tile) => total + tile.rows.length, 0)).toBe(lines.length);
    /*
     * Byte-for-byte, not merely equivalent. Re-serialising would be free to render `53.7996` as
     * `53.79960`, and then a later build at this grid would rewrite every object for data that
     * had not changed.
     */
    expect([...grouped.flatMap((tile) => tile.rows)].sort()).toEqual([...lines].sort());
  });

  it("refuses to quietly drop a line it cannot read", () => {
    const { refiled, faults } = refileLines(
      [
        line(uuid(1), LEEDS),
        '{"i":"truncated","a":"450010002","n":"Half a l',
        '{"i":"00000000-0000-5000-8000-000000000003","a":"450010003","n":"No position"}',
      ],
      STOP_TILE_DEGREES / 4,
    );

    expect(refiled).toHaveLength(1);
    expect(faults.map((fault) => fault.reason)).toEqual(["unparseable", "positionless"]);
  });

  it("counts an object's bytes as the lines plus the newlines between them", () => {
    const lines = [line(uuid(1), LEEDS), line(uuid(2), LEEDS)];
    const [tile] = groupRefiled(refileLines(lines, STOP_TILE_DEGREES).refiled);

    expect(tile).toBeDefined();
    // Exactly what `rows.join("\n")` will occupy, which is what the cap is checked against.
    expect(tile!.bytes).toBe(tile!.rows.join("\n").length);
  });

  /*
   * The coincidence worth pinning.
   *
   * `publishNetworkShards` orders a projection shard by each row's `i`; this orders the serialised
   * lines as strings. The two agree only because `i` is written first and every id is a same-length
   * UUID, so the comparison reaches the id before anything else and never weighs a short id against
   * a long one. If a row ever gains a key before `i`, or ids stop being fixed-length, a re-filed
   * family and a rebuilt one stop being the same bytes — and nothing else would notice.
   */
  it("orders a tile the way the publisher orders a shard", () => {
    const ids = [uuid(9), uuid(1), uuid(40), uuid(3)];
    const lines = ids.map((id) => line(id, LEEDS));
    const [tile] = groupRefiled(refileLines(lines, STOP_TILE_DEGREES).refiled);

    const byPublisherRule = [...lines]
      .map((text) => ({ text, row: JSON.parse(text) as MapStopRow }))
      .sort((a, b) => (a.row.i < b.row.i ? -1 : 1))
      .map((entry) => entry.text);

    expect(tile!.rows).toEqual(byPublisherRule);
  });

  it("groups onto the coarse grid too, which is what a rollback would ask for", () => {
    const spread = Array.from({ length: 20 }, (_, i) =>
      line(uuid(i), { lat: 53.7 + i * 0.01, lon: -1.6 }),
    );
    const fine = groupRefiled(refileLines(spread, STOP_TILE_DEGREES / 4).refiled);
    const coarse = groupRefiled(refileLines(spread, MAP_STOP_TILE_DEGREES).refiled);

    expect(fine.length).toBeGreaterThan(coarse.length);
    expect(fine.reduce((n, tile) => n + tile.rows.length, 0)).toBe(
      coarse.reduce((n, tile) => n + tile.rows.length, 0),
    );
  });
});
