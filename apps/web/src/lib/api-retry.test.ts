import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./api.js";

/**
 * One retry, for the platform refusing rather than the Worker answering.
 *
 * Measured on the deployed preview: `/v1/search` for "Bullring" came back as Cloudflare's error 1102
 * page, so a recruiter typing a landmark got "no results" from an index that holds Bull Ring. The
 * same happened to `/v1/nearby`, the stop weather and the place-journey. The deaths cluster on a warm
 * isolate and fall roughly every other request, so one more attempt is most of the fix.
 */
function clientWith(fetchImpl: typeof fetch): ApiClient {
  return new ApiClient({ baseUrl: "https://api.example", fetchImpl });
}

const META = {
  generatedAt: "2026-10-01T08:00:00.000Z",
  observedAt: null,
  sources: [],
  coverage: 1,
  degradation: "normal",
  governorState: "green",
  attribution: ["NaPTAN"],
};

/** A valid empty answer: the retry is the subject here, not the payload. */
function emptyResults(): Response {
  return new Response(JSON.stringify({ meta: META, data: { results: [] } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("asking again when the platform refuses", () => {
  it("retries a blocked fetch, which is what error 1102 looks like in a browser", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(emptyResults());

    const client = clientWith(fetchImpl as unknown as typeof fetch);
    await client.search("Bullring");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a 503, and gives the answer the second attempt produced", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValue(emptyResults());

    const client = clientWith(fetchImpl as unknown as typeof fetch);
    const answer = await client.nearby({ lat: 53.8, lon: -1.5 }, 800);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(answer).toBeTruthy();
  });

  /*
   * An answer the Worker meant is not a failure to retry: it would be the same answer more slowly,
   * and retrying a rate limit is an attack on ourselves.
   */
  it.each([
    ["not found", 404],
    ["a bad request", 400],
    ["a rate limit", 429],
  ])("does not retry %s", async (_why, status) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "no", message: "no" } }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = clientWith(fetchImpl as unknown as typeof fetch);
    await expect(client.search("anything")).rejects.toBeInstanceOf(ApiError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after one retry rather than hammering a Worker already over its limit", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const client = clientWith(fetchImpl as unknown as typeof fetch);
    await expect(client.search("Bullring")).rejects.toThrow("Failed to fetch");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  /*
   * The map is the exception, because it runs its own ladder — the view, the view again, then a
   * quarter of it. A retry here as well would make that six requests instead of three.
   */
  it("leaves the map to its own ladder", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const client = clientWith(fetchImpl as unknown as typeof fetch);
    await expect(
      client.map({ west: -1.6, south: 53.775, east: -1.49, north: 53.825 }, 15),
    ).rejects.toThrow("Failed to fetch");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /*
   * A request that is never answered becomes a stated failure, not a page that spins.
   *
   * Nothing bounded a request the server simply never answered. Run 96's sweep caught it twice:
   * the journey page showing a working animation, no result and no reason, because its request had
   * neither returned nor failed. A passenger watching a bus drive across the screen for thirty
   * seconds has been told nothing.
   */
  it("gives up on a request that is never answered, and says so", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      );
      const client = new ApiClient({
        baseUrl: "https://api.example",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const pending = client.sourcesHealth();
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(pending).rejects.toThrow(/heard nothing back/);
      /*
       * Once, not twice, and deliberately.
       *
       * A blocked fetch and a 503 are retried because they usually succeed on the second ask and
       * cost a passenger a few hundred milliseconds. A deadline is different: the Worker's own
       * budgets are 1.8 seconds for a map and 6 for a journey, so twenty seconds of silence is not
       * slowness, and asking again would mean forty seconds of a bus animation before anybody was
       * told anything. The timeout surfaces as a 504, which `isPlatformFailure` does not count, so
       * this is the policy agreeing with itself rather than an omission.
       */
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * And a caller's own abort stays a cancellation. Every page treats that as "never mind" — a fast
   * pan drops its map request — so turning it into an error would put a notice on screen every
   * time somebody moved the map.
   */
  it("keeps a caller's cancellation a cancellation", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const client = new ApiClient({
      baseUrl: "https://api.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const pending = client.sourcesHealth(controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(DOMException);
    // Not retried, and not dressed up as a timeout.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
