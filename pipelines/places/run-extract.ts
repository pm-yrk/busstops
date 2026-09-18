#!/usr/bin/env node
/**
 * Scheduled extraction of the places gazetteer.
 *
 * Search could find a stop, a route or an operator, and nothing else — so "York Minster" matched
 * nothing at all. The fix for that is not a special case for York Minster; it is a gazetteer, and
 * OpenStreetMap is the source that has one: the stations, the shopping centres, the hospitals,
 * the universities, the parks and the cathedrals, each with the name people use.
 *
 * Bounded the same way the road extraction is, and for the same reason: Overpass is a shared
 * volunteer service that asks for modest, targeted queries. One query per area, spaced, over the
 * areas named in the road pipeline — the places worth naming are in the same towns the buses run
 * through. The coverage is published with the artifact so a search can say what it looked in.
 */

import { writeFileSync } from "node:fs";
import { OVERPASS_HEADERS, OVERPASS_URL, OSM_ATTRIBUTION } from "@busstops/adapters";
import { ArtifactStore, SourceClient, r2StoreFromEnv } from "@busstops/pipeline-core";
import { ROAD_AREAS } from "@busstops/pipeline-road-network";
import {
  MAX_GAZETTEER_RECORDS,
  PLACES_DATASET,
  placesFromOverpass,
  placesQuery,
  type PlaceRecord,
} from "./src/index.js";

const PAUSE_BETWEEN_AREAS_MS = 5_000;
/** Names carried into the report per area, so a missing landmark can be checked against reality. */
const SAMPLE_NAMES_PER_AREA = 40;
/**
 * Kinds listed in full rather than sampled.
 *
 * The smallest categories, and the ones somebody types into a search box by name: a shopping
 * centre, a station, an airport. If a landmark of one of these kinds is missing from the
 * gazetteer, this is the list that says so outright instead of leaving it to be inferred from a
 * count.
 */
