import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapVehicleSummary } from "@busstops/contracts";
import { useSessionTrail } from "./use-session-trail.js";

/**
 * The trail that forms while somebody watches.
 *
 * The server's bucket covers before the page was opened and is empty for most of the day, because
 * collection runs about four times a day. This fills the gap from data the map is already
 * receiving — so the properties worth asserting are that it costs nothing extra, that it cannot
 * leak between buses or across a reload, and that it is bounded.
 */

function vehicle(overrides: Partial<MapVehicleSummary> = {}): MapVehicleSummary {
  return {
    vehicleRef: "bus-a",
    coordinate: { lat: 53.79, lon: -1.55 },
    bearingDegrees: 0,
    routePublicName: "36",
    routeId: null,
    routePatternId: null,
    destinationName: "Leeds",
    delaySeconds: null,
    freshnessSeconds: 0,
    motionState: "moving",
    ...overrides,
  };
}

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 20, 9, minutes)).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("accumulating a bus's positions while it is selected", () => {
  it("starts with nothing", () => {
    const { result } = renderHook(() => useSessionTrail("bus-a", [vehicle()], at(0)));
    // One refresh is one position, and one position is not a path.
    expect(result.current.length).toBe(1);
  });

  it("keeps each new position as the map refreshes", () => {
    const { result, rerender } = renderHook(
      ({ vehicles, observedAt }: { vehicles: MapVehicleSummary[]; observedAt: string }) =>
        useSessionTrail("bus-a", vehicles, observedAt),
      { initialProps: { vehicles: [vehicle()], observedAt: at(0) } },
    );

    rerender({
      vehicles: [vehicle({ coordinate: { lat: 53.795, lon: -1.55 } })],
      observedAt: at(1),
    });
    rerender({
      vehicles: [vehicle({ coordinate: { lat: 53.8, lon: -1.55 } })],
      observedAt: at(2),
    });

    expect(result.current.length).toBe(3);
    expect(result.current.map((point) => point.coordinate.lat)).toEqual([53.79, 53.795, 53.8]);
  });

  /*
   * A refresh that returns the same reading is not a new position. The feed publishes every ten
   * seconds and the map asks every twenty, so this happens constantly.
   */
  it("does not record the same reading twice", () => {
    const { result, rerender } = renderHook(
      ({ observedAt }: { observedAt: string }) => useSessionTrail("bus-a", [vehicle()], observedAt),
      { initialProps: { observedAt: at(0) } },
    );
    rerender({ observedAt: at(0) });
    rerender({ observedAt: at(0) });
    expect(result.current.length).toBe(1);
  });

  /*
   * Stamped from the feed's clock, not ours. A bus whose position is a minute stale must not be
   * recorded as being somewhere it had already left a minute ago.
   */
  it("stamps a position with when the feed saw it", () => {
    const { result } = renderHook(() =>
      useSessionTrail("bus-a", [vehicle({ freshnessSeconds: 60 })], at(10)),
    );
    expect(result.current[0]!.observedAt).toBe(at(9));
  });

  it("ignores a response that cannot say when it saw anything", () => {
    const { result } = renderHook(() => useSessionTrail("bus-a", [vehicle()], null));
    expect(result.current).toEqual([]);
  });

  it("ignores a refresh in which the selected bus is not present", () => {
    const { result, rerender } = renderHook(
      ({ vehicles, observedAt }: { vehicles: MapVehicleSummary[]; observedAt: string }) =>
        useSessionTrail("bus-a", vehicles, observedAt),
      { initialProps: { vehicles: [vehicle()], observedAt: at(0) } },
    );
    // Out of the viewport, or dropped out of the feed. Not a reason to lose what we have.
    rerender({ vehicles: [vehicle({ vehicleRef: "someone-else" })], observedAt: at(1) });
    expect(result.current.length).toBe(1);
  });

  /*
   * The leak that would matter most: bus A's path drawn under bus B's number.
   */
  it("throws away the previous bus's path when the selection changes", () => {
    const { result, rerender } = renderHook(
      ({ ref, observedAt }: { ref: string | null; observedAt: string }) =>
        useSessionTrail(ref, [vehicle({ vehicleRef: ref ?? "none" })], observedAt),
      { initialProps: { ref: "bus-a" as string | null, observedAt: at(0) } },
    );
    rerender({ ref: "bus-a", observedAt: at(1) });
    expect(result.current.length).toBe(2);

    rerender({ ref: "bus-b", observedAt: at(2) });
    // Not two points and not three: a new bus starts from nothing.
    expect(result.current.length).toBeLessThanOrEqual(1);
  });

  it("keeps nothing at all once no bus is selected", () => {
    const { result, rerender } = renderHook(
      ({ ref, observedAt }: { ref: string | null; observedAt: string }) =>
        useSessionTrail(ref, [vehicle()], observedAt),
      { initialProps: { ref: "bus-a" as string | null, observedAt: at(0) } },
    );
    rerender({ ref: null, observedAt: at(1) });
    expect(result.current).toEqual([]);
  });

  it("drops positions older than the trail's window", () => {
    const { result, rerender } = renderHook(
      ({ observedAt }: { observedAt: string }) => useSessionTrail("bus-a", [vehicle()], observedAt),
      { initialProps: { observedAt: at(0) } },
    );
    // Forty minutes later: the first point is outside the half-hour window.
    rerender({ observedAt: at(40) });
    expect(result.current.length).toBe(1);
    expect(result.current[0]!.observedAt).toBe(at(40));
  });

  it("stays bounded over a long watch", () => {
    const { result, rerender } = renderHook(
      ({ observedAt, lat }: { observedAt: string; lat: number }) =>
        useSessionTrail("bus-a", [vehicle({ coordinate: { lat, lon: -1.55 } })], observedAt),
      { initialProps: { observedAt: at(0), lat: 53.79 } },
    );
    // Twenty-second refreshes for half an hour is ninety; the cap is a hundred and twenty.
    for (let tick = 1; tick <= 200; tick += 1) {
      rerender({
        observedAt: new Date(Date.UTC(2026, 9, 20, 9, 0, tick * 20)).toISOString(),
        lat: 53.79 + tick * 0.0001,
      });
    }
    expect(result.current.length).toBeLessThanOrEqual(120);
  });
});

describe("what the session trail does not do", () => {
  /*
   * In memory for as long as one bus is selected, and nowhere else. A reload starts from nothing,
   * which is the difference between a visual trail and a tracking feature.
   */
  it("writes to no browser storage", () => {
    const local = vi.spyOn(globalThis.localStorage, "setItem");
    const session = vi.spyOn(globalThis.sessionStorage, "setItem");

    const { rerender, unmount } = renderHook(
      ({ observedAt }: { observedAt: string }) => useSessionTrail("bus-a", [vehicle()], observedAt),
      { initialProps: { observedAt: at(0) } },
    );
    rerender({ observedAt: at(1) });
    rerender({ observedAt: at(2) });
    unmount();

    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  });

  it("leaves nothing behind for the next page load", () => {
    const first = renderHook(
      ({ observedAt }: { observedAt: string }) => useSessionTrail("bus-a", [vehicle()], observedAt),
      { initialProps: { observedAt: at(0) } },
    );
    act(() => first.rerender({ observedAt: at(1) }));
    first.unmount();

    // A fresh mount is a fresh page: the same bus starts again from one point.
    const second = renderHook(() => useSessionTrail("bus-a", [vehicle()], at(2)));
    expect(second.result.current.length).toBe(1);
  });
});
