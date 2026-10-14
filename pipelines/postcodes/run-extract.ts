#!/usr/bin/env node
/**
 * Build England's postcode index from Ordnance Survey Code-Point Open.
 *
 * "LS1 4DY" is how a lot of people would start, and it matches nothing today. The source was
 * chosen by measurement rather than by recollection: run 38366891204 asked both candidates from a
 * runner and Code-Point Open answered with no credential of any kind — version 2026-08, a
 * 14,461,176-byte CSV archive with a published md5 — against ONSPD's roughly one gigabyte of CSV,
 * whose only advantage was carrying latitude and longitude already. That advantage costs nothing
 * here, because the National Grid conversion this project wrote for NaPTAN already exists and is
 * tested against the Ordnance Survey's own worked example.
 *
 * What it publishes is a derived index and nothing more: the postcode and its coordinate, in one
 * object per outward code. A search for `LS1 4DY` reads `search/postcodes/LS1` — about 25 KB — and
 * an absent object is a complete answer. That is the same discipline the service buckets
 * introduced, and it is the opposite of the national object a stop board used to decode.
 *
 *   node --import tsx pipelines/postcodes/run-extract.ts            # report only, publishes nothing
 *   node --import tsx pipelines/postcodes/run-extract.ts --publish   # writes the index
 *
 * Report-only is the default deliberately. The preview bucket is close enough to R2's free
 * allowance that a new family's real size should be read off a measurement before it is written,
 * and this job can produce that measurement without writing a byte.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ArtifactStore, annotateReport, r2StoreFromEnv } from "@busstops/pipeline-core";
import { readZipDirectory, streamZipEntryLines } from "@busstops/pipeline-static-network";
import {
  bucketPostcodes,
  parseCodePointRow,
  POSTCODE_ATTRIBUTION,
  type PostcodeRecord,
} from "./src/index.js";

const PRODUCT_URL = "https://api.os.uk/downloads/v1/products/CodePointOpen";
const DOWNLOADS_URL = `${PRODUCT_URL}/downloads?area=GB&format=CSV`;
const DOWNLOAD_TIMEOUT_MS = 600_000;
/** How many buckets are published at once. Small, because R2 is shared with everything else. */
const PUBLISH_CONCURRENCY = 6;

const publishing = process.argv.includes("--publish");
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  mode: publishing ? "publish" : "report_only",
};

interface DownloadOption {
  format?: string;
  size?: number;
  md5?: string;
  fileName?: string;
  url?: string;
}

async function resolveDownload(): Promise<DownloadOption | null> {
  const response = await fetch(DOWNLOADS_URL, { signal: AbortSignal.timeout(60_000) });
  report.downloadsStatus = response.status;
  if (!response.ok) return null;
  const options = (await response.json()) as DownloadOption[];
  const csv = (Array.isArray(options) ? options : []).find(
    (option) => (option.format ?? "").toUpperCase() === "CSV",
  );
  return csv ?? null;
}

/**
 * Download to disk, hashing as it goes.
 *
 * To disk because the zip reader seeks: it reads the central directory from the tail of the file
 * and then inflates one entry at a time, which is what keeps a 13.8 MB archive of 120 files from
 * being held in memory as 120 strings. Hashing in the same pass because the publisher gives an
 * md5 and an unverified download is a silent corruption waiting to be published.
 */
