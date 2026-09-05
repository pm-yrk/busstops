import type { SourceHealth, SourceHealthStatus } from "@busstops/contracts";

/**
 * Resilient upstream client: bounded timeouts, exponential backoff with jitter, a circuit
 * breaker per source, and request coalescing. A single source failure must never blank the
 * application (docs/04_ARCHITECTURE.md "Resilience").
 */

export interface FetchOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "rate_limited" | "server_error" | "client_error" | "network",
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }

  get retryable(): boolean {
    return (
      this.kind === "timeout" ||
      this.kind === "network" ||
      this.kind === "server_error" ||
      this.kind === "rate_limited"
    );
  }
}

/** Full jitter backoff: prevents synchronised retries across collectors after an outage. */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs = 500,
  maxDelayMs = 30_000,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * exponential);
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  openDurationMs: number;
}

export type CircuitState = "closed" | "open" | "half_open";

/**
 * Per-source circuit breaker. Once open, calls fail fast so a broken upstream cannot consume
 * the request budget or stall the Worker; a single trial call probes recovery.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private halfOpenInFlight = false;

  constructor(
    private readonly options: CircuitBreakerOptions = {
      failureThreshold: 5,
      openDurationMs: 60_000,
    },
  ) {}

  state(now: number = Date.now()): CircuitState {
    if (this.openedAt === null) return "closed";
    if (now - this.openedAt >= this.options.openDurationMs) return "half_open";
    return "open";
  }

  canAttempt(now: number = Date.now()): boolean {
    const state = this.state(now);
    if (state === "closed") return true;
    if (state === "open") return false;
    if (this.halfOpenInFlight) return false;
    this.halfOpenInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.halfOpenInFlight = false;
  }

  recordFailure(now: number = Date.now()): void {
    this.failures += 1;
    this.halfOpenInFlight = false;
    if (this.failures >= this.options.failureThreshold) {
      this.openedAt = now;
    }
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}

export interface SourceClientDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One client per upstream source. Tracks health so the UI can show honest freshness and
 * degradation instead of silently serving nothing.
 */
export class SourceClient {
  private readonly breaker: CircuitBreaker;
  private lastSuccessAt: string | null = null;
  private lastAttemptAt: string | null = null;
  private lastMessage: string | undefined;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    readonly sourceName: string,
    readonly coverageArea: string,
    private readonly freshnessSlaSeconds: number,
    private readonly deps: SourceClientDeps = {},
    breakerOptions?: CircuitBreakerOptions,
  ) {
    this.breaker = new CircuitBreaker(breakerOptions);
  }

  /**
   * The fetch this client calls.
   *
   * Bound to `globalThis` rather than read as a property and called as a method. `this.fetchImpl(url)`
   * invokes the global with the SourceClient as its receiver, which Node tolerates and some
   * runtimes — Cloudflare's among them — refuse outright with an illegal-invocation TypeError.
   *
   * This is hazard removal, not a diagnosis: every test injects its own `fetchImpl`, so the
   * unbound path is the one code that only ever runs in a deployment and never in a test, which
   * is precisely the shape of thing that turns out to be broken in production. Binding it costs
   * nothing and removes the question.
   */
  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }
  private get sleep(): (ms: number) => Promise<void> {
    return this.deps.sleep ?? defaultSleep;
  }
  private get nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Coalesces identical concurrent requests so N browsers asking for the same viewport
   * produce one upstream call, not N.
   */
  async coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = run().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  async fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
    const text = await this.fetchText(url, options);
    return JSON.parse(text) as T;
  }

  async fetchText(url: string, options: FetchOptions = {}): Promise<string> {
    return this.fetchWith(url, options, (response) => response.text());
  }

  /**
   * The same retry, backoff, circuit-breaker and health accounting as fetchText, for a body that
   * is not text. BODS publishes every timetable dataset as a zip archive, and decoding one as
   * text is a silent corruption rather than an error: the XML parser simply finds nothing.
   */
  async fetchBytes(url: string, options: FetchOptions = {}): Promise<Uint8Array> {
    return this.fetchWith(
      url,
      options,
      async (response) => new Uint8Array(await response.arrayBuffer()),
    );
  }

  private async fetchWith<T>(
    url: string,
    options: FetchOptions,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const {
      timeoutMs = 8_000,
      maxAttempts = 3,
      baseDelayMs = 500,
      maxDelayMs = 30_000,
      headers = {},
    } = options;

    if (!this.breaker.canAttempt(this.nowMs)) {
      throw new UpstreamError(`Circuit open for ${this.sourceName}`, "network");
    }

    let lastError: UpstreamError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.lastAttemptAt = new Date(this.nowMs).toISOString();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          headers,
          signal: options.signal ?? controller.signal,
        });

        if (response.ok) {
          const body = await read(response);
          this.breaker.recordSuccess();
          this.lastSuccessAt = new Date(this.nowMs).toISOString();
          this.lastMessage = undefined;
          return body;
        }

        const retryAfter = Number(response.headers.get("retry-after")) || undefined;
        if (response.status === 429) {
          lastError = new UpstreamError(
            `${this.sourceName} rate limited`,
            "rate_limited",
            429,
            retryAfter,
          );
        } else if (response.status >= 500) {
          lastError = new UpstreamError(
            `${this.sourceName} server error ${response.status}`,
            "server_error",
            response.status,
          );
        } else {
          // 4xx other than 429 will not succeed on retry.
          lastError = new UpstreamError(
            `${this.sourceName} client error ${response.status}`,
            "client_error",
            response.status,
          );
          break;
        }
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        lastError = new UpstreamError(
          aborted
            ? `${this.sourceName} timed out after ${timeoutMs}ms`
            : `${this.sourceName} network error`,
          aborted ? "timeout" : "network",
        );
      } finally {
        clearTimeout(timer);
      }

      if (attempt < maxAttempts && lastError?.retryable) {
        const delay = lastError.retryAfterSeconds
          ? lastError.retryAfterSeconds * 1000
          : backoffDelayMs(attempt, baseDelayMs, maxDelayMs, this.deps.random);
        await this.sleep(delay);
      }
    }

    this.breaker.recordFailure(this.nowMs);
    this.lastMessage = lastError?.message;
    throw lastError ?? new UpstreamError(`${this.sourceName} failed`, "network");
  }

  health(now: Date = new Date(this.nowMs)): SourceHealth {
    const ageSeconds =
      this.lastSuccessAt === null
        ? null
        : Math.max(0, (now.getTime() - new Date(this.lastSuccessAt).getTime()) / 1000);

    let status: SourceHealthStatus;
    if (this.breaker.state(now.getTime()) === "open") {
      status = "down";
    } else if (ageSeconds === null) {
      status = this.lastAttemptAt === null ? "degraded" : "down";
    } else if (ageSeconds > this.freshnessSlaSeconds * 3) {
      status = "stale";
    } else if (ageSeconds > this.freshnessSlaSeconds || this.breaker.consecutiveFailures > 0) {
      status = "degraded";
    } else {
      status = "healthy";
    }

    return {
      source: this.sourceName,
      coverageArea: this.coverageArea,
      status,
      lastSuccessfulFetchAt: this.lastSuccessAt,
      lastAttemptAt: this.lastAttemptAt,
      ageSeconds,
      consecutiveFailures: this.breaker.consecutiveFailures,
      ...(this.lastMessage === undefined ? {} : { message: this.lastMessage }),
    };
  }
}
