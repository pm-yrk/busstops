/**
 * What one request cost, measured rather than assumed.
 *
 * Cloudflare answers a Worker that runs out of resources with error 1102 and its own HTML page.
 * That page says "Worker exceeded resource limits" and nothing else: not which limit, not how
 * close the requests that *succeeded* came to it. Five deployments in a row failed the same three
 * endpoints and none of them could say why, because the only requests that carry any evidence are
 * the ones the platform destroys before they can report.
 *
 * So the evidence is collected on the way through, and reported by the requests that live. A
 * successful map request that says it spent 180ms and parsed nine mebibytes is worth more than a
 * dozen 1102s, because it is the one that can be compared against the next.
 *
 * Nothing here holds anything from the request but counts and durations — no keys, no object
 * bodies, no credentials.
 */

/** The artifact families a request can spend its budget on. */
export type ArtifactFamily =
  | "index"
  | "stops"
  | "patterns"
  | "route-patterns"
  | "services"
  | "operators"
  | "route-tiles"
  | "search"
  | "departures"
  | "trips";

export interface FamilyCost {
  /** Objects this family was asked for. */
  requested: number;
  /** Objects that came back with a body from the store. */
  read: number;
  /** Objects already resident in the isolate's cache, which cost no round trip and no parse. */
  cached: number;
  /** Objects the store reported absent. A missing shard is an ordinary answer, not a failure. */
  missing: number;
  /** Objects whose read threw. */
  failed: number;
  /** Characters of decoded text. The wire is gzipped; this is what was held in the isolate. */
  chars: number;
  /** Records handed back after parsing. */
  records: number;
  /** Milliseconds spent inside this family's reads. */
  ms: number;
}

function emptyCost(): FamilyCost {
  return { requested: 0, read: 0, cached: 0, missing: 0, failed: 0, chars: 0, records: 0, ms: 0 };
}

export interface LedgerCounts {
  /** Patterns assembled from what was read. */
  patterns?: number;
  /** Trips loaded for the planner. */
  trips?: number;
  /** Stops resolved. */
  stops?: number;
  /** Nodes in the journey graph. */
  graphNodes?: number;
  /** Edges in the journey graph. */
  graphEdges?: number;
}

/**
 * What the isolate was already holding when this request began, and what it holds now.
 *
 * A request's own cost is only half the question 1102 asks. The readers are module-level
 * singletons, so the twentieth request in an isolate starts against whatever the nineteen before
 * it left resident — and run 45's route detail was killed after six requests that each reported
 * three cheap mebibytes. Without this, "the requests were cheap" and "the isolate was full" are
 * the same measurement.
 */
export interface IsolateResidency {
  /** How many requests this isolate has served, this one included. */
  requestsServed: number;
  /** Resident shards and their source-text size before this request did any work. */
  shardsBefore: number;
  charsBefore: number;
  /** Parsed records still held from earlier requests. This is the memory, not the characters. */
  recordsBefore: number;
  /** Shards let go at the start of this request to make room. */
  evicted: number;
  /** Resident shards and size once this request had finished. */
  shardsAfter: number;
  charsAfter: number;
  recordsAfter: number;
  /** Whole national datasets the isolate keeps: operators, services, places, route tiles. */
  singletons: Record<string, number>;
}

export interface ReadDiagnostics {
  elapsedMs: number;
  /**
   * The wall-clock budget — which is not the resource this Worker runs out of.
   *
   * Workers Free allows **10 ms of CPU** per invocation, and waiting on a fetch or an R2 read
   * costs none of it. A Worker's `Date.now()` also advances only across I/O, so every figure here
   * measures time spent waiting and none of the time spent computing: a request can report
   * "509ms of a 1800ms budget, degraded false" and be killed for exceeding its compute limit in
   * the same breath. Read these as I/O accounting. The compute is not visible from in here, and
   * the way to spend less of it is to parse less, not to lower this number.
   */
  budgetMs: number;
  /** Stated in the payload so nobody reads the number above as headroom. */
  budgetMeasures: "wall-clock-io";
  /**
   * What the published index says this artifact can answer with, and what was used.
   *
   * Three runs read the same 490 records at 1.97 MiB — full `Stop` records, not the projection —
   * against three different artifacts, including one deployed minutes after `map-stops` published
   * cleanly and one served by a Worker with no warm isolate at all. That rules out staleness and
   * leaves "the reader is not taking the new path", which is not something the numbers already
   * here can distinguish from "the new family is not in the index". This says which.
   */
  artifact?: Record<string, string | number | boolean>;
  objectsRequested: number;
  objectsRead: number;
  objectsCached: number;
  objectsMissing: number;
  objectsFailed: number;
  chars: number;
  records: number;
  families: Partial<Record<ArtifactFamily, FamilyCost>>;
  counts: LedgerCounts;
  /** True when this request stopped optional work itself rather than being stopped for it. */
  budgetStopped: boolean;
  degradationReason: string | null;
  stages: Record<string, number>;
  /** Absent on endpoints that read nothing cached across requests. */
  residency?: IsolateResidency;
}

