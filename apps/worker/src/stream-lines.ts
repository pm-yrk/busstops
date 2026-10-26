/**
 * One streaming line reader, for every large line-oriented object this Worker reads.
 *
 * Cloudflare's own list of remedies for a Worker that exceeds its memory limit begins with
 * "stream responses or large payloads instead of buffering entire payloads in memory", and until
 * now this Worker did the opposite everywhere: `R2BindingStore.get` called `object.text()`, so a
 * pattern tile arrived as one three-to-five-megabyte string before a single line of it was looked
 * at. The limit that kills these requests is **per isolate, not per invocation** — an isolate that
 * has served about a hundred passenger requests reaches 128 MB and the runtime then sheds whatever
 * arrives next, irrespective of what that request costs. Which is why a paced walk passes
 * fifty-four requests in a row and then loses a third of the next fifty, and why an 87,543-
 * character `nearby` dies while a 5,008,974-character read a minute earlier does not.
 *
 * So the string is never built. A chunk at a time is decoded, complete lines are handed to the
 * caller as offsets into the buffer that happens to hold them, and the buffer is cut back to the
 * partial line at its end. What is held at once is one chunk plus one line, not one object.
 *
 * Three things here are deliberate and each is a test in `stream-lines.test.ts`:
 *
 * **The callback gets `(body, start, end)`, not a string.** That is the signature the existing
 * line filters already have, so every one of them — the pattern-id test, the search-word test, the
 * proximity test — works unchanged and still rejects a line without allocating it. A reader that
 * handed over `string` would have to slice every line it looked at, which is the allocation this
 * exists to remove, only spread over forty thousand small ones instead of one big one.
 *
 * **A line's ordinal comes with it.** A header line is identified by being first, and the old
 * whole-object filters could say `start === 0` for that. Streaming makes that wrong rather than
 * imprecise: when a chunk boundary falls exactly after a newline the next line genuinely begins at
 * offset zero of the buffer, so a filter testing the offset would keep an arbitrary row and call
 * it the header.
 *
 * **A line that never ends is refused rather than carried.** The carry buffer is the one thing
 * here that can grow to the size of the object, which would reproduce the allocation exactly. So
 * it is capped, and the cap is a measurement: see `MAX_LINE_CHARS`.
 */

/**
 * A test on one line, as offsets into whatever buffer currently holds it.
 *
 * `index` is the line's ordinal in the object, counted from zero over non-empty lines, and is how
 * a header is recognised. Called in order, so a filter may be stateful — the pattern-proximity
 * filter remembers which shapes passed near the bus and then keeps the patterns that reference
 * them, which only works because the shapes are written before the patterns that use them.
 */
export type LinePredicate = (body: string, start: number, end: number, index: number) => boolean;

/** What a streamed read consumed. Reported to the ledger, and asserted by the isolate tests. */
export interface StreamLineStats {
  /**
   * Characters decoded from the body. This is what the isolate actually saw, which is the whole
   * point of reporting it: a read that stopped early decoded less than the object holds, and the
   * old `charsDecoded` — the length of the whole string — could not say so.
   */
  chars: number;
  /** Chunks the stream delivered. */
  chunks: number;
  /** Non-empty lines walked. */
  linesScanned: number;
  /** Lines the predicate kept and that were therefore parsed. */
  linesParsed: number;
  /** Rows handed back to the caller. Differs from `linesParsed` when a row is parsed and dropped. */
  rowsRetained: number;
  /** The longest partial line carried across a chunk boundary. The bound that matters. */
  maxCarryChars: number;
  /** The largest buffer held at once: one chunk plus whatever partial line preceded it. */
  maxBufferChars: number;
  /** True when the caller said it had enough and the rest of the body was cancelled. */
  stoppedEarly: boolean;
  /** True when a line exceeded `MAX_LINE_CHARS`. The read then fails rather than truncating. */
  oversizedLine: boolean;
}

function emptyStats(): StreamLineStats {
  return {
    chars: 0,
    chunks: 0,
    linesScanned: 0,
    linesParsed: 0,
    rowsRetained: 0,
    maxCarryChars: 0,
    maxBufferChars: 0,
    stoppedEarly: false,
    oversizedLine: false,
  };
}

