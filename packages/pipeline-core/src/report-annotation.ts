/**
 * A pipeline's own report, as a workflow annotation.
 *
 * Both the collector and the batch run with `continue-on-error`, which reports a failed step as
 * "success" in the job's step list, and their JSON reports are uploaded as artifacts — served from
 * a host this project's container cannot reach. So a run where collection failed is
 * indistinguishable from one where it worked, unless the report comes back through the one channel
 * that is readable: an annotation.
 *
 * That is not a hypothetical. The run that was meant to give Pro fresh figures collected nothing,
 * the settle step correctly skipped itself because the collector's `outcome` was failure, the batch
 * correctly reported `no_input` — and the only thing readable about the cause was the batch saying
 * it had no input. Three steps behaved exactly as designed and the actual error was invisible.
 */

/** What one annotation body survives. GitHub cuts it at about four kibibytes, undocumented. */
const MAX_ANNOTATION_CHARS = 3400;

/** Newlines and the characters the workflow-command parser treats as syntax. */
function escape(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/::/g, "%3A%3A");
}

/**
 * Emit `report` as a notice titled with its outcome, or as a failure where the outcome is one.
 *
 * GitHub truncates an annotation body at about four kibibytes, so the body is capped with a marker
 * rather than cut off mid-string — a JSON body that will not parse is harder to read than a short
 * one that will.
 */
export function annotateReport(name: string, report: Record<string, unknown>): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outcome = String(report.outcome ?? "unknown");
  const bad = outcome === "threw" || outcome === "failed" || outcome === "not_configured";

  /*
   * Escape first, then cap. The other way round does not work: escaping expands every newline
   * from one character to three, so a body capped at 3400 characters of JSON came back as 4169
   * characters of annotation — over the limit it was capped to stay under, and truncated by
   * GitHub at a point of its choosing instead of ours.
   */
  let body = escape(JSON.stringify(report, null, 1));
  if (body.length > MAX_ANNOTATION_CHARS) {
    body = body.slice(0, MAX_ANNOTATION_CHARS);
    // Never leave a half-written escape sequence on the end.
    body = body.replace(/%.?$/, "");
    body = `${body}%0A… truncated`;
  }

  const level = bad ? "error" : "notice";
  /*
   * A workflow command, not logging: stdout is the only channel GitHub reads these from, and the
   * rule forbidding `console.log` is about keeping noise out of library code. This line IS the
   * output.
   */
  // eslint-disable-next-line no-console
  console.log(`::${level} title=${name} (${outcome})::${body}`);
}
