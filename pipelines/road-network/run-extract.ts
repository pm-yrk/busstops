#!/usr/bin/env node
/**
 * Scheduled extraction of the road segments the analytics batch runs on.
 *
 * `network/segments` had no producer. The batch named the dataset, read it, found nothing and
 * stopped — every scheduled run, since the first one — so Bus Stops Pro has only ever shown its
 * dated demonstration snapshot. This is the missing half.
 *
 * Bounded by the provider's policy rather than by our own convenience. Overpass is a shared
 * volunteer service that asks for modest, targeted queries, so this asks for one bounding box at
 * a time, spaces them, and covers the urban areas named in `areas.ts` rather than the country.
 * The coverage travels with the artifact, so Pro says which parts of England its road figures are
 * about instead of leaving it to be assumed.
 *
 * Exits zero when storage is not configured: a schedule that fails loudly on a missing credential
 * disappears into a wall of red runs, and the gap is more useful reported than fatal.
 */

import { writeFileSync } from "node:fs";
import { OVERPASS_HEADERS, OVERPASS_URL, OSM_ATTRIBUTION, overpassQuery } from "@busstops/adapters";
import { ArtifactStore, SourceClient, r2StoreFromEnv } from "@busstops/pipeline-core";
import {
  ROAD_AREAS,
  describeCoverage,
  segmentsFromOverpass,
  type PublishedRoadSegment,
} from "./src/index.js";

const SEGMENT_DATASET = "network/segments";

/**
 * Overpass asks for gentle use and publishes no quota. One query per area with a pause between
 * them is well inside anything it asks for, and this runs on a monthly cadence — a road network
 * changes over months, not minutes.
 */
const PAUSE_BETWEEN_AREAS_MS = 5_000;
const QUERY_TIMEOUT_MS = 180_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  const startedAt = new Date();
  const report: Record<string, unknown> = {
    startedAt: startedAt.toISOString(),
    areas: ROAD_AREAS.map((area) => area.id),
  };

  const storage = r2StoreFromEnv(process.env);
  if (!storage.ok) {
    report.outcome = "storage_not_configured";
    report.missing = storage.missing;
    console.error(`R2 is not configured (${storage.missing.join(", ")}); nothing published.`);
    writeReport(report);
    return 0;
  }

  /*
   * A day's freshness allowance, because a road network is not a live feed: OSM's roads change
   * over months, and calling a week-old extraction stale would be a health warning about nothing.
   */
  const client = new SourceClient("osm", "England (selected urban areas)", 86_400);
  const segments = new Map<string, PublishedRoadSegment>();
  const perArea: Array<Record<string, unknown>> = [];
  const failed: string[] = [];

  for (const [at, area] of ROAD_AREAS.entries()) {
    if (at > 0) await sleep(PAUSE_BETWEEN_AREAS_MS);
    const query = overpassQuery(area.bbox);
    try {
      /*
       * GET with the query in `?data=`, which is the form Overpass documents and the one the
       * shared client can make — it takes timeouts, retries and a circuit breaker and does not
       * take a request body. The query is a few hundred characters, well inside any URL limit.
       */
      const payload = await client.fetchJson<unknown>(
        `${OVERPASS_URL}?data=${encodeURIComponent(query)}`,
        { timeoutMs: QUERY_TIMEOUT_MS, maxAttempts: 3, headers: OVERPASS_HEADERS },
      );
      const extracted = segmentsFromOverpass(payload, {
        retrievedAt: startedAt.toISOString(),
        areaId: area.id,
      });
      /*
       * Areas overlap at their edges and a way can appear in two of them. Keyed by segment id,
       * which is derived from the way and the piece index, so the second sighting replaces the
       * first with identical geometry rather than publishing the same road twice.
       */
      for (const segment of extracted.segments) segments.set(segment.id, segment);
      perArea.push({
        area: area.id,
        segments: extracted.segments.length,
        rejected: extracted.rejected,
        split: extracted.split,
      });
      console.log(
        `${area.name}: ${extracted.segments.length} segment(s), ${extracted.rejected} way(s) not bus-routable, ${extracted.split} split.`,
      );
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : "unreadable";
      failed.push(`${area.id} (${reason})`);
      perArea.push({ area: area.id, error: reason });
      console.error(`${area.name}: extraction failed — ${reason}`);
    }
  }

  report.perArea = perArea;
  report.failed = failed;
  report.segments = segments.size;

  /*
   * An extraction that got nothing publishes nothing.
   *
   * Overwriting a good segment set with an empty one because Overpass was busy would take Pro's
   * road figures away and look exactly like a network with no roads in it. The previous publish
   * stays current and the gap is reported.
   */
  if (segments.size === 0) {
    report.outcome = "no_segments";
    console.error("No segments extracted; the previous publish is unchanged.");
    writeReport(report);
    return failed.length === ROAD_AREAS.length ? 1 : 0;
  }

  const artifacts = new ArtifactStore(storage.store);
  await artifacts.publish({
    dataset: SEGMENT_DATASET,
    version: startedAt.toISOString(),
    records: [...segments.values()],
    schemaVersion: "1.0.0",
    sources: ["osm"],
    // True whenever an area could not be read, and true in general: this is six urban areas.
    partialCoverage: true,
    notes: `${describeCoverage()} ${OSM_ATTRIBUTION}.${failed.length > 0 ? ` Not extracted this run: ${failed.join(", ")}.` : ""}`,
  });

  report.outcome = "published";
  console.log(
    `Published ${segments.size} road segment(s) across ${ROAD_AREAS.length - failed.length} of ${ROAD_AREAS.length} area(s).`,
  );
  writeReport(report);
  return 0;
}

function writeReport(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("road-network-report.json", JSON.stringify(report, null, 2));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Road network extraction failed:", error);
    /*
     * A job that throws still has to say so in its report.
     *
     * Every ordinary exit writes one; an exception wrote nothing at all, and the workflow step runs
     * with `continue-on-error`, which marks a failed step "success" in the job's own step list. So a
     * collection that threw looked from the outside like a collection that had worked and simply
     * chosen not to report — which is how run 47's "no collection-report.json was written" read for
     * three runs. The report is the only thing that distinguishes them.
     */
    try {
      writeFileSync(
        "road-network-report.json",
        JSON.stringify(
          {
            outcome: "threw",
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            finishedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // A report we cannot write is not worth failing twice over; the console still carries it.
    }
    process.exitCode = 1;
  });
