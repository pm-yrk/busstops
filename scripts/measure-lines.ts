#!/usr/bin/env node
/**
 * How big an object a serving read buffers, and how long the longest line inside it is.
 *
 * Two numbers are needed before any of these reads can be streamed, and neither had been
 * measured. The first is per family: what a passenger read actually buffers, so the migration is
 * ordered by what it saves rather than by what looks untidy — a manifest of a few hundred bytes
 * is not worth a stream parser. The second is one number for all of them: the longest *legitimate*
 * line in published data, because a streaming reader has to carry a partial line across chunk
 * boundaries and a line that never ends would grow that carry buffer to the size of the object,
 * which is the failure the streaming is being done to avoid. A guard needs a cap, and a cap
 * chosen by guess is either a cliff under real data or no guard at all.
 *
 * It reads the live version only, from the index record, and writes nothing.
 *
 *   npx tsx scripts/measure-lines.ts [--json lines.json]
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  mapWithConcurrency,
  r2StoreFromEnv,
  type StoredObject,
} from "@busstops/pipeline-core";
import { SHARDED, type NetworkIndexRecord } from "@busstops/pipeline-static-network";

const JSON_OUT = (() => {
  const index = process.argv.indexOf("--json");
  return index === -1 ? undefined : process.argv[index + 1];
})();

/**
 * How many objects of a family to open.
 *
 * The largest ones, plus one from the middle of the size distribution. The longest line is not
 * guaranteed to live in the largest object, but it cannot be longer than the object that holds it
 * — so the largest objects bound the answer, and the median one says whether the family's lines
 * are uniform or whether the big object is big because of one enormous row.
 */
const SAMPLE_LARGEST = 3;

