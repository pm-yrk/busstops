import { describe, expect, it } from "vitest";
import {
  patternIdInIndexLine,
  stopMentionedInLine,
  wantedPatternLineFilter,
} from "./network-reader.js";
import { patternIndexShardLines, type PatternIndexRow } from "@busstops/pipeline-static-network";

/**
 * Both of these filters exist for one reason: on Workers Free an invocation gets ten milliseconds
 * of CPU, and `JSON.parse` is what spends it. Scanning the raw text to decide what not to build is
 * the only lever left, so the scans are tested against text the publisher actually writes rather
 * than against a hand-typed approximation — a change to the stored form must fail here, not in
 * production as an empty board.
 */

const row = (id: string, stops: string[]): PatternIndexRow => ({
  id,
  serviceRouteId: "svc-1",
  direction: "outbound",
  stopSequence: stops,
  distanceMetres: 4_000,
});

/** The real published lines, joined the way a shard is. */
function shard(rows: PatternIndexRow[]): string {
  return patternIndexShardLines(rows).join("\n");
}

function lines(body: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < body.length;) {
    const newline = body.indexOf("\n", start);
    const end = newline < 0 ? body.length : newline;
    if (end > start) out.push({ start, end });
    if (newline < 0) break;
    start = newline + 1;
  }
  return out;
}

describe("reading a pattern id without parsing its row", () => {
  it("finds the id of every row the publisher writes, and refuses the header", () => {
    const body = shard([row("p-1", ["a", "b"]), row("p-2", ["b", "c"])]);
    const found = lines(body).map(({ start, end }) => patternIdInIndexLine(body, start, end));
    // The header line is first and is an object, not a pair: it has no id and must not claim one.
    expect(found).toEqual([null, "p-1", "p-2"]);
  });

  it("stops at its own line, so a row does not take the next row's id", () => {
    const body = shard([row("p-1", ["a"]), row("p-2", ["a"])]);
    const [, first] = lines(body);
    expect(patternIdInIndexLine(body, first!.start, first!.end)).toBe("p-1");
  });
});

describe("keeping only the patterns a journey asked for", () => {
  it("keeps the named rows and skips the rest, header included", () => {
    const body = shard([row("p-1", ["a"]), row("p-2", ["b"]), row("p-3", ["c"])]);
    const keep = wantedPatternLineFilter(["p-1", "p-3"]);
    expect(keep).toBeDefined();
    const kept = lines(body)
      .filter(({ start, end }) => keep!(body, start, end))
      .map(({ start, end }) => JSON.parse(body.slice(start, end)) as [string, PatternIndexRow])
      .map(([id]) => id);
    expect(kept).toEqual(["p-1", "p-3"]);
  });

  /*
   * An empty want list must not become "keep nothing". The planner only calls the resolver when a
   * trip named a pattern the slice lacks, but a filter that silently dropped everything would turn
   * a corridor with nothing left to resolve into a refusal, which is the opposite of the intent.
   */
  it("asks for no filter at all when nothing was named", () => {
    expect(wantedPatternLineFilter([])).toBeUndefined();
  });

  it("does not match a row whose id merely contains the wanted one", () => {
    const body = shard([row("p-1", ["a"]), row("p-12", ["b"])]);
    const keep = wantedPatternLineFilter(["p-1"])!;
    const kept = lines(body).filter(({ start, end }) => keep(body, start, end));
    expect(kept).toHaveLength(1);
    expect(patternIdInIndexLine(body, kept[0]!.start, kept[0]!.end)).toBe("p-1");
  });
});

describe("finding the lines that mention a stop", () => {
  const body = [
    JSON.stringify({ kind: "shape", shapeRef: "s1", points: [{ lat: 53.8, lon: -1.5 }] }),
    JSON.stringify({
      kind: "pattern",
      pattern: row("p-1", ["stop-a", "stop-b"]),
      shapeRef: "s1",
      stopDistancesMetres: [0, 400],
    }),
    JSON.stringify({
      kind: "pattern",
      pattern: row("p-2", ["stop-c", "stop-d"]),
      shapeRef: "s1",
      stopDistancesMetres: [0, 400],
    }),
  ].join("\n");

  it("keeps the pattern that calls there and leaves the others unparsed", () => {
    const keep = stopMentionedInLine("stop-b");
    const kept = lines(body)
      .filter(({ start, end }) => keep(body, start, end))
      .map(({ start, end }) => body.slice(start, end));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain('"p-1"');
  });

  /*
   * The shape lines are the volume: a city tile's polylines dwarf its stop sequences, and a board
   * draws no route line. Leaving them unparsed is most of the saving.
   */
  it("never keeps a shape line", () => {
    for (const stopId of ["stop-a", "stop-b", "stop-c", "stop-d"]) {
      const keep = stopMentionedInLine(stopId);
      const first = lines(body)[0]!;
      expect(keep(body, first.start, first.end)).toBe(false);
    }
  });

  it("does not match a stop id that is only a prefix of another", () => {
    const keep = stopMentionedInLine("stop-a");
    const widened = body.replace('"stop-c"', '"stop-abc"');
    const kept = lines(widened).filter(({ start, end }) => keep(widened, start, end));
    expect(kept).toHaveLength(1);
  });
});
