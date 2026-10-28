/**
 * Walking transfers, published per tile instead of computed per request.
 *
 * Stops do not move. The walking time between two of them is a property of the published network,
 * not of a passenger's question — and yet a journey request was computing it from scratch every
 * time: a Manchester corridor holds 108,284 transfer edges over 2,063 stops, a Birmingham one
 * 126,952, and building them measured 21 to 25 milliseconds against the ten a Workers Free
 * invocation is allowed for everything. It was the largest single item left in the endpoint after
 * the trip parse moved into the published form.
 *
 * So they are published. The layout is the same one the search walks — offsets into a flat
 * neighbour array, with the walk alongside — so the reader decodes into the structure it uses
 * rather than into an object graph it would then have to walk. Integer index space, no coordinates,
 * no names, no route or display data: the only strings are the stop ids, and they sit at the end
 * because a search touches one per edge it actually takes, not one per edge it considers.
 *
 * ```
 *   header: 8 × u32
 *     0  magic 'BTRN'        16  capSeconds
 *     4  version             20  idOffsetsAt
 *     8  stopCount           24  idBlobAt
 *    12  edgeCount           28  byteLength
 *   offsets     u32[stopCount + 1]   where each stop's edges begin
 *   neighbours  u32[edgeCount]       the stop index each edge reaches
 *   seconds     u16[edgeCount]       the walk, in seconds
 *   idOffsets   u32[stopCount + 1]   into the id blob
 *   idBlob      utf-8                stop ids, in ascending order
 * ```
 *
 * One tile holds every stop whose coordinate falls inside it, plus the stops outside it that are
 * within the walking cap of one of those — the halo — so that a stop's neighbour list is complete
 * whichever side of a boundary the neighbour is on. A corridor reads the tiles its stops are in and
 * every edge it needs is in one of them, which is what makes the partitioning exact rather than
 * nearly right.
 *
 * `capSeconds` is in the header because an adjacency is only valid for the cap it was built under.
 * A reader asked for a different cap must not quietly use these: it has to fall back and say so.
 */

import { SHARDED } from "./shards.js";

const MAGIC = 0x4e525442; /* 'BTRN' little-endian */
const VERSION = 1;
const HEADER_U32 = 8;
const HEADER_BYTES = HEADER_U32 * 4;
const MAX_WALK_SECONDS = 0xffff;

/** Where one tile's transfers are published. */
export function journeyTransfersDataset(tile: string): string {
  return `${SHARDED.journeyTransfers}/${tile}`;
}

export interface TransferTileInput {
  /** Stop ids, ascending. The index space for `neighbours`. */
  stopIds: readonly string[];
  /** `stopCount + 1` entries: stop `i`'s edges are `offsets[i]` up to `offsets[i + 1]`. */
  offsets: Uint32Array;
  neighbours: Uint32Array;
  seconds: Uint32Array;
  capSeconds: number;
}

export interface TransferTileStats {
  stops: number;
  edges: number;
  bytes: number;
  /** Walks longer than a sixteen-bit second count, clamped to the cap. Expected to be zero. */
  clampedWalks: number;
}

const align4 = (value: number): number => (value + 3) & ~3;

export function encodeTransferTile(input: TransferTileInput): {
  bytes: Uint8Array;
  stats: TransferTileStats;
} {
  const stopCount = input.stopIds.length;
  const edgeCount = input.neighbours.length;
  if (input.offsets.length !== stopCount + 1) {
    throw new Error(
      `transfer tile: ${String(input.offsets.length)} offsets for ${String(stopCount)} stops`,
    );
  }
  if (input.seconds.length !== edgeCount) {
    throw new Error("transfer tile: seconds and neighbours disagree about the edge count");
  }

  const encoder = new TextEncoder();
  const idBytes = input.stopIds.map((id) => encoder.encode(id));
  const idBlobLength = idBytes.reduce((total, part) => total + part.length, 0);

  const offsetsAt = HEADER_BYTES;
  const neighboursAt = offsetsAt + (stopCount + 1) * 4;
  const secondsAt = neighboursAt + edgeCount * 4;
  const idOffsetsAt = align4(secondsAt + edgeCount * 2);
  const idBlobAt = idOffsetsAt + (stopCount + 1) * 4;
  const byteLength = idBlobAt + idBlobLength;

  const bytes = new Uint8Array(byteLength);
  const header = new Uint32Array(bytes.buffer, 0, HEADER_U32);
  header[0] = MAGIC;
  header[1] = VERSION;
  header[2] = stopCount;
  header[3] = edgeCount;
  header[4] = input.capSeconds;
  header[5] = idOffsetsAt;
  header[6] = idBlobAt;
  header[7] = byteLength;

  new Uint32Array(bytes.buffer, offsetsAt, stopCount + 1).set(input.offsets);
  new Uint32Array(bytes.buffer, neighboursAt, edgeCount).set(input.neighbours);

  const view = new DataView(bytes.buffer);
  let clampedWalks = 0;
  for (let edge = 0; edge < edgeCount; edge += 1) {
    let walk = input.seconds[edge]!;
    if (walk > MAX_WALK_SECONDS) {
      walk = MAX_WALK_SECONDS;
      clampedWalks += 1;
    }
    view.setUint16(secondsAt + edge * 2, walk, true);
  }

  const idOffsets = new Uint32Array(bytes.buffer, idOffsetsAt, stopCount + 1);
  let at = 0;
  for (let stop = 0; stop < stopCount; stop += 1) {
    idOffsets[stop] = at;
    bytes.set(idBytes[stop]!, idBlobAt + at);
    at += idBytes[stop]!.length;
  }
  idOffsets[stopCount] = at;

  return {
    bytes,
    stats: { stops: stopCount, edges: edgeCount, bytes: byteLength, clampedWalks },
  };
}

