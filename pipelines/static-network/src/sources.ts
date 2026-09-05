import { SourceClient } from "@busstops/pipeline-core";
import { getSourceRegistryEntry, type SourceHealth } from "@busstops/contracts";
import { isZipArchive, readTransXChangeFromZip } from "./zip.js";

/**
 * Fetches the national static datasets. Every request is bounded, retried with jitter and
 * circuit-broken; a source that cannot be fetched is reported as a health failure so the
 * pipeline degrades visibly instead of publishing a partial network as if it were complete.
 */

export const NAPTAN_CSV_URL = "https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv";

/** How much of the published timetable estate a run actually took. */
export interface TimetableCoverage {
  /** Datasets BODS says it has published, or null if the catalogue did not say. */
  published: number | null;
  requested: number;
  fetched: number;
}

export interface StaticSourceResult {
  naptanCsv: string | null;
  transXChangeDocuments: string[];
  health: SourceHealth[];
  errors: Array<{ source: string; message: string }>;
  /** Null when no catalogue was read, which means no timetable was ingested at all. */
  timetableCoverage: TimetableCoverage | null;
}

/**
 * How many timetable datasets a run takes by default.
 *
 * Zero, because the timetable no longer comes from here.
 *
 * This used to page the BODS dataset catalogue and unpack the first N archives, and N was a
 * memory limit wearing a coverage limit's clothes: everything it fetched was assembled into one
 * in-memory network, so the ceiling on how much of England could have a timetable was how much of
 * England would fit in a heap. At 60 of 945 that meant a complete national map with a departure
 * board at some stops and nothing at others.
 *
 * The timetable now comes from BODS's own GTFS extract, read as a stream and spilled to disk, so
 * there is no ceiling to set — see `gtfs-sources.ts` and `gtfs-network.ts`. This path is kept for
 * NaPTAN, which is still fetched here, and the cap stays as a parameter so a test can ask for a
 * TransXChange document without the default being to fetch dozens.
 */
export const DEFAULT_MAX_TIMETABLE_DATASETS = 0;

export interface FetchStaticSourcesOptions {
  bodsApiKey: string | undefined;
  fetchImpl?: typeof fetch;
  /**
   * How many of BODS's published timetable datasets a run downloads.
   *
   * This is the single number that decides how much of England has a timetable. NaPTAN gives
   * every stop in the country regardless; services, routes and departures come only from the
   * datasets fetched here. At 25 a national build produced 1,043 services out of 945 published
   * datasets — enough for a working map of the whole country and a departure board only where
   * those operators run, which is how a stop in Manchester came back with no routes at all.
   *
   * It is a cap rather than "all of them" because the download, the parse and the publish all
   * scale with it and the job has a runtime budget. The count fetched and the count published
   * are both reported, so the gap is a number in the build report rather than a surprise at a
   * bus stop.
   */
  maxTimetableDatasets?: number;
}

export async function fetchStaticSources(
  options: FetchStaticSourcesOptions,
): Promise<StaticSourceResult> {
  const errors: StaticSourceResult["errors"] = [];
  const health: SourceHealth[] = [];

  const naptanEntry = getSourceRegistryEntry("naptan")!;
  const naptanClient = new SourceClient(
    "naptan",
    "national",
    naptanEntry.freshnessSlaSeconds,
    options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
  );

  let naptanCsv: string | null = null;
  try {
    naptanCsv = await naptanClient.fetchText(NAPTAN_CSV_URL, {
      timeoutMs: 120_000,
      maxAttempts: 3,
    });
  } catch (error) {
    errors.push({
      source: "naptan",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  health.push(naptanClient.health());

  const bodsEntry = getSourceRegistryEntry("bods")!;
  const bodsClient = new SourceClient(
    "bods",
    "non_london",
    bodsEntry.freshnessSlaSeconds,
    options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
  );

  const transXChangeDocuments: string[] = [];
  let timetableCoverage: TimetableCoverage | null = null;
  if (!options.bodsApiKey) {
    errors.push({
      source: "bods",
      message: "BODS_API_KEY is not configured; timetable ingestion cannot run",
    });
  } else {
    try {
      const wanted = options.maxTimetableDatasets ?? DEFAULT_MAX_TIMETABLE_DATASETS;
      const datasetsUrl = new URL("https://data.bus-data.dft.gov.uk/api/v1/dataset/");
      datasetsUrl.searchParams.set("api_key", options.bodsApiKey);
      datasetsUrl.searchParams.set("status", "published");
      datasetsUrl.searchParams.set("limit", String(wanted));

      const catalogue = await bodsClient.fetchJson<{
        count?: number;
        results?: Array<{ url?: string }>;
      }>(datasetsUrl.toString(), { timeoutMs: 60_000 });

      // What the publisher has, against what this run took. Recorded whether or not it is all of
      // them, because "England-wide" is a claim that should be checkable against a number.
      timetableCoverage = {
        published: catalogue.count ?? null,
        requested: wanted,
        fetched: (catalogue.results ?? []).filter((dataset) => dataset.url).length,
      };

      for (const dataset of catalogue.results ?? []) {
        if (!dataset.url) continue;
        try {
          // Verified against the live catalogue on 2026-09-03: every published dataset reports
          // `extension: "zip"` and the download answers `application/zip`. Fetching the bytes and
          // unpacking is therefore the normal path, not a fallback — but a dataset served as bare
          // XML is still read directly, because the catalogue is the publisher's to change.
          const bytes = await bodsClient.fetchBytes(dataset.url, { timeoutMs: 120_000 });
          if (isZipArchive(bytes)) {
            const archive = readTransXChangeFromZip(bytes);
            for (const entry of archive.entries) transXChangeDocuments.push(entry.text);
            for (const skip of archive.skipped) {
              errors.push({
                source: "bods",
                message: `dataset ${dataset.url}: skipped ${skip.name} (${skip.reason})`,
              });
            }
            if (archive.entries.length === 0) {
              errors.push({
                source: "bods",
                message: `dataset ${dataset.url}: archive contained no TransXChange XML`,
              });
            }
          } else {
            transXChangeDocuments.push(new TextDecoder().decode(bytes));
          }
        } catch (error) {
          errors.push({
            source: "bods",
            message: `dataset fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    } catch (error) {
      errors.push({
        source: "bods",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  health.push(bodsClient.health());

  return { naptanCsv, transXChangeDocuments, health, errors, timetableCoverage };
}
