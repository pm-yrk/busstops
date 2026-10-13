import { describe, expect, it } from "vitest";
import {
  bucketPostcodes,
  ENGLAND_COUNTRY_CODE,
  looksLikePostcode,
  normalisePostcode,
  outwardCode,
  parseCodePointCsv,
  postcodeBucketDataset,
} from "./postcodes.js";

/**
 * Rows in Code-Point Open's published shape: no header, ten columns, the postcode in the
 * seven-character fixed-width form with the outward code left-justified.
 */
function row(
  postcode: string,
  easting: number,
  northing: number,
  country = ENGLAND_COUNTRY_CODE,
  quality = 10,
): string {
  return [
    postcode,
    String(quality),
    String(easting),
    String(northing),
    country,
    "E18000003",
    "E19000003",
    "E10000034",
    "E08000035",
    "E05001411",
  ].join(",");
}

describe("what somebody typed, turned into a key", () => {
  it("accepts every way the same postcode gets written", () => {
    for (const written of ["LS1 4DY", "ls1 4dy", "LS14DY", "ls14dy", " LS1  4DY ", "LS1-4DY"]) {
      expect(normalisePostcode(written), written).toBe("LS1 4DY");
    }
  });

  it("accepts the fixed-width form the source itself publishes", () => {
    // Code-Point Open writes seven characters with the outward code left-justified.
    expect(normalisePostcode("LS1  4DY")).toBe("LS1 4DY");
    expect(normalisePostcode("M1   1AE")).toBe("M1 1AE");
  });

  it("accepts the awkward real formats rather than only the common one", () => {
    expect(normalisePostcode("W1A 1AA")).toBe("W1A 1AA");
    expect(normalisePostcode("EC1A 1BB")).toBe("EC1A 1BB");
    expect(normalisePostcode("M1 1AE")).toBe("M1 1AE");
    expect(normalisePostcode("CR2 6XH")).toBe("CR2 6XH");
    expect(normalisePostcode("DN55 1PT")).toBe("DN55 1PT");
  });

  it("refuses what is not a postcode instead of inventing a key for it", () => {
    for (const written of ["", "Leeds", "12 Acacia Avenue", "LS1", "LS1 4", "4DY", "LS1 4DYX"]) {
      expect(normalisePostcode(written), written).toBeNull();
    }
  });

  it("names the bucket from the part the query already contains", () => {
    expect(outwardCode("ls1 4dy")).toBe("LS1");
    expect(outwardCode("EC1A1BB")).toBe("EC1A");
    expect(outwardCode("not a postcode")).toBeNull();
    expect(postcodeBucketDataset("LS1")).toBe("search/postcodes/LS1");
  });

  /*
   * A half-typed postcode is the normal case, and it must not fall through to a place-name search
   * that cannot match it.
   */
  it("recognises a postcode being typed, and stops at what is still plausible", () => {
    for (const typed of ["LS1", "LS1 4", "ls14", "EC1A", "EC1A 1", "M1", "DN55"]) {
      expect(looksLikePostcode(typed), typed).toBe(true);
    }
    for (const typed of ["L", "Leeds", "Bradford Interchange", "72", "LS1 4DYZ"]) {
      expect(looksLikePostcode(typed), typed).toBe(false);
    }
  });
});