/**
 * The longest line a published object may contain, measured rather than guessed.
 *
 * Measured against the live artifact by `scripts/measure-lines.ts`, which opens the largest
 * objects of every family and reports the longest line in each. The guard exists because the carry
 * buffer is the one allocation in a streaming read that can reach the size of the object: an
 * object with no newline in it at all — a truncated write, a JSON array published where JSONL was
 * expected, a body that is actually an error page — would be carried in full, which is the
 * allocation being removed.
 *
 * The cap is the measured maximum with an order of magnitude of headroom, so a family growing by
 * half is unremarkable and a missing newline is not. Exceeding it makes the read **fail**: the
 * object is unavailable, and the caller's completeness flag says so. It is deliberately not a
 * truncation, because half a JSON row either throws or, worse, parses into a different row.
 */
export const MAX_LINE_CHARS = 2 * 1024 * 1024;

/** A line longer than the cap. Distinct from a parse failure: the object is malformed, not the row. */
export class OversizedLineError extends Error {
  constructor(
    readonly chars: number,
    readonly cap: number,
    readonly key?: string,
  ) {
    super(
      `a line of at least ${String(chars)} characters exceeds the ${String(cap)}-character cap` +
        (key === undefined ? "" : ` in ${key}`),
    );
    this.name = "OversizedLineError";
  }
}

/** What `onLine` returns to end the read without consuming the rest of the body. */
export type LineVerdict = void | "stop";

export interface StreamLinesOptions {
  /** Overridable so a test can make the guard bite on a fixture small enough to read. */
  maxLineChars?: number;
  /** Named in the error when a line is oversized, so a report says which object was malformed. */
  key?: string;
}

/**
 * Walks a body's lines without ever holding more than a chunk and a line.
 *
 * `onLine` is called with the buffer and the line's bounds inside it; returning `"stop"` cancels
 * the rest of the body. The stream's reader is released in every path, including a failure, and a
 * read that fails is propagated rather than reported as an empty object — "no rows" and "we could
 * not read it" are different answers and every caller here distinguishes them.
 */
export async function streamLines(
  body: ReadableStream<Uint8Array>,
  onLine: (buffer: string, start: number, end: number, index: number) => LineVerdict,
  options: StreamLinesOptions = {},
): Promise<StreamLineStats> {
  const cap = options.maxLineChars ?? MAX_LINE_CHARS;
  const stats = emptyStats();
  const decoder = new TextDecoder("utf-8");
  const reader = body.getReader();

  let carry = "";
  let index = 0;
  let stop = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stats.chunks += 1;

      /*
       * `stream: true` so a multi-byte character split across a chunk boundary is held by the
       * decoder rather than turned into a replacement character. A UTF-8 name with an accent in it
       * is exactly the kind of row that would otherwise fail to parse once in a few thousand reads
       * — the sort of bug that is found by a passenger rather than by a test.
       */
      const text = decoder.decode(value, { stream: true });
      stats.chars += text.length;
      if (text.length === 0) continue;

      carry = carry.length === 0 ? text : carry + text;
      if (carry.length > stats.maxBufferChars) stats.maxBufferChars = carry.length;

      let from = 0;
      for (;;) {
        const newline = carry.indexOf("\n", from);
        if (newline < 0) break;
        /* Tolerate CRLF. These artifacts are written with newlines, but a body from anywhere else. */
        const end = newline > from && carry.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
        if (end > from) {
          stats.linesScanned += 1;
          if (onLine(carry, from, end, index) === "stop") stop = true;
          index += 1;
        }
        from = newline + 1;
        if (stop) break;
      }

      if (from > 0) carry = carry.slice(from);
      if (carry.length > stats.maxCarryChars) stats.maxCarryChars = carry.length;

      if (stop) {
        stats.stoppedEarly = true;
        break;
      }
      /*
       * Checked after the cut, so this is the length of one line in progress rather than of the
       * chunk that arrived. Thrown rather than carried: the alternative is to keep concatenating
       * until the buffer is the object, which is the allocation this file exists to remove.
       */
      if (carry.length > cap) {
        stats.oversizedLine = true;
        throw new OversizedLineError(carry.length, cap, options.key);
      }
    }

    if (!stop) {
      /* Whatever the decoder was holding, then the last line if the body did not end in a newline. */
      const tail = decoder.decode();
      if (tail.length > 0) {
        stats.chars += tail.length;
        carry += tail;
        if (carry.length > stats.maxBufferChars) stats.maxBufferChars = carry.length;
        if (carry.length > stats.maxCarryChars) stats.maxCarryChars = carry.length;
      }
      if (carry.length > cap) {
        stats.oversizedLine = true;
        throw new OversizedLineError(carry.length, cap, options.key);
      }
      const end =
        carry.length > 0 && carry.charCodeAt(carry.length - 1) === 13
          ? carry.length - 1
          : carry.length;
      if (end > 0) {
        stats.linesScanned += 1;
        onLine(carry, 0, end, index);
      }
    }
  } finally {
    /*
     * Cancelled only when this reader chose to stop: cancelling a body that ended on its own is
     * pointless, and cancelling one that threw would replace the error with whatever cancel does.
     * The lock is released in every path, so a body is never left locked to a reader nobody holds.
     */
    if (stop) {
      try {
        await reader.cancel();
      } catch {
        /* A body that will not cancel has already given us everything we asked for. */
      }
    }
    reader.releaseLock();
  }

  return stats;
}

