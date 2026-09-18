import type {
  BoundingBox,
  DeparturePrediction,
  DegradationStatus,
  GovernorState,
  MapVehicleSummary,
  ResponseMeta,
  SourceHealth,
  VehicleObservation,
} from "@busstops/contracts";
import { MAP_QUERY_LIMITS, attributionsFor, getSourceRegistryEntry } from "@busstops/contracts";
import { passengerName, routeBadgeName } from "@busstops/pipeline-static-network";
import { SourceClient, ageSeconds } from "@busstops/pipeline-core";
import {
  bodsDatafeedUrl,
  dailyRotationSalt,
  normalizeSiriVm,
  normalizeTflArrivals,
  tflUrl,
} from "@busstops/adapters";
import { cacheTtlMultiplier } from "@busstops/governor";
import type { WorkerEnv } from "./env.js";

/**
 * Live data service.
 *
 * Two rules shape this module. First, requests are always viewport- or stop-scoped: no browser
 * request ever triggers a national fetch. Second, when a source fails the response degrades
 * visibly — stale age, partial coverage, scheduled-only — rather than silently returning
 * nothing or, worse, invented data.
 */

export const LONDON_BOUNDS: BoundingBox = {
  west: -0.55,
  south: 51.28,
  east: 0.32,
  north: 51.7,
};

/** London is served by TfL and the rest of England by BODS; a viewport can span both. */
export function sourcesForBoundingBox(bbox: BoundingBox): Array<"tfl" | "bods"> {
  const intersectsLondon =
    bbox.west <= LONDON_BOUNDS.east &&
    bbox.east >= LONDON_BOUNDS.west &&
    bbox.south <= LONDON_BOUNDS.north &&
    bbox.north >= LONDON_BOUNDS.south;

  const extendsBeyondLondon =
    bbox.west < LONDON_BOUNDS.west ||
    bbox.east > LONDON_BOUNDS.east ||
    bbox.south < LONDON_BOUNDS.south ||
    bbox.north > LONDON_BOUNDS.north;

  const sources: Array<"tfl" | "bods"> = [];
  if (intersectsLondon) sources.push("tfl");
  if (extendsBeyondLondon) sources.push("bods");
  return sources;
}

export function isLondonAtcoCode(atcoCode: string): boolean {
  return atcoCode.startsWith("490") || atcoCode.startsWith("940");
}

export interface LiveServiceDeps {
  env: WorkerEnv;
  now: () => Date;
  fetchImpl?: typeof fetch;
}

export interface VehicleFetchResult {
  observations: VehicleObservation[];
  journeyContext: Map<
    string,
    { publishedLineName?: string | undefined; destinationName?: string | undefined }
  >;
  health: SourceHealth[];
  /** Sources that were expected to contribute but failed. */
  failedSources: string[];
  /**
   * Why a viewport came back with no buses.
   *
   * "Zero vehicles" has four causes that look identical from outside — the request never left,
   * it was refused, the body was empty, or the body was full and every record was rejected — and
   * a bare catch collapsed all four into "bods failed". Each is a different bug, so each is
   * reported separately. Counts and reasons only: never a source vehicle reference.
   */
  diagnostics: VehicleSourceDiagnostics[];
}

export interface VehicleSourceDiagnostics {
  source: string;
  /** "ok" | "request_failed" | "empty_feed" | "all_rejected" */
  outcome: "ok" | "request_failed" | "empty_feed" | "all_rejected";
  rawRecords: number;
  accepted: number;
  /** Rejection reasons with the numbers generalised, so this is a handful of keys not thousands. */
  rejectedBy: Record<string, number>;
  /** Age in seconds of the newest and oldest record the feed offered, accepted or not. */
  newestRecordAgeSeconds: number | null;
  oldestRecordAgeSeconds: number | null;
  /**
   * Where the time in this stage actually went.
   *
   * Every 1102 this deployment has produced arrived immediately after the largest `vehicles` stage
   * in its trail, and run 49 measured that stage at 1,379ms, 1,729ms and 2,530ms during the
   * morning peak against a 1,200ms budget — on route detail and then on the map, which is every
   * endpoint that reads this feed. Handing the fetch a deadline did not shorten it, which points
   * at the parse; but "points at" is not a measurement, and the last time a sound-looking
   * inference went in without one it cost three runs. These two numbers settle it.
   */
  fetchMs?: number;
  parseMs?: number;
  /** Characters of feed text this source returned, which is what the parse is proportional to. */
  chars?: number;
  error?: string;
}

