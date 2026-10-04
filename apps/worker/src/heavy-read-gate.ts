/**
 * Admission control for the reads that allocate megabytes.
 *
 * ## Why this exists
 *
 * Cloudflare's free plan allows ten milliseconds of **CPU** per invocation. An invocation's CPU is
 * its own, but the isolate's heap is shared, and garbage collection is charged in CPU time to
 * whichever request happens to provoke it. So a request that allocates a few mebibytes of
 * short-lived string while three others are doing the same can be billed for collecting a heap it
 * did not fill, and killed with error 1102 — which Cloudflare serves from a page carrying no
 * `Access-Control-Allow-Origin`, so a browser reports it as a CORS failure rather than a 503.
 *
 * ## The evidence, in the order it arrived
 *
 * `startedNotFinished` was added to test whether the isolate was accumulating dead requests. It
 * reported 4, 3 and 2 on dying requests, with the peak equal to the live count and the shard cache
 * empty — so nothing was accumulating and the concurrency was low. That refuted the hypothesis and
 * left allocation pressure as what fits.
 *
 * What made it worth acting on was the visual sweep, which is one browser opening one page at a
 * time against the real deployment — not a synthetic burst. It still reported the map and route
 * endpoints failing CORS on several pages, because **one page load fires three or four requests at
 * once**: stops, patterns, live vehicles, weather. That is the same 2-to-4 the breadcrumbs showed,
 * from a client that represents a person. A map that intermittently loses its stops is visible to
 * a passenger, so this stopped being a stress-harness curiosity.
 *
 * ## What it does, and what it deliberately does not do
 *
 * At most `MAX_CONCURRENT` heavy reads run at once in an isolate; the rest wait. Waiting costs
 * wall-clock, which a suspended request is not charged CPU for, so a queued request is not at risk
 * while it waits — that asymmetry is the whole mechanism.
 *
 * It does not change what any endpoint reads, or how. A lone request — the normal case — passes
 * straight through and cannot tell the gate is there.
 *
 * And it never queues indefinitely. Past `MAX_WAIT_MS` a request proceeds anyway, because the
 * frontend abandons a request after 20 seconds (8 for the map) and a timeout is worse for a
 * passenger than the risk the gate is reducing. That bypass is counted, so a deployment where the
 * gate is too tight says so instead of quietly making pages slow.
 */

/**
 * Two, not one.
 *
 * One would serialise a page's own requests behind each other and show a passenger a map that
 * arrives in stages. Two is the smallest number that still lets a page's stops and its vehicles
 * overlap, and it halves the worst heap the breadcrumbs recorded.
 */
const MAX_CONCURRENT = 2;

/** Past this, proceeding is the lesser risk. See the note above. */
const MAX_WAIT_MS = 2_500;

let active = 0;
const waiting: Array<() => void> = [];

/** Counters for the breadcrumb, so a run can say whether the gate is doing anything. */
let entered = 0;
let queued = 0;
let bypassed = 0;
let peakActive = 0;
let longestWaitMs = 0;

export interface HeavyReadSlot {
  /** Milliseconds spent waiting for the slot. Zero means it was free. */
  waitedMs: number;
  /** True when the wait ran out and the read proceeded without a slot. */
  bypassed: boolean;
  release(): void;
}

function take(): void {
  active += 1;
  if (active > peakActive) peakActive = active;
}

/** Hand the slot to the next waiter, or give it back. */
function handOver(): void {
  const next = waiting.shift();
  if (next) {
    // The slot moves straight across: `active` is not decremented, so it cannot be taken by a
    // request that arrived after this one.
    next();
    return;
  }
  active = Math.max(0, active - 1);
}

/**
 * Acquire a slot, waiting up to `MAX_WAIT_MS`.
 *
 * `release` is safe to call exactly once, including after a bypass, and is written so a thrown
 * read cannot leak the slot — every caller releases in a `finally`.
 */
export async function acquireHeavyRead(): Promise<HeavyReadSlot> {
  if (active < MAX_CONCURRENT) {
    take();
    entered += 1;
    return { waitedMs: 0, bypassed: false, release: makeRelease(false) };
  }

  queued += 1;
  const startedAt = Date.now();

  const granted = await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Remove ourselves so a later `handOver` does not resume a request that has moved on.
      const at = waiting.indexOf(admit);
      if (at >= 0) waiting.splice(at, 1);
      resolve(false);
    }, MAX_WAIT_MS);

    function admit(): void {
      if (settled) {
        // The slot was handed to a request that had already given up; pass it on rather than
        // holding it.
        handOver();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(true);
    }

    waiting.push(admit);
  });

  const waitedMs = Date.now() - startedAt;
  if (waitedMs > longestWaitMs) longestWaitMs = waitedMs;

  if (!granted) {
    bypassed += 1;
    return { waitedMs, bypassed: true, release: makeRelease(true) };
  }

  entered += 1;
  return { waitedMs, bypassed: false, release: makeRelease(false) };
}

function makeRelease(wasBypass: boolean): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // A bypass never held a slot, so it has none to give back.
    if (!wasBypass) handOver();
  };
}

/** What to put in the breadcrumb. Read-only; the gate's state is the isolate's. */
export function heavyReadGateState(): Record<string, number> {
  return { active, waiting: waiting.length, entered, queued, bypassed, peakActive, longestWaitMs };
}

/** For tests only: the gate is module state and a test must be able to start from nothing. */
export function resetHeavyReadGate(): void {
  active = 0;
  waiting.length = 0;
  entered = 0;
  queued = 0;
  bypassed = 0;
  peakActive = 0;
  longestWaitMs = 0;
}

export const HEAVY_READ_GATE_LIMITS = { MAX_CONCURRENT, MAX_WAIT_MS } as const;
