import { describe, expect, it } from "vitest";
import {
  PatternStopsTile,
  encodePatternStops,
  journeyPatternStopsDataset,
  patternKeyBytes,
  tileHoldsEveryPattern,
  type PatternStopSequence,
} from "./journey-pattern-stops.js";

/**
 * The pattern-stop projection, held to what went into it.
 *
 * A journey reads this to learn which stops a trip's pattern calls at, in order. The format exists
 * so that reading two hundred of a tile's eight hundred patterns costs two hundred patterns rather
 * than the whole index, so what has to be true is twofold: a pattern asked for by id comes back
 * with exactly the sequence published, and a pattern that is not in the tile is reported absent
 * rather than answered with a neighbour's stops. A format that returns the wrong sequence plans a
 * journey through stops the bus does not call at.
 */

/** Ids written out, not generated, so the expected order is not computed by the code under test. */
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "ffffffff-0000-4000-8000-00000000000c";

const ROUTE_X = "route-x";
const ROUTE_Y = "route-y";

function sample(): PatternStopSequence[] {
  return [
    /* Deliberately not in key order: the encoder sorts, and the reader depends on that. */
    { id: C, serviceRouteId: ROUTE_Y, stopSequence: ["stop-leeds", "stop-york"] },
    {
      id: A,
      serviceRouteId: ROUTE_X,
      stopSequence: ["stop-york", "stop-leeds", "stop-selby", "stop-york"],
    },
    /* The same route as A: two patterns of one route share its id in the tile's route table. */
    { id: B, serviceRouteId: ROUTE_X, stopSequence: ["stop-selby"] },
  ];
}

describe("journeyPatternStopsDataset", () => {
  it("names one tile under the shared prefix", () => {
    expect(journeyPatternStopsDataset("3")).toBe("network/journey-pattern-stops/3");
  });
});

describe("patternKeyBytes", () => {
  it("packs a UUID into sixteen bytes, in the order it is written", () => {
    const key = patternKeyBytes("01234567-89ab-4cde-8f01-234567890abc");
    expect(key).not.toBeNull();
    expect(key!.byteLength).toBe(16);
    expect([...key!.subarray(0, 4)]).toEqual([0x01, 0x23, 0x45, 0x67]);
    expect(key![15]).toBe(0xbc);
    expect(patternKeyBytes(A)![15]).toBe(0x0a);
  });

  it("refuses an id that is not a UUID rather than truncating it", () => {
    /* A truncated key would collide with a different pattern and answer with its stops. */
    expect(patternKeyBytes("ATCO:12345")).toBeNull();
    expect(patternKeyBytes("")).toBeNull();
    expect(patternKeyBytes(A.slice(0, -1))).toBeNull();
    expect(patternKeyBytes(`${A}0`)).toBeNull();
    expect(patternKeyBytes(A.replace("a", "g"))).toBeNull();
  });
});

describe("encodePatternStops", () => {
  it("round-trips every published sequence, by id", () => {
    const patterns = sample();
    const encoded = encodePatternStops(patterns);
    expect(encoded.patterns).toBe(3);
    expect(encoded.calls).toBe(7);
    expect(encoded.stops).toBe(3);
    expect(encoded.routes).toBe(2);
    expect(encoded.skipped).toBe(0);

    const tile = new PatternStopsTile(encoded.bytes);
    expect(tile.patternCount).toBe(3);
    expect(tile.callCount).toBe(7);
    for (const pattern of patterns) {
      expect(tile.stopSequenceOf(pattern.id)).toEqual(pattern.stopSequence);
      expect(tile.patternOf(pattern.id)).toEqual(pattern);
    }
  });

  it("gives a pattern its id back out of the key, not out of a stored string", () => {
    const tile = new PatternStopsTile(encodePatternStops(sample()).bytes);
    expect(tile.patternIdAt(tile.indexOf(C))).toBe(C);
    expect(tile.patternIdAt(tile.indexOf(A))).toBe(A);
  });

  it("names each pattern's service route, holding one id per route", () => {
    const tile = new PatternStopsTile(encodePatternStops(sample()).bytes);
    expect(tile.routeCount).toBe(2);
    expect(tile.serviceRouteIdAt(tile.indexOf(A))).toBe(ROUTE_X);
    expect(tile.serviceRouteIdAt(tile.indexOf(B))).toBe(ROUTE_X);
    expect(tile.serviceRouteIdAt(tile.indexOf(C))).toBe(ROUTE_Y);
  });

  it("keeps a repeated stop in place rather than collapsing the sequence", () => {
    /* A circular pattern calls at its first stop again at the end; the sequence is positional. */
    const tile = new PatternStopsTile(encodePatternStops(sample()).bytes);
    expect(tile.stopSequenceOf(A)).toEqual(["stop-york", "stop-leeds", "stop-selby", "stop-york"]);
  });

  it("holds each distinct stop id once", () => {
    const encoded = encodePatternStops(sample());
    const blob = new TextDecoder().decode(encoded.bytes);
    expect(blob.split("stop-york").length - 1).toBe(1);
  });

  it("reports a pattern it cannot key rather than publishing a partial tile silently", () => {
    const encoded = encodePatternStops([
      ...sample(),
      { id: "not-a-uuid", serviceRouteId: ROUTE_X, stopSequence: ["stop-leeds"] },
    ]);
    expect(encoded.skipped).toBe(1);
    expect(encoded.patterns).toBe(3);
    expect(new PatternStopsTile(encoded.bytes).stopSequenceOf("not-a-uuid")).toBeNull();
  });

  it("encodes the same tile to the same bytes whatever order it is given in", () => {
    const forwards = encodePatternStops(sample()).bytes;
    const backwards = encodePatternStops([...sample()].reverse()).bytes;
    expect([...backwards]).toEqual([...forwards]);
  });

  it("encodes an empty tile that opens and holds nothing", () => {
    const tile = new PatternStopsTile(encodePatternStops([]).bytes);
    expect(tile.patternCount).toBe(0);
    expect(tile.stopSequenceOf(A)).toBeNull();
  });
});

