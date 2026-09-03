import { contentHash, contentHashOf } from "@busstops/pipeline-core";

/**
 * Daily change detection (docs/07_DATA_PIPELINES.md "Static network").
 *
 * The national timetable and stop datasets are large and change rarely. Downloading and
 * reprocessing them unconditionally would burn the compute and storage budget for no benefit,
 * so each source is fingerprinted first and a full rebuild runs only when something moved.
 * A check that finds no change is still recorded, so "nothing happened" is distinguishable
 * from "the job did not run".
 */

export interface SourceFingerprint {
  source: string;
  /** Strong identity where the provider gives one: ETag, checksum or published version. */
  identity: string | null;
  sizeBytes: number | null;
  lastModified: string | null;
  checkedAt: string;
}

export interface FingerprintComparison {
  changed: boolean;
  reason: string;
  previous: SourceFingerprint | null;
  current: SourceFingerprint;
}

export function fingerprintFromHeaders(
  source: string,
  headers: { etag?: string | null; lastModified?: string | null; contentLength?: string | null },
  checkedAt: string,
): SourceFingerprint {
  const size =
    headers.contentLength === undefined || headers.contentLength === null
      ? null
      : Number(headers.contentLength);
  return {
    source,
    identity: headers.etag?.replace(/^W\//, "").replace(/"/g, "") ?? null,
    sizeBytes: Number.isFinite(size) ? size : null,
    lastModified: headers.lastModified ?? null,
    checkedAt,
  };
}

export function fingerprintFromBody(
  source: string,
  body: string,
  checkedAt: string,
): SourceFingerprint {
  return {
    source,
    identity: contentHash(body),
    sizeBytes: body.length,
    lastModified: null,
    checkedAt,
  };
}

/**
 * Fingerprints a source that arrives as many documents rather than one body.
 *
 * Joining them to reuse fingerprintFromBody would allocate a second copy of the whole dataset,
 * which is exactly what exhausted the heap on the first real bootstrap. The hash is identical to
 * the one the joined string would produce.
 */
export function fingerprintFromParts(
  source: string,
  parts: readonly string[],
  checkedAt: string,
): SourceFingerprint {
  let sizeBytes = 0;
  for (const part of parts) sizeBytes += part.length;
  return {
    source,
    identity: contentHashOf(parts),
    sizeBytes,
    lastModified: null,
    checkedAt,
  };
}

export function compareFingerprints(
  previous: SourceFingerprint | null,
  current: SourceFingerprint,
): FingerprintComparison {
  if (!previous) {
    return { changed: true, reason: "no previous fingerprint recorded", previous, current };
  }
  if (current.identity !== null && previous.identity !== null) {
    const changed = current.identity !== previous.identity;
    return {
      changed,
      reason: changed ? "content identity changed" : "content identity unchanged",
      previous,
      current,
    };
  }
  // Without a strong identity, fall back to size and last-modified. Both being unknown means
  // we cannot prove the source is unchanged, so we rebuild rather than risk serving stale data.
  if (current.sizeBytes !== null && previous.sizeBytes !== null) {
    const changed = current.sizeBytes !== previous.sizeBytes;
    if (changed) return { changed, reason: "content length changed", previous, current };
  }
  if (current.lastModified !== null && previous.lastModified !== null) {
    const changed = current.lastModified !== previous.lastModified;
    return {
      changed,
      reason: changed ? "last-modified changed" : "last-modified unchanged",
      previous,
      current,
    };
  }
  if (current.sizeBytes !== null && previous.sizeBytes !== null) {
    return { changed: false, reason: "content length unchanged", previous, current };
  }
  return { changed: true, reason: "no comparable fingerprint fields", previous, current };
}
