import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Exactly one job may commit to the branch.
 *
 * The evidence workflow's probe and GTFS jobs both called `commit-evidence.mjs`, and both rewrote
 * `evidence/README.md` with their own label and timestamp. The second one's rebase therefore hit a
 * content conflict in that one file, all four retries found a rebase already in progress, and a run
 * whose measurements had every one succeeded reported a failure. A red run that means nothing is
 * worse than no run: it teaches whoever is watching to ignore the colour.
 *
 * The measurement jobs now hand their files over as artifacts and a single `publish` job commits
 * once. This asserts the shape rather than the symptom, because the symptom only appears when two
 * jobs happen to finish close together against a branch that has moved.
 *
 * Read as text rather than parsed, because the only YAML library in `node_modules` is there
 * transitively — a test that depends on someone else's dependency is a test that breaks on an
 * unrelated upgrade.
 */

const WORKFLOWS = join(new URL("../..", import.meta.url).pathname, ".github/workflows");

/** Each top-level job in a workflow, as `{ id, body }`, by the two-space indent they sit at. */
function jobsOf(text: string): Array<{ id: string; body: string }> {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) return [];

  const jobs: Array<{ id: string; body: string }> = [];
  let current: { id: string; body: string[] } | null = null;

  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header !== null) {
      if (current !== null) jobs.push({ id: current.id, body: current.body.join("\n") });
      current = { id: header[1]!, body: [] };
      continue;
    }
    /* A key back at column zero ends `jobs:`. */
    if (/^[A-Za-z]/.test(line)) break;
    current?.body.push(line);
  }
  if (current !== null) jobs.push({ id: current.id, body: current.body.join("\n") });
  return jobs;
}

function pushersIn(text: string): string[] {
  return jobsOf(text)
    .filter(({ body }) => body.includes("commit-evidence"))
    .map(({ id }) => id);
}

describe("workflows that commit back onto the branch", () => {
  it("never have two jobs pushing in the same run", () => {
    const offenders: string[] = [];

    for (const name of readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file))) {
      const pushers = pushersIn(readFileSync(join(WORKFLOWS, name), "utf8"));
      if (pushers.length > 1) offenders.push(`${name}: ${pushers.join(", ")}`);
    }

    expect(
      offenders,
      "Two jobs committing to one branch race on `evidence/README.md` and the loser's rebase " +
        `conflicts, which makes a healthy run red.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("is the publish job that does the committing, and it waits for both measurements", () => {
    const text = readFileSync(join(WORKFLOWS, "evidence.yml"), "utf8");
    expect(pushersIn(text)).toEqual(["publish"]);

    const publish = jobsOf(text).find(({ id }) => id === "publish");
    expect(publish, "evidence.yml has no publish job").toBeDefined();
    expect(publish!.body).toMatch(/needs:\s*\[[^\]]*\bprobe\b[^\]]*\]/);
    expect(publish!.body).toMatch(/needs:\s*\[[^\]]*\bgtfs\b[^\]]*\]/);
    /* A failed measurement is the evidence most worth having back. */
    expect(publish!.body).toMatch(/if:\s*always\(\)/);
  });

  /* The parser has to actually find the jobs, or every assertion above passes on nothing. */
  it("finds the workflow's jobs", () => {
    const ids = jobsOf(readFileSync(join(WORKFLOWS, "evidence.yml"), "utf8")).map(({ id }) => id);
    expect(ids).toEqual(["probe", "gtfs", "publish"]);
  });
});
