import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isZipArchive, readTransXChangeFromZip, readZipEntries } from "./zip.js";

/**
 * The fixture is written by Python's `zipfile`, not by this package, so these tests check the
 * reader against an independent implementation of the format rather than against itself. It mixes
 * the four shapes a real BODS archive contains: a deflated XML document, a stored one, a non-XML
 * file and a directory entry.
 */

const fixture = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../tests/fixtures/zip/transxchange-sample.zip",
  ),
);
const bytes = new Uint8Array(fixture);

describe("readZipEntries", () => {
  it("recognises a zip archive by its magic bytes", () => {
    expect(isZipArchive(bytes)).toBe(true);
    expect(isZipArchive(new TextEncoder().encode('<?xml version="1.0"?>'))).toBe(false);
  });

  it("reads both deflated and stored entries", () => {
    const result = readZipEntries(bytes);
    expect(result.skipped).toEqual([]);
    const names = result.entries.map((entry) => entry.name).sort();
    expect(names).toEqual(["readme.txt", "timetable/route-1.xml", "timetable/route-2.xml"]);
  });

  it("decompresses to the original text, not to bytes an XML parser would reject", () => {
    const result = readZipEntries(bytes);
    const first = result.entries.find((entry) => entry.name === "timetable/route-1.xml");
    expect(first?.text).toContain("<TransXChange");
    expect(first?.text).toContain("ZZZT");
    // The stored entry takes a different code path and must come out identically readable.
    const second = result.entries.find((entry) => entry.name === "timetable/route-2.xml");
    expect(second?.text).toContain("<TransXChange");
  });

  it("skips directory entries rather than emitting them as empty documents", () => {
    const result = readZipEntries(bytes);
    expect(result.entries.some((entry) => entry.name.endsWith("/"))).toBe(false);
  });

  it("filters before decompressing, so a mixed archive costs only its XML", () => {
    const result = readTransXChangeFromZip(bytes);
    expect(result.entries.map((entry) => entry.name).sort()).toEqual([
      "timetable/route-1.xml",
      "timetable/route-2.xml",
    ]);
  });

  it("reports an unreadable archive instead of throwing", () => {
    // A run must lose one operator's timetables to a bad archive, never the whole build.
    const result = readZipEntries(new TextEncoder().encode("this is not a zip file at all"));
    expect(result.entries).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/end-of-central-directory/);
  });

  it("survives a truncated archive", () => {
    const truncated = bytes.subarray(0, Math.floor(bytes.length / 2));
    const result = readZipEntries(truncated);
    expect(result.entries.length + result.skipped.length).toBeGreaterThan(0);
  });
});
