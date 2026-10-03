/**
 * Print a result as a GitHub workflow annotation as well as to the log.
 *
 * The reason this exists is narrow and practical: a job's log and its uploaded artifacts are both
 * served from a storage host that this container's egress policy refuses, and the deployed preview
 * itself is unreachable from here too. So for an agent working in this container the only readable
 * evidence a run produces is what comes back through the GitHub API — and annotations do, via
 * `repos/{owner}/{repo}/check-runs/{id}/annotations`. A verification whose result cannot be read
 * is a verification that has to be run twice.
 *
 * GitHub keeps at most ten annotations per level per step, so failures are emitted individually
 * (they are what needs reading) and the passes are rolled into one notice.
 */

/** Newlines and the characters the workflow-command parser treats as syntax. */
function escape(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/::/g, "%3A%3A");
}

/** A single annotation line. `level` is error, warning or notice. */
export function annotate(level, title, message) {
  if (!process.env.GITHUB_ACTIONS) return;
  // A title with a comma or a colon in it would be read as another parameter.
  const safeTitle = escape(title).replace(/[,:]/g, " ");
  process.stdout.write(`::${level} title=${safeTitle}::${escape(message)}\n`);
}

/**
 * The run's verdict, as annotations a reader can fetch.
 *
 * `results` is `{ name, ok, detail }[]`. Failures first and individually, because a failure's
 * detail is the whole point of reading it; then one notice holding every passing line, truncated
 * so a very long roll-up cannot push the failures out.
 */
export function annotateResults(heading, results, limit = 9) {
  if (!process.env.GITHUB_ACTIONS) return;
  const failed = results.filter((result) => !result.ok);
  for (const result of failed.slice(0, limit)) {
    annotate("error", `${heading}: ${result.name}`, result.detail ?? "no detail");
  }
  if (failed.length > limit) {
    annotate(
      "error",
      `${heading}: and ${failed.length - limit} more`,
      failed
        .slice(limit)
        .map((result) => result.name)
        .join("; "),
    );
  }

  const passed = results.filter((result) => result.ok);
  if (passed.length === 0) return;
  const lines = passed.map((result) => `${result.name} — ${result.detail ?? "ok"}`).join("\n");
  annotate(
    failed.length === 0 ? "notice" : "warning",
    `${heading}: ${passed.length} of ${results.length} passed`,
    // Well inside what an annotation body carries, and the failures above are never displaced.
    lines.length > 60_000 ? `${lines.slice(0, 60_000)}\n[truncated]` : lines,
  );
}
