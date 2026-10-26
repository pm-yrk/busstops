import { describe, expect, it, vi } from "vitest";
import {
  MAX_LINE_CHARS,
  OversizedLineError,
  readFilteredLinesStreaming,
  streamLines,
} from "./stream-lines.js";

/**
 * The invariants a streaming line reader has to hold, each one a way an earlier sketch was wrong.
 *
 * A stream arrives in chunks nobody chose. A line is split across two of them, several lines come
 * in one, the last line has no newline after it, and a multi-byte character lands on the boundary.
 * Each of those is a different bug and none of them is visible when the body is one string — which
 * is exactly why `object.text()` never had to think about any of it, and why replacing it needs
 * this file rather than a careful read of the diff.
 */

const encoder = new TextEncoder();

/** A body delivered in chunks of exactly `size` bytes, so a boundary can be placed on purpose. */
function streamOf(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

/** Lines collected as strings, which is what a test wants to assert on. */
async function linesOf(body: ReadableStream<Uint8Array>) {
  const seen: Array<{ text: string; index: number }> = [];
  const stats = await streamLines(body, (buffer, start, end, index) => {
    seen.push({ text: buffer.slice(start, end), index });
  });
  return { seen, stats };
}

describe("walking a body's lines without buffering it", () => {
  it("joins a line split across an arbitrary chunk boundary", async () => {
    const body = ["first line", "second line", "third line"].join("\n");
    /* Three bytes at a time: every line is split, twice. */
    const { seen } = await linesOf(streamOf(body, 3));
    expect(seen.map((line) => line.text)).toEqual(["first line", "second line", "third line"]);
  });

  it("delivers several lines that arrive in one chunk", async () => {
    const body = ["a", "b", "c", "d"].join("\n");
    const { seen, stats } = await linesOf(streamOf(body, 1024));
    expect(seen.map((line) => line.text)).toEqual(["a", "b", "c", "d"]);
    expect(stats.chunks).toBe(1);
  });

  it("delivers a final line with no newline after it", async () => {
    const { seen } = await linesOf(streamOf("one\ntwo\nthree", 4));
    expect(seen.map((line) => line.text)).toEqual(["one", "two", "three"]);
  });

  it("delivers a final line when the body does end in a newline, and no empty one after it", async () => {
    const { seen } = await linesOf(streamOf("one\ntwo\n", 4));
    expect(seen.map((line) => line.text)).toEqual(["one", "two"]);
  });

  it("skips blank lines rather than calling back with an empty one", async () => {
    const { seen } = await linesOf(streamOf("one\n\n\ntwo\n", 2));
    expect(seen.map((line) => line.text)).toEqual(["one", "two"]);
    /* And the ordinals are of non-empty lines, so a header is still line zero. */
    expect(seen.map((line) => line.index)).toEqual([0, 1]);
  });

  it("tolerates CRLF", async () => {
    const { seen } = await linesOf(streamOf("one\r\ntwo\r\n", 3));
    expect(seen.map((line) => line.text)).toEqual(["one", "two"]);
  });

  it("keeps a multi-byte character whole across a chunk boundary", async () => {
    /*
     * "Bryn Mawr Café" in a stop name is two bytes for the é, and a chunk size that splits them
     * would hand the first half to one decode and the second to the next. Without `stream: true`
     * that is two replacement characters and a row that will not parse — once in a few thousand
     * reads, found by a passenger rather than by a test.
     */
    const body = '{"name":"Café"}\n{"name":"Köln"}';
    const bytes = encoder.encode(body);
    for (let size = 1; size <= bytes.length; size += 1) {
      const { seen } = await linesOf(streamOf(body, size));
      expect(
        seen.map((line) => line.text),
        `chunk size ${String(size)}`,
      ).toEqual(['{"name":"Café"}', '{"name":"Köln"}']);
    }
  });

  it("reports what it consumed, not what the object holds", async () => {
    const body = Array.from({ length: 50 }, (_, i) => `line ${String(i)}`).join("\n");
    const { stats } = await linesOf(streamOf(body, 16));
    expect(stats.linesScanned).toBe(50);
    expect(stats.chars).toBe(body.length);
    expect(stats.chunks).toBeGreaterThan(1);
    /* The bound that matters: a partial line, never the object. */
    expect(stats.maxCarryChars).toBeLessThan(32);
    expect(stats.maxBufferChars).toBeLessThan(64);
    expect(stats.stoppedEarly).toBe(false);
  });

  it("holds one chunk and one line, not the object, over a body of several megabytes", async () => {
    /*
     * The shape of the real read: forty thousand irrelevant rows and one wanted one. What is
     * asserted is the high-water mark of the buffer — the number that distinguishes this from
     * `object.text()`, which would be the whole four megabytes.
     */
    const filler = `{"i":"${"x".repeat(80)}"}`;
    const body = [...Array.from({ length: 40_000 }, () => filler), '{"i":"wanted"}'].join("\n");
    expect(body.length).toBeGreaterThan(3_000_000);

    const { stats } = await linesOf(streamOf(body, 64 * 1024));
    expect(stats.chars).toBe(body.length);
    expect(stats.maxBufferChars).toBeLessThan(200_000);
    expect(stats.maxCarryChars).toBeLessThan(200);
  });
});

describe("stopping before the end of a body", () => {
  it("cancels the rest of the body and releases the reader", async () => {
    const cancelled = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(encoder.encode(`line ${String(pulls)}\n`));
      },
      cancel: cancelled,
    });

    const stats = await streamLines(body, (_buffer, _start, _end, index) =>
      index === 2 ? "stop" : undefined,
    );

    expect(stats.stoppedEarly).toBe(true);
    expect(cancelled, "the body is cancelled, not left to be pulled forever").toHaveBeenCalled();
    /*
     * And the lock is gone, so nothing holds the body: a second reader can be taken, which is only
     * possible if `releaseLock` ran. This is the assertion that fails if the `finally` is removed.
     */
    expect(body.locked).toBe(false);
  });

  it("releases the reader when the store fails mid-body, and propagates the failure", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first\n"));
      },
      pull(controller) {
        controller.error(new Error("R2 connection reset"));
      },
    });

    await expect(streamLines(body, () => undefined)).rejects.toThrow("R2 connection reset");
    /*
     * The honest behaviour and the one the callers depend on: a read that failed is not an object
     * with no rows in it. Every caller here turns a throw into "we cannot say" rather than into
     * "this stop has no routes".
     */
    expect(body.locked).toBe(false);
  });
});

