#!/usr/bin/env node
/**
 * Commits whatever the evidence workflow just wrote back onto the branch.
 *
 * This session's GitHub token lost its Actions scope: dispatching a workflow is refused and a run
 * that was read in full an hour earlier now 404s, while pushes still work. So the reports are put
 * where git can reach them rather than only in a run log. It is plumbing around a broken read
 * path, not a place to keep results permanently — `evidence/` is a scratch record of what a
 * runner saw and when, overwritten by the next run.
 *
 * It rebases before pushing, because two evidence jobs can finish close together.
 *
 *   node scripts/commit-evidence.mjs <label> [note]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const [label = "evidence", note = ""] = process.argv.slice(2);
const branch = process.env.GITHUB_REF_NAME;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

mkdirSync("evidence", { recursive: true });
writeFileSync(
  "evidence/README.md",
  `${[
    "# evidence/",
    "",
    "What a GitHub Actions runner actually saw, committed back onto the branch.",
    "",
    "This exists because the build session's GitHub token lost its Actions scope: it can push, but",
    "it cannot dispatch a workflow or read a run's logs. Writing the reports here is how the",
    "results get back to somewhere readable. Files are overwritten by each run — this is the",
    "latest measurement, not an archive.",
    "",
    `Last written: ${new Date().toISOString()} (${label})`,
    note ? `\n${note}` : "",
  ].join("\n")}\n`,
);

git("config", "user.name", "github-actions[bot]");
git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
git("add", "evidence");

if (git("diff", "--cached", "--name-only").trim().length === 0) {
  console.log("Nothing to commit.");
  process.exit(0);
}

git("commit", "-m", `Evidence: ${label} at ${new Date().toISOString()}`);

if (!branch) {
  console.error("GITHUB_REF_NAME is not set; refusing to guess which branch to push to.");
  process.exit(1);
}

for (let attempt = 1; attempt <= 4; attempt += 1) {
  try {
    git("pull", "--rebase", "origin", branch);
    git("push", "origin", `HEAD:${branch}`);
    console.log(`Pushed the evidence on attempt ${attempt}.`);
    process.exit(0);
  } catch (error) {
    console.log(`Push attempt ${attempt} failed: ${String(error.message).split("\n")[0]}`);
  }
}

console.error("Could not push the evidence.");
process.exit(1);
