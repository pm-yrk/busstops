import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A dataset whose record count measures the world must not be published under the shrink guard.
 *
 * ## The distinction
 *
 * `ArtifactStore.publish` refuses a 25% shrink by default, and for a static artifact that is
 * exactly right: a national timetable that came back a third smaller was read badly, and keeping
 * the previous good version is the safe answer.
 *
 * It is the wrong instrument for an artifact whose record count is a measurement. A snapshot of
 * buses currently on the road, or of road segments that had traffic to measure, legitimately
 * collapses in the evening — and the guard cannot tell a quiet Wednesday night from a half-read
 * feed. Three separate schedules have now gone red on it:
 *
 *   - weather shards, where one degree square holds a handful of 0.10° cells, so a single cell
 *     lost to a rate-limited batch is more than a quarter of the square;
 *   - `intelligence/observations`, which threw `shrank by 57.0%` at 20:04 on 14 October — nine in
 *     the evening having fewer buses out than four in the afternoon;
 *   - `segmentMetrics-15min`, found by auditing the rest after that failure, and worse than the
 *     others because it throws out of the run that also prunes R2.
 *
 * Refusing is also the worse outcome for the product rather than the safer one: the previous good
 * version is kept, so Pro presents an afternoon snapshot as the current picture — a fuller number
 * that is no longer true. Thin real data beats fake precision.
 *
 * So each of these call sites passes `maximumShrinkFraction: 1` deliberately, and this test fails
 * if one loses it. Source-level, because the subject is a live R2 bucket and the cost of the
 * regression is a schedule that goes quietly red at nightfall.
 */

const ROOT = new URL("../..", import.meta.url).pathname;

/** Each file, and the text that must appear inside the publish call that needs the allowance. */
const MEASUREMENT_PUBLISHERS: Array<{ file: string; dataset: string }> = [
  { file: "pipelines/live-collection/run-collect.ts", dataset: "OBSERVATION_DATASET" },
  { file: "pipelines/analytics-batch/run-retention.ts", dataset: "segmentMetrics}-15min" },
  { file: "pipelines/weather/src/collect.ts", dataset: "weatherShardDataset(tile)" },
];

/** The body of the `publish({ ... })` call that names `dataset`, by brace depth. */
function publishCallNaming(source: string, dataset: string): string | null {
  for (const match of source.matchAll(/\.publish\(\{/g)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let at = start;
    while (at < source.length && depth > 0) {
      if (source[at] === "{") depth += 1;
      else if (source[at] === "}") depth -= 1;
      at += 1;
    }
    const body = source.slice(start, at - 1);
    if (body.includes(dataset)) return body;
  }
  return null;
}

describe("datasets whose record count measures the world", () => {
  it.each(MEASUREMENT_PUBLISHERS)(
    "$file publishes without the shrink guard",
    ({ file, dataset }) => {
      const source = readFileSync(join(ROOT, file), "utf8");
      const body = publishCallNaming(source, dataset);

      expect(body, `${file}: no publish call naming ${dataset}`).not.toBeNull();
      expect(
        body!,
        `${file} publishes ${dataset} under the default 25% shrink guard. That guard reads a quiet ` +
          "evening as a bad upstream read, throws, and keeps a fuller stale version the product " +
          "then presents as current.",
      ).toMatch(/maximumShrinkFraction:\s*1\b/);
    },
  );

  /*
   * And the converse, so this does not become a habit: the guard stays on for the static artifacts
   * it was written for, where a smaller record count really does mean a bad read.
   */
  it("leaves the guard in place for artifacts that are not measurements", () => {
    const places = readFileSync(join(ROOT, "pipelines/places/run-extract.ts"), "utf8");
    const body = publishCallNaming(places, "PLACES_DATASET");
    expect(body).not.toBeNull();
    expect(
      body!,
      "the places gazetteer is extracted from OSM: a third fewer places is a bad extract, not an evening",
    ).not.toMatch(/maximumShrinkFraction/);
  });
});
