import { ApiError } from "./api.js";

/**
 * Keeping a map on the screen when the platform refuses one request.
 *
 * `/v1/map` sometimes answers with Cloudflare's own error 1102 page — "Worker exceeded resource
 * limits" — rather than with the Worker's answer. In a browser that does not arrive as a 503: the
 * platform's error page carries no `Access-Control-Allow-Origin` header, so the fetch is blocked by
 * CORS and the client sees a bare `TypeError`. Measured on the deployed preview, the deaths cluster
 * on a warm isolate and fall roughly every other request, which is exactly the shape a retry fixes.
 *
 * So: ask again, and if the platform refuses twice, ask for less. A narrower box is strictly less
 * work for the Worker — fewer stop tiles, fewer vehicles — and gives the middle of the view, which
 * is where the person is looking, with stops that can actually be clicked. Showing half the stops is
 * a worse map; showing none is not a map.
 */

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** The ways a request can fail that asking again might fix. */
export function isPlatformFailure(error: unknown): boolean {
  /*
   * A `TypeError` from `fetch` is the browser's report of a blocked or dropped response, which is
   * what a Worker that died looks like from the outside. 503 and 502 are the same thing when the
   * platform does send CORS headers, as it does through a plain `curl`.
   */
  if (error instanceof ApiError) return error.status === 503 || error.status === 502;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return error instanceof TypeError;
}

/**
 * The same view, smaller, around the same centre.
 *
 * Not a different place: a person who has panned to Leeds should not be shown York because the
 * first request failed. Halving each side quarters the area and so quarters the stop tiles the
 * Worker has to read.
 */
export function narrowBounds(bounds: Bounds, factor = 0.5): Bounds {
  const centreLon = (bounds.west + bounds.east) / 2;
  const centreLat = (bounds.south + bounds.north) / 2;
  const halfWidth = ((bounds.east - bounds.west) / 2) * factor;
  const halfHeight = ((bounds.north - bounds.south) / 2) * factor;
  return {
    west: centreLon - halfWidth,
    east: centreLon + halfWidth,
    south: centreLat - halfHeight,
    north: centreLat + halfHeight,
  };
}

export interface MapAttemptOutcome<T> {
  response: T;
  /** True when the answer covers less than the view, so the page can say so rather than imply coverage. */
  narrowed: boolean;
  /** How many requests it took, so a run log can show a retry that worked rather than hiding it. */
  attempts: number;
}

/**
 * Three attempts at most: the view, the view again, then a quarter of it.
 *
 * The delay between the first two is deliberate and short. The isolate that refused the first
 * request is the thing being waited out, not a rate limit, and a person watching a blank map will
 * not wait a second for it.
 */
export async function fetchMapWithFallback<T>(
  load: (bounds: Bounds, signal: AbortSignal) => Promise<T>,
  bounds: Bounds,
  signal: AbortSignal,
  options: { delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MapAttemptOutcome<T>> {
  const delayMs = options.delayMs ?? 350;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const plan: Array<{ bounds: Bounds; narrowed: boolean }> = [
    { bounds, narrowed: false },
    { bounds, narrowed: false },
    { bounds: narrowBounds(bounds), narrowed: true },
  ];

  let attempts = 0;
  let last: unknown;
  for (const step of plan) {
    attempts += 1;
    try {
      return { response: await load(step.bounds, signal), narrowed: step.narrowed, attempts };
    } catch (error) {
      last = error;
      // Anything that is not the platform refusing is the Worker's considered answer — a box that
      // is too large, a bad zoom — and asking again would get the same answer more slowly.
      if (!isPlatformFailure(error)) throw error;
      if (signal.aborted) throw error;
      if (attempts < plan.length) await sleep(delayMs);
    }
  }
  throw last;
}
