import { describe, expect, it } from "vitest";
import { InMemoryObjectStore, objectKeyFor, corridorBoundingBox } from "@busstops/pipeline-core";
import {
  currentArtifactLayout,
  patternTripsDataset,
  tripTilesForBoundingBox,
  tripWindowsFor,
} from "@busstops/pipeline-static-network";
import { JOURNEY_LIMITS, JourneyService } from "./journey-service.js";
import type { NetworkSlice } from "./network-reader.js";

/**
 * The stage that answered Cloudflare error 1102 on Leeds to Leeds Bradford Airport.
 *
 * `loadTrips` was a plain nested loop: every corridor tile crossed with every window, each one
 * `await store.get(...)` and a whole-shard parse, and nothing counting what it had opened. The
 * largest published pattern-trips shard is 8,109,406 bytes, and `JOURNEY_LIMITS.maxTiles` is
 * sixteen, so a corridor could ask for far more than an isolate holds and the platform ended the
 * request before the search ran.
 *
 * Two things are asserted here. That the read stops at a budget it owns — and that when it does,
 * the planner refuses rather than planning on the part of the corridor it managed to read. That
 * second half is the whole difference between this endpoint and the map: a partly drawn map is
 * still a map, and a journey missing the shard the direct bus was in is a confident wrong answer.
 */

const SERVICE_DATE = "2026-09-17";
const DEPART_AT = 8 * 3600;
const ORIGIN = { lat: 53.7955, lon: -1.5478 };
const DESTINATION = { lat: 53.8659, lon: -1.6606 };

const corridor = corridorBoundingBox(ORIGIN, DESTINATION, JOURNEY_LIMITS.maxAccessWalkMetres);

function stop(id: string, name: string, lat: number, lon: number) {
  return { id, name, coordinate: { lat, lon } };
}

/** A corridor with one pattern that actually gets you there, plus filler to make shards big. */
function slice(): NetworkSlice {
  const stops = [
    stop("s-leeds", "Leeds City Square", 53.7955, -1.5478),
    stop("s-horsforth", "Horsforth Town Street", 53.8395, -1.6294),
    stop("s-airport", "Leeds Bradford Airport", 53.8659, -1.6606),
  ];
  return {
    stopsById: new Map(
      stops.map((entry) => [
        entry.id,
        {
          id: entry.id,
          atcoCode: entry.id.toUpperCase(),
          name: entry.name,
          locationCoordinate: entry.coordinate,
        } as never,
      ]),
    ),
    patternsById: new Map([
      [
        "p-a2",
        {
          id: "p-a2",
          serviceRouteId: "svc-a2",
          direction: "outbound",
          stopSequence: ["s-leeds", "s-horsforth", "s-airport"],
          distanceMetres: 14_000,
          shapeRef: "shape-a2",
        } as never,
      ],
    ]),
    services: new Map([["svc-a2", { id: "svc-a2", publicName: "A2", operatorId: "op" } as never]]),
  };
}

function tripLine(index: number, startSeconds: number): string {
  const base = Date.parse(`${SERVICE_DATE}T00:00:00.000Z`) / 1000 + startSeconds;
  return JSON.stringify({
    p: "p-a2",
    j: `trip-${index}`,
    t: [base, base + 900, base + 1500],
  });
}

/** Rows on a pattern the corridor does not have, which the reader must drop as it parses. */
function fillerLine(index: number): string {
  const base = Date.parse(`${SERVICE_DATE}T00:00:00.000Z`) / 1000 + DEPART_AT;
  return JSON.stringify({
    p: `p-filler-${index}`,
    j: `filler-${index}`,
    t: [base, base + 600],
    note: "x".repeat(400),
  });
}

async function publish(fillerPerShard: number) {
  const store = new InMemoryObjectStore();
  const tiles = tripTilesForBoundingBox(corridor);
  const midnight = Date.parse(`${SERVICE_DATE}T00:00:00.000Z`) / 1000;
  const windows = tripWindowsFor(
    midnight + DEPART_AT,
    midnight + DEPART_AT + 4 * 3600,
    SERVICE_DATE,
  );

  for (const tile of tiles) {
    for (const window of windows) {
      const lines = [
        tripLine(0, DEPART_AT + 600),
        tripLine(1, DEPART_AT + 1800),
        ...Array.from({ length: fillerPerShard }, (_, i) => fillerLine(i)),
      ];
      await store.put(
        objectKeyFor(patternTripsDataset(SERVICE_DATE, tile, window), "v1"),
        `${lines.join("\n")}\n`,
      );
    }
  }
  return { store, shards: tiles.length * windows.length };
}

const request = {
  origin: ORIGIN,
  destination: DESTINATION,
  departAtSeconds: DEPART_AT,
  serviceDate: SERVICE_DATE,
  version: "v1",
  layout: currentArtifactLayout(),
};

describe("a journey plan owns its trip read", () => {
  it("plans from a corridor it could read in full, and says what the read cost", async () => {
    const { store, shards } = await publish(10);
    const outcome = await new JourneyService(store).planJourney(slice(), request);

    expect(outcome.diagnostics.shardsRequested).toBe(shards);
    expect(outcome.diagnostics.shardsSkipped).toBe(0);
    expect(outcome.diagnostics.tripChars).toBeGreaterThan(0);
    expect(outcome.diagnostics.stageMs?.readTrips).toBeGreaterThanOrEqual(0);
    expect(outcome.ok).toBe(true);
  });

  it("drops rows it could never use while parsing, rather than after building a graph", async () => {
    const { store } = await publish(50);
    const outcome = await new JourneyService(store).planJourney(slice(), request);

    // Every filler row is on a pattern the corridor slice does not have.
    expect(outcome.diagnostics.tripsFiltered).toBeGreaterThan(0);
    expect(outcome.diagnostics.tripsLoaded).toBeLessThan(outcome.diagnostics.tripsFiltered!);
    expect(outcome.diagnostics.tripsWithoutPattern).toBe(0);
  });

  it("refuses to plan on a corridor it could not read in full", async () => {
    const { store, shards } = await publish(200);
    expect(shards).toBeGreaterThan(1);

    // A budget a real corridor would never hit, so the refusal can be proved on a small fixture.
    const outcome = await new JourneyService(store, 2_000).planJourney(slice(), request);

    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics.code).toBe("incomplete_read");
    expect(outcome.diagnostics.shardsSkipped).toBeGreaterThan(0);
    if (!outcome.ok) {
      // And says so in words a passenger can act on, rather than "no journeys found".
      expect(outcome.reason).toContain("could not read the whole timetable");
    }
  });

  it("never returns a shortened itinerary as though the corridor had been read", async () => {
    const { store } = await publish(200);
    const outcome = await new JourneyService(store, 2_000).planJourney(slice(), request);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("incomplete_read");
  });
});
