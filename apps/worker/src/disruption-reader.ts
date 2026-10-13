import type { DisruptionNotice, DisruptionSource } from "@busstops/contracts";
import { ArtifactStore, type ObjectStore } from "@busstops/pipeline-core";

/**
 * The official disruption notices, read at the edge.
 *
 * The collection pipeline publishes one small artifact — bounded to
 * `MAX_PUBLISHED_NOTICES`, ordered worst-first — and this reads it whole and caches it per
 * isolate. That is a deliberate exception to the "never read a whole dataset" rule the isolate
 * memory guard enforces, and it is safe for one measured reason: the set is capped at publish
 * time, so its size is a property of this code rather than of how much England happens to be
 * disrupted today.
 *
 * The alternative — fetching SIRI-SX per request — was rejected on a measurement: the document
 * was 6,016,038 bytes when a runner fetched it, and no amount of edge caching makes a six-megabyte
 * XML parse a reasonable thing to do inside a request.
 */

export const DISRUPTIONS_DATASET = "disruptions/notices";

/** How long a cached copy is served before the next request refreshes it. */
const TTL_MS = 3 * 60 * 1000;

export interface DisruptionSourceOutcome {
  source: DisruptionSource;
  outcome: "ok" | "empty" | "failed" | "not_configured";
  records: number;
  queriedAt: string;
  error?: string;
}

export interface DisruptionSnapshot {
  notices: DisruptionNotice[];
  /** When the pipeline last asked the publishers, not when this response was generated. */
  collectedAt: string | null;
  sourcesQueried: DisruptionSourceOutcome[];
  /** True when nothing has ever been published, which is different from "no disruptions". */
  neverPublished: boolean;
}

const EMPTY: DisruptionSnapshot = {
  notices: [],
  collectedAt: null,
  sourcesQueried: [],
  neverPublished: true,
};

export class DisruptionReader {
  private cached: DisruptionSnapshot | null = null;
  private loadedAt = 0;
  private inFlight: Promise<DisruptionSnapshot> | null = null;

  constructor(
    private readonly store: ObjectStore,
    private readonly ttlMs = TTL_MS,
  ) {}

  async snapshot(now: number = Date.now()): Promise<DisruptionSnapshot> {
    if (this.cached && now - this.loadedAt < this.ttlMs) return this.cached;
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      const artifacts = new ArtifactStore(this.store);
      try {
        const { manifest, records } =
          await artifacts.readCurrent<DisruptionNotice>(DISRUPTIONS_DATASET);
        if (!manifest) return EMPTY;

        // The pipeline records what each publisher said in the manifest's notes, so the board can
        // distinguish "no disruptions" from "nobody answered" without a second artifact.
        let sourcesQueried: DisruptionSourceOutcome[] = [];
        if (manifest.notes) {
          try {
            const notes = JSON.parse(manifest.notes) as { sources?: DisruptionSourceOutcome[] };
            sourcesQueried = notes.sources ?? [];
          } catch {
            sourcesQueried = [];
          }
        }

        const snapshot: DisruptionSnapshot = {
          notices: records,
          collectedAt: manifest.publishedAt,
          sourcesQueried,
          neverPublished: false,
        };
        this.cached = snapshot;
        this.loadedAt = now;
        return snapshot;
      } catch {
        // A corrupt or unreadable artifact must not take the page down; it reports as nothing
        // published, which the board says out loud.
        return EMPTY;
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }
}

/** Notices that name any of these stops, or any of these route names. */
export function noticesFor(
  notices: readonly DisruptionNotice[],
  match: { atcoCodes?: readonly string[]; routeNames?: readonly string[] },
  limit = 20,
): DisruptionNotice[] {
  const stops = new Set(match.atcoCodes ?? []);
  // Route names are compared case- and space-insensitively: publishers write "X1", "x1" and
  // "X 1" for the same service, and a passenger does not care which.
  const routes = new Set(
    (match.routeNames ?? []).map((name) => name.replace(/\s+/g, "").toUpperCase()),
  );

  const found: DisruptionNotice[] = [];
  for (const notice of notices) {
    const hitsStop = notice.affectedStops.some((stop) => stops.has(stop.atcoCode));
    const hitsRoute = notice.affectedRoutes.some((route) => {
      const name = route.publishedLineName ?? route.lineRef;
      return name !== undefined && routes.has(name.replace(/\s+/g, "").toUpperCase());
    });
    if (hitsStop || hitsRoute) found.push(notice);
    if (found.length >= limit) break;
  }
  return found;
}
