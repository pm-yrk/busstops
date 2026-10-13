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
  const level = bad ? "error" : "notice";

  /*
   * Escape first, then split. The other way round does not work: escaping expands every newline
   * from one character to three, so a body split at 3,400 characters of JSON came back as 4,169
   * characters of annotation — over the limit it was split to stay under.
   */
  const body = escape(JSON.stringify(report, null, 1));

  if (body.length <= MAX_ANNOTATION_CHARS) {
    // eslint-disable-next-line no-console
    console.log(`::${level} title=${name} (${outcome})::${body}`);
    return;
  }

  /*
   * Split across numbered annotations rather than capped, because capping loses whichever field
   * happens to be last and that is never the one a reader came for.
   *
   * Three separate runs proved it. The static-network report was cut off mid-`spill`, hiding
   * whether the operators had been republished with their National Operator Codes — the entire
   * point of that run. The analytics batch was cut off inside `atomic_publish`, hiding which
   * dataset was rejected and why the batch rolled back. In both cases the run had the answer and
   * the channel threw it away.
   *
   * Parts are numbered so a reader can tell a body that was divided from one that was cut off,
   * and split on `%0A` — an escaped line boundary — so each part is still readable on its own.
   *
   * GitHub keeps at most ten annotations per level per step, so splitting is not a licence to send
   * anything of any size: a report running to tens of kilobytes still needs a caller-side digest
   * naming the fields it is judged on, which is what `run-daily.ts` does. Splitting is for the
   * reports that are merely a little too big, which is most of them.
   */
  const parts: string[] = [];
  let rest = body;
  while (rest.length > 0) {
    if (rest.length <= MAX_ANNOTATION_CHARS) {
      parts.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("%0A", MAX_ANNOTATION_CHARS);
    // A body with no line boundary in reach is split where it is, minus any half escape sequence.
    if (cut <= 0) cut = MAX_ANNOTATION_CHARS;
    parts.push(rest.slice(0, cut).replace(/%.?$/, ""));
    rest = rest.slice(cut);
  }

  parts.forEach((part, index) => {
    // eslint-disable-next-line no-console
    console.log(`::${level} title=${name} (${outcome}) ${index + 1}/${parts.length}::${part}`);
  });
}
