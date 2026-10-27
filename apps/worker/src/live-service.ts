import type {
  BoundingBox,
  DeparturePrediction,
  DegradationStatus,
  GovernorState,
  MapVehicleSummary,
  ResponseMeta,
  SourceHealth,
} from "@busstops/contracts";
import { MAP_QUERY_LIMITS, attributionsFor, getSourceRegistryEntry } from "@busstops/contracts";
import { passengerName, routeBadgeName } from "@busstops/pipeline-static-network";
import { SourceClient } from "@busstops/pipeline-core";
import {
  bodsDatafeedUrl,
  dailyRotationSalt,
  normalizeTflArrivals,
  scanSiriVehicles,
  tflUrl,
  type LiveVehicle,
} from "@busstops/adapters";
import { cacheTtlMultiplier } from "@busstops/governor";
import type { WorkerEnv } from "./env.js";
import { mark } from "./breadcrumb.js";

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
  /**
   * The live vehicles, as compact records rather than full `VehicleObservation`s.
   *
   * Cloudflare classified this Worker's failures as `exceededCpu` against a ten-millisecond free
   * limit, and `/v1/map` was measured at ninety-six milliseconds of which eighty-eight were
   * turning SIRI-VM into observations — a DOM of the whole document, a Zod `safeParse` per
   * vehicle, and then a `deterministicUuid`, a provenance object and an `externalIds` array each.
   * A map marker reads six fields. `scanSiriVehicles` produces those in a measured 1.72 ms, which
   * is eighteen times less, and the `journeyContext` side map is gone with it: the route number
   * and the destination travel on the vehicle instead of in a second `Map` of 437 entries.
   *
   * The full observation shape still exists and is still right — for the collector, which runs in
   * CI where CPU is free and publishes these for the analytics batch, and for the selected-bus
   * endpoint, which builds exactly one.
   */
  vehicles: LiveVehicle[];
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
  /**
   * Whether this answer reused a parse instead of making one.
   *
   * The only way to see the saving from outside: a Worker's clock does not advance across pure
   * computation, so `parseMs` cannot show it and never could.
   */
  reusedParse?: boolean;
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
  /**
   * Rejections, either as a list or already counted by reason.
   *
   * The list is what the full normaliser produces, one object per rejected record; the counts are
   * what the scan produces, because a national feed rejects thousands and building an object per
   * rejection to count it is work with no reader. Both arrive here and both are bucketed the same
   * way, so the diagnostics a passenger-facing degradation message is built from do not change
   * shape depending on which reader ran.
   */
  rejected: ReadonlyArray<{ reason: string }> | Readonly<Record<string, number>>,
  now: Date,
  recordAgeSeconds: readonly number[] = [],
): VehicleSourceDiagnostics {
  void now;
  const rejectedBy: Record<string, number> = {};
  let rejectedTotal = 0;
  if (Array.isArray(rejected)) {
    for (const entry of rejected as ReadonlyArray<{ reason: string }>) {
      // Bucket by shape: "observation 812s old" would otherwise be a thousand distinct keys.
      const key = entry.reason.replace(/\d+/g, "N");
      rejectedBy[key] = (rejectedBy[key] ?? 0) + 1;
      rejectedTotal += 1;
    }
  } else {
    for (const [reason, count] of Object.entries(rejected as Record<string, number>)) {
      const key = reason.replace(/\d+/g, "N");
      rejectedBy[key] = (rejectedBy[key] ?? 0) + count;
      rejectedTotal += count;
    }
  }
  const rawRecords = accepted + rejectedTotal;
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

/**
 * How long a normalised feed is reused before it is parsed again.
 *
 * BODS republishes SIRI-VM every ten seconds or so, so a parse held for less than that cannot
 * make an answer staler than the feed already is — the observations keep the timestamps they were
 * published with, so freshness is reported from the data rather than from when it was reused.
 */
const NORMALIZED_FEED_TTL_MS = 8_000;

/**
 * Awaits a promise somebody else started, for no longer than this caller can afford.
 *
 * Rejects rather than resolving empty, because the caller's `catch` already knows how to report a
 * source that did not answer — and an empty feed reported as a successful read is the "zero buses
 * with a 200" failure this whole file exists to have stopped doing.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`shared live-feed parse exceeded ${String(timeoutMs)}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface NormalizedFeed {
  /** The whole scan, so a reuse answers exactly what a fresh scan would have. */
  parsed: ReturnType<typeof scanSiriVehicles>;
  chars: number;
  at: number;
}

export class LiveService {
  private readonly clients = new Map<string, SourceClient>();

