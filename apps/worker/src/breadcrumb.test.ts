import { describe, expect, it, beforeEach } from "vitest";
import { beginBreadcrumb, endBreadcrumb, mark, takeUnfinished } from "./breadcrumb.js";

/**
 * The breadcrumb exists for the one case no other instrument can reach: a request the platform
 * kills, which never returns its own diagnostics. These assert the mechanism that makes that
 * possible — that a handler which never finishes leaves its last position behind, and that a
 * handler which does finish leaves nothing.
 */
describe("the breadcrumb a dead request leaves behind", () => {
  beforeEach(() => {
    // Drain anything a previous test left, so each starts from a clean isolate.
    beginBreadcrumb("reset", 0);
    endBreadcrumb();
    takeUnfinished();
  });

  it("reports nothing when every request finished", () => {
    beginBreadcrumb("route-detail", 1);
    mark("siri:parse:done", { chars: 1000 });
    endBreadcrumb();

    beginBreadcrumb("route-detail", 2);
    expect(takeUnfinished()).toBeNull();
  });

  it("hands the next request the last phase a killed one reached", () => {
    beginBreadcrumb("route-detail", 7);
    mark("siri:fetch:begin", { bounded: true });
    mark("siri:parse:begin", { chars: 461_000 });
    // No `endBreadcrumb`: this is what being killed looks like from inside the isolate.

    beginBreadcrumb("route-detail", 8);
    const died = takeUnfinished();
    expect(died?.request).toBe(7);
    expect(died?.phase).toBe("siri:parse:begin");
    expect(died?.detail?.["parse.chars"]).toBe(461_000);
    /*
     * And what the stages before it recorded, which used to be discarded.
     *
     * `mark` replaced the detail rather than merging it, so run 69's one recovered death
     * reported the parse's byte count and nothing else — not whether the isolate was cold, not
     * how long the fetch took, not whether the read came from cache. Those are precisely the
     * fields that turn one observation into a pattern across several, which is the bar set for
     * acting on this at all.
     */
    expect(died?.detail?.["fetch.bounded"]).toBe(true);
  });

  it("namespaces each stage's fields, so two stages cannot overwrite each other", () => {
    // Both the fetch and the parse record a byte count, and they are two facts about a request,
    // not one fact recorded twice.
    beginBreadcrumb("route-detail", 21);
    mark("siri:fetch:done", { chars: 674_405, elapsedMs: 512 });
    mark("siri:parse:begin", { chars: 674_405 });
    beginBreadcrumb("route-detail", 22);

    const died = takeUnfinished();
    expect(died?.detail?.["fetch.chars"]).toBe(674_405);
    expect(died?.detail?.["fetch.elapsedMs"]).toBe(512);
    expect(died?.detail?.["parse.chars"]).toBe(674_405);
  });

  it("carries the path it took, not only where it stopped", () => {
    /*
     * One phase name is a position. The sequence says whether the request was already slow
     * before the stage it died in — which separates "the parse is expensive" from "everything on
     * this isolate was", and those have different fixes.
     */
    beginBreadcrumb("route-detail", 31);
    mark("reads:begin", { cold: false });
    mark("statics:done", { objects: 6 });
    mark("siri:fetch:begin", { bounded: true });
    beginBreadcrumb("route-detail", 32);

    const trail = takeUnfinished()?.trail ?? [];
    expect(trail.map((entry) => entry.split("@")[0])).toEqual([
      "reads:begin",
      "statics:done",
      "siri:fetch:begin",
    ]);
  });

  it("bounds the trail, so a handler marking in a loop cannot grow module scope without end", () => {
    // This instrument runs in a 128 MiB isolate and exists to investigate resource exhaustion.
    // An unbounded array in module scope would be the instrument causing the fault it hunts.
    beginBreadcrumb("map", 41);
    for (let step = 0; step < 500; step += 1) mark(`stage:${step}`);
    beginBreadcrumb("map", 42);
    expect(takeUnfinished()!.trail.length).toBeLessThanOrEqual(24);
  });

  it("distinguishes dying on the socket from dying in the parse", () => {
    beginBreadcrumb("route-detail", 3);
    mark("siri:fetch:begin", { bounded: true });
    beginBreadcrumb("route-detail", 4);
    expect(takeUnfinished()?.phase).toBe("siri:fetch:begin");
  });

  it("is reported once and then forgotten", () => {
    beginBreadcrumb("journeys", 11);
    mark("reads:begin", { cold: true });
    beginBreadcrumb("journeys", 12);

    expect(takeUnfinished()?.request).toBe(11);
    // A second reader gets nothing: one death is reported by exactly one later response.
    expect(takeUnfinished()).toBeNull();
  });

  it("marks a cold isolate, because the first request is not like the rest", () => {
    beginBreadcrumb("map", 1);
    mark("reads:begin", { cold: true, residentChars: 0 });
    beginBreadcrumb("map", 2);
    expect(takeUnfinished()?.detail?.["begin.cold"]).toBe(true);
  });
});
