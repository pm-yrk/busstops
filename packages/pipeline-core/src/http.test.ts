import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker, SourceClient, UpstreamError, backoffDelayMs } from "./http.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

/** A client whose sleep is instant and whose clock is controllable, so tests never wait. */
function makeClient(fetchImpl: typeof fetch, nowRef = { value: 0 }) {
  return new SourceClient("tfl", "london", 120, {
    fetchImpl,
    sleep: async () => {},
    now: () => nowRef.value,
    random: () => 0.5,
  });
}

describe("backoff", () => {
  it("grows exponentially and stays within the cap", () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(attempt, 500, 30_000, () => 1));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(backoffDelayMs(20, 500, 30_000, () => 1)).toBe(30_000);
  });

  it("applies jitter so retries do not synchronise", () => {
    expect(backoffDelayMs(3, 500, 30_000, () => 0)).toBe(0);
    expect(backoffDelayMs(3, 500, 30_000, () => 0.5)).toBe(1000);
  });
});

describe("SourceClient retries", () => {
  it("returns the body on first success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.fetchJson("https://example.test/a")).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 500 and succeeds on a later attempt", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? jsonResponse({}, 503) : jsonResponse({ ok: true });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.fetchJson("https://example.test/a")).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("retries a 429 and honours retry-after", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({}, 429, { "retry-after": "2" })
        : jsonResponse({ ok: true });
    });
    const client = new SourceClient("tfl", "london", 120, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(client.fetchJson("https://example.test/a")).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([2000]);
  });

  it("does not retry a 404, which cannot succeed on retry", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.fetchJson("https://example.test/a")).rejects.toThrow(UpstreamError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt limit and reports the failure kind", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(
      client.fetchJson("https://example.test/a", { maxAttempts: 2 }),
    ).rejects.toMatchObject({
      kind: "server_error",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("request coalescing", () => {
  it("collapses identical concurrent requests into one upstream call", async () => {
    let calls = 0;
    const client = makeClient((async () => {
      calls += 1;
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch);

    const key = "map:bbox:leeds";
    const results = await Promise.all([
      client.coalesce(key, () => client.fetchJson("https://example.test/a")),
      client.coalesce(key, () => client.fetchJson("https://example.test/a")),
      client.coalesce(key, () => client.fetchJson("https://example.test/a")),
    ]);

    expect(results).toHaveLength(3);
    expect(calls).toBe(1);
  });

  it("allows a fresh call after the previous one settles", async () => {
    let calls = 0;
    const client = makeClient((async () => {
      calls += 1;
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch);

    await client.coalesce("k", () => client.fetchJson("https://example.test/a"));
    await client.coalesce("k", () => client.fetchJson("https://example.test/a"));
    expect(calls).toBe(2);
  });
});

describe("CircuitBreaker", () => {
  it("opens after the failure threshold and fails fast", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 1000 });
    expect(breaker.canAttempt(0)).toBe(true);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.state(0)).toBe("closed");
    breaker.recordFailure(0);
    expect(breaker.state(0)).toBe("open");
    expect(breaker.canAttempt(500)).toBe(false);
  });

  it("half-opens after the timeout and allows a single probe", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1000 });
    breaker.recordFailure(0);
    expect(breaker.state(1500)).toBe("half_open");
    expect(breaker.canAttempt(1500)).toBe(true);
    // Only one probe is admitted while half-open.
    expect(breaker.canAttempt(1500)).toBe(false);
  });

  it("closes again on success", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1000 });
    breaker.recordFailure(0);
    breaker.canAttempt(1500);
    breaker.recordSuccess();
    expect(breaker.state(1600)).toBe("closed");
    expect(breaker.consecutiveFailures).toBe(0);
  });
});

describe("source health", () => {
  it("reports healthy immediately after a successful fetch", async () => {
    const now = { value: Date.parse("2026-09-02T08:00:00Z") };
    const client = makeClient(
      (async () => jsonResponse({ ok: true })) as unknown as typeof fetch,
      now,
    );
    await client.fetchJson("https://example.test/a");

    const health = client.health(new Date(now.value));
    expect(health.status).toBe("healthy");
    expect(health.consecutiveFailures).toBe(0);
    expect(health.ageSeconds).toBe(0);
  });

  it("degrades when data ages past the freshness SLA, then goes stale", async () => {
    const now = { value: Date.parse("2026-09-02T08:00:00Z") };
    const client = makeClient(
      (async () => jsonResponse({ ok: true })) as unknown as typeof fetch,
      now,
    );
    await client.fetchJson("https://example.test/a");

    // SLA is 120s: 200s old is degraded, 500s old is stale.
    expect(client.health(new Date(now.value + 200_000)).status).toBe("degraded");
    expect(client.health(new Date(now.value + 500_000)).status).toBe("stale");
  });

  it("reports down once the circuit is open", async () => {
    const now = { value: 0 };
    const client = new SourceClient(
      "bods",
      "non_london",
      120,
      {
        fetchImpl: (async () => jsonResponse({}, 500)) as unknown as typeof fetch,
        sleep: async () => {},
        now: () => now.value,
      },
      { failureThreshold: 1, openDurationMs: 60_000 },
    );

    await expect(client.fetchJson("https://example.test/a", { maxAttempts: 1 })).rejects.toThrow();
    const health = client.health(new Date(now.value));
    expect(health.status).toBe("down");
    expect(health.lastSuccessfulFetchAt).toBeNull();
    expect(health.message).toContain("server error");
  });

  it("never reports a successful fetch it did not make", () => {
    const client = makeClient((async () => jsonResponse({})) as unknown as typeof fetch);
    const health = client.health(new Date());
    expect(health.lastSuccessfulFetchAt).toBeNull();
    expect(health.ageSeconds).toBeNull();
    expect(health.status).toBe("degraded");
  });
});
