/**
 * Pattern stop sequences a journey takes by id, instead of scanning a tile for them.
 *
 * A journey reads its trips first and the trips name their patterns, so what it needs is the stop
 * sequences of a few hundred named patterns. The published pattern index is JSON lines, one per
 * pattern, so finding them means reading every line in every tile the corridor crosses: measured
 * on a real request, 2,098,153 of a journey's 2,316,100 decoded characters, 5,123 lines scanned to
 * keep the 1,090 it wanted. That is ninety-one per cent of a journey's text, spent on patterns it
 * discards.
 *
 * An isolate-level cache removes it for the *second* journey through a city and cannot help the
 * first, which measured 39 to 41 ms against a budget of ten. This is the form that helps the first
 * one: the same patterns, keyed so a reader can find each of them without reading the rest.
 *
 * ```
 *   header: 11 × u32
 *     0  magic 'BPST'        24  routeIndicesAt
 *     4  version             28  routeIdOffsetsAt
 *     8  patternCount        32  routeIdBlobAt
 *    12  callCount           36  routeCount
 *    16  stopIdOffsetsAt     40  byteLength
 *    20  stopIdBlobAt
 *   patternKeys    u8[patternCount × 16]   pattern uuids, ascending, binary-searchable
 *   callOffsets    u32[patternCount + 1]   where each pattern's calls begin
 *   stopIndices    u32[callCount]          into this tile's own stop table
 *   routeIndices   u32[patternCount]       into this tile's own service-route table
 *   stopIdOffsets  u32[stopCount + 1]      into the stop id blob
 *   stopIdBlob     utf-8                   each distinct stop id once, ascending
 *   routeIdOffsets u32[routeCount + 1]     into the route id blob
 *   routeIdBlob    utf-8                   each distinct service route id once, ascending
 * ```
 *
 * Three fields, because three are what a plan uses: the pattern's id, the stops it calls at in
 * order, and the service route it belongs to — the planner looks a leg's route up by that one id
 * to put a number on the badge. Direction, shape reference and pattern distance are left out
 * deliberately: a journey never reads them, and a caller that needs them reads the text index,
 * which keeps them.
 *
 * Two decisions carry the size. A pattern id is a UUID, so sixteen bytes holds it exactly where
 * thirty-six characters of text would; and a tile's stops are listed once and referenced by index,
 * where the text form repeats a stop's id in every sequence it appears in. Costed against the live
 * index before any of this was built: 225,978,836 bytes of text become 48,872,144, a ratio of
 * 0.216, over 2,097 tiles, 124,960 patterns and 5,095,167 calls. The route table adds four bytes
 * per pattern and one id per route in the tile, which is about a megabyte nationally.
 *
 * The keys are sorted so a reader binary-searches them. That is what makes this better than a
 * smaller copy of the same scan: the cost of finding one pattern is a handful of comparisons over
 * bytes rather than a walk through every line in the tile.
 *
 * One invariant carries the reader: **a published tile holds every pattern its text tile holds.**
 * That is what lets a reader which opened every tile of a corridor skip the text scan altogether
 * rather than only skip the patterns it found — without it, one pattern filed outside the corridor
 * would send every request back through the full scan and the family would buy nothing. The
 * publisher keeps the invariant by refusing to publish a tile at all when it holds a pattern this
 * format cannot key, so a tile that exists is complete and a tile that does not falls back.
 *
 * Reads per query are deliberately unchanged — the same tiles a corridor already opens, in a
 * different form. An artifact that needed more subrequests would be a worse artifact however small
 * it was, because a Workers Free invocation gets fifty of them.
 *
 * Every field is read through a `DataView`, so a tile works wherever in a buffer it lands: a
 * sliced R2 body can begin on any byte, and nothing here needs a four-byte boundary.
 */

import { SHARDED } from "./shards.js";

const MAGIC = 0x54535042; /* 'BPST' little-endian */
const VERSION = 1;
const HEADER_U32 = 11;
const HEADER_BYTES = HEADER_U32 * 4;
/** A UUID is sixteen bytes. Anything else is not a pattern id this format can hold. */
const KEY_BYTES = 16;

/** Where one tile's pattern stop sequences are published. */
export function journeyPatternStopsDataset(tile: string): string {
  return `${SHARDED.journeyPatternStops}/${tile}`;
}

/** One pattern as the publisher hands it over, and as a reader gets it back. */
export interface PatternStopSequence {
  readonly id: string;
  /** The service route the pattern belongs to: what a plan names a leg by. */
  readonly serviceRouteId: string;
  /** The stops it calls at, in order, with a repeat kept where the pattern repeats one. */
  readonly stopSequence: readonly string[];
}

