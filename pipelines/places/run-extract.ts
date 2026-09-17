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
import { OVERPASS_URL, OSM_ATTRIBUTION } from "@busstops/adapters";
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

  for (const [at, area] of ROAD_AREAS.entries()) {
    if (at > 0) await sleep(PAUSE_BETWEEN_AREAS_MS);
    try {
      const payload = await client.fetchJson<unknown>(
        `${OVERPASS_URL}?data=${encodeURIComponent(placesQuery(area.bbox))}`,
        { timeoutMs: QUERY_TIMEOUT_MS, maxAttempts: 3 },
      );
      const extracted = placesFromOverpass(payload);
      // Areas overlap; the id is derived from the OSM element, so a second sighting is the same
      // record rather than a duplicate result in the list.
      for (const place of extracted.places) places.set(place.id, place);
      perArea.push({ area: area.id, places: extracted.places.length, skipped: extracted.skipped });
      console.log(
        `${area.name}: ${extracted.places.length} place(s), ${extracted.skipped} skipped.`,
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