export interface FilteredLinesOptions<T> extends StreamLinesOptions {
  /**
   * Which lines to build, tested against the raw line before it is parsed.
   *
   * Absent means every line, which is what a caller that wants the whole tile asks for. The
   * saving here is the parse and the object graph, not the transfer: the bytes arrive either way,
   * and `JSON.parse` on forty thousand rows to keep a hundred is the part that runs on the
   * isolate's ten milliseconds of CPU.
   */
  keep?: LinePredicate;
  /**
   * Whether the row that was just built should be kept, and whether to stop.
   *
   * A read for one stop's row in a departure shard wants exactly one line and then nothing; a
   * read for a hundred pattern ids wants to stop when it has a hundred. Stopping cancels the rest
   * of the body, so the characters after the last wanted row are never decoded at all.
   */
  take?: (row: T, retained: number) => "keep" | "stop" | "keep-and-stop" | "drop";
  /**
   * What to do with a line that passed the filter and will not parse.
   *
   * `throw` by default, which is what the buffered readers did: a shard whose rows do not parse is
   * a fault in the artifact, and answering a passenger from the half of it that happened to work
   * is how a quietly wrong board gets published. Callers that already cope with an unnameable
   * record pass `skip`.
   */
  onParseError?: "throw" | "skip";
}

export interface FilteredLinesResult<T> {
  records: T[];
  stats: StreamLineStats;
}

/**
 * The rows a caller wants, built from a stream, with nothing else parsed and nothing buffered.
 *
 * This is the replacement for `const raw = await store.get(key)` followed by a walk over `raw`:
 * same records, same order, same completeness semantics, without the one allocation the size of
 * the object.
 */
export async function readFilteredLinesStreaming<T>(
  body: ReadableStream<Uint8Array>,
  options: FilteredLinesOptions<T> = {},
): Promise<FilteredLinesResult<T>> {
  const records: T[] = [];
  const keep = options.keep;
  const take = options.take;
  const skipUnparseable = options.onParseError === "skip";

  /*
   * Counted in this call's own closure, not on a shared object. These functions are called
   * concurrently — a map request reads four tiles at once — and a counter anywhere outside one
   * call would blend them into a number describing neither, which is the mistake the read ledger
   * was created to stop making about requests.
   */
  let linesParsed = 0;
  let rowsRetained = 0;

  const stats = await streamLines(
    body,
    (buffer, start, end, index) => {
      if (keep && !keep(buffer, start, end, index)) return;
      let row: T;
      try {
        /* The one slice that is unavoidable, and only for a line the caller is keeping. */
        row = JSON.parse(buffer.slice(start, end)) as T;
      } catch (error) {
        if (skipUnparseable) return;
        throw error;
      }
      linesParsed += 1;
      const verdict = take ? take(row, rowsRetained) : "keep";
      if (verdict === "keep" || verdict === "keep-and-stop") {
        records.push(row);
        rowsRetained += 1;
      }
      if (verdict === "stop" || verdict === "keep-and-stop") return "stop";
      return;
    },
    options,
  );

  return { records, stats: { ...stats, linesParsed, rowsRetained } };
}
