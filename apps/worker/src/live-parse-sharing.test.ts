import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LiveService } from "./live-service.js";
import type { WorkerEnv } from "./env.js";

/**
 * Two requests that want the identical live feed must not both parse it.
 *
 * On the free plan the parse is the expensive half. A local benchmark puts SIRI-VM at about a
 * hundred milliseconds per mebibyte and an invocation gets ten milliseconds of CPU, and the
 * Worker's own numbers cannot show it: `Date.now()` in Workers advances only across I/O, so every
 * one of these parses reported `parse=0ms` while costing several times the budget. That is most of
 * why the deployed 1102s went unattributed for so long.
 *
 * Holding the finished parse — which the service already did — helps the request that arrives a
 * second later and does nothing for the one that arrives in the same millisecond. A page load
 * produces the second kind: the deployed burst instrument answered 1102 on a Leeds viewport's
 * second attempt while a paced walk of sixty-six requests passed without one.
 *
 * These assert the sharing from outside, through `reusedParse`, which is set from whether that
 * particular call did the parse itself. Not from timings: this is a Node test runner and the
 * thing being protected is Cloudflare's CPU accounting.
 */

const siriXml = readFileSync(
  join(new URL("../../../tests/fixtures/documented", import.meta.url).pathname, "bods-siri-vm.xml"),
  "utf8",
);

const BBOX = { west: -1.62, south: 53.75, east: -1.46, north: 53.84 };

function serviceWith(options: { onFetch?: () => void } = {}) {
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches += 1;
    options.onFetch?.();
    /* A tick of latency, so a second caller genuinely arrives while the first is in flight. */
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(siriXml, { status: 200 });
  }) as unknown as typeof fetch;

  const live = new LiveService({
    env: { BODS_API_KEY: "test-key" } as unknown as WorkerEnv,
    now: () => new Date("2026-09-02T08:00:05Z"),
    fetchImpl,
  });
  return { live, fetches: () => fetches };
}

describe("concurrent requests for one live feed", () => {
  it("parses once and tells the second caller it did not parse", async () => {
    const { live, fetches } = serviceWith();

    const [first, second] = await Promise.all([
      live.vehiclesInBoundingBox(BBOX, 2_000),
      live.vehiclesInBoundingBox(BBOX, 2_000),
    ]);

    /* Both answered, and with the same feed: sharing must not cost the second caller its data. */
    expect(first.observations.length).toBeGreaterThan(0);
    expect(second.observations.length).toBe(first.observations.length);

    const parsed = [first, second].filter((result) => result.diagnostics[0]?.reusedParse === false);
    const shared = [first, second].filter((result) => result.diagnostics[0]?.reusedParse === true);
    expect(parsed, "exactly one of the two should have done the parse").toHaveLength(1);
    expect(shared, "and the other should have awaited it").toHaveLength(1);
    expect(fetches(), "and the fetch is shared too, as it already was").toBe(1);
  });

  it("does not leave a failed parse for the next request to inherit", async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("socket closed");
      return new Response(siriXml, { status: 200 });
    }) as unknown as typeof fetch;

    const live = new LiveService({
      env: { BODS_API_KEY: "test-key" } as unknown as WorkerEnv,
      now: () => new Date("2026-09-02T08:00:05Z"),
      fetchImpl,
    });

    const failed = await live.vehiclesInBoundingBox(BBOX, 2_000);
    expect(failed.observations).toHaveLength(0);

    /*
     * The one that matters. A rejected promise left in the cache would be awaited by every
     * request for the next eight seconds, each reporting the feed as down when a retry answers.
     */
    const retried = await live.vehiclesInBoundingBox(BBOX, 2_000);
    expect(retried.observations.length).toBeGreaterThan(0);
  });

  it("still reuses a finished parse for a request that arrives later", async () => {
    const { live, fetches } = serviceWith();

    const first = await live.vehiclesInBoundingBox(BBOX, 2_000);
    const later = await live.vehiclesInBoundingBox(BBOX, 2_000);

    expect(first.diagnostics[0]?.reusedParse).toBe(false);
    expect(later.diagnostics[0]?.reusedParse).toBe(true);
    expect(later.observations.length).toBe(first.observations.length);
    expect(fetches()).toBe(1);
  });
});
