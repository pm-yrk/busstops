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
    expect(died?.detail?.chars).toBe(461_000);
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
    expect(takeUnfinished()?.detail?.cold).toBe(true);
  });
});