interface FamilyMeasurement {
  family: string;
  objects: number;
  bytes: number;
  maxObjectBytes: number;
  medianObjectBytes: number;
  sampled: number;
  /** The longest line, in characters, over the objects actually opened. */
  maxLineChars: number;
  maxLineIn: string | null;
  medianLineChars: number;
  linesInLargest: number;
  /** True when every object of the family was opened, so the maximum is the family's own. */
  exhaustive: boolean;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** `data/<family>/<version>.jsonl`, where a family may itself contain slashes. */
function familyOf(key: string): string | null {
  const match = /^data\/(.+)\/([^/]+)\.jsonl$/.exec(key);
  return match === null ? null : match[1]!;
}

function versionOf(key: string): string | null {
  const match = /^data\/(.+)\/([^/]+)\.jsonl$/.exec(key);
  return match === null ? null : match[2]!;
}

/**
 * Line lengths, without ever holding the body twice.
 *
 * `split` would copy the whole object into an array of substrings, which is the allocation this
 * whole exercise is about — so the lines are walked by index and only their lengths are kept.
 */
function lineStats(body: string): { max: number; median: number; count: number } {
  const lengths: number[] = [];
  let max = 0;
  for (let start = 0; start < body.length;) {
    const newline = body.indexOf("\n", start);
    const end = newline < 0 ? body.length : newline;
    const length = end - start;
    if (length > 0) {
      lengths.push(length);
      if (length > max) max = length;
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return { max, median: median(lengths), count: lengths.length };
}

async function main(): Promise<number> {
  const resolved = r2StoreFromEnv(process.env);
  if (!resolved.ok) {
    console.error(`Not configured: ${resolved.missing.join(", ")}`);
    annotateReport("published line sizes", {
      outcome: "not_configured",
      missing: resolved.missing,
    });
    return 2;
  }
  const store = resolved.store;
  const artifacts = new ArtifactStore(store);

  const index = (await artifacts.readCurrent<NetworkIndexRecord>(SHARDED.index)).records[0];
  if (!index) {
    annotateReport("published line sizes", { outcome: "failed", reason: "no index record" });
    return 1;
  }
  console.log(`Live version: ${index.version}`);

  console.log("Listing data/ …");
  const all: StoredObject[] = await store.listDetailed("data/");
  console.log(`${String(all.length)} object(s) in the bucket`);

  /*
   * The live version only. Older versions are a rollback and a prune target, not something a
   * passenger read ever opens, and including them would describe storage rather than serving.
   *
   * The families with no version in their key — the national ones, whose manifest names the
   * object — keep every version they have, and the manifest decides which. Those are listed by
   * family and the newest object is the one opened.
   */
  const byFamily = new Map<string, StoredObject[]>();
  for (const object of all) {
    const family = familyOf(object.key);
    if (family === null) continue;
    const version = versionOf(object.key);
    const list = byFamily.get(family) ?? [];
    list.push(object);
    byFamily.set(family, list);
    void version;
  }

  /* Families are keyed by their full dataset name, which for a tiled family is one per tile. */
  const grouped = new Map<string, StoredObject[]>();
  for (const [family, objects] of byFamily) {
    /* `network/map-stops/3_-1` and `network/map-stops/4_-2` are one family, read the same way. */
    const parts = family.split("/");
    const root = parts.length > 2 ? parts.slice(0, 2).join("/") : family;
    const list = grouped.get(root) ?? [];
    list.push(...objects);
    grouped.set(root, list);
  }

  const measurements: FamilyMeasurement[] = [];

  for (const [family, objects] of [...grouped].sort((a, b) => a[0].localeCompare(b[0]))) {
    /*
     * One version's worth. A tiled family writes a version per publish, so taking the newest
     * version present keeps the comparison to what is being served.
     */
    const versions = new Set(objects.map((o) => versionOf(o.key) ?? ""));
    const live = versions.has(index.version)
      ? index.version
      : ([...versions].sort().reverse()[0] ?? "");
    const current = objects.filter((o) => versionOf(o.key) === live);
    if (current.length === 0) continue;

    const bySize = [...current].sort((a, b) => b.sizeBytes - a.sizeBytes);
    const picks = bySize.slice(0, SAMPLE_LARGEST);
    const middle = bySize[Math.floor(bySize.length / 2)];
    if (middle && !picks.includes(middle)) picks.push(middle);

    console.log(
      `${family}: ${String(current.length)} object(s), ` +
        `largest ${String(bySize[0]?.sizeBytes ?? 0)} B — opening ${String(picks.length)}`,
    );

    const opened = await mapWithConcurrency(picks, 4, async (object) => {
      try {
        const body = await store.get(object.key);
        if (body === null) return null;
        return { key: object.key, ...lineStats(body) };
      } catch (error) {
        console.log(`  could not read ${object.key}: ${String(error)}`);
        return null;
      }
    });
    const read = opened.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    let maxLineChars = 0;
    let maxLineIn: string | null = null;
    for (const entry of read) {
      if (entry.max > maxLineChars) {
        maxLineChars = entry.max;
        maxLineIn = entry.key;
      }
    }

    measurements.push({
      family,
      objects: current.length,
      bytes: current.reduce((total, o) => total + o.sizeBytes, 0),
      maxObjectBytes: bySize[0]?.sizeBytes ?? 0,
      medianObjectBytes: median(current.map((o) => o.sizeBytes)),
      sampled: read.length,
      maxLineChars,
      maxLineIn,
      medianLineChars: median(read.map((entry) => entry.median)),
      linesInLargest: read[0]?.count ?? 0,
      exhaustive: read.length === current.length,
    });
  }

  const worst = [...measurements].sort((a, b) => b.maxLineChars - a.maxLineChars)[0];

  const report = {
    outcome: "measured",
    version: index.version,
    families: measurements.length,
    /* The one number the streaming guard's cap has to clear. */
    longestLineChars: worst?.maxLineChars ?? 0,
    longestLineFamily: worst?.family ?? null,
    longestLineIn: worst?.maxLineIn ?? null,
    /* Ordered by what a read of the family's largest object would buffer. */
    table: [...measurements]
      .sort((a, b) => b.maxObjectBytes - a.maxObjectBytes)
      .map((m) => ({
        family: m.family,
        objects: m.objects,
        bytes: m.bytes,
        maxObjectBytes: m.maxObjectBytes,
        medianObjectBytes: m.medianObjectBytes,
        maxLineChars: m.maxLineChars,
        medianLineChars: m.medianLineChars,
        sampled: m.sampled,
        exhaustive: m.exhaustive,
      })),
  };

  console.log("");
  console.log(JSON.stringify(report, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("published line sizes", report);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Measuring published line sizes failed:", error);
    annotateReport("published line sizes", { outcome: "threw", error: String(error) });
    process.exitCode = 1;
  });