describe("reading Code-Point Open", () => {
  it("keeps England's postcodes with a real coordinate", () => {
    // Leeds city centre, which the National Grid conversion's own tests already pin down.
    const parsed = parseCodePointCsv(row("LS1  4DY", 429933, 433742));
    expect(parsed.records).toHaveLength(1);
    const [record] = parsed.records;
    expect(record!.id).toBe("LS1 4DY");
    /*
     * Tight enough to catch the mistake this test exists for.
     *
     * At one decimal place the easting and the northing could be read in the wrong order and still
     * pass — the swap lands 4 km away, inside that tolerance. At two it does not: swapped, this
     * grid reference comes out at 53.765, -1.490.
     */
    expect(record!.coordinate.lat).toBeCloseTo(53.799, 2);
    expect(record!.coordinate.lon).toBeCloseTo(-1.547, 2);
  });

  it("drops the rest of the United Kingdom, and says how many", () => {
    const parsed = parseCodePointCsv(
      [
        row("LS1  4DY", 429933, 433742),
        row("CF10 1EP", 318000, 176000, "W92000004"),
        row("EH1  1YZ", 325000, 673000, "S92000003"),
      ].join("\n"),
    );
    expect(parsed.records.map((record) => record.id)).toEqual(["LS1 4DY"]);
    expect(parsed.skipped.notEngland).toBe(2);
  });

  it("counts an unreadable row rather than guessing at it", () => {
    const parsed = parseCodePointCsv(
      [
        row("LS1  4DY", 429933, 433742),
        row("NOTAPOSTCODE", 429933, 433742),
        row("M1   1AE", -5, 433742),
        "LS2 8LX,10",
        "",
      ].join("\n"),
    );
    expect(parsed.records.map((record) => record.id)).toEqual(["LS1 4DY"]);
    expect(parsed.skipped.unparseablePostcode).toBe(1);
    expect(parsed.skipped.offGrid).toBe(1);
    expect(parsed.skipped.shortRow).toBe(1);
  });

  /*
   * Quality 90 means the grid reference was imputed from a neighbouring postcode. That is still a
   * place and still finds the right bus stops, so it is kept — and counted, so the report can say
   * how much of the index is imputed rather than surveyed.
   */
  it("keeps an imputed position and reports that it did", () => {
    const parsed = parseCodePointCsv(
      [row("LS1  4DY", 429933, 433742, ENGLAND_COUNTRY_CODE, 90)].join("\n"),
    );
    expect(parsed.records).toHaveLength(1);
    expect(parsed.imputed).toBe(1);
  });

  it("tolerates quoted fields, because quoting them would still be legal", () => {
    const parsed = parseCodePointCsv(
      `"LS1  4DY","10","429933","433742","${ENGLAND_COUNTRY_CODE}","","","","",""`,
    );
    expect(parsed.records.map((record) => record.id)).toEqual(["LS1 4DY"]);
  });
});

describe("one object per outward code", () => {
  it("puts every postcode in the object its own text names", () => {
    const parsed = parseCodePointCsv(
      [
        row("LS1  4DY", 429933, 433742),
        row("LS1  4AP", 429900, 433700),
        row("LS2  8LX", 430400, 434300),
        row("M1   1AE", 384500, 398000),
      ].join("\n"),
    );
    const buckets = bucketPostcodes(parsed.records);

    expect([...buckets.keys()].sort()).toEqual([
      "search/postcodes/LS1",
      "search/postcodes/LS2",
      "search/postcodes/M1",
    ]);
    expect(buckets.get("search/postcodes/LS1")!.map((record) => record.id)).toEqual([
      "LS1 4DY",
      "LS1 4AP",
    ]);
  });

  it("publishes no object for an outward code it has nothing for", () => {
    const buckets = bucketPostcodes([]);
    expect(buckets.size).toBe(0);
    expect(buckets.has("search/postcodes/LS1")).toBe(false);
  });

  it("loses nothing: every record is in exactly one object", () => {
    const rows: string[] = [];
    for (let district = 1; district <= 40; district += 1) {
      for (let unit = 0; unit < 25; unit += 1) {
        rows.push(
          row(
            `LS${district} ${unit % 9}A${String.fromCharCode(65 + (unit % 26))}`.padEnd(8, " "),
            429000 + district * 10 + unit,
            433000 + district * 10 + unit,
          ),
        );
      }
    }
    const parsed = parseCodePointCsv(rows.join("\n"));
    expect(parsed.records.length).toBe(1000);

    const buckets = bucketPostcodes(parsed.records);
    const placed = new Set<string>();
    let total = 0;
    for (const [dataset, records] of buckets) {
      for (const record of records) {
        expect(dataset).toBe(postcodeBucketDataset(outwardCode(record.id)!));
        placed.add(record.id);
        total += 1;
      }
    }
    expect(total).toBe(parsed.records.length);
    expect(placed.size).toBe(new Set(parsed.records.map((record) => record.id)).size);
  });
});
