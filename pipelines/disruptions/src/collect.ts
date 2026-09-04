import {
  BODS_SITUATIONS_URL,
  normalizeSiriSx,
  normalizeTflLineStatuses,
  normalizeTflRoadDisruptions,
  tflUrl,
} from "@busstops/adapters";
import type { DisruptionNotice, DisruptionSource } from "@busstops/contracts";
import { getSourceRegistryEntry } from "@busstops/contracts";
import { SourceClient } from "@busstops/pipeline-core";

/**
 * Collects the official disruption notices, from every publisher that has any.
 *
 * This runs in a scheduled job rather than in the Worker, for one measured reason: the BODS
 * SIRI-SX document was 6,016,038 bytes when a runner fetched it on 2026-09-04. Parsing six
 * megabytes of XML inside an edge isolate, per viewport, on every request, is neither free nor
 * fast, and caching it there would still mean the first request of each cold isolate paid for it.
 * So it is fetched once every few minutes here, reduced to the notices that are current, and
 * published as a small artifact the Worker can read whole.
 *
 * What is never done: filling a gap. A source that fails is recorded as having failed, and the
 * board says so, rather than the list quietly shrinking.
 */

/**
 * How many notices are published.
 *
 * England has a few thousand open situations at any time and almost all of them are local. The
 * cap keeps the artifact inside what an edge isolate reads comfortably; what it drops is reported
 * so the number can be revisited against a measurement rather than a feeling.
 */
export const MAX_PUBLISHED_NOTICES = 1500;

export interface CollectOptions {
  bodsApiKey: string | undefined;
  tflAppKey: string | undefined;
  retrievedAt: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  maxNotices?: number;
}

export interface SourceOutcome {
  source: DisruptionSource;
  outcome: "ok" | "empty" | "failed" | "not_configured";
  records: number;
  queriedAt: string;
  /** A short class, never a URL and never a credential. */
  error?: string;
  /** What the feed offered before filtering, so "empty" can be told from "all expired". */
  offered?: number;
  bytes?: number;
  ms?: number;
}

export interface CollectResult {
  notices: DisruptionNotice[];
  sources: SourceOutcome[];
  /** Notices dropped by the cap, so the cap is never invisible. */
  dropped: number;
}

/** Reduces a failure to a class. Nothing here can carry a key or a host. */
function failureClass(error: unknown): string {
  if (error instanceof Error) {
    const status = /\b(\d{3})\b/.exec(error.message);
    if (/timed out/i.test(error.message)) return "timeout";
    if (status) return `http_${status[1]}`;
    if (/circuit open/i.test(error.message)) return "circuit_open";
    return error.name || "error";
  }
  return "error";
}

export async function collectDisruptions(options: CollectOptions): Promise<CollectResult> {
  const now = options.now ?? new Date(options.retrievedAt);
  const deps = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
  const sources: SourceOutcome[] = [];
  const notices: DisruptionNotice[] = [];

  // --- England outside London: operators' own SIRI-SX situations ----------------------------
  {
    const started = Date.now();
    const queriedAt = new Date().toISOString();
    if (!options.bodsApiKey) {
      sources.push({
        source: "bods_situations",
        outcome: "not_configured",
        records: 0,
        queriedAt,
      });
    } else {
      const entry = getSourceRegistryEntry("bods")!;
      const client = new SourceClient("bods", "non_london", entry.freshnessSlaSeconds, deps);
      const url = new URL(BODS_SITUATIONS_URL);
      url.searchParams.set("api_key", options.bodsApiKey);
      try {
        const xml = await client.fetchText(url.toString(), { timeoutMs: 120_000 });
        const result = normalizeSiriSx(xml, { retrievedAt: options.retrievedAt, now });
        notices.push(...result.notices);
        sources.push({
          source: "bods_situations",
          outcome: result.notices.length > 0 ? "ok" : "empty",
          records: result.notices.length,
          offered: result.offered,
          bytes: xml.length,
          ms: Date.now() - started,
          queriedAt,
        });
      } catch (error) {
        sources.push({
          source: "bods_situations",
          outcome: "failed",
          records: 0,
          error: failureClass(error),
          ms: Date.now() - started,
          queriedAt,
        });
      }
    }
  }

  // --- London: line status, then the roads those buses run on -------------------------------
  const londonEntry = getSourceRegistryEntry("tfl")!;
  const tflClient = new SourceClient("tfl", "london", londonEntry.freshnessSlaSeconds, deps);

  for (const feed of [
    {
      source: "tfl_status" as const,
      path: "/Line/Mode/bus/Status?detail=true",
      normalize: normalizeTflLineStatuses,
    },
    {
      source: "tfl_disruption" as const,
      path: "/Road/all/Disruption",
      normalize: normalizeTflRoadDisruptions,
    },
  ]) {
    const started = Date.now();
    const queriedAt = new Date().toISOString();
    if (!options.tflAppKey) {
      sources.push({ source: feed.source, outcome: "not_configured", records: 0, queriedAt });
      continue;
    }
    try {
      const payload = await tflClient.fetchJson<unknown>(tflUrl(feed.path, options.tflAppKey), {
        timeoutMs: 30_000,
      });
      const result = feed.normalize(payload, { retrievedAt: options.retrievedAt });
      notices.push(...result.notices);
      sources.push({
        source: feed.source,
        outcome: result.notices.length > 0 ? "ok" : "empty",
        records: result.notices.length,
        offered: result.offered,
        ms: Date.now() - started,
        queriedAt,
      });
    } catch (error) {
      sources.push({
        source: feed.source,
        outcome: "failed",
        records: 0,
        error: failureClass(error),
        ms: Date.now() - started,
        queriedAt,
      });
    }
  }

  /*
   * Ordering, before the cap bites: severity first, then most recently changed. A cap that cut an
   * arbitrary slice would drop a route suspension to keep a leaflet about a bus stop moving ten
   * metres, which is the wrong thousand-and-first notice to lose.
   */
  const rank = ["unknown", "information", "minor", "moderate", "severe"];
  notices.sort((a, b) => {
    const bySeverity = rank.indexOf(b.severity) - rank.indexOf(a.severity);
    if (bySeverity !== 0) return bySeverity;
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });

  const limit = options.maxNotices ?? MAX_PUBLISHED_NOTICES;
  return {
    notices: notices.slice(0, limit),
    sources,
    dropped: Math.max(0, notices.length - limit),
  };
}
