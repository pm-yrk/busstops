import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api.js";
import { fetchMapWithFallback, isPlatformFailure, narrowBounds } from "./map-fallback.js";

const VIEW = { west: -1.6, south: 53.775, east: -1.49, north: 53.825 };
const nowait = { sleep: () => Promise.resolve() };

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("telling a platform failure from an answer", () => {
  /*
   * The one that matters: error 1102 reaches a browser as a bare TypeError, because Cloudflare's
   * error page carries no CORS header. A retry keyed only on 503 would never fire in a browser.
   */
  it("counts a blocked fetch, which is what error 1102 looks like in a browser", () => {
    expect(isPlatformFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(
      isPlatformFailure(new ApiError("Worker exceeded resource limits", 503, "unavailable")),
    ).toBe(true);
    expect(isPlatformFailure(new ApiError("bad gateway", 502, "unavailable"))).toBe(true);
  });

  it("does not count an answer the Worker meant, however unwelcome", () => {
    expect(isPlatformFailure(new ApiError("too large", 400, "bbox_too_large"))).toBe(false);
    expect(isPlatformFailure(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isPlatformFailure(new Error("something else"))).toBe(false);
  });
});

describe("narrowing a view", () => {
  it("keeps the centre, so a retry shows the same place", () => {
    const narrowed = narrowBounds(VIEW);
    expect((narrowed.west + narrowed.east) / 2).toBeCloseTo((VIEW.west + VIEW.east) / 2, 10);
    expect((narrowed.south + narrowed.north) / 2).toBeCloseTo((VIEW.south + VIEW.north) / 2, 10);
    expect(narrowed.east - narrowed.west).toBeCloseTo((VIEW.east - VIEW.west) / 2, 10);
  });
});

describe("keeping stops on the map when the platform refuses", () => {
  it("asks once when the first answer arrives", async () => {
    const load = vi.fn().mockResolvedValue("map");
    const outcome = await fetchMapWithFallback(load, VIEW, signal(), nowait);
    expect(outcome).toMatchObject({ response: "map", narrowed: false, attempts: 1 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("asks again for the same view, and says it was not narrowed", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue("map");
    const outcome = await fetchMapWithFallback(load, VIEW, signal(), nowait);
    expect(outcome).toMatchObject({ narrowed: false, attempts: 2 });
    expect(load).toHaveBeenNthCalledWith(2, VIEW, expect.anything());
  });

  /*
   * Two refusals means the isolate is not going to answer for this view, so ask for a quarter of it.
   * The page says the view is partial; it does not pretend the answer covers the screen.
   */
  it("falls back to a quarter of the view, and reports that it did", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue("smaller map");
    const outcome = await fetchMapWithFallback(load, VIEW, signal(), nowait);
    expect(outcome).toMatchObject({ response: "smaller map", narrowed: true, attempts: 3 });
    expect(load).toHaveBeenNthCalledWith(3, narrowBounds(VIEW), expect.anything());
  });

  it("gives up after three, rather than hammering a Worker that is already over its limit", async () => {
    const load = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchMapWithFallback(load, VIEW, signal(), nowait)).rejects.toThrow(
      "Failed to fetch",
    );
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not retry an answer the Worker meant", async () => {
    const load = vi.fn().mockRejectedValue(new ApiError("too large", 400, "bbox_too_large"));
    await expect(fetchMapWithFallback(load, VIEW, signal(), nowait)).rejects.toThrow("too large");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
