import { useCallback, useEffect, useRef, useState } from "react";
import { haversineMetresBrowser, type LatLon } from "./geo.js";

/**
 * Where the passenger is, for as long as the page is open.
 *
 * Browser geolocation belongs in the page/client layer, not in the map: `MapView` is handed a
 * coordinate and draws it, and never asks a browser for permission. That boundary is the reason
 * this is a hook rather than something inside the renderer — the permission prompt is a thing that
 * happens to a person, and it should be owned by the thing that knows why it is being asked for.
 *
 * ## Privacy
 *
 * The coordinate exists in React state in this tab and nowhere else. It is not written to
 * `localStorage`, `sessionStorage`, a cookie, the URL, or any request body. The only thing derived
 * from it that leaves the device is a *viewport* — the same `?bbox` four numbers any panned map
 * sends — which is a rectangle a couple of kilometres across, not a position. Nothing here
 * persists across a reload, by design: a passenger who closes the tab has left no trace to clear.
 */

export type LocationStatus =
  /** Not asked yet. */
  | "idle"
  /** Waiting for the browser, which may or may not be showing a prompt. */
  | "requesting"
  /** A real fix. */
  | "granted"
  /** The person said no. Sticky for the visit — see `request`. */
  | "denied"
  /** Asked and answered with a failure that is not a refusal: no fix, or it took too long. */
  | "unavailable"
  /** This browser has no geolocation at all. */
  | "unsupported";

export interface CurrentLocation {
  coordinate: LatLon;
  /** Metres, as the browser reported it, or null when it did not. */
  accuracyMetres: number | null;
}

export interface UseCurrentLocation {
  status: LocationStatus;
  location: CurrentLocation | null;
  /**
   * Ask the browser where we are.
   *
   * Safe to call more than once: it does nothing while a request is already in flight, and
   * nothing at all once the person has refused. A map that re-prompts somebody who said no is a
   * map that has not listened, and browsers punish it anyway by suppressing the prompt.
   */
  request: () => void;
  /**
   * Ask, and ask the camera to come back to us.
   *
   * Separate from `request` because the camera moving is the part the passenger did not
   * necessarily consent to. A position arriving on its own must never move the view; this is the
   * one path that says they pressed the button.
   */
  recentre: () => void;
}

export interface UseCurrentLocationOptions {
  /**
   * Called when the caller should move the camera: once on the first successful fix, and once per
   * `recentre`. Never on a position arriving on its own.
   *
   * A callback rather than a piece of state the caller watches, because moving the camera is an
   * *event* and not a value. Signalling it through a nonce meant the page had to answer it from an
   * effect, which is three `setState` calls in an effect body — cascading renders, and React's own
   * lint rule says so. The browser's position callback is already outside React's render pass, so
   * calling back from there is the plain version of the same thing.
   *
   * Held in a ref internally, so an inline arrow function is fine and will not re-arm anything.
   */
  onCameraMove?: (location: CurrentLocation) => void;
}

/**
 * Unhurried on purpose.
 *
 * `enableHighAccuracy` turns the GPS on, which costs battery and takes seconds, to answer a
 * question — which neighbourhood is this — that a coarse fix answers perfectly. The whole app asks
 * for location this way; this is the same bargain the other three call sites already make.
 */
const FIRST_FIX_OPTIONS: globalThis.PositionOptions = {
  enableHighAccuracy: false,
  timeout: 8000,
  maximumAge: 60_000,
};

/**
 * How far the passenger must move before the marker is redrawn.
 *
 * A stationary phone reports a position that wanders by a few metres as satellites and wifi come
 * and go, and every one of those is a React state change and a new GeoJSON payload. Fifteen metres
 * is below the width of a road — the dot never visibly lags where somebody actually is — and above
 * the jitter of a device sitting still on a table.
 *
 * Accuracy alone also moves the halo, so a material change in it counts: a fix that improves from
 * 500 m to 30 m has told us something worth drawing even if the centre barely moved.
 */
const MARKER_MOVE_THRESHOLD_METRES = 15;
const ACCURACY_CHANGE_FRACTION = 0.3;

function worthRedrawing(previous: CurrentLocation | null, next: CurrentLocation): boolean {
  if (previous === null) return true;
  if (
    haversineMetresBrowser(previous.coordinate, next.coordinate) >= MARKER_MOVE_THRESHOLD_METRES
  ) {
    return true;
  }
  const before = previous.accuracyMetres;
  const after = next.accuracyMetres;
  if (before === null || after === null) return before !== after;
  // Relative, so the test means the same thing at 20 m as it does at 2 km.
  return Math.abs(after - before) >= before * ACCURACY_CHANGE_FRACTION;
}

function readPosition(position: globalThis.GeolocationPosition): CurrentLocation {
  const accuracy = position.coords.accuracy;
  return {
    coordinate: { lat: position.coords.latitude, lon: position.coords.longitude },
    accuracyMetres: typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null,
  };
}

