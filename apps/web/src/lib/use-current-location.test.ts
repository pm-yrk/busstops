import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCurrentLocation } from "./use-current-location.js";

/**
 * The camera rule, which is the part of this that is easy to get wrong.
 *
 * A map that recentres on every position update drags itself out from under the person reading it;
 * a map that only ever recentres once has a location button that does nothing. The rule is that the
 * camera moves on the first fix and on an explicit press, and never in between — and because that
 * rule lives in this hook rather than in the page or the renderer, this is where it can be asserted
 * without a WebGL context.
 *
 * jsdom has no `navigator.geolocation` at all, so each test installs exactly the browser it wants
 * to describe.
 */

interface FakeGeolocation {
  geolocation: {
    getCurrentPosition: ReturnType<typeof vi.fn>;
    watchPosition: ReturnType<typeof vi.fn>;
    clearWatch: ReturnType<typeof vi.fn>;
  };
  /** Fire the most recent `watchPosition` success callback. */
  moveTo: (lat: number, lon: number, accuracyMetres?: number) => void;
  cleared: () => number[];
}

/**
 * A position, with the accuracy the browser would have put on it.
 *
 * Three arguments rather than a default, because a *default* parameter cannot express "the browser
 * reported no accuracy" — passing `undefined` explicitly would still take the default, which is
 * how the first version of this helper made the missing-accuracy test pass for the wrong reason.
 */
function position(lat: number, lon: number, accuracy: number | undefined) {
  return { coords: { latitude: lat, longitude: lon, accuracy } } as globalThis.GeolocationPosition;
}

/** The common case: a decent coarse fix. */
function fix(lat: number, lon: number) {
  return position(lat, lon, 25);
}

