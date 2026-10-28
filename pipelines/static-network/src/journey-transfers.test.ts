import { describe, expect, it } from "vitest";
import { TransferTile, encodeTransferTile, journeyTransfersDataset } from "./journey-transfers.js";

/**
 * The transfer tile's bytes, held to what went into them.
 *
 * The format exists to let a journey request read its walking transfers without building them, so
 * what has to be true is that the bytes carry exactly the adjacency that was published: the same
 * stops, the same neighbours in the same order, the same walks, and the cap they were built under.
 * A format that loses an edge loses a journey; one that loses its cap offers a walk a passenger
 * cannot make.
 */

/** A small adjacency, written out by hand so the expected bytes are not computed by the code. */
function sample(): {
  stopIds: string[];
  offsets: Uint32Array;
  neighbours: Uint32Array;
  seconds: Uint32Array;
} {
  /* a → b (120 s), a → c (300 s), b → a (120 s), c nothing. */
  return {
    stopIds: ["stop-a", "stop-b", "stop-c"],
    offsets: Uint32Array.from([0, 2, 3, 3]),
    neighbours: Uint32Array.from([1, 2, 0]),
    seconds: Uint32Array.from([120, 300, 120]),
  };
}

describe("a published transfer tile", () => {
  it("reads back exactly what was written", () => {
    const input = sample();
    const { bytes, stats } = encodeTransferTile({ ...input, capSeconds: 600 });
    expect(stats.stops).toBe(3);
    expect(stats.edges).toBe(3);
    expect(stats.clampedWalks).toBe(0);

    const tile = new TransferTile(bytes);
    expect(tile.stopCount).toBe(3);
    expect(tile.edgeCount).toBe(3);
    expect(tile.capSeconds).toBe(600);
    expect([...tile.stopIds()]).toEqual(input.stopIds);

    const read: string[] = [];
    for (let stop = 0; stop < tile.stopCount; stop += 1) {
      for (let edge = tile.firstEdge(stop); edge < tile.edgeEnd(stop); edge += 1) {
        read.push(
          `${tile.stopIdAt(stop)}>${tile.stopIdAt(tile.neighbourAt(edge))}@${String(tile.secondsOf(edge))}`,
        );
      }
    }
    expect(read).toEqual(["stop-a>stop-b@120", "stop-a>stop-c@300", "stop-b>stop-a@120"]);
  });

  it("keeps a stop with no neighbours, as an empty range rather than an absence", () => {
    const tile = new TransferTile(encodeTransferTile({ ...sample(), capSeconds: 600 }).bytes);
    const lonely = tile.stopCount - 1;
    expect(tile.stopIdAt(lonely)).toBe("stop-c");
    expect(tile.edgeEnd(lonely) - tile.firstEdge(lonely)).toBe(0);
  });

  it("is a fraction of the size of the edges it carries as objects", () => {
    /* A city tile's worth: 1,200 stops, each reaching about thirty others. */
    const stopCount = 1_200;
    const perStop = 30;
    const stopIds = Array.from(
      { length: stopCount },
      (_, at) => `019200aa-${String(at).padStart(8, "0")}`,
    );
    const offsets = new Uint32Array(stopCount + 1);
    const neighbours = new Uint32Array(stopCount * perStop);
    const seconds = new Uint32Array(stopCount * perStop);
    for (let stop = 0; stop < stopCount; stop += 1) {
      offsets[stop] = stop * perStop;
      for (let at = 0; at < perStop; at += 1) {
        neighbours[stop * perStop + at] = (stop + at + 1) % stopCount;
        seconds[stop * perStop + at] = 60 + at * 10;
      }
    }
    offsets[stopCount] = stopCount * perStop;

    const { stats } = encodeTransferTile({
      stopIds,
      offsets,
      neighbours,
      seconds,
      capSeconds: 600,
    });
    /* Six bytes an edge plus the ids, against the hundred-odd an object graph spends on each. */
    expect(stats.bytes).toBeLessThan(stats.edges * 12 + stopCount * 60);
  });

  it("refuses an input whose offsets and stops disagree", () => {
    const input = sample();
    expect(() =>
      encodeTransferTile({ ...input, offsets: Uint32Array.from([0, 1]), capSeconds: 600 }),
    ).toThrow(/offsets/);
    expect(() =>
      encodeTransferTile({ ...input, seconds: Uint32Array.from([1]), capSeconds: 600 }),
    ).toThrow(/edge count/);
  });

  it("reports a walk too long to store rather than wrapping it round", () => {
    const input = sample();
    const { stats, bytes } = encodeTransferTile({
      ...input,
      seconds: Uint32Array.from([120, 70_000, 120]),
      capSeconds: 600,
    });
    expect(stats.clampedWalks).toBe(1);
    /* Clamped to the ceiling, which is far beyond any cap, so the edge is unusable rather than
     * quietly short. */
    const tile = new TransferTile(bytes);
    expect(tile.secondsOf(1)).toBe(0xffff);
  });

  it("refuses bytes that are not a tile, and bytes that are missing their tail", () => {
    expect(() => new TransferTile(new Uint8Array(64))).toThrow(/not a published transfer tile/);
    const { bytes } = encodeTransferTile({ ...sample(), capSeconds: 600 });
    expect(() => new TransferTile(bytes.subarray(0, bytes.byteLength - 4))).toThrow(/truncated/);
  });

  it("opens a body that does not begin on a four-byte boundary", () => {
    const { bytes } = encodeTransferTile({ ...sample(), capSeconds: 600 });
    const padded = new Uint8Array(bytes.byteLength + 1);
    padded.set(bytes, 1);
    const tile = new TransferTile(padded.subarray(1));
    expect([...tile.stopIds()]).toEqual(sample().stopIds);
    expect(tile.secondsOf(1)).toBe(300);
  });

  it("files a tile under the family a reader looks in", () => {
    expect(journeyTransfersDataset("215_-7")).toBe("network/journey-transfers/215_-7");
  });
});
