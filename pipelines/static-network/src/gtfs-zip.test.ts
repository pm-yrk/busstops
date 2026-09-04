import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readZipDirectory, streamZipEntryLines } from "./gtfs-zip.js";
import { parseCsvRecord, recordIsComplete, streamGtfsTable } from "./gtfs-csv.js";

/**
 * These build real archives rather than mocking the reader, because every defect this reader can
 * have is a byte-offset defect: a wrong local-header calculation or a mis-read Zip64 field seeks
 * to the wrong place and produces plausible-looking rubbish, which no mock would ever catch.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A minimal, correct zip writer, so the tests exercise the real format. */
function buildZip(files: Array<{ name: string; content: string; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const raw = Buffer.from(file.content, "utf8");
    const stored = file.store ?? false;
    const data = stored ? raw : deflateRawSync(raw);
    const name = Buffer.from(file.name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

function writeArchive(files: Parameters<typeof buildZip>[0]): string {
  const directory = mkdtempSync(join(tmpdir(), "gtfs-zip-"));
  const path = join(directory, "feed.zip");
  writeFileSync(path, buildZip(files));
  return path;
}

describe("streaming zip reader", () => {
  it("lists entries without decompressing them", async () => {
    const path = writeArchive([
      { name: "agency.txt", content: "agency_id\nOP1\n" },
      { name: "stops.txt", content: "stop_id\n1\n2\n" },
    ]);
    const directory = await readZipDirectory(path);
    expect(directory.entries.map((entry) => entry.name)).toEqual(["agency.txt", "stops.txt"]);
    expect(directory.entries[1]!.uncompressedSize).toBe("stop_id\n1\n2\n".length);
  });

  it("streams lines from a deflated entry", async () => {
    const lines = Array.from({ length: 5000 }, (_, index) => `row-${index}`);
    const path = writeArchive([{ name: "big.txt", content: `${lines.join("\n")}\n` }]);
    const directory = await readZipDirectory(path);

    const seen: string[] = [];
    const count = await streamZipEntryLines(path, directory.entries[0]!, (line) => {
      seen.push(line);
    });
    expect(count).toBe(5000);
    expect(seen[0]).toBe("row-0");
    expect(seen.at(-1)).toBe("row-4999");
  });

  it("streams a stored entry too, and keeps a final line with no newline", async () => {
    const path = writeArchive([{ name: "s.txt", content: "one\ntwo", store: true }]);
    const directory = await readZipDirectory(path);
    const seen: string[] = [];
    await streamZipEntryLines(path, directory.entries[0]!, (line) => void seen.push(line));
    expect(seen).toEqual(["one", "two"]);
  });

  it("does not split a multi-byte character across chunks", async () => {
    // Long enough to cross the stream's internal chunk boundary many times over.
    const line = `${"Sŵn y Môr – Ynys Môn ".repeat(400)}`;
    const path = writeArchive([{ name: "u.txt", content: `${line}\n${line}\n` }]);
    const directory = await readZipDirectory(path);
    const seen: string[] = [];
    await streamZipEntryLines(path, directory.entries[0]!, (l) => void seen.push(l));
    expect(seen).toEqual([line, line]);
  });

  it("respects back-pressure from an async consumer", async () => {
    const path = writeArchive([
      { name: "a.txt", content: `${Array.from({ length: 200 }, (_, i) => i).join("\n")}\n` },
    ]);
    const directory = await readZipDirectory(path);
    let concurrent = 0;
    let peak = 0;
    await streamZipEntryLines(path, directory.entries[0]!, async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await yieldToLoop();
      concurrent -= 1;
    });
    expect(peak).toBe(1);
  });
});

describe("GTFS CSV", () => {
  it("splits quoted fields, doubled quotes and empty columns", () => {
    expect(parseCsvRecord('a,"b,c",,"say ""hi"""')).toEqual(["a", "b,c", "", 'say "hi"']);
  });

  it("knows when a record is still open", () => {
    expect(recordIsComplete('a,"b')).toBe(false);
    expect(recordIsComplete('a,"b"')).toBe(true);
  });

  it("reads rows as objects, keeping only the requested columns", async () => {
    const path = writeArchive([
      {
        name: "stops.txt",
        content:
          "stop_id,stop_name,stop_lat,stop_lon,extra\n" +
          "450010001,Boar Lane,53.7965,-1.5445,ignored\n" +
          '450010002,"Market Place, North",54.1,-1.52,ignored\n',
      },
    ]);
    const directory = await readZipDirectory(path);
    const rows: Array<Record<string, string>> = [];
    const result = await streamGtfsTable(
      path,
      directory.entries[0]!,
      (row) => void rows.push(row),
      { columns: ["stop_id", "stop_name"] },
    );

    expect(result.rows).toBe(2);
    expect(result.malformed).toBe(0);
    expect(result.header).toContain("stop_lat");
    expect(rows[0]).toEqual({ stop_id: "450010001", stop_name: "Boar Lane" });
    expect(rows[1]!.stop_name).toBe("Market Place, North");
  });

  it("joins a record whose quoted field contains a newline", async () => {
    const path = writeArchive([{ name: "t.txt", content: 'id,name\n1,"two\nlines"\n2,plain\n' }]);
    const directory = await readZipDirectory(path);
    const rows: Array<Record<string, string>> = [];
    const result = await streamGtfsTable(path, directory.entries[0]!, (row) => void rows.push(row));
    expect(result.rows).toBe(2);
    expect(rows[0]!.name).toBe("two\nlines");
    expect(rows[1]!.name).toBe("plain");
  });

  it("skips a row with the wrong number of fields rather than guessing at it", async () => {
    const path = writeArchive([{ name: "t.txt", content: "a,b\n1,2\n3\n4,5\n" }]);
    const directory = await readZipDirectory(path);
    const rows: Array<Record<string, string>> = [];
    const result = await streamGtfsTable(path, directory.entries[0]!, (row) => void rows.push(row));
    expect(result.rows).toBe(2);
    expect(result.malformed).toBe(1);
  });

  it("strips a byte-order mark from the first column name", async () => {
    const path = writeArchive([{ name: "t.txt", content: "﻿stop_id,name\n1,A\n" }]);
    const directory = await readZipDirectory(path);
    const rows: Array<Record<string, string>> = [];
    await streamGtfsTable(path, directory.entries[0]!, (row) => void rows.push(row));
    expect(rows[0]).toEqual({ stop_id: "1", name: "A" });
  });

  it("stops early when a limit is given", async () => {
    const path = writeArchive([
      { name: "t.txt", content: `a\n${Array.from({ length: 1000 }, (_, i) => i).join("\n")}\n` },
    ]);
    const directory = await readZipDirectory(path);
    const result = await streamGtfsTable(path, directory.entries[0]!, () => {}, { limit: 10 });
    expect(result.rows).toBe(10);
  });
});
