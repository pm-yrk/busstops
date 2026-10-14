import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The retire mode inverts this file's central invariant, so its guards are asserted rather than
 * trusted to review.
 *
 * Every other path in `run-prune.ts` keeps the live version by construction: the job is "delete
 * what has been superseded", and the comments say the failure mode is arranged to be "deleted
 * nothing" rather than "deleted the timetable England is being served". `--retire-live-version`
 * deliberately does the opposite, for the one case that is not that — a bucket whose live artifact
 * nothing reads.
 *
 * Four guards make that safe, and the order matters: the preview refusal is unconditional and
 * first, because it must not depend on anything else being right.
 *
 * This is a source-level contract test rather than an execution test because the mode's whole
 * subject is a live R2 bucket and a Cloudflare account. Running it to prove it refuses would mean
 * standing up both. What can be checked cheaply, and is worth checking on every commit, is that
 * the refusals are still there and still in order — a reordering or a deletion of one is exactly
 * the regression that would not be noticed until it had deleted the wrong bucket.
 */
const SOURCE = readFileSync(
  join(new URL("../..", import.meta.url).pathname, "pipelines/static-network/run-prune.ts"),
  "utf8",
);

describe("retiring a live version", () => {
  it("refuses a bucket whose name looks like a preview bucket", () => {
    expect(SOURCE).toContain("refused_preview_bucket");
    expect(SOURCE).toMatch(/\/preview\/i\.test\(bucket\)/);
  });

  it("checks the preview refusal before anything else can go wrong", () => {
    const preview = SOURCE.indexOf("refused_preview_bucket");
    const mismatch = SOURCE.indexOf("refused_version_mismatch");
    const readers = SOURCE.indexOf("refused_bucket_has_readers");
    expect(preview).toBeGreaterThan(0);
    expect(
      preview,
      "the preview refusal must come first: it must not depend on another guard being right",
    ).toBeLessThan(mismatch);
    expect(preview).toBeLessThan(readers);
  });

  it("requires the caller to name the version, and it to be the live one", () => {
    expect(SOURCE).toContain("refused_version_mismatch");
    expect(SOURCE).toMatch(/RETIRE_VERSION !== manifest\.version/);
  });

  it("refuses when a deployed Worker binds the bucket", () => {
    expect(SOURCE).toContain("refused_bucket_has_readers");
    expect(SOURCE).toMatch(/readers\.length > 0/);
  });

  /*
   * An unanswerable question is a refusal, not a "no". "Nothing reads it" is the entire
   * justification for this mode, so a Cloudflare API that will not answer must stop the deletion
   * rather than be treated as absence of readers.
   */
  it("refuses when it cannot find out who reads the bucket", () => {
    expect(SOURCE).toContain("refused_readers_unknown");
    expect(SOURCE).toMatch(/readers === null/);
  });

  it("deletes nothing without --apply", () => {
    expect(SOURCE).toContain("retire_dry_run");
    const dryRun = SOURCE.indexOf("retire_dry_run");
    const retireDelete = SOURCE.indexOf("Retired ${retired} of");
    expect(dryRun).toBeLessThan(retireDelete);
  });

  /* A pointer to an object that has gone is worse than no pointer, so both go together. */
  it("removes the manifests that point at the retired version", () => {
    expect(SOURCE).toContain("danglingManifests");
    expect(SOURCE).toMatch(/pointer\?\.version === RETIRE_VERSION/);
  });

  /*
   * `bytesAfter` is `bytesBefore - bytesRetired`, so a `bytesRetired` that misses the manifests
   * reports a bucket emptier than it is. The 14 October retirement said 25,071 bytes remained;
   * re-listing the bucket found 4,409. The sum has to be over every doomed key.
   */
  it("counts the manifests it deletes in the bytes it claims to have reclaimed", () => {
    expect(SOURCE).toMatch(/const doomed = new Set\(doomedKeys\)/);
    expect(SOURCE).toMatch(/bytesRetired = all\.reduce\(/);
    expect(SOURCE, "bytesRetired must not be summed over the data objects alone").not.toMatch(
      /bytesRetired = atVersion\.reduce\(/,
    );
  });

  it("still requires a complete listing, like every other path here", () => {
    expect(SOURCE.match(/inventory_incomplete/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