describe("the malformed giant line guard", () => {
  it("fails rather than carrying a body with no newline in it", async () => {
    /* A truncated write, a JSON array where JSONL was expected, or an error page. */
    const body = `{"rows":[${"0,".repeat(5_000)}0]}`;
    await expect(
      streamLines(streamOf(body, 1024), () => undefined, { maxLineChars: 2_048, key: "tile/7" }),
    ).rejects.toBeInstanceOf(OversizedLineError);
  });

  it("names the object and both numbers, so a report says what was malformed", async () => {
    const thrown = await streamLines(streamOf("x".repeat(5_000), 512), () => undefined, {
      maxLineChars: 1_024,
      key: "network/patterns-tile/3_-1",
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(thrown).toBeInstanceOf(OversizedLineError);
    const error = thrown as OversizedLineError;
    expect(error.cap).toBe(1_024);
    expect(error.chars).toBeGreaterThan(1_024);
    expect(error.message).toContain("network/patterns-tile/3_-1");
  });

  it("does not truncate the line and hand back half a row", async () => {
    const seen: string[] = [];
    await streamLines(
      streamOf(`{"id":"${"x".repeat(4_000)}"}`, 256),
      (buffer, start, end) => {
        seen.push(buffer.slice(start, end));
      },
      { maxLineChars: 1_024 },
    ).catch(() => undefined);
    /*
     * Nothing at all, rather than a prefix. Half a JSON row either throws or — the dangerous one —
     * parses into a different row, and a board built from that is wrong rather than incomplete.
     */
    expect(seen).toEqual([]);
  });

  it("accepts a line the published data actually contains", async () => {
    /* The guard has to be generous enough that real data never meets it; see MAX_LINE_CHARS. */
    const line = `{"s":"${"y".repeat(100_000)}"}`;
    const { seen } = await linesOf(streamOf(`${line}\n{"s":"short"}`, 8 * 1024));
    expect(seen).toHaveLength(2);
    expect(MAX_LINE_CHARS).toBeGreaterThan(line.length * 4);
  });
});

describe("building only the rows a caller keeps", () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) => JSON.stringify({ id: `p-${String(i)}`, n: i })).join(
      "\n",
    );

  it("parses the lines that pass the filter and no others", async () => {
    const parse = vi.spyOn(JSON, "parse");
    parse.mockClear();

    const wanted = new Set(["p-3", "p-17"]);
    const { records, stats } = await readFilteredLinesStreaming<{ id: string; n: number }>(
      streamOf(rows(100), 1_000),
      {
        keep: (buffer, start, end) => {
          for (const id of wanted) {
            const needle = `{"id":"${id}"`;
            if (buffer.startsWith(needle, start) && start + needle.length <= end) return true;
          }
          return false;
        },
      },
    );

    expect(records.map((row) => row.id)).toEqual(["p-3", "p-17"]);
    expect(stats.linesScanned).toBe(100);
    expect(stats.linesParsed).toBe(2);
    expect(stats.rowsRetained).toBe(2);
    expect(
      parse,
      "ninety-eight lines were rejected before any of them became an object",
    ).toHaveBeenCalledTimes(2);
    parse.mockRestore();
  });

  it("builds every row when no filter is given", async () => {
    const { records } = await readFilteredLinesStreaming<{ id: string }>(
      streamOf(rows(10), 17),
      {},
    );
    expect(records).toHaveLength(10);
  });

  it("stops as soon as the caller has what it came for", async () => {
    const { records, stats } = await readFilteredLinesStreaming<{ id: string; n: number }>(
      streamOf(rows(10_000), 4_096),
      { take: (_row, retained) => (retained >= 1 ? "keep-and-stop" : "keep") },
    );
    expect(records).toHaveLength(2);
    expect(stats.stoppedEarly).toBe(true);
    /* And the rest of the body was never decoded, which is the saving. */
    expect(stats.chars).toBeLessThan(10_000);
  });

  it("throws on a line that passed the filter and will not parse", async () => {
    await expect(
      readFilteredLinesStreaming(streamOf('{"id":"a"}\n{"id":"b"', 4), {}),
    ).rejects.toThrow();
  });

  it("skips an unparseable line when the caller says it copes", async () => {
    const { records } = await readFilteredLinesStreaming<{ id: string }>(
      streamOf('{"id":"a"}\nnot json\n{"id":"c"}', 5),
      { onParseError: "skip" },
    );
    expect(records.map((row) => row.id)).toEqual(["a", "c"]);
  });

  it("gives a stateful filter its lines in order", async () => {
    /*
     * The pattern-proximity filter depends on this: it remembers which shapes passed near the bus
     * and then keeps the patterns referencing them, which only works because a shape is written
     * before the patterns that use it. A reader that delivered lines per chunk in any other order
     * would break it silently — the filter would simply find fewer patterns.
     */
    const order: number[] = [];
    await readFilteredLinesStreaming(streamOf(rows(40), 7), {
      keep: (_buffer, _start, _end, index) => {
        order.push(index);
        return false;
      },
    });
    expect(order).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });
});