/** One published tile's transfers, read in place. */
export class TransferTile {
  readonly stopCount: number;
  readonly edgeCount: number;
  readonly capSeconds: number;

  private readonly bytes: Uint8Array;
  private readonly offsetsArray: Uint32Array;
  private readonly neighboursArray: Uint32Array;
  private readonly secondsAt: number;
  private readonly view: DataView;
  private readonly idOffsets: Uint32Array;
  private readonly idBlobAt: number;
  private readonly decoder = new TextDecoder();
  private decodedIds: string[] | null = null;
  private decodedSeconds: Uint16Array | null = null;

  constructor(input: Uint8Array | ArrayBuffer) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    /* A copy only when the body does not begin on a four-byte boundary, which a sliced R2 body can
     * fail to do and which a `Uint32Array` view refuses. The normal case copies nothing. */
    this.bytes = bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes);
    const base = this.bytes.byteOffset;
    const buffer = this.bytes.buffer;
    const header = new Uint32Array(buffer, base, HEADER_U32);
    if (header[0] !== MAGIC) throw new Error("not a published transfer tile");
    if (header[1] !== VERSION) {
      throw new Error(`unsupported transfer tile version ${String(header[1])}`);
    }
    this.stopCount = header[2]!;
    this.edgeCount = header[3]!;
    this.capSeconds = header[4]!;
    const idOffsetsAt = header[5]!;
    this.idBlobAt = header[6]!;
    if (header[7]! > this.bytes.byteLength) throw new Error("truncated transfer tile");

    const offsetsAt = HEADER_BYTES;
    const neighboursAt = offsetsAt + (this.stopCount + 1) * 4;
    this.offsetsArray = new Uint32Array(buffer, base + offsetsAt, this.stopCount + 1);
    this.neighboursArray = new Uint32Array(buffer, base + neighboursAt, this.edgeCount);
    this.secondsAt = base + neighboursAt + this.edgeCount * 4;
    this.view = new DataView(buffer);
    this.idOffsets = new Uint32Array(buffer, base + idOffsetsAt, this.stopCount + 1);
  }

  firstEdge(stop: number): number {
    return this.offsetsArray[stop]!;
  }

  edgeEnd(stop: number): number {
    return this.offsetsArray[stop + 1]!;
  }

  neighbourAt(edge: number): number {
    return this.neighboursArray[edge]!;
  }

  secondsOf(edge: number): number {
    return this.view.getUint16(this.secondsAt + edge * 2, true);
  }

  /** The offsets, as the view over the bytes: no copy. */
  offsets(): Uint32Array {
    return this.offsetsArray;
  }

  /** The neighbour indices, as the view over the bytes: no copy. */
  neighbours(): Uint32Array {
    return this.neighboursArray;
  }

  /**
   * The walks, as one aligned array.
   *
   * The bytes hold them as sixteen-bit values after an odd number of word-sized sections, so a
   * `Uint16Array` cannot be a view over them — this copies, once, and keeps it. Two bytes an edge
   * is a tenth of what the objects it replaces would cost, and a bulk merge wants the array rather
   * than a call per edge.
   */
  walkSeconds(): Uint16Array {
    if (this.decodedSeconds !== null) return this.decodedSeconds;
    const seconds = new Uint16Array(this.edgeCount);
    for (let edge = 0; edge < this.edgeCount; edge += 1) {
      seconds[edge] = this.view.getUint16(this.secondsAt + edge * 2, true);
    }
    this.decodedSeconds = seconds;
    return seconds;
  }

  /** One stop's id. Allocates a string, so a caller that needs them all asks for `stopIds()`. */
  stopIdAt(stop: number): string {
    const from = this.idBlobAt + this.idOffsets[stop]!;
    const to = this.idBlobAt + this.idOffsets[stop + 1]!;
    return this.decoder.decode(this.bytes.subarray(from, to));
  }

  /**
   * Every stop id, decoded once.
   *
   * Held, because a published tile is immutable for its version: a reader that keeps the tile
   * keeps this, and the second journey through the same tile pays nothing for it.
   */
  stopIds(): readonly string[] {
    if (this.decodedIds !== null) return this.decodedIds;
    const ids: string[] = new Array<string>(this.stopCount);
    for (let stop = 0; stop < this.stopCount; stop += 1) ids[stop] = this.stopIdAt(stop);
    this.decodedIds = ids;
    return ids;
  }
}