const HEX = "0123456789abcdef";

/**
 * A pattern id as its sixteen bytes, or null when it is not a UUID.
 *
 * Null rather than a throw or a truncation: a key that is not sixteen bytes of the right id would
 * collide with a different pattern and answer a reader with another pattern's stops, which is a
 * wrong journey rather than a missing one. A publisher counts these and says so.
 */
export function patternKeyBytes(id: string): Uint8Array | null {
  if (id.length !== 36) return null;
  if (id[8] !== "-" || id[13] !== "-" || id[18] !== "-" || id[23] !== "-") return null;
  const bytes = new Uint8Array(KEY_BYTES);
  let at = 0;
  for (let index = 0; index < 36; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) continue;
    const high = HEX.indexOf(id[index]!.toLowerCase());
    const low = HEX.indexOf(id[index + 1]!.toLowerCase());
    if (high === -1 || low === -1) return null;
    bytes[at] = high * 16 + low;
    at += 1;
    index += 1;
  }
  return at === KEY_BYTES ? bytes : null;
}

/** The sixteen bytes back as the id they came from. */
function keyToUuid(bytes: Uint8Array, from: number): string {
  let text = "";
  for (let at = 0; at < KEY_BYTES; at += 1) {
    if (at === 4 || at === 6 || at === 8 || at === 10) text += "-";
    const byte = bytes[from + at]!;
    text += HEX[byte >> 4]! + HEX[byte & 15]!;
  }
  return text;
}

