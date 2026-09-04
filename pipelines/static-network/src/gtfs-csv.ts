import { streamZipEntryLines, type ZipDirectoryEntry } from "./gtfs-zip.js";

/**
 * GTFS CSV, read one row at a time.
 *
 * The format is RFC 4180: fields may be quoted, a quote inside a quoted field is doubled, and a
 * quoted field may contain commas and newlines. The newline case is why this is not a `split(",")`
 * over lines — a single stop name with a line break in it would silently shift every column after
 * it, and the failure would look like bad data rather than a parser bug.
 */

/** Splits one complete record. Assumes quoting is balanced, which `recordIsComplete` checks. */
export function parseCsvRecord(record: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < record.length; index += 1) {
    const character = record[index]!;
    if (quoted) {
      if (character === '"') {
        if (record[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

/** A record is finished when its quotes balance; an odd count means a field spans a newline. */
export function recordIsComplete(record: string): boolean {
  let quotes = 0;
  for (const character of record) if (character === '"') quotes += 1;
  return quotes % 2 === 0;
}

export interface GtfsTableStreamOptions {
  /**
   * Columns to keep. Everything else is dropped before the row object is built, which is the
   * difference between a national `stop_times.txt` row costing five short strings and costing
   * twelve. Omit to keep every column.
   */
  columns?: readonly string[];
  /** Stop reading once this many rows have been handed over. Used for measurement passes. */
  limit?: number;
}

export interface GtfsTableStreamResult {
  /** Header names in file order, so a caller can report what the publisher actually shipped. */
  header: string[];
  rows: number;
  /** Rows whose field count did not match the header; they are skipped, never guessed at. */
  malformed: number;
}

/**
 * Streams one GTFS table out of a zip, calling back per row.
 *
 * The row object is rebuilt each time and nothing is retained here, so a table of any size costs
 * one row of memory in this function.
 */
export async function streamGtfsTable(
  path: string,
  entry: ZipDirectoryEntry,
  onRow: (row: Record<string, string>, index: number) => void | Promise<void>,
  options: GtfsTableStreamOptions = {},
): Promise<GtfsTableStreamResult> {
  let header: string[] | null = null;
  let keep: number[] = [];
  let carry: string | null = null;
  let rows = 0;
  let malformed = 0;
  let stopped = false;

  await streamZipEntryLines(path, entry, async (line) => {
    if (stopped) return;

    const record = carry === null ? line : `${carry}\n${line}`;
    if (!recordIsComplete(record)) {
      carry = record;
      return;
    }
    carry = null;

    if (header === null) {
      // A byte-order mark at the start of the file becomes part of the first column name, and
      // then `stop_id` is not `stop_id` and every lookup misses.
      const first = record.charCodeAt(0) === 0xfeff ? record.slice(1) : record;
      header = parseCsvRecord(first).map((name) => name.trim());
      keep = options.columns
        ? header.map((name, index) => (options.columns!.includes(name) ? index : -1))
        : header.map((_, index) => index);
      return;
    }

    const fields = parseCsvRecord(record);
    if (fields.length !== header.length) {
      malformed += 1;
      return;
    }

    const row: Record<string, string> = {};
    for (let index = 0; index < keep.length; index += 1) {
      if (keep[index] === -1) continue;
      row[header[index]!] = fields[index]!;
    }

    await onRow(row, rows);
    rows += 1;
    if (options.limit !== undefined && rows >= options.limit) stopped = true;
  });

  return { header: header ?? [], rows, malformed };
}