describe("PatternStopsTile", () => {
  it("reports a pattern that is not in the tile as absent", () => {
    const tile = new PatternStopsTile(encodePatternStops(sample()).bytes);
    expect(tile.indexOf("11111111-0000-4000-8000-000000000000")).toBe(-1);
    expect(tile.stopSequenceOf("11111111-0000-4000-8000-000000000000")).toBeNull();
  });

  it("finds every pattern by binary search, including the first and the last", () => {
    const many: PatternStopSequence[] = Array.from({ length: 64 }, (_, at) => ({
      id: `0000${at.toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`,
      serviceRouteId: `route-${String(at % 7)}`,
      stopSequence: [`stop-${String(at)}`, `stop-${String(at + 1)}`],
    }));
    const tile = new PatternStopsTile(encodePatternStops(many).bytes);
    for (const pattern of many) {
      expect(tile.stopSequenceOf(pattern.id)).toEqual(pattern.stopSequence);
    }
  });

  it("reads bytes that do not begin on a four-byte boundary", () => {
    /* A sliced R2 body can land at any offset; a reader that assumes alignment throws on it. */
    const encoded = encodePatternStops(sample()).bytes;
    const padded = new Uint8Array(encoded.byteLength + 3);
    padded.set(encoded, 3);
    const tile = new PatternStopsTile(padded.subarray(3));
    expect(tile.stopSequenceOf(B)).toEqual(["stop-selby"]);
  });

  it("refuses bytes that are not a published tile", () => {
    expect(() => new PatternStopsTile(new Uint8Array(32))).toThrow();
  });

  it("refuses a tile that is cut short", () => {
    const encoded = encodePatternStops(sample()).bytes;
    expect(() => new PatternStopsTile(encoded.subarray(0, encoded.byteLength - 4))).toThrow();
  });
});

describe("tileHoldsEveryPattern", () => {
  it("passes a tile that carries what was published", () => {
    const patterns = sample();
    expect(tileHoldsEveryPattern(encodePatternStops(patterns).bytes, patterns)).toEqual({
      ok: true,
    });
  });

  it("fails when a pattern is missing from the bytes", () => {
    const published = encodePatternStops(sample().slice(0, 2)).bytes;
    const verdict = tileHoldsEveryPattern(published, sample());
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("missing pattern");
  });

  it("fails when a sequence in the bytes is a different length", () => {
    const published = encodePatternStops(sample()).bytes;
    const claimed = sample().map((pattern) =>
      pattern.id === B
        ? { id: B, serviceRouteId: ROUTE_X, stopSequence: ["stop-selby", "stop-york"] }
        : pattern,
    );
    const verdict = tileHoldsEveryPattern(published, claimed);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("calls, expected");
  });

  it("fails when a call in the bytes is the wrong stop", () => {
    const published = encodePatternStops(sample()).bytes;
    const claimed = sample().map((pattern) =>
      pattern.id === C
        ? { id: C, serviceRouteId: ROUTE_Y, stopSequence: ["stop-york", "stop-leeds"] }
        : pattern,
    );
    const verdict = tileHoldsEveryPattern(published, claimed);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("wrong stop");
  });

  it("fails when a pattern in the bytes is on a different service route", () => {
    const published = encodePatternStops(sample()).bytes;
    const claimed = sample().map((pattern) =>
      pattern.id === B ? { ...pattern, serviceRouteId: ROUTE_Y } : pattern,
    );
    const verdict = tileHoldsEveryPattern(published, claimed);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("wrong service route");
  });

  it("fails on bytes that will not open at all", () => {
    const verdict = tileHoldsEveryPattern(new Uint8Array(8), sample());
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("will not open");
  });
});