/**
 * One request's ledger.
 *
 * Deliberately per-request. The readers are module-level singletons shared by every request an
 * isolate handles, so a ledger living on a reader would blend concurrent requests together and
 * report a number that describes neither.
 */
export class ReadLedger {
  private readonly families = new Map<ArtifactFamily, FamilyCost>();
  private readonly stageMs = new Map<string, number>();
  private readonly counts: LedgerCounts = {};
  private stoppedReason: string | null = null;
  private residencyReport: IsolateResidency | null = null;
  private artifactNotes: Record<string, string | number | boolean> | null = null;

  constructor(
    readonly budgetMs: number,
    private readonly clock: () => number = () => Date.now(),
    private readonly startedAt: number = clock(),
  ) {}

  get elapsedMs(): number {
    return this.clock() - this.startedAt;
  }

  /** Whether optional work should still be attempted. */
  get withinBudget(): boolean {
    return this.stoppedReason === null && this.elapsedMs < this.budgetMs;
  }

  /** Milliseconds left before optional work should stop. Never negative. */
  get remainingMs(): number {
    return Math.max(0, this.budgetMs - this.elapsedMs);
  }

  /** Records that this request chose to stop, and why. Only the first reason is kept. */
  stop(reason: string): void {
    this.stoppedReason ??= reason;
  }

  get stopped(): boolean {
    return this.stoppedReason !== null;
  }

  get reason(): string | null {
    return this.stoppedReason;
  }

  /**
   * One object read.
   *
   * `missing` and `failed` are different answers and counted apart: an absent shard is an ordinary
   * fact about coverage, a throwing one is a fault. `cached` is counted apart from `read` because
   * the question 1102 raises is what this request decoded, and a cache hit decodes nothing.
   */
  record(
    family: ArtifactFamily,
    entry: {
      chars?: number;
      records?: number;
      ms?: number;
      outcome: "read" | "cached" | "missing" | "failed";
    },
  ): void {
    const cost = this.families.get(family) ?? emptyCost();
    cost.requested += 1;
    cost[entry.outcome] += 1;
    cost.chars += entry.chars ?? 0;
    cost.records += entry.records ?? 0;
    cost.ms += entry.ms ?? 0;
    this.families.set(family, cost);
  }

  /** What the isolate was holding, recorded once the request has finished its reads. */
  /** Records what the artifact declared and which path the handler took because of it. */
  artifactNote(notes: Record<string, string | number | boolean>): void {
    this.artifactNotes = { ...this.artifactNotes, ...notes };
  }

  residency(report: IsolateResidency): void {
    this.residencyReport = report;
  }

  /** A derived count the reads do not describe: patterns assembled, graph size, and so on. */
  count(counts: LedgerCounts): void {
    Object.assign(this.counts, counts);
  }

  /** Time a named stage, so a slow request says which part of it was slow. */
  async stage<T>(name: string, run: () => Promise<T>): Promise<T> {
    const began = this.clock();
    try {
      return await run();
    } finally {
      this.stageMs.set(name, (this.stageMs.get(name) ?? 0) + (this.clock() - began));
    }
  }

  toJSON(): ReadDiagnostics {
    const families: Partial<Record<ArtifactFamily, FamilyCost>> = {};
    let objectsRequested = 0;
    let objectsRead = 0;
    let objectsCached = 0;
    let objectsMissing = 0;
    let objectsFailed = 0;
    let chars = 0;
    let records = 0;
    for (const [family, cost] of this.families) {
      families[family] = cost;
      objectsRequested += cost.requested;
      objectsRead += cost.read;
      objectsCached += cost.cached;
      objectsMissing += cost.missing;
      objectsFailed += cost.failed;
      chars += cost.chars;
      records += cost.records;
    }
    return {
      elapsedMs: this.elapsedMs,
      budgetMs: this.budgetMs,
      budgetMeasures: "wall-clock-io",
      objectsRequested,
      objectsRead,
      objectsCached,
      objectsMissing,
      objectsFailed,
      chars,
      records,
      families,
      counts: { ...this.counts },
      budgetStopped: this.stopped,
      degradationReason: this.stoppedReason,
      stages: Object.fromEntries(this.stageMs),
      ...(this.artifactNotes === null ? {} : { artifact: this.artifactNotes }),
      ...(this.residencyReport === null ? {} : { residency: this.residencyReport }),
    };
  }

  /**
   * The same figures as a `Server-Timing` header, so they show up in a browser's network panel
   * without anyone having to read JSON. Names only, never a key or a URL.
   */
  serverTiming(): string {
    const parts = [`total;dur=${this.elapsedMs}`];
    for (const [family, cost] of this.families) {
      if (cost.ms > 0) parts.push(`${family};dur=${cost.ms};desc="${cost.read}obj"`);
    }
    for (const [stage, ms] of this.stageMs) parts.push(`${stage};dur=${ms}`);
    return parts.join(", ");
  }
}
