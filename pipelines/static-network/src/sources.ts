import { SourceClient } from "@busstops/pipeline-core";
import { getSourceRegistryEntry, type SourceHealth } from "@busstops/contracts";
import { isZipArchive, readTransXChangeFromZip } from "./zip.js";

/**
 * Fetches the national static datasets. Every request is bounded, retried with jitter and
 * circuit-broken; a source that cannot be fetched is reported as a health failure so the
 * pipeline degrades visibly instead of publishing a partial network as if it were complete.
 */

export const NAPTAN_CSV_URL = "https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv";

export interface StaticSourceResult {
  naptanCsv: string | null;
  transXChangeDocuments: string[];
  health: SourceHealth[];
  errors: Array<{ source: string; message: string }>;
}

export interface FetchStaticSourcesOptions {
  bodsApiKey: string | undefined;
  fetchImpl?: typeof fetch;
  /** Caps how many timetable datasets a single run downloads, protecting the runtime budget. */
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
  if (!options.bodsApiKey) {
    errors.push({
      source: "bods",
      message: "BODS_API_KEY is not configured; timetable ingestion cannot run",
    });
  } else {
    try {
      const datasetsUrl = new URL("https://data.bus-data.dft.gov.uk/api/v1/dataset/");
      datasetsUrl.searchParams.set("api_key", options.bodsApiKey);
      datasetsUrl.searchParams.set("status", "published");
      datasetsUrl.searchParams.set("limit", String(options.maxTimetableDatasets ?? 25));

      const catalogue = await bodsClient.fetchJson<{ results?: Array<{ url?: string }> }>(
        datasetsUrl.toString(),
        { timeoutMs: 60_000 },
      );

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

  return { naptanCsv, transXChangeDocuments, health, errors };
}
