import { tileIdFor } from "@busstops/pipeline-core";
import type { MapStopRow } from "./shards.js";

/** One published line, kept exactly as written, with the tile it belongs in on the target grid. */
export interface RefiledLine {
  tile: string;
  text: string;
  bytes: number;
}

export interface RefiledTile {
  tile: string;
  rows: string[];
  bytes: number;
}

export interface RefileFault {
  /** The line, truncated, so a fault names something a person can go and look at. */
  text: string;
  reason: "unparseable" | "positionless";
}

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Where each published projection line belongs on a different grid.
 *
 * The lines are carried, never re-serialised. A repartition that rebuilt the JSON could change a
 * number's formatting — `53.7996` and `53.79960` are the same position and different bytes — and
 * then a later full build at the same grid would not produce byte-identical objects for data
 * that had not changed, which is the property that makes a publish diffable at all.
 *
 * A line that cannot be read is returned as a fault rather than dropped. The caller's job is to
 * refuse: the one thing worse than a map that costs too much to draw is a map with stops missing
 * from it that reports no degradation at all.
 */
export function refileLines(
  lines: readonly string[],
  sizeDegrees: number,
): { refiled: RefiledLine[]; faults: RefileFault[] } {
  const refiled: RefiledLine[] = [];
  const faults: RefileFault[] = [];

  for (const text of lines) {
    if (text.length === 0) continue;
    let row: MapStopRow;
    try {
      row = JSON.parse(text) as MapStopRow;
    } catch {
      faults.push({ text: text.slice(0, 120), reason: "unparseable" });
      continue;
    }
    if (typeof row.y !== "number" || typeof row.x !== "number") {
      faults.push({ text: text.slice(0, 120), reason: "positionless" });
      continue;
    }
    refiled.push({
      tile: tileIdFor({ lat: row.y, lon: row.x }, sizeDegrees),
      text,
      bytes: utf8Bytes(text) + 1,
    });
  }

  return { refiled, faults };
}

/**
 * The lines grouped into the objects they would be written as, ordered as the publisher orders.
 *
 * `publishNetworkShards` sorts a projection shard's rows by their `i` field. This sorts the
 * serialised lines as strings, which comes to the same thing only because `i` is written first in
 * the row and every stop id is a same-length UUID — so the comparison reaches the id before
 * anything else and never has to compare a short id against a long one. That is a coincidence of
 * two files agreeing, which is exactly the kind of thing that stops being true quietly, so it is
 * asserted in `retile.test.ts` against a shard the publisher actually produced.
 *
 * The ordering matters because it is what makes a re-filed family and a rebuilt one the same
 * bytes: a build asked for this grid afterwards should overwrite these objects with identical
 * content rather than with a reshuffle of it.
 */
export function groupRefiled(refiled: readonly RefiledLine[]): RefiledTile[] {
  const byTile = new Map<string, string[]>();
  for (const line of refiled) {
    const existing = byTile.get(line.tile);
    if (existing) existing.push(line.text);
    else byTile.set(line.tile, [line.text]);
  }

  return [...byTile]
    .map(([tile, rows]) => {
      const ordered = [...rows].sort((a, b) => (a < b ? -1 : 1));
      return {
        tile,
        rows: ordered,
        /* The object is the lines joined by newlines, so the separators are one fewer. */
        bytes: ordered.reduce((total, text) => total + utf8Bytes(text), 0) + ordered.length - 1,
      };
    })
    .sort((a, b) => (a.tile < b.tile ? -1 : 1));
}
