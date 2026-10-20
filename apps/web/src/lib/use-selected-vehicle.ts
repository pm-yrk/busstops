import { useEffect, useRef, useState } from "react";
import type { VehicleDetailResponse } from "@busstops/contracts";
import { apiClient, ApiError } from "./api.js";
import type { Bounds } from "./geo.js";

/**
 * One lookup for the bus a passenger has tapped, shared by everything that draws it.
 *
 * `SelectedVehicleBoard` used to fetch this itself, which was fine while the board was the only
 * thing that wanted it. The map now needs the same response — the scheduled shape, the progress
 * along it, the recent trail and the upcoming stops — and a second component calling the same
 * endpoint with the same arguments would be two requests for one tap, on the endpoint that reads a
 * live feed. So the fetch moves up to the page and the answer is passed down.
 *
 * ## Why the key, rather than just an abort
 *
 * Aborting the previous request is necessary and not sufficient. An abort is a request to stop,
 * not a guarantee of having stopped: a response already in flight can resolve after the abort
 * lands, and the naive version of this then renders bus A's stops under bus B's number. The stored
 * answer carries the reference it was asked about, so every read is matched against the current
 * selection and a late arrival is simply not the answer to the question being asked.
 */

export interface SelectedVehicle {
  /** The detail response, or null while loading, errored, or nothing is selected. */
  detail: VehicleDetailResponse | null;
  loading: boolean;
  error: string | null;
}

interface Stored {
  ref: string;
  detail: VehicleDetailResponse | null;
  error: string | null;
}

export function useSelectedVehicle(vehicleRef: string | null, bounds: Bounds): SelectedVehicle {
  const [stored, setStored] = useState<Stored | null>(null);

  /*
   * The viewport, without making it a dependency by identity.
   *
   * `bounds` is rebuilt on every render and changes on every pan, and the lookup is scoped to the
   * box the bus was found in — so depending on it would re-request the same bus continuously while
   * somebody moved the map. The box at the moment of selection is the right one: it is the box the
   * vehicle was returned in, and therefore the one most likely to still contain it.
   *
   * Written in an effect rather than during render, and declared before the effect that reads it:
   * effects run in declaration order, so by the time the fetch runs this holds the bounds of the
   * render that selected the bus.
   */
  const boundsRef = useRef(bounds);
  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  useEffect(() => {
    if (vehicleRef === null) return;

    const controller = new AbortController();
    let current = true;

    apiClient
      .vehicle(vehicleRef, boundsRef.current, controller.signal)
      .then((detail) => {
        if (!current) return;
        setStored({ ref: vehicleRef, detail, error: null });
      })
      .catch((cause: unknown) => {
        if (!current || controller.signal.aborted) return;
        setStored({
          ref: vehicleRef,
          detail: null,
          error:
            cause instanceof ApiError
              ? cause.message
              : "This bus could not be loaded. The map is still usable.",
        });
      });

    return () => {
      current = false;
      controller.abort();
      /*
       * Cleared on the way out, not on the way in.
       *
       * The previous selection's answer has to go, or re-selecting the same bus would show a
       * minutes-old response as current with `loading` already false. Doing it here rather than at
       * the top of the next run keeps the effect body free of a synchronous `setState`, which is a
       * cascading render React's own lint rule objects to — and the teardown is the honest place
       * for it anyway: it is the previous selection being undone.
       */
      setStored(null);
    };
  }, [vehicleRef]);

  if (vehicleRef === null) return { detail: null, loading: false, error: null };

  /*
   * Only an answer about the bus currently selected counts. Anything else — a leftover from the
   * previous selection, or a response that resolved after its abort — reads as still loading,
   * which is what it is from the passenger's point of view.
   */
  const settled = stored?.ref === vehicleRef ? stored : null;
  return {
    detail: settled?.detail ?? null,
    loading: settled === null,
    error: settled?.error ?? null,
  };
}
