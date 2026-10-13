import { appendFileSync, createReadStream, mkdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

/**
 * Somewhere to put a national timetable while it is being sorted into tiles.
 *
 * The streaming GTFS build emits journeys one at a time and never holds them, which solves half
 * the problem. The other half is that they arrive in trip order and have to leave in tile order,
 * and a national build's worth of journeys will not sit in memory while that reordering happens.
 *
 * So they go to disk, one file per tile, and are read back a tile at a time when each is
 * published. Peak memory is the write buffer, which is bounded below; peak disk is the size of
 * the timetable, which a runner has and an isolate does not.
 *
 * Two things it deliberately does not do: keep a file handle per tile (a national build has
 * thousands of tiles and the process would run out), or buffer per tile without a global bound (a
 * few thousand half-full buffers is the same memory problem in a different shape).
 */

/**
 * Total buffered bytes before the fullest tiles are written out.
 *
 * 32 MiB is chosen against the runner rather than the edge: this never runs in an isolate. Too
 * small and the job becomes one syscall per journey; too large and the buffer is the memory
 * problem it exists to avoid.
 */
const FLUSH_THRESHOLD_BYTES = 32 * 1024 * 1024;

export interface SpillStats {
  tiles: number;
  lines: number;
  bytes: number;
  /** Times the buffer filled and had to be written out — a cheap picture of the write pattern. */
  flushes: number;
}

export class TileSpill {
  private readonly buffers = new Map<string, string[]>();
  private readonly bufferedBytes = new Map<string, number>();
  private readonly lineCounts = new Map<string, number>();
  private totalBuffered = 0;
  private flushes = 0;
  private totalLines = 0;
  private totalBytes = 0;

  constructor(
    private readonly directory: string,
    private readonly thresholdBytes = FLUSH_THRESHOLD_BYTES,
  ) {
    mkdirSync(directory, { recursive: true });
  }

  private pathFor(tile: string): string {
    // Tile keys are the pipeline's own and contain no separators, but a name is a filesystem path
    // the moment it is joined, so anything unexpected is neutralised rather than trusted.
    return join(this.directory, `${tile.replace(/[^\w.-]/g, "_")}.jsonl`);
  }

  /** Appends one record to a tile. The line must not itself contain a newline. */
  append(tile: string, line: string): void {
    const buffer = this.buffers.get(tile);
    if (buffer) buffer.push(line);
    else this.buffers.set(tile, [line]);

    const size = Buffer.byteLength(line, "utf8") + 1;
    this.bufferedBytes.set(tile, (this.bufferedBytes.get(tile) ?? 0) + size);
    this.lineCounts.set(tile, (this.lineCounts.get(tile) ?? 0) + 1);
    this.totalBuffered += size;
    this.totalLines += 1;
    this.totalBytes += size;

    if (this.totalBuffered >= this.thresholdBytes) this.flushLargest();
  }

  /**
   * Writes out the fullest tiles until the buffer is comfortably under the threshold.
   *
   * The fullest first, rather than all of them: a national build has a long tail of tiles holding
   * three journeys each, and flushing those costs a syscall to save a few hundred bytes.
   */
  private flushLargest(): void {
    const bySize = [...this.bufferedBytes.entries()].sort((a, b) => b[1] - a[1]);
    const target = this.thresholdBytes / 2;
    for (const [tile] of bySize) {
      if (this.totalBuffered <= target) break;
      this.flushTile(tile);
    }
    this.flushes += 1;
  }

  private flushTile(tile: string): void {
    const buffer = this.buffers.get(tile);
    if (!buffer || buffer.length === 0) return;
    appendFileSync(this.pathFor(tile), `${buffer.join("\n")}\n`, "utf8");
    this.totalBuffered -= this.bufferedBytes.get(tile) ?? 0;
    this.buffers.set(tile, []);
    this.bufferedBytes.set(tile, 0);
  }

  /** Writes everything still buffered. Must be called before reading anything back. */
  flush(): void {
    for (const tile of [...this.buffers.keys()]) this.flushTile(tile);
  }

  stats(): SpillStats {
    return {
      tiles: this.lineCounts.size,
      lines: this.totalLines,
      bytes: this.totalBytes,
      flushes: this.flushes,
    };
  }

  /** Tiles that received at least one record, with how many. */
  tiles(): Array<{ tile: string; lines: number }> {
    return [...this.lineCounts.entries()].map(([tile, lines]) => ({ tile, lines }));
  }

  /** Reads one tile back, a record at a time. Bounded by the tile, never by the nation. */
  async *read(tile: string): AsyncIterable<string> {
    const stream = createReadStream(this.pathFor(tile), { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.length > 0) yield line;
      }
    } finally {
      lines.close();
      stream.close();
    }
  }

  /** Reads a whole tile into memory. Safe because a tile is one shard, not the nation. */
  async readAll<T>(tile: string): Promise<T[]> {
    const records: T[] = [];
    for await (const line of this.read(tile)) records.push(JSON.parse(line) as T);
    return records;
  }

  /** Removes the spill directory. The data is a build intermediate, not an artifact. */
  dispose(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
