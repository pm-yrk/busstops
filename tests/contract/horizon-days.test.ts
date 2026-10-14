import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every workflow has to agree on how many service dates the departure horizon holds.
 *
 * ## Why this is a test
 *
 * The number lived in five places across three workflows and three of them were wrong. The refresh
 * published three service dates; `prove-horizon` asked about four on its schedule, and
 * `deploy-preview` asked about four in three separate steps. The failure mode is quiet rather than
 * loud: the fourth date is simply absent, the proof reports `covered_using_slack` instead of
 * `covered`, and a warning that fires on every single scheduled run is a warning nobody reads. The
 * two dispatch defaults saying four were worse — a manual run would publish a service date the
 * horizon is no longer sized for, on an account whose R2 allowance this project spent a day
 * reclaiming.
 *
 * It cannot be a shared constant, because these are GitHub Actions expressions rather than code, so
 * it is asserted instead. Both halves matter: the `${{ inputs.horizon_days || 'N' }}` fallback is
 * what a *scheduled* run uses, and the input's `default:` is what a *dispatched* run uses. They are
 * different code paths and they diverged independently.
 */

const WORKFLOWS = join(new URL("../..", import.meta.url).pathname, ".github/workflows");

/** The horizon the refresh actually publishes. Moving it means moving it here too, deliberately. */
const HORIZON_DAYS = "3";

function workflows(): Array<{ name: string; text: string }> {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => ({ name, text: readFileSync(join(WORKFLOWS, name), "utf8") }));
}

describe("the departure horizon", () => {
  it("is the same number in every workflow that reads it from an input", () => {
    const disagreements: string[] = [];

    for (const { name, text } of workflows()) {
      for (const [index, line] of text.split("\n").entries()) {
        const fallback = /inputs\.horizon_days\s*\|\|\s*'([^']*)'/.exec(line);
        if (fallback !== null && fallback[1] !== HORIZON_DAYS) {
          disagreements.push(`${name}:${index + 1}: falls back to ${fallback[1]}`);
        }
      }
    }

    expect(
      disagreements,
      `Scheduled runs pass no inputs, so the fallback is what they use. It must be ` +
        `${HORIZON_DAYS}, matching what the refresh publishes.\n${disagreements.join("\n")}`,
    ).toEqual([]);
  });

  it("is the same number in every workflow's dispatch default", () => {
    const disagreements: string[] = [];

    for (const { name, text } of workflows()) {
      const lines = text.split("\n");
      const declared = lines.findIndex((line) => /^\s{6}horizon_days:\s*$/.test(line));
      if (declared < 0) continue;

      /*
       * The `default:` belonging to this input: the next one before the next sibling key at the
       * same indentation, so a later input's default cannot be read as this one's.
       */
      const indent = /^(\s+)/.exec(lines[declared]!)![1]!.length;
      let found: string | null = null;
      for (let at = declared + 1; at < lines.length; at += 1) {
        const line = lines[at]!;
        if (/^\s*$/.test(line)) continue;
        const lead = /^(\s*)/.exec(line)![1]!.length;
        if (lead <= indent) break;
        const match = /^\s*default:\s*"?([^"\s#]+)"?/.exec(line);
        if (match !== null) {
          found = match[1]!;
          break;
        }
      }

      if (found === null) {
        disagreements.push(`${name}: horizon_days has no default`);
      } else if (found !== HORIZON_DAYS) {
        disagreements.push(`${name}: horizon_days defaults to ${found}`);
      }
    }

    expect(
      disagreements,
      `A dispatched run uses the input's default, and publishing a fourth service date costs ` +
        `about 1.22 GB on an account that has 10 GB in total.\n${disagreements.join("\n")}`,
    ).toEqual([]);
  });

  /* And that at least one workflow still declares it, so the test cannot pass by finding nothing. */
  it("is declared by the workflows that own it", () => {
    const owners = workflows()
      .filter(({ text }) => /^\s{6}horizon_days:\s*$/m.test(text))
      .map(({ name }) => name);

    expect(owners).toContain("preview-departures-refresh.yml");
    expect(owners).toContain("prove-horizon.yml");
    expect(owners).toContain("deploy-preview.yml");
  });
});