/**
 * What went wrong, in a form that is safe to publish.
 *
 * An upstream error message can carry the request URL, and the request URL carries the API key,
 * so the message is reduced to its class and its status. That is enough to tell a refused request
 * from a timed-out one, which is the distinction that matters.
 */
export function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";

  const status = /\b([45]\d\d)\b/.exec(error.message)?.[1];
  if (error.name === "TimeoutError" || /abort|timeout/i.test(error.message)) return "timeout";
  if (status) return `http_${status}`;

  /*
   * The class alone was not enough.
   *
   * "network_error" is what a deployment reports when its fetch never left, when the runtime
   * refused the call and when the host was unreachable — three different faults with one label,
   * and the whole point of this diagnosis is telling them apart. So the message comes too, with
   * anything that could carry a secret taken out of it first: query strings go entirely, and any
   * host is reduced to the fact that there was one.
   */
  const safeMessage = error.message
    .replace(/https?:\/\/[^\s"']+/g, "<url>")
    .replace(/api_key=[^&\s]*/gi, "api_key=<redacted>")
    .slice(0, 120);

  const name = error.name === "Error" ? "network_error" : error.name;
  return safeMessage.length > 0 ? `${name}: ${safeMessage}` : name;
}

/**
 * Turns one source's normalisation result into a publishable diagnosis.
 *
 * The distinction it exists to draw: a feed that returned nothing, and a feed that returned
 * plenty which we then threw away. The second is our bug and used to be invisible.
 */
export function summariseVehicleSource(
  source: string,
  accepted: number,
  rejected: ReadonlyArray<{ reason: string }>,
  now: Date,
  recordAgeSeconds: readonly number[] = [],
): VehicleSourceDiagnostics {
  void now;
  const rejectedBy: Record<string, number> = {};
  for (const entry of rejected) {
    // Bucket by shape: "observation 812s old" would otherwise be a thousand distinct keys.
    const key = entry.reason.replace(/\d+/g, "N");
    rejectedBy[key] = (rejectedBy[key] ?? 0) + 1;
  }
  const rawRecords = accepted + rejected.length;
  const ages = [...recordAgeSeconds].sort((a, b) => a - b);
  return {
    source,
    outcome: accepted > 0 ? "ok" : rawRecords === 0 ? "empty_feed" : "all_rejected",
    rawRecords,
    accepted,
    rejectedBy,
    newestRecordAgeSeconds: ages.length > 0 ? ages[0]! : null,
    oldestRecordAgeSeconds: ages.length > 0 ? ages[ages.length - 1]! : null,
  };
}

export class LiveService {
  private readonly clients = new Map<string, SourceClient>();

  constructor(private readonly deps: LiveServiceDeps) {}

  private client(source: "bods" | "tfl"): SourceClient {
    const existing = this.clients.get(source);
    if (existing) return existing;

    const entry = getSourceRegistryEntry(source)!;
    const client = new SourceClient(
      source,
      source === "tfl" ? "london" : "non_london",
      entry.freshnessSlaSeconds,
      this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {},
    );
    this.clients.set(source, client);
    return client;
  }

  private vehicleSalt(): string {
    const serviceDate = this.deps.now().toISOString().slice(0, 10);
    return dailyRotationSalt(
      serviceDate,
      this.deps.env.VEHICLE_SALT_SECRET ?? "busstops-default-salt",
    );
  }

  /** Live vehicles inside a viewport. Never fetches beyond the requested bounding box. */
  /**
   * @param timeoutMs How long the upstream fetch may take. Defaults to the map's own limit.
   *
   * Route detail checks its time budget before starting this and the check cannot help, because
   * the overrun happens *inside* the stage: run 48's last request before the platform killed it
   * spent 1,167ms here alone, having entered with time to spare. Run 45's spent 891ms, and both
   * kills arrived immediately after the largest `vehicles` stage in their trail. A caller with a
   * deadline has to be able to hand it over rather than hope.
   */
  async vehiclesInBoundingBox(
    bbox: BoundingBox,
    timeoutMs: number = MAP_QUERY_LIMITS.timeoutMs,
  ): Promise<VehicleFetchResult> {
    const now = this.deps.now();
    const observations: VehicleObservation[] = [];
    const journeyContext = new Map<
      string,
      { publishedLineName?: string; destinationName?: string }
    >();
    const health: SourceHealth[] = [];
    const failedSources: string[] = [];
    const diagnostics: VehicleSourceDiagnostics[] = [];

    const sources = sourcesForBoundingBox(bbox);

    if (sources.includes("bods")) {
      const client = this.client("bods");
      const url = bodsDatafeedUrl(bbox, this.deps.env.BODS_API_KEY);
      const cacheKey = `bods:${url}`;
      try {
        const fetchBegan = Date.now();
        const xml = await client.coalesce(cacheKey, () => client.fetchText(url, { timeoutMs }));
        const fetchMs = Date.now() - fetchBegan;
        const parseBegan = Date.now();
        const normalized = normalizeSiriVm(xml, {
          retrievedAt: now.toISOString(),
          vehicleSalt: this.vehicleSalt(),
          now,
        });
        const parseMs = Date.now() - parseBegan;
        observations.push(...normalized.observations);
        for (const [ref, context] of normalized.journeyContext) {
          journeyContext.set(ref, {
            ...(context.publishedLineName === undefined
              ? {}
              : { publishedLineName: context.publishedLineName }),
            ...(context.destinationName === undefined
              ? {}
              : { destinationName: context.destinationName }),
          });
        }
        diagnostics.push({
          ...summariseVehicleSource(
            "bods",
            normalized.observations.length,
            normalized.rejected,
            now,
            normalized.recordAgeSeconds,
          ),
          fetchMs,
          parseMs,
          chars: xml.length,
        });
      } catch (error) {
        failedSources.push("bods");
        diagnostics.push({
          source: "bods",
          outcome: "request_failed",
          rawRecords: 0,
          accepted: 0,
          rejectedBy: {},
          newestRecordAgeSeconds: null,
          oldestRecordAgeSeconds: null,
          error: describeFetchFailure(error),
        });
      }
      health.push(client.health(now));
    }

    if (sources.includes("tfl")) {
      // TfL publishes arrival predictions rather than vehicle positions, so the live map's
      // London vehicle layer is intentionally empty; London arrivals are served per stop.
      const client = this.client("tfl");
      health.push(client.health(now));
    }

    return { observations, journeyContext, health, failedSources, diagnostics };
  }

  /** Departures for one stop, from whichever source covers it. */
  async departuresForStop(atcoCode: string): Promise<{
    departures: DeparturePrediction[];
    health: SourceHealth[];
    failed: boolean;
    /** When the data behind these departures was observed — never a future arrival time. */
    observedAt: string | null;
  }> {
    const now = this.deps.now();

    if (isLondonAtcoCode(atcoCode)) {
      const client = this.client("tfl");
      const url = tflUrl(
        `/StopPoint/${encodeURIComponent(atcoCode)}/Arrivals`,
        this.deps.env.TFL_APP_KEY,
      );
      try {
        const payload = await client.coalesce(`tfl:${url}`, () =>
          client.fetchJson<unknown>(url, { timeoutMs: MAP_QUERY_LIMITS.timeoutMs }),
        );
        const normalized = normalizeTflArrivals(payload, { retrievedAt: now.toISOString(), now });
        return {
          departures: normalized.departures,
          health: [client.health(now)],
          failed: false,
          // TfL answers with predictions it has just computed, so the fetch is the observation.
          observedAt: now.toISOString(),
        };
      } catch {
        return {
          departures: [],
          health: [client.health(now)],
          failed: true,
          observedAt: null,
        };
      }
    }

    /*
     * Outside London there is no per-stop live source: BODS publishes vehicle positions, not
     * arrival predictions. The board is composed from the timetable by the caller, which is
     * exactly what this used to say and exactly what nothing did.
     */
    const client = this.client("bods");
    return { departures: [], health: [client.health(now)], failed: false, observedAt: null };
  }

  /**
   * Health for every source this deployment covers, used or not.
   *
   * This returned the clients that happened to have been constructed, and the clients are built
   * lazily by whichever request first needs one — so on a cold isolate `/v1/sources/health`
   * answered with an empty array and four deployment verifications in a row reported "no sources
   * reported". That read as an outage and was a lazy map: the sources were fine and nobody had
   * asked them anything yet.
   *
   * Naming both sources makes the answer a property of the deployment rather than of what it has
   * been asked so far. A source that has never been called reports its own never-fetched state,
   * which is the truth and is what a status page should show.
   */
  health(): SourceHealth[] {
    const now = this.deps.now();
    for (const source of ["bods", "tfl"] as const) this.client(source);
    return [...this.clients.values()].map((client) => client.health(now));
  }
}

export interface MetaInput {
  sources: readonly SourceHealth[];
  observedAt: string | null;
  coverage: number;
  governorState: GovernorState;
  now: Date;
  networkPartialCoverage?: boolean;
  failedSources?: readonly string[];
  safeMode?: boolean;
  /** What the request cost. Counts and durations; see ResponseMetaSchema.diagnostics. */
  diagnostics?: Record<string, unknown>;
}

/**
 * Builds the response envelope. Degradation is derived from what actually happened to the
 * sources on this request, so the UI can state the truth rather than a generic "live" label.
 */
export function buildMeta(input: MetaInput): ResponseMeta {
  const sourceNames = input.sources.map((s) => s.source);
  const degradation = deriveDegradation(input);

  return {
    generatedAt: input.now.toISOString(),
    observedAt: input.observedAt,
    sources: [...input.sources],
    coverage: input.coverage,
    degradation,
    governorState: input.governorState,
    attribution: attributionsFor([...sourceNames, "naptan", "osm"]),
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
  };
}

export function deriveDegradation(input: MetaInput): DegradationStatus {
  if (input.safeMode || input.governorState === "critical") return "safe_mode";

  const failed = input.failedSources ?? [];
  const contributing = input.sources.filter((s) => s.status !== "down");

  if (contributing.length === 0 && input.sources.length > 0) return "scheduled_only";
  if (failed.length > 0 || input.networkPartialCoverage) return "partial_sources";
  if (input.sources.some((s) => s.status === "stale")) return "stale_data";
  return "normal";
}

/** Cache TTL for a response, scaled by governor pressure. */
export function cacheTtlSeconds(
  source: "bods" | "tfl" | "static",
  governorState: GovernorState,
): number {
  const base = source === "static" ? 3600 : (getSourceRegistryEntry(source)?.cacheTtlSeconds ?? 20);
  return Math.round(base * cacheTtlMultiplier(governorState));
}

/** Oldest contributing observation, which is what the freshness label must reflect. */
export function oldestObservedAt(observations: readonly { observedAt: string }[]): string | null {
  if (observations.length === 0) return null;
  return observations.reduce(
    (oldest, o) => (o.observedAt < oldest ? o.observedAt : oldest),
    observations[0]!.observedAt,
  );
}

export function toMapVehicle(
  observation: VehicleObservation,
  context:
    { publishedLineName?: string | undefined; destinationName?: string | undefined } | undefined,
  now: Date,
  motionState: MapVehicleSummary["motionState"] = "unknown",
  delaySeconds: number | null = null,
): MapVehicleSummary {
  return {
    vehicleRef: observation.vehicleRef,
    coordinate: observation.coordinate,
    bearingDegrees: observation.bearingDegrees ?? null,
    routePublicName: context?.publishedLineName ? routeBadgeName(context.publishedLineName) : null,
    /*
     * Unknown until the viewport's patterns say otherwise.
     *
     * A live feed gives the number on the front and nothing that identifies the service, so this
     * cannot be filled in here however tempting it is to reuse the name. The map handler resolves
     * it where the viewport's own patterns make it unambiguous, and leaves it null where they do
     * not — a bus linked to the wrong operator's 36 is worse than a bus with no route link.
     */
    routeId: null,
    routePatternId: null,
    destinationName: context?.destinationName ? passengerName(context.destinationName) : null,
    delaySeconds,
    freshnessSeconds: ageSeconds(observation.observedAt, now),
    motionState,
  };
}
