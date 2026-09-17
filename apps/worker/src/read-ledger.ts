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

export interface ReadDiagnostics {
  elapsedMs: number;
  budgetMs: number;
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