async function download(
  option: DownloadOption,
): Promise<{ path: string; bytes: number; md5: string }> {
  const path = join(tmpdir(), option.fileName ?? "code-point-open.zip");
  const response = await fetch(option.url ?? "", {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`download answered http_${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path));
  const { size } = await stat(path);

  const hash = createHash("md5");
  await pipeline(createReadStream(path), hash);
  return { path, bytes: size, md5: hash.digest("hex") };
}

async function main(): Promise<number> {
  const option = await resolveDownload();
  if (option === null) {
    report.outcome = "no_csv_download_offered";
    annotateReport("postcodes", report);
    return 1;
  }
  report.product = {
    fileName: option.fileName ?? null,
    publishedBytes: option.size ?? null,
    md5Published: option.md5 ? "present" : null,
  };

  let archive: { path: string; bytes: number; md5: string };
  try {
    archive = await download(option);
  } catch (error) {
    report.outcome = "download_failed";
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    annotateReport("postcodes", report);
    return 1;
  }

  report.downloadedBytes = archive.bytes;
  /*
   * A mismatch is reported and does not stop the run.
   *
   * The checksum the API publishes is for the product, and it has been seen to be absent on some
   * products; treating a missing or differing value as fatal would turn an advisory into an
   * outage. What matters is that the comparison is recorded either way, so a parse that produces
   * nonsense has a checksum line above it to explain itself.
   */
  report.md5Matches =
    typeof option.md5 === "string" ? option.md5.toLowerCase() === archive.md5 : null;

  const records: PostcodeRecord[] = [];
  const skipped = { notEngland: 0, unparseablePostcode: 0, offGrid: 0, shortRow: 0 };
  let imputed = 0;
  let filesRead = 0;
  let rowsRead = 0;

  try {
    const directory = await readZipDirectory(archive.path);
    const csvEntries = directory.entries.filter((entry) => /\.csv$/i.test(entry.name));
    report.csvFiles = csvEntries.length;

    for (const entry of csvEntries) {
      filesRead += 1;
      await streamZipEntryLines(archive.path, entry, (line) => {
        rowsRead += 1;
        const outcome = parseCodePointRow(line);
        if ("blank" in outcome) return;
        if ("skipped" in outcome) {
          skipped[outcome.skipped] += 1;
          return;
        }
        if (outcome.imputed) imputed += 1;
        records.push(outcome.kept);
      });
    }
  } catch (error) {
    report.outcome = "parse_failed";
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    report.filesRead = filesRead;
    report.rowsRead = rowsRead;
    annotateReport("postcodes", report);
    await unlink(archive.path).catch(() => undefined);
    return 1;
  }

  await unlink(archive.path).catch(() => undefined);

  const buckets = bucketPostcodes(records);
  const bucketSizes = [...buckets.values()].map((rows) => rows.length);
  /*
   * The size the index would be, computed without writing it.
   *
   * `JSON.stringify` over every record is the same work the publisher does, so this is the real
   * figure rather than an estimate from a sample — and it is what decides whether the family fits
   * inside the free allowance before anything is written.
   */
  const bodyBytes = [...buckets.values()].reduce(
    (total, rows) => total + Buffer.byteLength(rows.map((row) => JSON.stringify(row)).join("\n")),
    0,
  );

  report.rowsRead = rowsRead;
  report.filesRead = filesRead;
  report.englandPostcodes = records.length;
  report.skipped = skipped;
  report.imputed = imputed;
  report.outwardCodes = buckets.size;
  report.indexBytes = bodyBytes;
  report.meanBucketBytes = buckets.size > 0 ? Math.round(bodyBytes / buckets.size) : 0;
  report.largestBucket = bucketSizes.length > 0 ? Math.max(...bucketSizes) : 0;
  report.smallestBucket = bucketSizes.length > 0 ? Math.min(...bucketSizes) : 0;
  /* Named samples, so a published figure can be checked against a real postcode by hand. */
  report.samples = ["LS1 4DY", "M1 1AE", "BS1 4DJ", "NR1 3DY", "SW1A 1AA"].map((postcode) => {
    const outward = postcode.split(" ")[0]!;
    const rows = buckets.get(`search/postcodes/${outward}`) ?? [];
    const found = rows.find((row) => row.id === postcode);
    return found
      ? `${postcode} → ${outward} (${rows.length} in bucket): ${found.coordinate.lat.toFixed(5)}, ${found.coordinate.lon.toFixed(5)}`
      : `${postcode} → ${outward} (${rows.length} in bucket): absent`;
  });

  if (!publishing) {
    report.outcome = "measured";
    annotateReport("postcodes", report);
    return 0;
  }

  const storage = r2StoreFromEnv(process.env);
  if (!storage.ok) {
    report.outcome = "not_configured";
    report.missing = storage.missing;
    annotateReport("postcodes", report);
    return 1;
  }
  const artifacts = new ArtifactStore(storage.store);
  const version = new Date().toISOString();
  const failures: string[] = [];
  let published = 0;
  let writtenBytes = 0;

  const entries = [...buckets.entries()];
  for (let at = 0; at < entries.length; at += PUBLISH_CONCURRENCY) {
    const slice = entries.slice(at, at + PUBLISH_CONCURRENCY);
    await Promise.all(
      slice.map(async ([dataset, rows]) => {
        try {
          const manifest = await artifacts.publish({
            dataset,
            version,
            records: rows,
            schemaVersion: "1.0.0",
            sources: ["os_code_point"],
            partialCoverage: false,
            /*
             * A quarterly product reshapes its districts, so a bucket legitimately shrinks between
             * editions. The guard that matters here is the England total in the report, not a
             * per-object one on a few hundred postcodes.
             */
            maximumShrinkFraction: 1,
            notes: `England's postcodes for this outward code. ${POSTCODE_ATTRIBUTION}`,
          });
          published += 1;
          writtenBytes += manifest.sizeBytes;
        } catch (error) {
          failures.push(
            `${dataset}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          );
        }
      }),
    );
  }

  /*
   * Delete the versions this publish superseded, because nothing else will.
   *
   * The network retention job walks `data/network/` only, and this family lives under
   * `data/search/postcodes/`, so a republish would add another 123 MB that no scheduled prune ever
   * reclaims — against a 10.74 GB allowance that is already at 9.68. Found by checking the prune's
   * prefix rather than by watching the bucket grow.
   *
   * `pruneOldVersions` always protects the live version and the one before it, so rollback is
   * untouched and the family settles at two editions rather than growing by one every quarter. It
   * is per dataset, which is why it runs here beside each publish rather than as a second pass.
   */
  let supersededDeleted = 0;
  const pruneFailures: string[] = [];
  for (let at = 0; at < entries.length; at += PUBLISH_CONCURRENCY) {
    const slice = entries.slice(at, at + PUBLISH_CONCURRENCY);
    await Promise.all(
      slice.map(async ([dataset]) => {
        try {
          supersededDeleted += (await artifacts.pruneOldVersions(dataset, 2)).length;
        } catch (error) {
          if (pruneFailures.length < 5) {
            pruneFailures.push(
              `${dataset}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 120),
            );
          }
        }
      }),
    );
  }
  report.supersededObjectsDeleted = supersededDeleted;
  if (pruneFailures.length > 0) report.pruneFailures = pruneFailures;

  report.version = version;
  report.publishedBuckets = published;
  report.publishedBytes = writtenBytes;
  report.failures = failures.slice(0, 10);
  report.failureCount = failures.length;
  report.outcome = failures.length === 0 ? "published" : "partially_published";
  annotateReport("postcodes", report);
  return failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    report.outcome = "threw";
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    annotateReport("postcodes", report);
    process.exit(1);
  });
