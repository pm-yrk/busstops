import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("returns results in input order, not completion order", async () => {
    // The slowest item is first, so a naive implementation that collects as things finish would
    // return it last and silently misalign every result with its input.
    const delays = [30, 1, 1, 1];
    const results = await mapWithConcurrency(delays, 4, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 50 }, (_, i) => i),
      5,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
    );
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it("keeps the pool full rather than working in batches", async () => {
    // With batching, 6 items at limit 2 takes 3 rounds of the slowest member. With a pool the
    // fast items are picked up as slots free, so a single slow item cannot stall the rest.
    const started: number[] = [];
    await mapWithConcurrency([50, 1, 1, 1, 1, 1], 2, async (ms, index) => {
      started.push(index);
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 99, async (n) => n * 2)).toEqual([2, 4]);
  });

  it("rejects a limit below one rather than hanging with no workers", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(RangeError);
  });

  it("propagates a rejection instead of swallowing it", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
