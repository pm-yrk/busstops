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
  /**
   * Everything every stage recorded, accumulated rather than replaced.
   *
   * This used to hold only the last stage's detail, which threw away the correlates at exactly
   * the moment they mattered: run 69's recovered death reported `chars=674405` from
   * `siri:parse:begin` and nothing else, so whether the isolate was cold, how long the fetch had
   * taken, and whether the read came from cache were all lost — and those are the fields that
   * turn one observation into a pattern across several.
   *
   * Merged, so a request that dies in the parse still carries what the fetch and the reads
   * before it recorded. Keys are namespaced by their stage, so two stages recording `chars`
   * cannot overwrite each other.
   */
  detail: Record<string, number | string | boolean>;
  /** Every phase this request reached, in order, so the path is visible and not just its end. */
  trail: string[];
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
  current = { request, handler, phase: "start", atMs: 0, detail: {}, trail: [] };
}

/**
 * Stamp progress, keeping what earlier stages recorded.
 *
 * The phase is the position — the last place reached — and the detail is cumulative. A death is
 * only useful across several observations, and comparing them needs the same fields present
 * every time regardless of which phase the request happened to stop in.
 *
 * Keys are prefixed with the stage that wrote them, so `fetch.chars` and `parse.chars` are two
 * facts rather than one overwriting the other. The trail is capped: a handler that marked in a
 * loop would otherwise grow an unbounded array in module scope, which on a 128 MiB isolate is
 * the sort of thing this instrument exists to investigate rather than to cause.
 */
const MAX_TRAIL = 24;

export function mark(phase: string, detail?: Record<string, number | string | boolean>): void {
  if (current === null) return;
  current.phase = phase;
  current.atMs = Date.now() - startedAt;
  if (current.trail.length < MAX_TRAIL) current.trail.push(`${phase}@${current.atMs}`);
  if (detail) {
    // Namespaced by the stage's own first token, so `siri:parse:begin` writes `parse.chars`.
    const stage = phase.split(":")[1] ?? phase;
    for (const [key, value] of Object.entries(detail)) {
      current.detail[`${stage}.${key}`] = value;
    }
  }
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
