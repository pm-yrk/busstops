/**
 * Types for `annotate.mjs`, which is JavaScript because the workflows invoke it directly.
 *
 * Three TypeScript scripts import it, and until `tsconfig.scripts.json` existed nothing
 * typechecked them, so the module arrived as an implicit `any` and took their argument checking
 * with it. Declared rather than converted: the `.mjs` is run by `node` from the workflows as well
 * as imported here, and converting it would mean building it first.
 */

/** A GitHub workflow annotation level. `failure` is what fails a step's checks. */
export type AnnotationLevel = "notice" | "warning" | "error";

/**
 * One annotation, split across several numbered ones when the body is too long to survive.
 *
 * A no-op outside GitHub Actions, so a script can call it unconditionally.
 */
export function annotate(level: AnnotationLevel, title: string, message: string): void;

/**
 * A list of results as annotations: each failure on its own, the passes rolled into one notice.
 *
 * GitHub keeps ten annotations per level per step, which is why the passes are summarised and the
 * failures are not.
 */
export function annotateResults(
  heading: string,
  results: ReadonlyArray<{ ok: boolean; name: string; detail?: string }>,
  limit?: number,
): void;