/**
 * `PERMISSION_DENIED` is 1 in the spec, and the constant is on the error object rather than a
 * global. Read defensively: a browser that reports a bare object should be treated as "could not",
 * not as "refused", because the two states differ in whether we are allowed to ask again.
 */
function isDenial(error: globalThis.GeolocationPositionError): boolean {
  return error.code === (error.PERMISSION_DENIED ?? 1);
}

export function useCurrentLocation(options: UseCurrentLocationOptions = {}): UseCurrentLocation {
  const [status, setStatus] = useState<LocationStatus>("idle");
  const [location, setLocation] = useState<CurrentLocation | null>(null);

  /* The latest callback, without making `request` a new function every time the caller renders. */
  const onCameraMoveRef = useRef(options.onCameraMove);
  useEffect(() => {
    onCameraMoveRef.current = options.onCameraMove;
  }, [options.onCameraMove]);

  /*
   * Read inside callbacks that must not be re-created when these change.
   *
   * `request` is called from an effect on mount and from a button; giving it `status` in its
   * dependency list would make it a different function on every transition, which in turn would
   * re-run the mount effect. The refs keep the identity stable and the decisions current.
   */
  const statusRef = useRef<LocationStatus>("idle");
  const locationRef = useRef<CurrentLocation | null>(null);
  const watchRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  /** Set by `recentre`, consumed by the next successful fix. */
  const moveCameraOnNextFix = useRef(false);
  /** The first fix always moves the camera; later ones only when asked. */
  const hadFirstFix = useRef(false);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      // The watcher outlives React unless it is told not to, and a watcher on an unmounted page is
      // the definition of background location tracking.
      if (watchRef.current !== null) {
        globalThis.navigator?.geolocation?.clearWatch(watchRef.current);
        watchRef.current = null;
      }
    },
    [],
  );

  const accept = useCallback(
    (position: globalThis.GeolocationPosition, allowCameraMove: boolean) => {
      if (!mountedRef.current) return;
      const next = readPosition(position);
      setStatus("granted");
      if (worthRedrawing(locationRef.current, next)) {
        locationRef.current = next;
        setLocation(next);
      }
      const first = !hadFirstFix.current;
      hadFirstFix.current = true;
      if (allowCameraMove && (first || moveCameraOnNextFix.current)) {
        moveCameraOnNextFix.current = false;
        onCameraMoveRef.current?.(next);
      }
    },
    [],
  );

  /**
   * Keep the marker current as somebody walks.
   *
   * Started only after a fix has been granted, so it never produces a prompt of its own, and it
   * deliberately passes `allowCameraMove` — the camera still only moves on the first fix or on an
   * explicit press, which `accept` decides. Watching without that rule is how a map ends up
   * dragging itself out from under the person reading it.
   */
  const startWatching = useCallback(() => {
    const geolocation = globalThis.navigator?.geolocation;
    if (!geolocation?.watchPosition || watchRef.current !== null) return;
    watchRef.current = geolocation.watchPosition(
      (position) => accept(position, true),
      () => {
        /*
         * A failing watch is not a reason to tear down a good position. The marker keeps the last
         * fix, which is still roughly where somebody is, and the status stays `granted` because
         * permission has not been withdrawn — a transient loss of signal is not a refusal.
         */
      },
      FIRST_FIX_OPTIONS,
    );
  }, [accept]);

  const ask = useCallback(
    (moveCamera: boolean) => {
      const geolocation = globalThis.navigator?.geolocation;
      if (!geolocation?.getCurrentPosition) {
        setStatus("unsupported");
        return;
      }
      // Listened to. Asking again after a refusal is both rude and futile.
      if (statusRef.current === "denied" || statusRef.current === "requesting") return;

      if (moveCamera) moveCameraOnNextFix.current = true;
      // A re-press while a position is already known should not blank the marker, so only the
      // first request shows as `requesting`.
      if (locationRef.current === null) setStatus("requesting");

      geolocation.getCurrentPosition(
        (position) => {
          accept(position, true);
          startWatching();
        },
        (error) => {
          if (!mountedRef.current) return;
          moveCameraOnNextFix.current = false;
          setStatus(isDenial(error) ? "denied" : "unavailable");
        },
        FIRST_FIX_OPTIONS,
      );
    },
    [accept, startWatching],
  );

  const request = useCallback(() => ask(false), [ask]);
  const recentre = useCallback(() => {
    /*
     * Already have a position and permission? Move now and refresh in the background.
     *
     * Waiting for a new fix before moving makes the button feel broken for the two seconds the
     * browser takes, and the position we have is correct to within a few metres. So the camera
     * goes immediately and the fix that arrives afterwards updates the marker.
     */
    if (statusRef.current === "granted" && locationRef.current !== null) {
      onCameraMoveRef.current?.(locationRef.current);
      ask(false);
      return;
    }
    ask(true);
  }, [ask]);

  return { status, location, request, recentre };
}
