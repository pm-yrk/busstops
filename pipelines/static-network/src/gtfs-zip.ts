import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInflateRaw } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * A zip reader that never holds the archive.
 *
 * The BODS national GTFS timetable is a single zip whose `stop_times.txt` alone is measured in
 * gigabytes once inflated. The existing reader (src/zip.ts) takes the whole archive as a
 * `Uint8Array` and inflates each entry into a string, which is right for a 3 MiB TransXChange
 * dataset and impossible here — the buffer would exceed what a runtime will hold long before the
 * decompressed text did.
 *
 * So this one reads the central directory from a file on disk, then inflates one entry at a time
 * through a stream, handing out lines as they appear. Peak memory is a chunk, not a file.
 *
 * Zip64 is supported because the national archive needs it: past 4 GiB the sizes and offsets in
 * the classic records are sentinels, and reading them as numbers silently seeks to the wrong
 * place rather than failing.
 */

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_EXTRA = 0x0001;

const STORED = 0;
const DEFLATED = 8;

/** 22 fixed bytes plus the largest comment the format allows. */
const MAX_EOCD_SIZE = 22 + 0xffff;
const UINT32_MAX = 0xffffffff;

export interface ZipDirectoryEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipDirectory {
  path: string;
  fileSize: number;
  entries: ZipDirectoryEntry[];
}

async function readRange(path: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Reads the entry list without decompressing anything.
 *
 * Only the tail of the file and the central directory are read, so opening a 500 MiB archive
 * costs a few hundred kilobytes.
 */
export async function readZipDirectory(path: string): Promise<ZipDirectory> {
  const { size } = await stat(path);
  const tailLength = Math.min(size, MAX_EOCD_SIZE);
  const tail = await readRange(path, size - tailLength, tailLength);

  let eocdOffset = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === EOCD) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error(`${path}: no end-of-central-directory record`);

  let entryCount = tail.readUInt16LE(eocdOffset + 10);
  let directorySize = tail.readUInt32LE(eocdOffset + 12);
  let directoryOffset = tail.readUInt32LE(eocdOffset + 16);

  // Past 4 GiB, or past 65,535 entries, the classic record holds sentinels and the real figures
  // live in a Zip64 record that the locator immediately before it points at.
  const locatorOffset = eocdOffset - 20;
  if (
    locatorOffset >= 0 &&
    tail.readUInt32LE(locatorOffset) === EOCD64_LOCATOR &&
    (entryCount === 0xffff || directorySize === UINT32_MAX || directoryOffset === UINT32_MAX)
  ) {
    const eocd64Offset = Number(tail.readBigUInt64LE(locatorOffset + 8));
    const record = await readRange(path, eocd64Offset, 56);
    if (record.readUInt32LE(0) !== EOCD64) {
      throw new Error(`${path}: Zip64 locator does not point at a Zip64 record`);
    }
    entryCount = Number(record.readBigUInt64LE(32));
    directorySize = Number(record.readBigUInt64LE(40));
    directoryOffset = Number(record.readBigUInt64LE(48));
  }

  const directory = await readRange(path, directoryOffset, directorySize);
  const entries: ZipDirectoryEntry[] = [];
  let offset = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error(`${path}: malformed central directory at entry ${index}`);
    }
    const compressionMethod = directory.readUInt16LE(offset + 10);
    let compressedSize = directory.readUInt32LE(offset + 20);
    let uncompressedSize = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    let localHeaderOffset = directory.readUInt32LE(offset + 42);
    const name = directory.toString("utf8", offset + 46, offset + 46 + nameLength);

    // The Zip64 extra field carries whichever of the three the classic fields could not hold, in
    // this fixed order, present only when its classic counterpart is the sentinel.
    const extraStart = offset + 46 + nameLength;
    let cursor = extraStart;
    while (cursor + 4 <= extraStart + extraLength) {
      const headerId = directory.readUInt16LE(cursor);
      const dataSize = directory.readUInt16LE(cursor + 2);
      if (headerId === ZIP64_EXTRA) {
        let field = cursor + 4;
        if (uncompressedSize === UINT32_MAX && field + 8 <= cursor + 4 + dataSize) {
          uncompressedSize = Number(directory.readBigUInt64LE(field));
          field += 8;
        }
        if (compressedSize === UINT32_MAX && field + 8 <= cursor + 4 + dataSize) {
          compressedSize = Number(directory.readBigUInt64LE(field));
          field += 8;
        }
        if (localHeaderOffset === UINT32_MAX && field + 8 <= cursor + 4 + dataSize) {
          localHeaderOffset = Number(directory.readBigUInt64LE(field));
        }
        break;
      }
      cursor += 4 + dataSize;
    }

    offset = extraStart + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
  }

  return { path, fileSize: size, entries };
}

/** Where an entry's compressed bytes start, which only its local header can say. */
async function dataStartOf(path: string, entry: ZipDirectoryEntry): Promise<number> {
  const header = await readRange(path, entry.localHeaderOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
    throw new Error(`${entry.name}: malformed local file header`);
  }
  // The local header repeats the name and extra lengths and they may differ from the central
  // directory's, so the data offset is computed from this header rather than reused.
  return entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

/**
 * Calls back with each line of one entry, in order, as it decompresses.
 *
 * A line is handed over as a string and forgotten; nothing accumulates. `onLine` may return a
 * promise, and back-pressure is respected while it is pending, so a slow consumer slows the
 * inflate rather than filling memory ahead of it.
 */
export async function streamZipEntryLines(
  path: string,
  entry: ZipDirectoryEntry,
  onLine: (line: string, index: number) => void | Promise<void>,
): Promise<number> {
  if (entry.compressionMethod !== STORED && entry.compressionMethod !== DEFLATED) {
    throw new Error(`${entry.name}: unsupported compression method ${entry.compressionMethod}`);
  }
  const start = await dataStartOf(path, entry);
  const source = createReadStream(path, {
    start,
    end: start + Math.max(entry.compressedSize, 1) - 1,
  });

  let index = 0;
  let carry = "";
  // A decoder rather than chunk.toString(): a multi-byte character split across a chunk boundary
  // would otherwise become two replacement characters in the middle of a stop name.
  const decoder = new StringDecoder("utf8");
  const consume = new Transform({
    decodeStrings: false,
    async transform(chunk: Buffer, _encoding, callback) {
      try {
        carry += decoder.write(chunk);
        let newline = carry.indexOf("\n");
        while (newline !== -1) {
          const line = carry.slice(0, newline);
          carry = carry.slice(newline + 1);
          await onLine(line.endsWith("\r") ? line.slice(0, -1) : line, index);
          index += 1;
          newline = carry.indexOf("\n");
        }
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    async flush(callback) {
      try {
        carry += decoder.end();
        if (carry.length > 0) {
          await onLine(carry.endsWith("\r") ? carry.slice(0, -1) : carry, index);
          index += 1;
        }
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  if (entry.compressionMethod === STORED) {
    await pipeline(source, consume);
  } else {
    await pipeline(source, createInflateRaw(), consume);
  }
  return index;
}
