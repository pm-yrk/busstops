import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join } from "node:path";

/**
 * No pipeline may read a number out of the environment with `Number(process.env.X ?? default)`.
 *
 * ## Why this is a test rather than a convention
 *
 * GitHub Actions does not omit an environment variable whose repository variable is unset — it
 * sets it to the empty string. `??` falls back only on `null` and `undefined`, so `""` survives
 * it, and `Number("")` is **0**. Every optional numeric knob passed as `${{ vars.X }}` therefore
 * becomes zero the moment a workflow starts running, and a zero is not obviously wrong: it reads
 * as a deliberate pause, a disabled feature, or a governor doing its job.
 *
 * It cost a day and two separate outages of the same pipeline:
 *
 *   - `MAX_PARTITIONS_PER_RUN` became 0, so scheduled collection planned zero partitions and
 *     fetched nothing — `outcome: "suspended"`, which looked exactly like the quota governor
 *     working as designed.
 *   - `R2_STORAGE_LIMIT_BYTES` became 0, so retention believed the storage allowance was zero
 *     bytes, concluded it was infinitely over, and deleted all 36,114 collected observations
 *     between one batch run and the next.
 *
 * Five more numbers had the same fault and had not yet been noticed. The second one was missed on
 * the first sweep because it was written `?? String(10 * 1024 * 1024 * 1024)` rather than with a
 * string literal, which a regex over the obvious form does not catch — so the rule is enforced
 * here instead of trusted to a grep.
 *
 * `numberFromEnv` and `positiveNumberFromEnv` are the only sanctioned readers: both treat absent,
 * blank and unparseable alike, and the positive variant additionally refuses an accidental zero
 * where zero would turn a pipeline off.
 */

const ROOT = new URL("../..", import.meta.url).pathname;

/** Everything that runs in a workflow and could be handed a blank variable. */
const SEARCHED = ["pipelines", "packages", "apps/worker", "scripts"];

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const dir of SEARCHED) {
    for (const pattern of ["**/*.ts", "**/*.mjs"]) {
      files.push(
        ...globSync(pattern, { cwd: join(ROOT, dir) })
          .map((relative) => join(ROOT, dir, relative))
          .filter((file) => !file.includes("node_modules") && !/\.test\.[cm]?[jt]s$/.test(file)),
      );
    }
  }
  return files;
}

describe("numbers read from the environment", () => {
  it("never coerces an environment variable with Number() and a nullish fallback", () => {
    /*
     * Both spellings: a string literal default and a computed one. The computed form is the one
     * that got through the first time.
     */
    const forbidden = /(?:Number|parseInt|parseFloat)\(\s*process\.env\.[A-Za-z_][A-Za-z0-9_]*/;
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        if (forbidden.test(line)) {
          offenders.push(`${file.slice(ROOT.length)}:${index + 1}: ${line.trim().slice(0, 110)}`);
        }
      }
    }

    expect(
      offenders,
      'Use numberFromEnv or positiveNumberFromEnv: an unset repository variable arrives as "", ' +
        "which `??` does not catch and Number() turns into 0.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  /*
   * And the other half of the rule: a workflow that passes an optional variable through must be
   * read by one of the sanctioned helpers. This checks the specific variables that have already
   * caused an outage, by name, so a future edit that reverts one is caught by the name rather than
   * by the shape.
   */
  it("reads the variables that have already caused an outage through the helpers", () => {
    const known: Array<{ env: string; file: string }> = [
      { env: "MAX_PARTITIONS_PER_RUN", file: "pipelines/live-collection/run-collect.ts" },
      { env: "BODS_DAILY_REQUEST_BUDGET", file: "pipelines/live-collection/run-collect.ts" },
      { env: "COLLECTION_PASSES", file: "pipelines/live-collection/run-collect.ts" },
      { env: "COLLECTION_BUDGET_MS", file: "pipelines/live-collection/run-collect.ts" },
      { env: "BATCH_BUDGET_MS", file: "pipelines/analytics-batch/run-batch.ts" },
      { env: "R2_STORAGE_LIMIT_BYTES", file: "pipelines/analytics-batch/run-retention.ts" },
    ];

    for (const { env, file } of known) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, `${file} no longer reads ${env}`).toContain(env);
      /*
       * The line that *reads* it, not a line that mentions it. These files explain the outage in
       * prose directly above the fix, so matching on the name alone finds the comment first.
       */
      const line = text.split("\n").find((candidate) => candidate.includes(`process.env.${env}`));
      expect(line ?? "", `${file}: ${env} is not read from process.env at all`).not.toBe("");
      expect(line ?? "", `${file}: ${env} must be read through a helper`).toMatch(
        /(?:positiveNumberFromEnv|numberFromEnv)\(/,
      );
    }
  });
});
