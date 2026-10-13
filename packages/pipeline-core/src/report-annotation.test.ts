import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { annotateReport } from "./report-annotation.js";

/**
 * The thing this guards is not the formatting, it is the visibility. A collection that failed and
 * a collection that worked looked identical from outside the runner, and these hold the three
 * properties that stopped being true: it says something, it says the outcome, and a body with a
 * workflow-command character in it does not come back as something that will not parse.
 */
describe("annotateReport", () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    process.env.GITHUB_ACTIONS = "true";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GITHUB_ACTIONS;
  });

  it("says nothing outside a workflow, where there is nothing to annotate", () => {
    delete process.env.GITHUB_ACTIONS;
    annotateReport("live collection", { outcome: "collected" });
    expect(lines).toEqual([]);
  });

  it("titles the annotation with the outcome, so a run can be read at a glance", () => {
    annotateReport("live collection", { outcome: "collected", observations: 1240 });
    expect(lines[0]).toContain("::notice title=live collection (collected)::");
    expect(lines[0]).toContain("1240");
  });

  /*
   * The whole reason for this: `no_observations` was the outcome and the step still read as a
   * success, because the workflow runs it with `continue-on-error`.
   */
  it("raises a failed outcome to an error rather than a notice", () => {
    annotateReport("live collection", { outcome: "threw", error: "TypeError: boom" });
    expect(lines[0]!.startsWith("::error title=live collection (threw)::")).toBe(true);
  });

  it("escapes the characters the workflow-command parser would read as syntax", () => {
    annotateReport("x", { outcome: "ok", note: "50% of 10::20\nsecond line" });
    const line = lines[0]!;
    // A raw newline would end the command and lose everything after it.
    expect(line.includes("\n")).toBe(false);
    expect(line).toContain("%0A");
    expect(line).toContain("%25");
    expect(line).toContain("%3A%3A");
  });

  /*
   * Split, not capped. Capping loses whichever field happens to be last, and that is never the one
   * a reader came for: three runs proved it, hiding whether the operators had been republished and
   * why a batch rolled back.
   */
  it("splits a long body across numbered annotations and loses nothing", () => {
    annotateReport("live collection", {
      outcome: "collected",
      partitions: Array.from({ length: 500 }, (_, i) => `p${i}`),
    });

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThan(4096);
      expect(line).toMatch(/\(collected\) \d+\/\d+::/);
    }

    // The last field survives, which is the whole point, and so does the first.
    const body = lines.map((line) => line.replace(/^::\w+ title=[^:]*::/, "")).join("");
    expect(body).toContain("p499");
    expect(body).toContain("p0");
  });

  it("does not number an annotation that fits in one", () => {
    annotateReport("live collection", { outcome: "collected", observations: 12 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/\d+\/\d+::/);
  });

  it("calls an outcome it has never seen a notice rather than hiding it", () => {
    annotateReport("x", {});
    expect(lines[0]).toContain("(unknown)");
  });
});
