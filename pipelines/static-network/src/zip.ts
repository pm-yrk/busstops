import { inflateRawSync } from "node:zlib";

/**
 * Minimal zip reader for BODS timetable datasets.
 *
 * Every published BODS timetable dataset is a zip archive — verified against the live catalogue,
 * where all 25 datasets in a page reported `extension: "zip"` and the download answered
 * `application/zip`. Fetching one as text and handing it to an XML parser is a silent corruption
 * rather than an error: the parser finds no journeys, every downstream dataset comes out empty,
 * and the publish rolls back with nothing to explain why.
 *
 * This runs in the Node pipelines only, never in the Worker, which is why `node:zlib` is imported
 * here rather than anywhere `@busstops/pipeline-core` would carry it into the edge bundle.
 *
 * It is deliberately small: enough of the format to read a well-formed archive produced by a
 * publisher, not a general-purpose implementation. Anything it does not understand is reported as
 * a skipped entry, so a single odd archive costs one operator's timetables rather than the run.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/** The largest an end-of-central-directory record can be: 22 fixed bytes plus a 64 KiB comment. */
const MAX_EOCD_SIZE = 22 + 0xffff;

const STORED = 0;
const DEFLATED = 8;

export interface ZipEntry {
  name: string;
  text: string;
}

export interface ZipReadResult {
  entries: ZipEntry[];
  /** Entries that could not be read, with the reason, so a partial archive is visible. */
  skipped: Array<{ name: string; reason: string }>;
}

export function isZipArchive(bytes: Uint8Array): boolean {
  // "PK\x03\x04". An empty archive starts "PK\x05\x06", which has no entries to read anyway.
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03;
}

function findEndOfCentralDirectory(view: DataView): number | null {
  const from = Math.max(0, view.byteLength - MAX_EOCD_SIZE);
  // Scanning backwards finds the real record first when a stored file happens to contain the
  // signature as data.
  for (let offset = view.byteLength - 22; offset >= from; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return null;
}

/**
 * Reads every text entry in a zip archive.
 *
 * `include` filters by name before anything is decompressed, so a dataset that also ships PDFs or
 * images costs nothing to skip.
 */
export function readZipEntries(
  bytes: Uint8Array,
  options: { include?: (name: string) => boolean } = {},
): ZipReadResult {
  const entries: ZipEntry[] = [];
  const skipped: ZipReadResult["skipped"] = [];
  const include = options.include ?? (() => true);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const eocd = findEndOfCentralDirectory(view);
  if (eocd === null) {
    return {
      entries,
      skipped: [{ name: "(archive)", reason: "no end-of-central-directory record" }],
    };
  }

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_FILE_HEADER) {
      skipped.push({ name: `(entry ${index})`, reason: "malformed central directory header" });
      break;
    }

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue; // a directory entry has no content
    if (!include(name)) continue;

    if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER) {
      skipped.push({ name, reason: "malformed local file header" });
      continue;
    }
    // The local header repeats the name and extra lengths, and they can differ from the central
    // directory's, so the data offset must be computed from the local header rather than reused.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);

    try {
      if (method === STORED) {
        entries.push({ name, text: new TextDecoder().decode(data) });
      } else if (method === DEFLATED) {
        entries.push({ name, text: inflateRawSync(data).toString("utf8") });
      } else {
        skipped.push({ name, reason: `unsupported compression method ${method}` });
      }
    } catch (error) {
      skipped.push({
        name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { entries, skipped };
}

/** The XML documents in a BODS timetable archive, which is all the network build reads. */
export function readTransXChangeFromZip(bytes: Uint8Array): ZipReadResult {
  return readZipEntries(bytes, { include: (name) => name.toLowerCase().endsWith(".xml") });
}