const LANDMARK_KINDS = new Set(["shopping", "bus_station", "rail_station", "airport"]);
const QUERY_TIMEOUT_MS = 120_000;

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

  const client = new SourceClient("osm", "England (selected urban areas)", 86_400);
  const places = new Map<string, PlaceRecord>();
  const perArea: Array<Record<string, unknown>> = [];
  const failed: string[] = [];

  /**
   * One area, recorded either way.
   *
   * Returns the names it found, because a report that says "290 places" cannot answer the
   * question run 45 actually raised: the Birmingham extraction succeeded with 290 places and
   * `Bullring` was not findable afterwards. "How many" and "which ones" are different facts, and
   * only the second one says whether a gap is in the query or in the index.
   */
  async function extractArea(area: (typeof ROAD_AREAS)[number]): Promise<PlaceRecord[] | null> {
    try {
      const payload = await client.fetchJson<unknown>(
        `${OVERPASS_URL}?data=${encodeURIComponent(placesQuery(area.bbox))}`,
        { timeoutMs: QUERY_TIMEOUT_MS, maxAttempts: 3, headers: OVERPASS_HEADERS },
      );
      const extracted = placesFromOverpass(payload);
      // Areas overlap; the id is derived from the OSM element, so a second sighting is the same
      // record rather than a duplicate result in the list.
      for (const place of extracted.places) places.set(place.id, place);
      const kinds: Record<string, number> = {};
      for (const place of extracted.places) kinds[place.kind] = (kinds[place.kind] ?? 0) + 1;
      /*
       * Two samples, because the first one answered the wrong question.
       *
       * Forty names taken alphabetically off the top of Birmingham's 290 were all "B" — every one
       * of them a Birmingham-something — and `Bullring`, the landmark this report exists to
       * account for, sorts after them. A sample that only ever shows the first letter cannot say
       * what an area holds. So the general one is spread evenly across the sorted list, and the
       * categories a passenger actually names a destination from are listed in full: they are the
       * smallest kinds, and they are where a missing landmark would be.
       */
      const sorted = extracted.places.map((place) => place.name).sort((a, b) => a.localeCompare(b));
      const step = Math.max(1, Math.ceil(sorted.length / SAMPLE_NAMES_PER_AREA));
      perArea.push({
        area: area.id,
        places: extracted.places.length,
        skipped: extracted.skipped,
        kinds,
        sampleNames: sorted.filter((_, at) => at % step === 0),
        landmarks: extracted.places
          .filter((place) => LANDMARK_KINDS.has(place.kind))
          .map((place) => `${place.name} (${place.kind})`)
          .sort((a, b) => a.localeCompare(b)),
      });
      console.log(
        `${area.name}: ${extracted.places.length} place(s), ${extracted.skipped} skipped.`,
      );
      return extracted.places;
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : "unreadable";
      perArea.push({ area: area.id, error: reason });
      console.error(`${area.name}: extraction failed — ${reason}`);
      return null;
    }
  }

  const firstPassFailures: Array<(typeof ROAD_AREAS)[number]> = [];
  for (const [at, area] of ROAD_AREAS.entries()) {
    if (at > 0) await sleep(PAUSE_BETWEEN_AREAS_MS);
    if ((await extractArea(area)) === null) firstPassFailures.push(area);
  }

  /*
   * One more attempt at whatever failed, at the end rather than immediately.
   *
   * Run 45 lost Bristol to `osm server error 504` — Overpass timing out on its own side under
   * load — while the five areas either side of it succeeded. The client's own retries happen
   * within seconds and meet the same busy server; coming back after the rest of the run is
   * minutes later, which is the interval that actually differs. A second failure is reported as a
   * failure and the gazetteer publishes without that area, labelled.
   */
  for (const area of firstPassFailures) {
    await sleep(PAUSE_BETWEEN_AREAS_MS);
    console.log(`${area.name}: retrying after the other areas.`);
    if ((await extractArea(area)) === null) {
      const record = [...perArea].reverse().find((entry) => entry.area === area.id);
      failed.push(`${area.id} (${String(record?.error ?? "unreadable")}, twice)`);
    }
  }

  report.perArea = perArea;
  report.failed = failed;
  report.places = places.size;

  if (places.size === 0) {
    // Overwriting a good gazetteer with an empty one would take place search away and look
    // exactly like a country with no landmarks in it. The previous publish stays current.
    report.outcome = "no_places";
    console.error("No places extracted; the previous publish is unchanged.");
    writeReport(report);
    return failed.length === ROAD_AREAS.length ? 1 : 0;
  }

  /*
   * The edge holds this whole object, so the ceiling is enforced at the publish rather than
   * discovered in an isolate. Outgrowing it means sharding the gazetteer the way the search index
   * is sharded — not raising the number.
   */
  if (places.size > MAX_GAZETTEER_RECORDS) {
    report.outcome = "too_large";
    console.error(
      `${places.size} places is past the ${MAX_GAZETTEER_RECORDS} the edge may hold in one object. ` +
        "Shard the gazetteer rather than raising the cap.",
    );
    writeReport(report);
    return 1;
  }

  const artifacts = new ArtifactStore(storage.store);
  await artifacts.publish({
    dataset: PLACES_DATASET,
    version: startedAt.toISOString(),
    records: [...places.values()],
    schemaVersion: "1.0.0",
    sources: ["osm"],
    partialCoverage: true,
    notes:
      `Named places in ${ROAD_AREAS.map((area) => area.name).join(", ")}. ${OSM_ATTRIBUTION}.` +
      (failed.length > 0 ? ` Not extracted this run: ${failed.join(", ")}.` : ""),
  });

  report.outcome = "published";
  console.log(
    `Published ${places.size} place(s) across ${ROAD_AREAS.length - failed.length} of ${ROAD_AREAS.length} area(s).`,
  );
  writeReport(report);
  return 0;
}

function writeReport(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("places-report.json", JSON.stringify(report, null, 2));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Places extraction failed:", error);
    process.exitCode = 1;
  });
