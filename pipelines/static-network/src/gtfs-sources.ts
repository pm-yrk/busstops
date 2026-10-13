import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fetching the BODS GTFS timetable archives.
 *
 * Straight to disk, never into memory: the national archive is the whole of England's registered
 * timetables and the point of the streaming reader is undone if the download is buffered first.
 *
 * Regional downloads exist because they are the failure boundary. A national build that dies
 * two-thirds of the way through leaves nothing; six regional builds that lose one leave five
 * regions' timetables published and one region's gap reported. Which is used is the caller's
 * choice, and `REGIONS` is what BODS publishes.
 */

export const GTFS_BASE_URL = "https://data.bus-data.dft.gov.uk/timetable/download/gtfs-file";

/**
 * The regional extracts BODS publishes.
 *
 * `all` is the national file. The English regions are listed separately because England is this
 * product's scope; Scotland and Wales are published too and are deliberately not fetched.
 */
export const ENGLAND_REGIONS = [
  "north_east",
  "north_west",
  "yorkshire",
  "east_midlands",
  "west_midlands",
  "east_anglia",
  "south_east",
  "south_west",
  "london",
] as const;
export type GtfsRegion = (typeof ENGLAND_REGIONS)[number] | "all" | "england";

export interface GtfsDownload {
  region: string;
  path: string;
  bytes: number;
  ms: number;
  contentType: string | null;
}

export interface GtfsDownloadFailure {
  region: string;
  /** A short class — an HTTP status or an error name. Never a URL, never a key. */
  error: string;
  ms: number;
}

export function gtfsArchiveUrl(region: string, apiKey: string | undefined): string {
  const url = new URL(`${GTFS_BASE_URL}/${region}/`);
  if (apiKey) url.searchParams.set("api_key", apiKey);
  return url.toString();
}

/** Where an archive is put. Outside the repository, and removed when the build is done. */
export function gtfsArchivePath(region: string, directory = tmpdir()): string {
  return join(directory, `busstops-gtfs-${region.replace(/[^\w-]/g, "_")}.zip`);
}

export interface FetchGtfsOptions {
  apiKey: string | undefined;
  region: string;
  directory?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function fetchGtfsArchive(
  options: FetchGtfsOptions,
): Promise<{ ok: true; download: GtfsDownload } | { ok: false; failure: GtfsDownloadFailure }> {
  const started = Date.now();
  const path = gtfsArchivePath(options.region, options.directory);
  const doFetch = options.fetchImpl ?? fetch;

  try {
    const response = await doFetch(gtfsArchiveUrl(options.region, options.apiKey), {
      signal: AbortSignal.timeout(options.timeoutMs ?? 900_000),
    });
    if (!response.ok || !response.body) {
      return {
        ok: false,
        failure: {
          region: options.region,
          error: `http_${response.status}`,
          ms: Date.now() - started,
        },
      };
    }

    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path));
    const { size } = await stat(path);
    return {
      ok: true,
      download: {
        region: options.region,
        path,
        bytes: size,
        ms: Date.now() - started,
        contentType: response.headers.get("content-type"),
      },
    };
  } catch (error) {
    // A half-written archive is worse than none: the zip reader would find a truncated central
    // directory and report a malformed archive rather than a failed download.
    await rm(path, { force: true }).catch(() => {});
    return {
      ok: false,
      failure: {
        region: options.region,
        error: error instanceof Error ? error.name || "error" : "error",
        ms: Date.now() - started,
      },
    };
  }
}

export async function discardGtfsArchive(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {});
}