/** Byte order over two keys, so the encoder's sort and the reader's search are one rule. */
function compareKeys(left: Uint8Array, leftAt: number, right: Uint8Array, rightAt: number): number {
  for (let at = 0; at < KEY_BYTES; at += 1) {
    const a = left[leftAt + at]!;
    const b = right[rightAt + at]!;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

export interface EncodedPatternStops {
  bytes: Uint8Array;
  patterns: number;
  calls: number;
  stops: number;
  routes: number;
  /** Patterns left out because their id is not a UUID. Counted so a publish can report it. */
  skipped: number;
}

/** A table of distinct ids, ascending, with each one's offset into a blob of bytes. */
function idTable(ids: readonly string[]): {
  ids: string[];
  indexOf: Map<string, number>;
  bytes: Uint8Array[];
  blobLength: number;
} {
  const sorted = [...new Set(ids)].sort();
  const encoder = new TextEncoder();
  const bytes = sorted.map((id) => encoder.encode(id));
  return {
    ids: sorted,
    indexOf: new Map(sorted.map((id, index) => [id, index])),
    bytes,
    blobLength: bytes.reduce((total, part) => total + part.byteLength, 0),
  };
}

/**
 * One tile's patterns, encoded.
 *
 * Patterns are sorted by key so the reader can binary-search; stops and routes are sorted by id so
 * the blobs are deterministic and two publishes of the same tile produce the same bytes. That last
 * property is what makes the publisher resumable: a tile already at this version can be skipped
 * without wondering whether it would have been written differently this time.
 */
export function encodePatternStops(patterns: readonly PatternStopSequence[]): EncodedPatternStops {
  const keyed: Array<{ key: Uint8Array; pattern: PatternStopSequence }> = [];
  let skipped = 0;
  for (const pattern of patterns) {
    const key = patternKeyBytes(pattern.id);
    if (key === null) {
      skipped += 1;
      continue;
    }
    keyed.push({ key, pattern });
  }
  keyed.sort((a, b) => compareKeys(a.key, 0, b.key, 0));

  const stops = idTable(keyed.flatMap((entry) => entry.pattern.stopSequence));
  const routes = idTable(keyed.map((entry) => entry.pattern.serviceRouteId));

  const callCount = keyed.reduce((total, entry) => total + entry.pattern.stopSequence.length, 0);

  const keysAt = HEADER_BYTES;
  const callOffsetsAt = keysAt + keyed.length * KEY_BYTES;
  const stopIndicesAt = callOffsetsAt + (keyed.length + 1) * 4;
  const routeIndicesAt = stopIndicesAt + callCount * 4;
  const stopIdOffsetsAt = routeIndicesAt + keyed.length * 4;
  const stopIdBlobAt = stopIdOffsetsAt + (stops.ids.length + 1) * 4;
  const routeIdOffsetsAt = stopIdBlobAt + stops.blobLength;
  const routeIdBlobAt = routeIdOffsetsAt + (routes.ids.length + 1) * 4;
  const byteLength = routeIdBlobAt + routes.blobLength;

  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, keyed.length, true);
  view.setUint32(12, callCount, true);
  view.setUint32(16, stopIdOffsetsAt, true);
  view.setUint32(20, stopIdBlobAt, true);
  view.setUint32(24, routeIndicesAt, true);
  view.setUint32(28, routeIdOffsetsAt, true);
  view.setUint32(32, routeIdBlobAt, true);
  view.setUint32(36, routes.ids.length, true);
  view.setUint32(40, byteLength, true);

  let call = 0;
  for (let at = 0; at < keyed.length; at += 1) {
    const entry = keyed[at]!;
    bytes.set(entry.key, keysAt + at * KEY_BYTES);
    view.setUint32(callOffsetsAt + at * 4, call, true);
    view.setUint32(
      routeIndicesAt + at * 4,
      routes.indexOf.get(entry.pattern.serviceRouteId)!,
      true,
    );
    for (const stopId of entry.pattern.stopSequence) {
      view.setUint32(stopIndicesAt + call * 4, stops.indexOf.get(stopId)!, true);
      call += 1;
    }
  }
  view.setUint32(callOffsetsAt + keyed.length * 4, call, true);

  writeBlob(bytes, view, stops.bytes, stopIdOffsetsAt, stopIdBlobAt);
  writeBlob(bytes, view, routes.bytes, routeIdOffsetsAt, routeIdBlobAt);

  return {
    bytes,
    patterns: keyed.length,
    calls: callCount,
    stops: stops.ids.length,
    routes: routes.ids.length,
    skipped,
  };
}

function writeBlob(
  bytes: Uint8Array,
  view: DataView,
  parts: readonly Uint8Array[],
  offsetsAt: number,
  blobAt: number,
): void {
  let into = 0;
  for (let at = 0; at < parts.length; at += 1) {
    view.setUint32(offsetsAt + at * 4, into, true);
    bytes.set(parts[at]!, blobAt + into);
    into += parts[at]!.byteLength;
  }
  view.setUint32(offsetsAt + parts.length * 4, into, true);
}

/**
 * One published tile, read in place.
 *
 * Nothing is decoded until a pattern is asked for by id, and then only that pattern. A corridor
 * asking for two hundred of a tile's eight hundred decodes two hundred sequences and never touches
 * the rest, which is the whole difference from the text form.
 */
export class PatternStopsTile {
  private readonly view: DataView;
  readonly patternCount: number;
  readonly callCount: number;
  readonly routeCount: number;
  readonly byteLength: number;
  private readonly keysAt: number;
  private readonly callOffsetsAt: number;
  private readonly stopIndicesAt: number;
  private readonly routeIndicesAt: number;
  private readonly stopIdOffsetsAt: number;
  private readonly stopIdBlobAt: number;
  private readonly routeIdOffsetsAt: number;
  private readonly routeIdBlobAt: number;
  private readonly decoder = new TextDecoder();
  /** Ids already decoded, since a corridor's patterns share most of their stops and routes. */
  private readonly stopIds = new Map<number, string>();
  private readonly routeIds = new Map<number, string>();

  constructor(private readonly bytes: Uint8Array) {
    if (bytes.byteLength < HEADER_BYTES) throw new Error("pattern stops tile is too short");
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (this.view.getUint32(0, true) !== MAGIC) throw new Error("not a pattern stops tile");
    const version = this.view.getUint32(4, true);
    if (version !== VERSION) throw new Error(`pattern stops tile version ${String(version)}`);
    this.patternCount = this.view.getUint32(8, true);
    this.callCount = this.view.getUint32(12, true);
    this.stopIdOffsetsAt = this.view.getUint32(16, true);
    this.stopIdBlobAt = this.view.getUint32(20, true);
    this.routeIndicesAt = this.view.getUint32(24, true);
    this.routeIdOffsetsAt = this.view.getUint32(28, true);
    this.routeIdBlobAt = this.view.getUint32(32, true);
    this.routeCount = this.view.getUint32(36, true);
    this.byteLength = this.view.getUint32(40, true);
    if (this.byteLength !== bytes.byteLength) {
      throw new Error(
        `pattern stops tile says ${String(this.byteLength)} bytes, got ${String(bytes.byteLength)}`,
      );
    }
    this.keysAt = HEADER_BYTES;
    this.callOffsetsAt = this.keysAt + this.patternCount * KEY_BYTES;
    this.stopIndicesAt = this.callOffsetsAt + (this.patternCount + 1) * 4;
  }

  /** Where a pattern sits in this tile, or -1. A binary search over the stored keys. */
  indexOf(patternId: string): number {
    const wanted = patternKeyBytes(patternId);
    if (wanted === null) return -1;
    let low = 0;
    let high = this.patternCount - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const order = compareKeys(this.bytes, this.keysAt + mid * KEY_BYTES, wanted, 0);
      if (order === 0) return mid;
      if (order < 0) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  /** One id out of a blob, decoded once and held. */
  private idAt(
    held: Map<number, string>,
    offsetsAt: number,
    blobAt: number,
    index: number,
  ): string {
    const already = held.get(index);
    if (already !== undefined) return already;
    const from = this.view.getUint32(offsetsAt + index * 4, true);
    const to = this.view.getUint32(offsetsAt + (index + 1) * 4, true);
    const id = this.decoder.decode(this.bytes.subarray(blobAt + from, blobAt + to));
    held.set(index, id);
    return id;
  }

  /** The id of the pattern at this index, back out of its key. */
  patternIdAt(index: number): string {
    return keyToUuid(this.bytes, this.keysAt + index * KEY_BYTES);
  }

  /** The service route of the pattern at this index. */
  serviceRouteIdAt(index: number): string {
    return this.idAt(
      this.routeIds,
      this.routeIdOffsetsAt,
      this.routeIdBlobAt,
      this.view.getUint32(this.routeIndicesAt + index * 4, true),
    );
  }

  /** The stop sequence of the pattern at this index. */
  stopSequenceAt(index: number): string[] {
    const from = this.view.getUint32(this.callOffsetsAt + index * 4, true);
    const to = this.view.getUint32(this.callOffsetsAt + (index + 1) * 4, true);
    const sequence = new Array<string>(to - from);
    for (let call = from; call < to; call += 1) {
      sequence[call - from] = this.idAt(
        this.stopIds,
        this.stopIdOffsetsAt,
        this.stopIdBlobAt,
        this.view.getUint32(this.stopIndicesAt + call * 4, true),
      );
    }
    return sequence;
  }

  /** The whole pattern at this index. */
  patternAt(index: number): PatternStopSequence {
    return {
      id: this.patternIdAt(index),
      serviceRouteId: this.serviceRouteIdAt(index),
      stopSequence: this.stopSequenceAt(index),
    };
  }

  /** The stop sequence of a pattern by id, or null when this tile does not hold it. */
  stopSequenceOf(patternId: string): string[] | null {
    const index = this.indexOf(patternId);
    return index < 0 ? null : this.stopSequenceAt(index);
  }

  /** A pattern by id, or null when this tile does not hold it. */
  patternOf(patternId: string): PatternStopSequence | null {
    const index = this.indexOf(patternId);
    return index < 0 ? null : this.patternAt(index);
  }
}

/**
 * Whether these bytes hold what these patterns held.
 *
 * Read back out of the encoded form rather than compared against the encoder's own state: what
 * matters is that a reader opening the bytes sees the same patterns, and the only honest way to
 * check that is to open them the way a reader will. This is what the publisher runs before it
 * counts a tile as published.
 */
export function tileHoldsEveryPattern(
  bytes: Uint8Array,
  patterns: readonly PatternStopSequence[],
): { ok: true } | { ok: false; reason: string } {
  let tile: PatternStopsTile;
  try {
    tile = new PatternStopsTile(bytes);
  } catch (error) {
    return { ok: false, reason: `will not open: ${String(error).slice(0, 120)}` };
  }
  for (const pattern of patterns) {
    if (patternKeyBytes(pattern.id) === null) continue;
    const index = tile.indexOf(pattern.id);
    if (index < 0) return { ok: false, reason: `missing pattern ${pattern.id}` };
    if (tile.patternIdAt(index) !== pattern.id) {
      return { ok: false, reason: `pattern ${pattern.id} came back as ${tile.patternIdAt(index)}` };
    }
    if (tile.serviceRouteIdAt(index) !== pattern.serviceRouteId) {
      return { ok: false, reason: `pattern ${pattern.id} is on the wrong service route` };
    }
    const sequence = tile.stopSequenceAt(index);
    if (sequence.length !== pattern.stopSequence.length) {
      return {
        ok: false,
        reason: `pattern ${pattern.id} has ${String(sequence.length)} calls, expected ${String(pattern.stopSequence.length)}`,
      };
    }
    for (let at = 0; at < sequence.length; at += 1) {
      if (sequence[at] !== pattern.stopSequence[at]) {
        return { ok: false, reason: `pattern ${pattern.id} call ${String(at)} is the wrong stop` };
      }
    }
  }
  return { ok: true };
}
