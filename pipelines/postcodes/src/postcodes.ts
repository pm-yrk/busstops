import type { Coordinate } from "@busstops/contracts";
import { osgb36ToWgs84 } from "@busstops/adapters";

/**
 * Postcodes, so that "LS1 4DY" finds the stops at the end of someone's street.
 *
 * Search holds stops, routes, operators and an OpenStreetMap gazetteer, and a postcode is none of
 * those, so a postcode matches nothing at all today. The source is Ordnance Survey's Code-Point
 * Open, chosen after both candidates were measured from a runner: it answers with no credential of
 * any kind, the CSV is 13.8 MB with a published checksum, and the licence is the Open Government
 * Licence — against ONSPD's roughly one gigabyte of CSV, whose only advantage was carrying
 * latitude and longitude already.
 *
 * That advantage costs nothing here, because the National Grid conversion this project needs for
 * NaPTAN already exists and is tested against the Ordnance Survey's own worked example. So this
 * module is a parser and a partitioning rule, not a geodesy exercise.
 *
 * What gets published is a derived index — the postcode and its coordinate, nothing else — in one
 * object per outward code. That is the same discipline the service buckets introduced: a search
 * for one postcode reads one small object rather than a national file. Outward codes make a
 * better key than a hash here because the query already contains it: "LS1 4DY" names its own
 * bucket, so the reader needs no index of indexes.
 *
 * Attribution travels with the artifact, because the licence requires it:
 * "Contains OS data © Crown copyright and database right", plus the Royal Mail and
 * National Statistics notices that Code-Point Open carries.
 */

export const POSTCODE_ATTRIBUTION =
  "Contains OS data © Crown copyright and database right 2026; " +
  "Contains Royal Mail data © Royal Mail copyright and database right 2026; " +
  "Source: Office for National Statistics licensed under the Open Government Licence v3.0";

/** England's ONS country code, which is the only country this product covers. */
export const ENGLAND_COUNTRY_CODE = "E92000001";

export interface PostcodeRecord {
  /** Canonical form, with the single space: `LS1 4DY`. */
  id: string;
  coordinate: Coordinate;
}

/**
 * One object per outward code, named by it.
 *
 * `search/postcodes/LS1` rather than a hashed bucket: the thing being looked up contains its own
 * partition, so a reader that has normalised the query knows exactly which object to ask for and
 * an absent object is a complete answer — that postcode is not in England's index.
 */
export function postcodeBucketDataset(outward: string): string {
  return `search/postcodes/${outward}`;
}

/**
 * The canonical form of whatever somebody typed, or null if it is not a postcode at all.
 *
 * Deliberately generous about input and strict about output. People type `ls14dy`, `LS1  4DY`, and
 * `ls1 4dy` with a trailing space; Code-Point Open itself writes the seven-character fixed-width
 * form, `LS1  4DY`, with the outward code left-justified. All of those are the same postcode and
 * they must all produce the same key, because the key is what the bucket is named after.
 *
 * The shape test is the real validation: one or two letters, a digit, an optional letter or digit,
 * then a digit and two letters. That accepts every live UK format including the single-digit
 * districts and `W1A`-style ones, and rejects the house number somebody typed by mistake.
 */
export function normalisePostcode(input: string): string | null {
  const bare = input.toUpperCase().replace(/[\s-]+/g, "");
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(bare)) return null;
  const inward = bare.slice(-3);
  const outward = bare.slice(0, -3);
  return `${outward} ${inward}`;
}

/** The part before the space, which is also the name of the object the postcode lives in. */
export function outwardCode(postcode: string): string | null {
  const canonical = normalisePostcode(postcode);
  return canonical === null ? null : (canonical.split(" ")[0] ?? null);
}

/**
 * Whether what somebody typed is a postcode, or the start of one.
 *
 * Search has to decide this before it reads anything, and a half-typed postcode is the normal
 * case: `LS1` is a district, `LS1 4` is a sector, and both should look up the district's object
 * rather than falling through to a place-name search that will match nothing. So a prefix counts
 * as long as it begins the way a postcode does and no further.
 */