  /**
   * The parsed feed, not just the in-flight fetch — and the parse *in progress*, not only a
   * finished one.
   *
   * `coalesce` deduplicates concurrent requests and drops the entry the moment one settles, so
   * every `/v1/map` re-fetched *and* re-parsed the feed. On the free plan that is the expensive
   * half: a local benchmark puts SIRI-VM at about a hundred milliseconds per mebibyte, and the
   * whole CPU budget for an invocation is ten. The Worker's own diagnostics could never show it —
   * `Date.now()` in Workers advances only across I/O, so every one of these parses has been
   * reporting `parse=0ms` while costing several times the budget.
   *
   * Holding the finished parse fixed the second request that arrived a second later and did
   * nothing for the second request that arrived in the same millisecond, which is the one a page
   * load actually produces. Both missed an empty cache, both shared the fetch through `coalesce`,
   * and then both parsed the same XML independently — so the deployed burst instrument saw a
   * Leeds viewport answer 1102 on its second attempt while a paced walk of sixty-six requests
   * passed. What is held is therefore the promise: whoever asks second awaits the first parse
   * instead of repeating it.
   *
   * This is not an admission gate. Nothing is rejected, delayed or queued; two requests that want
   * the identical feed stop doing the identical work twice, and the second gets an answer at
   * least as fresh as the one it would have parsed for itself.
   */
  private readonly normalized = new Map<string, { at: number; feed: Promise<NormalizedFeed> }>();

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
      /*
       * A tighter breaker than a scheduled collector's, because an isolate does not live as long
       * as one.
       *
       * The default opens after five failed calls, which is calibrated for a job that makes
       * hundreds over minutes. Here a failure costs a passenger's request its budget, and the
       * isolate carrying the breaker is destroyed after a handful of them — so the counter resets
       * before it ever reaches five, and the breaker is defeated by exactly the failure it exists
       * to prevent. Run 52 is what that looks like: `/v1/map` killed on the first attempt of the
       * first city, taking `/v1/search` and `/v1/nearby` with it.
       *
       * Two, so the third request in a struggling isolate fails fast and cheaply instead of
       * spending its whole deadline finding out. Thirty seconds, because a passenger refreshing a
       * map should get live buses back quickly once the upstream recovers, and the half-open
       * probe means one request pays to find out rather than all of them.
       */
      { failureThreshold: 2, openDurationMs: 30_000 },
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
    /**
     * Whether the caller is describing one bus rather than drawing a viewport.
     *
     * The origin, direction, operator and block are read only for a selected bus: reading them
     * for every vehicle in a city measured 1.5 ms of a 4 ms budget, spent on five hundred buses'
     * worth of strings so that one could be described. See `LiveScanOptions.detail`.
     */
    detail = false,
  ): Promise<VehicleFetchResult> {
    const now = this.deps.now();
    const vehicles: LiveVehicle[] = [];
    const health: SourceHealth[] = [];
    const failedSources: string[] = [];
    const diagnostics: VehicleSourceDiagnostics[] = [];

    const sources = sourcesForBoundingBox(bbox);

    if (sources.includes("bods")) {
      const client = this.client("bods");
      const url = bodsDatafeedUrl(bbox, this.deps.env.BODS_API_KEY);
      const cacheKey = `bods:${url}`;
      // Outside the try, so a failure can say how long it spent failing. Run 50's longest stages
      // reported "fetch=?ms parse=?ms" — the throw skipped the assignment, and the one number
      // that would have named the retry chain was the one that went missing.
      const fetchBegan = Date.now();
      try {
        /*
         * A deadline is for the whole stage, so it gets one attempt.
         *
         * `fetchText` retries three times with exponential backoff, and `timeoutMs` bounds each
         * attempt rather than the operation. Handing it a deadline of the request's remaining time
         * therefore made the overrun worse, not better: the first attempt now times out where it
         * would have finished, and the two retries and their backoff follow. Run 49 measured the
         * result — 2,530ms from a stage given about 850ms, which is 3 x 850 plus jitter almost
         * exactly, and the platform answered the request after it.
         *
         * A local benchmark says the parse is not where that time goes: 2.51 MiB of SIRI-VM
         * normalises in 242ms and 7.53 MiB in 728ms, about a hundred milliseconds a mebibyte. So
         * the retries are the whole of it. A caller with a deadline gets one attempt inside it;
         * a caller without one keeps the three, because a scheduled collector genuinely should
         * retry a flaky upstream and has no passenger waiting.
         */
        const bounded = timeoutMs !== MAP_QUERY_LIMITS.timeoutMs;

        const held = this.normalized.get(cacheKey);
        const reused = held !== undefined && now.getTime() - held.at < NORMALIZED_FEED_TTL_MS;

        let normalized: NormalizedFeed;
        if (reused) {
          /*
           * Either a parse that finished or one still running; awaiting covers both, and a
           * settled promise resolves without yielding the thread to anything else.
           *
           * Bounded by *this* caller's deadline, not by the one that started the work. Sharing a
           * parse must not mean inheriting somebody else's patience: the map asks with about
           * 1,800ms, route detail with as little as 300, and a scheduled collector with no bound
           * at all — so an unbounded await let a request wait far past its own budget on a fetch
           * it did not start. The deployed peak walk caught it as a forty-five-second hang
           * followed by failures on the same isolate, which is the shape of a queue rather than
           * of a Worker out of CPU.
           *
           * Abandoning the wait does not abandon the work: the promise belongs to the request
           * that created it and settles for whoever is still waiting.
           */
          mark("siri:cache-hit", { cached: true });
          normalized = await withDeadline(held.feed, timeoutMs);
        } else {
          /*
           * Registered before it is awaited, so a request arriving in the same millisecond finds
           * it. This is the whole point: holding only the finished parse helped the request that
           * came a second later and not the one that came at the same instant, which is the one a
           * page load produces.
           */
          const work = (async (): Promise<NormalizedFeed> => {
            /*
             * Three stamps around the one stage nothing has been able to see inside.
             *
             * A request the platform kills reports nothing, so the only way to learn whether it
             * died waiting on the socket or partway through turning 0.4 MiB of XML into objects
             * is to leave a mark before each and let the next request carry it out. `parseMs`
             * cannot answer this — a Worker's clock does not advance across pure computation —
             * and the distinction is the whole question: waiting costs no CPU, parsing costs
             * nothing else.
             */
            mark("siri:fetch:begin", { bounded, cached: false, timeoutMs });
            const fetchStartedAt = Date.now();
            const xml = await client.coalesce(cacheKey, () =>
              client.fetchText(url, { timeoutMs, ...(bounded ? { maxAttempts: 1 } : {}) }),
            );
            /*
             * A stamp of its own between the socket and the parser.
             *
             * Without it, `siri:parse:begin` was the first evidence the fetch had returned at
             * all, so "died on the socket" and "died in the gap after it" were the same reading.
             * This also carries the fetch's own duration into the breadcrumb, which is one of the
             * correlates a pattern across several deaths needs and which a killed request could
             * never report from its own ledger.
             */
            mark("siri:fetch:done", {
              chars: xml.length,
              elapsedMs: Date.now() - fetchStartedAt,
            });
            mark("siri:parse:begin", { chars: xml.length });
            const parsed = scanSiriVehicles(xml, {
              vehicleSalt: this.vehicleSalt(),
              nowMs: now.getTime(),
              detail,
            });
            mark("siri:parse:done", {
              chars: xml.length,
              observations: parsed.vehicles.length,
            });
            return { parsed, chars: xml.length, at: now.getTime() };
          })();

          /*
           * One feed per viewport, and only the newest. The key carries the bounding box, so a
           * sweep across five cities would otherwise leave five parses resident for nothing.
           */
          this.normalized.clear();
          this.normalized.set(cacheKey, { at: now.getTime(), feed: work });
          try {
            normalized = await work;
          } catch (error) {
            /*
             * A failed parse must not be inherited. Left in place, every request for the next
             * eight seconds would await the same rejection and report the feed as down when a
             * retry would have answered.
             */
            if (this.normalized.get(cacheKey)?.feed === work) this.normalized.delete(cacheKey);
            throw error;
          }
        }

        const fetchMs = Date.now() - fetchBegan;
        // Zero on a reuse, and zero on a parse too: see `normalized` — a Worker's clock does not
        // advance across pure computation, so this number has never been able to show the cost.
        const parseMs = 0;
        vehicles.push(...normalized.parsed.vehicles);
        diagnostics.push({
          ...summariseVehicleSource(
            "bods",
            normalized.parsed.vehicles.length,
            normalized.parsed.rejected,
            now,
            normalized.parsed.recordAgeSeconds,
          ),
          fetchMs,
          parseMs,
          chars: normalized.chars,
          // So a run can see how often the parse is actually being paid for.
          reusedParse: reused,
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
          fetchMs: Date.now() - fetchBegan,
          parseMs: 0,
          chars: 0,
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

    return { vehicles, health, failedSources, diagnostics };
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
export function oldestObservedAt(vehicles: readonly { observedAtMs: number }[]): string | null {
  if (vehicles.length === 0) return null;
  let oldest = vehicles[0]!.observedAtMs;
  for (const vehicle of vehicles) if (vehicle.observedAtMs < oldest) oldest = vehicle.observedAtMs;
  return new Date(oldest).toISOString();
}

export function toMapVehicle(
  vehicle: LiveVehicle,
  now: Date,
  motionState: MapVehicleSummary["motionState"] = "unknown",
  delaySeconds: number | null = null,
): MapVehicleSummary {
  return {
    vehicleRef: vehicle.vehicleRef,
    coordinate: { lat: vehicle.lat, lon: vehicle.lon },
    bearingDegrees: vehicle.bearingDegrees ?? null,
    routePublicName: vehicle.publishedLineName ? routeBadgeName(vehicle.publishedLineName) : null,
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
    destinationName: vehicle.destinationName ? passengerName(vehicle.destinationName) : null,
    delaySeconds,
    freshnessSeconds: Math.max(0, Math.round((now.getTime() - vehicle.observedAtMs) / 1000)),
    motionState,
  };
}