/** A refusal, with the spec's own constant on it. */
function denial() {
  return { code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
}

function timeout() {
  return { code: 3, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
}

function installGeolocation(
  behaviour: {
    first?: (ok: (p: globalThis.GeolocationPosition) => void, fail: (e: unknown) => void) => void;
    watch?: boolean;
  } = {},
): FakeGeolocation {
  let watcher: ((p: globalThis.GeolocationPosition) => void) | null = null;
  const cleared: number[] = [];

  const geolocation = {
    getCurrentPosition: vi.fn(
      (ok: (p: globalThis.GeolocationPosition) => void, fail: (e: unknown) => void) => {
        const run = behaviour.first ?? ((resolve) => resolve(fix(53.8, -1.55)));
        run(ok, fail);
      },
    ),
    watchPosition: vi.fn((ok: (p: globalThis.GeolocationPosition) => void) => {
      if (behaviour.watch === false) return 0;
      watcher = ok;
      return 7;
    }),
    clearWatch: vi.fn((id: number) => cleared.push(id)),
  };

  Object.defineProperty(globalThis.navigator, "geolocation", {
    configurable: true,
    value: geolocation,
  });

  return {
    geolocation,
    moveTo: (lat, lon, accuracyMetres = 25) => {
      act(() => watcher?.(position(lat, lon, accuracyMetres)));
    },
    cleared: () => cleared,
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator, "geolocation");
  vi.restoreAllMocks();
});

describe("asking the browser where we are", () => {
  it("reports a position and the accuracy that came with it", () => {
    installGeolocation({ first: (ok) => ok(position(53.8, -1.55, 32)) });
    const { result } = renderHook(() => useCurrentLocation());

    act(() => result.current.request());

    expect(result.current.status).toBe("granted");
    expect(result.current.location).toEqual({
      coordinate: { lat: 53.8, lon: -1.55 },
      accuracyMetres: 32,
    });
  });

  it("treats a missing accuracy as unknown rather than as zero", () => {
    installGeolocation({ first: (ok) => ok(position(53.8, -1.55, undefined)) });
    const { result } = renderHook(() => useCurrentLocation());

    act(() => result.current.request());

    expect(result.current.location?.accuracyMetres).toBeNull();
  });

  it("says unsupported, not denied, when the browser has no geolocation", () => {
    const { result } = renderHook(() => useCurrentLocation());

    act(() => result.current.request());

    // The two states read differently to a passenger and differ in whether asking again is worth
    // offering, so they must not be collapsed.
    expect(result.current.status).toBe("unsupported");
  });

  it("separates a refusal from a device that could not say", () => {
    installGeolocation({ first: (_ok, fail) => fail(timeout()) });
    const { result } = renderHook(() => useCurrentLocation());

    act(() => result.current.request());

    expect(result.current.status).toBe("unavailable");
  });

  /*
   * Asking again after "no" is both rude and futile — browsers suppress the prompt anyway — and a
   * page that retries in a loop is the thing this guards against.
   */
  it("never asks again once the person has refused", () => {
    const fake = installGeolocation({ first: (_ok, fail) => fail(denial()) });
    const { result } = renderHook(() => useCurrentLocation());

    act(() => result.current.request());
    expect(result.current.status).toBe("denied");

    act(() => result.current.request());
    act(() => result.current.request());
    act(() => result.current.recentre());

    expect(fake.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("denied");
  });

  it("does not stack requests while one is already outstanding", () => {
    const fake = installGeolocation({ first: () => {} });
    const { result } = renderHook(() => useCurrentLocation());

    act(() => result.current.request());
    act(() => result.current.request());
    act(() => result.current.request());

    expect(fake.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("requesting");
  });
});

describe("when the camera is allowed to move", () => {
  it("moves on the first successful fix", () => {
    installGeolocation({ first: (ok) => ok(fix(53.8, -1.55)) });
    const onCameraMove = vi.fn();
    const { result } = renderHook(() => useCurrentLocation({ onCameraMove }));

    act(() => result.current.request());

    expect(onCameraMove).toHaveBeenCalledTimes(1);
    expect(onCameraMove.mock.calls[0]?.[0]).toMatchObject({
      coordinate: { lat: 53.8, lon: -1.55 },
    });
  });

  /*
   * The requirement, stated as a test: a passenger who has walked two streets sees their dot move
   * and the map stay where they left it. Anything else is the map fighting them.
   */
  it("does not move again as the passenger walks", () => {
    const fake = installGeolocation({ first: (ok) => ok(fix(53.8, -1.55)) });
    const onCameraMove = vi.fn();
    const { result } = renderHook(() => useCurrentLocation({ onCameraMove }));

    act(() => result.current.request());
    expect(onCameraMove).toHaveBeenCalledTimes(1);

    fake.moveTo(53.81, -1.54);
    fake.moveTo(53.82, -1.53);

    // The marker followed; the camera did not.
    expect(result.current.location?.coordinate).toEqual({ lat: 53.82, lon: -1.53 });
    expect(onCameraMove).toHaveBeenCalledTimes(1);
  });

  it("moves again when the passenger presses the button", () => {
    installGeolocation({ first: (ok) => ok(fix(53.8, -1.55)) });
    const onCameraMove = vi.fn();
    const { result } = renderHook(() => useCurrentLocation({ onCameraMove }));

    act(() => result.current.request());
    act(() => result.current.recentre());

    expect(onCameraMove).toHaveBeenCalledTimes(2);
  });

  /*
   * Pressed with a position already in hand, the camera goes immediately rather than after the two
   * seconds the browser takes to answer again. Waiting makes the button feel broken.
   */
  it("recentres on the position it already has, and refreshes behind it", () => {
    const fake = installGeolocation({ first: (ok) => ok(fix(53.8, -1.55)) });
    const onCameraMove = vi.fn();
    const { result } = renderHook(() => useCurrentLocation({ onCameraMove }));

    act(() => result.current.request());
    fake.geolocation.getCurrentPosition.mockClear();

    act(() => result.current.recentre());

    expect(onCameraMove).toHaveBeenCalledTimes(2);
    expect(fake.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("does not move the camera when the first request fails", () => {
    installGeolocation({ first: (_ok, fail) => fail(timeout()) });
    const onCameraMove = vi.fn();
    const { result } = renderHook(() => useCurrentLocation({ onCameraMove }));

    act(() => result.current.recentre());

    expect(onCameraMove).not.toHaveBeenCalled();
  });
});

describe("following the passenger without following them around", () => {
  /*
   * A phone sitting still reports a position that wanders a few metres as satellites and wifi come
   * and go. Every one of those is a React state change and a new GeoJSON payload for the renderer.
   */
  it("ignores jitter below the width of a road", () => {
    const fake = installGeolocation({ first: (ok) => ok(position(53.8, -1.55, 25)) });
    const { result } = renderHook(() => useCurrentLocation());

    act(() => result.current.request());
    const first = result.current.location;

    // About four metres north — a stationary device, not somebody walking.
    fake.moveTo(53.80004, -1.55, 25);

    expect(result.current.location).toBe(first);
  });

  it("follows a real walk", () => {
    const fake = installGeolocation({ first: (ok) => ok(position(53.8, -1.55, 25)) });
    const { result } = renderHook(() => useCurrentLocation());

    act(() => result.current.request());
    // About thirty metres: past the threshold, and the marker should keep up.
    fake.moveTo(53.8003, -1.55, 25);

    expect(result.current.location?.coordinate.lat).toBeCloseTo(53.8003, 5);
  });

  /* A fix that improves from half a kilometre to thirty metres has told us something. */
  it("redraws when the accuracy changes materially, even standing still", () => {
    const fake = installGeolocation({ first: (ok) => ok(position(53.8, -1.55, 500)) });
    const { result } = renderHook(() => useCurrentLocation());

    act(() => result.current.request());
    fake.moveTo(53.8, -1.55, 30);

    expect(result.current.location?.accuracyMetres).toBe(30);
  });

  it("stops watching when the page goes away", () => {
    const fake = installGeolocation({ first: (ok) => ok(fix(53.8, -1.55)) });
    const { result, unmount } = renderHook(() => useCurrentLocation());

    act(() => result.current.request());
    expect(fake.geolocation.watchPosition).toHaveBeenCalledTimes(1);

    unmount();

    // A watcher on an unmounted page is the definition of background location tracking.
    expect(fake.cleared()).toEqual([7]);
  });

  it("keeps the last good position when the watch starts failing", () => {
    const fake = installGeolocation({ first: (ok) => ok(fix(53.8, -1.55)) });
    const { result } = renderHook(() => useCurrentLocation());

    act(() => result.current.request());
    // A transient loss of signal is not a withdrawal of permission.
    act(() => {
      const fail = fake.geolocation.watchPosition.mock.calls[0]?.[1] as (e: unknown) => void;
      fail(timeout());
    });

    expect(result.current.status).toBe("granted");
    expect(result.current.location?.coordinate).toEqual({ lat: 53.8, lon: -1.55 });
  });
});

describe("what leaves the device", () => {
  /*
   * The coordinate lives in React state in this tab and nowhere else. Asserted rather than
   * documented because "we do not store your location" is a promise the code has to keep.
   */
  it("writes the coordinate to no storage at all", () => {
    const setItem = vi.spyOn(globalThis.localStorage, "setItem");
    const sessionSetItem = vi.spyOn(globalThis.sessionStorage, "setItem");
    installGeolocation({ first: (ok) => ok(fix(53.8, -1.55)) });

    const { result, unmount } = renderHook(() => useCurrentLocation());
    act(() => result.current.request());
    act(() => result.current.recentre());
    unmount();

    expect(setItem).not.toHaveBeenCalled();
    expect(sessionSetItem).not.toHaveBeenCalled();
  });

  it("leaves nothing behind after the page unmounts", () => {
    installGeolocation({ first: (ok) => ok(fix(53.8, -1.55)) });
    const { result, unmount } = renderHook(() => useCurrentLocation());
    act(() => result.current.request());
    unmount();

    // A fresh hook starts with no idea where anybody is: nothing survives the page.
    const { result: next } = renderHook(() => useCurrentLocation());
    expect(next.current.status).toBe("idle");
    expect(next.current.location).toBeNull();
  });
});