export function looksLikePostcode(input: string): boolean {
  const bare = input.toUpperCase().replace(/[\s-]+/g, "");
  if (bare.length < 2) return false;
  return /^[A-Z]{1,2}\d[A-Z\d]?(\d([A-Z]{1,2})?)?$/.test(bare);
}

/**
 * Code-Point Open's columns, in the order the published CSVs carry them.
 *
 * The files have no header row — one file per postcode area, `ls.csv` and so on — so the order is
 * the contract. Only three of the ten columns are read: the postcode, its grid reference, and the
 * country, which is how England is separated from Wales and Scotland. The positional quality
 * indicator is read too, but only to say so in the report: 90 means the grid reference was
 * imputed from a neighbouring postcode, which is still a place and still useful for finding a bus
 * stop, so it is kept rather than dropped.
 */
export const CODE_POINT_COLUMNS = [
  "Postcode",
  "Positional_quality_indicator",
  "Eastings",
  "Northings",
  "Country_code",
  "NHS_regional_HA_code",
  "NHS_HA_code",
  "Admin_county_code",
  "Admin_district_code",
  "Admin_ward_code",
] as const;

export interface CodePointParse {
  records: PostcodeRecord[];
  /** Rows that were read and deliberately not kept, by reason, so a count is explainable. */
  skipped: {
    notEngland: number;
    unparseablePostcode: number;
    offGrid: number;
    shortRow: number;
  };
  /** How many kept rows had an imputed rather than surveyed grid reference. */
  imputed: number;
}

/**
 * Parse the rows of one Code-Point Open CSV.
 *
 * Takes the text of a file rather than a stream because each area file is a few hundred kilobytes
 * and the whole product is 13.8 MB zipped; there is nothing here that needs incremental parsing,
 * and a function over a string is a function that can be tested.
 *
 * Fields are unquoted in this product, but a quoted field would be legal CSV, so the split
 * tolerates them rather than trusting the publisher's current formatting.
 */
export function parseCodePointCsv(text: string): CodePointParse {
  const records: PostcodeRecord[] = [];
  const skipped = { notEngland: 0, unparseablePostcode: 0, offGrid: 0, shortRow: 0 };
  let imputed = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const columns = line.split(",").map((value) => value.trim().replace(/^"|"$/g, ""));
    if (columns.length < 5) {
      skipped.shortRow += 1;
      continue;
    }

    const [rawPostcode, quality, easting, northing, country] = columns;
    if (country !== ENGLAND_COUNTRY_CODE) {
      skipped.notEngland += 1;
      continue;
    }

    const id = normalisePostcode(rawPostcode ?? "");
    if (id === null) {
      skipped.unparseablePostcode += 1;
      continue;
    }

    const coordinate = osgb36ToWgs84(Number(easting), Number(northing));
    if (coordinate === null) {
      skipped.offGrid += 1;
      continue;
    }

    if (Number(quality) >= 90) imputed += 1;
    records.push({ id, coordinate });
  }

  return { records, skipped, imputed };
}

/**
 * Group records into the objects they will be published as.
 *
 * Only non-empty outward codes come back, for the same reason the service buckets do it: an
 * absent object is a complete answer, and publishing empty ones would mean a reader could not
 * tell "nothing here" from "not built yet".
 */
export function bucketPostcodes(records: readonly PostcodeRecord[]): Map<string, PostcodeRecord[]> {
  const byOutward = new Map<string, PostcodeRecord[]>();
  for (const record of records) {
    const outward = outwardCode(record.id);
    if (outward === null) continue;
    const existing = byOutward.get(postcodeBucketDataset(outward));
    if (existing === undefined) byOutward.set(postcodeBucketDataset(outward), [record]);
    else existing.push(record);
  }
  return byOutward;
}
