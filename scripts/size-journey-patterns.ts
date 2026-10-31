#!/usr/bin/env node
/**
 * What a published journey pattern-stop projection would cost, before publishing one.
 *
 * Ninety-one per cent of a journey's decoded characters are the pattern index: 2,098,153 of
 * 2,316,100, which is 5,123 lines scanned to keep the 1,090 the corridor's trips name. An
 * isolate-level cache removes that for the second journey through a city and not for the first,
 * and the architectural answer to the first one is a projection a reader can take by pattern id
 * rather than by scanning a tile.
 *
 * That is a fourth published family in a bucket with about 863 MB of headroom, so it is measured
 * before it is proposed rather than after. This reads the published pattern index and reports what
 * the projection would weigh, how many objects it would be, how many of them a query would open,
 * and what it would do to the bucket — including the peak while both forms exist, because a
 * publish is not atomic and the old family cannot be deleted until the new one is proved.
 *
 * It reads and writes nothing else: no publishes, no deletes, no deploys.
 *
 *   npx tsx scripts/size-journey-patterns.ts [--json pattern-projection-size.json]
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  objectKeyFor,
  r2StoreFromEnv,
} from "@busstops/pipeline-core";
import {
  SHARDED,
  patternIndexTileDataset,
  type NetworkIndexRecord,
  type PatternIndexRow,
} from "@busstops/pipeline-static-network";

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const JSON_OUT = arg("json");

/** R2's free storage allowance, which is the number this has to stay under. */
const FREE_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * The projection's layout, costed per pattern.
 *
 * One object per pattern index tile, so a corridor opens exactly the tiles it already opens — the
 * reads per query do not change, only what each read costs to decode. Inside a tile:
 *
 *   header            6 × u32
 *   patternIds        one 16-byte key per pattern, sorted, so a reader can binary-search by id
 *   callOffsets       u32 per pattern, plus one
 *   stopIndices       u32 per call, into the tile's own stop table
 *   stopIdBlob        each distinct stop id once, as bytes, with u32 offsets
 *
 * A pattern id is a UUID, so sixteen bytes holds it exactly rather than thirty-six characters of
 * text. A stop id is also a UUID and appears in many sequences, which is where the saving is: the
 * text form repeats it in every sequence it occurs in.
 */
const HEADER_BYTES = 6 * 4;
const PATTERN_KEY_BYTES = 16;
const STOP_ID_BYTES = 16;

async function main(): Promise<number> {
  const resolved = r2StoreFromEnv(process.env);
  if (!resolved.ok) {
    annotateReport("pattern projection size", {
      outcome: "not_configured",
      missing: resolved.missing,
    });
    return 2;
  }
  const store = resolved.store;
  const index = (await new ArtifactStore(store).readCurrent<NetworkIndexRecord>(SHARDED.index))
    .records[0];
  if (!index) {
    annotateReport("pattern projection size", { outcome: "failed", reason: "no index record" });
    return 1;
  }

  const tiles = index.patternIndexTiles ?? [];
  if (tiles.length === 0) {
    annotateReport("pattern projection size", { outcome: "failed", reason: "no pattern tiles" });
    return 1;
  }

  let textChars = 0;
  let patterns = 0;
  let calls = 0;
  let projected = 0;
  let unreadable = 0;
  const distinctStops = new Set<string>();
  const perTile: Array<{ tile: string; patterns: number; textChars: number; bytes: number }> = [];
  let largest = { tile: "", bytes: 0 };

  for (const tile of tiles) {
    const body = await store.get(objectKeyFor(patternIndexTileDataset(tile), index.version));
    if (body === null) {
      unreadable += 1;
      continue;
    }
    textChars += body.length;

    /* The tile's own stop table: each distinct stop in it costs its id once. */
    const stopsHere = new Set<string>();
    let tilePatterns = 0;
    let tileCalls = 0;
    for (const line of body.split("\n")) {
      if (line.length === 0 || !line.startsWith("[")) continue;
      let row: [string, PatternIndexRow];
      try {
        row = JSON.parse(line) as [string, PatternIndexRow];
      } catch {
        continue;
      }
      const sequence = row[1]?.stopSequence;
      if (!Array.isArray(sequence)) continue;
      tilePatterns += 1;
      tileCalls += sequence.length;
      for (const stopId of sequence) {
        stopsHere.add(stopId);
        distinctStops.add(stopId);
      }
    }

    const bytes =
      HEADER_BYTES +
      tilePatterns * PATTERN_KEY_BYTES +
      (tilePatterns + 1) * 4 +
      tileCalls * 4 +
      stopsHere.size * (STOP_ID_BYTES + 4);

    patterns += tilePatterns;
    calls += tileCalls;
    projected += bytes;
    perTile.push({ tile, patterns: tilePatterns, textChars: body.length, bytes });
    if (bytes > largest.bytes) largest = { tile, bytes };
  }

  perTile.sort((a, b) => b.bytes - a.bytes);

  /*
   * What a query opens, which is the figure that decides whether this is worth it at all.
   *
   * A corridor already reads the pattern tiles it crosses — the planner's own cap is eight — so
   * the projection changes what a read costs to decode and not how many reads a journey makes.
   * A projection that needed more subrequests than the text it replaced would be a worse artifact
   * however small it was, because a Workers Free invocation gets fifty of them.
   */
  const readsPerQuery = { unchanged: true, planCapTiles: 8, note: "same tiles, different form" };

  const report = {
    outcome: "measured",
    version: index.version,
    tiles: tiles.length,
    unreadableTiles: unreadable,
    patterns,
    calls,
    distinctStops: distinctStops.size,
    callsPerPattern: patterns === 0 ? null : Number((calls / patterns).toFixed(1)),
    /* The family as published today, and as it would be. */
    textBytes: textChars,
    projectedBytes: projected,
    ratio: textChars === 0 ? null : Number((projected / textChars).toFixed(3)),
    savedBytes: textChars - projected,
    objects: tiles.length,
    largestObject: largest,
    averageObjectBytes: tiles.length === 0 ? null : Math.round(projected / tiles.length),
    readsPerQuery,
    /*
     * The bucket, three ways: as it is, at the peak while both forms exist, and once the text
     * form of the family is removed. The peak is the number that decides whether this can be
     * published at all — a publish is not atomic, and the old family cannot go until the new one
     * has been read back and proved.
     */
    bucket: {
      freeStorageBytes: FREE_STORAGE_BYTES,
      measuredTotalBytes: 9_873_932_749,
      headroomBytes: FREE_STORAGE_BYTES - 9_873_932_749,
      peakBytes: 9_873_932_749 + projected,
      peakWithinFree: 9_873_932_749 + projected <= FREE_STORAGE_BYTES,
      steadyStateBytes: 9_873_932_749 + projected - textChars,
      steadyStateWithinFree: 9_873_932_749 + projected - textChars <= FREE_STORAGE_BYTES,
    },
    note:
      "Sizing only. Nothing was published, deleted or deployed. The bucket figures are taken " +
      "against the last measured total rather than re-counted here, so a storage decision should " +
      "be made against a fresh [prune] report.",
    biggestTiles: perTile.slice(0, 8),
  };

  console.log(JSON.stringify(report, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("pattern projection size", report);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    annotateReport("pattern projection size", { outcome: "failed", error: String(error) });
    process.exitCode = 1;
  });
