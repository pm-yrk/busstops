/**
 * What the isolate was doing when a request died.
 *
 * Cloudflare answers a Worker over its resource limit with error 1102 and its own HTML page. The
 * request's diagnostics never come back — the whole point of the failure is that the handler did
 * not reach the line that would have reported them — so four runs of increasingly detailed
 * per-request ledgers have described, in detail, only the requests that survived.
 *
 * This is the instrument that sees the other half. A breadcrumb lives in module scope, which
 * survives across requests inside one isolate (the residency counter already proves that: it
 * reports req#12, #17, #19, #20, #22, #23, #25 from one isolate). Each stage of an instrumented
 * handler stamps where it has got to; a handler that finishes clears it. So a breadcrumb that is
 * still set when the *next* request starts belongs to a request that never finished, and that
 * next request reports it.
 *
 * **What it does and does not establish.** A breadcrumb names the last stage a request reached
 * before it disappeared. That is not the same as naming the resource that was exhausted, and the
 * phases must not be read as causes:
 *
 * - `siri:fetch:begin` means the request died after the fetch started and before the next stamp.
 *   It does not mean the socket caused it: a Worker pays no CPU for waiting, and something else
 *   in the same isolate may have been the cost.
 * - `siri:parse:begin` means it died after the parse started and before the parse finished. That
 *   is a narrower window and the work in it is real CPU, so it is stronger evidence — but it is
 *   still a position, not a mechanism.
 *
 * **Absence proves nothing.** This rests on module scope surviving, and whether Cloudflare keeps
 * an isolate alive after a 1102 or replaces it is not documented and not something this code can
 * assume. So:
 *
 * - a breadcrumb that arrives is positive evidence about where the request had got to;
 * - no breadcrumb is **inconclusive** — it may mean nothing died, or it may mean the isolate that
 *   held the record was thrown away with it.
 *
 * Which of those it is can be told apart from the request counter: a fresh isolate starts at 1,
 * so a death followed by a request numbered 1 is consistent with replacement, and a death
 * followed by a continuing sequence is consistent with survival. Both readings need a run's worth
 * of data before either is worth stating.
 *
 * Counts, phase names and durations only — never a key, a URL or a credential.
 */

export interface Breadcrumb {
  /** Which request of this isolate's life. 1 is a cold start. */
  request: number;
  /** Which handler. A path shape, never a populated path. */
  handler: string;
  /** The last stage reached. */
  phase: string;
  /** Milliseconds from the handler starting to that stage being stamped. */
  atMs: number;
  /** Whatever the stage wanted to record: bytes in hand, records kept, a cache outcome. */
  detail?: Record<string, number | string | boolean>;
}

let current: Breadcrumb | null = null;
let startedAt = 0;
/** The breadcrumb of a request that never cleared it, kept until somebody reports it. */
let unfinished: Breadcrumb | null = null;

/**
 * Begin a handler, and adopt any breadcrumb the previous one left behind.
 *
 * A breadcrumb still set at this point means the request that wrote it never reached its own
 * response — either the platform killed it, or it threw somewhere that does not clear. Either
 * way it is the interesting one, so it is kept for the next response to carry out.
 */
export function beginBreadcrumb(handler: string, request: number): void {
  if (current !== null) unfinished = current;
  startedAt = Date.now();
  current = { request, handler, phase: "start", atMs: 0 };
}

/** Stamp progress. Cheap on purpose: one object, no allocation per field. */
export function mark(phase: string, detail?: Record<string, number | string | boolean>): void {
  if (current === null) return;
  current.phase = phase;
  current.atMs = Date.now() - startedAt;
  if (detail) current.detail = detail;
}

/** The handler reached its response, so this request is not the one that died. */
export function endBreadcrumb(): void {
  current = null;
}

/**
 * The last request that did not finish, if one is waiting to be reported.
 *
 * Read once and cleared, so a single failure is reported by exactly one later response rather
 * than repeated by every request for the rest of the isolate's life.
 */
export function takeUnfinished(): Breadcrumb | null {
  const found = unfinished;
  unfinished = null;
  return found;
}
