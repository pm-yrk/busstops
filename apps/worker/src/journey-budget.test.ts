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
import { LiveService } from "./live-service.js";
import { NetworkReader } from "./network-reader.js";
import { patternTilesForBoundingBox } from "@busstops/pipeline-static-network";

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

/**
 * The order reversal that takes geometry out of the corridor.
 *
 * The slice used to read the corridor's pattern tiles — shapes and all — and a Leeds corridor
 * spent the whole pattern budget on geometry the planner never looks at, came back incomplete,
 * and the planner refused to plan. The trips name their patterns, so the read order reverses:
 * trips first, then exactly the patterns they named.
 */
describe("a corridor's patterns get a corridor's budget", () => {
  it("never lets a caller's pattern budget exceed the request's own ceiling", async () => {
    /*
     * The journey asks for six mebibytes of pattern where the map asks for three, because a
     * corridor is not a viewport. What must not follow is a caller being able to ask for more
     * than the request may hold in total — that ceiling is the one the isolate depends on.
     */
    const { store } = await publish(20);
    const reader = new NetworkReader(store, 15 * 60 * 1000, 1024);
    const result = await reader.patternsInTilesDetailed(
      patternTilesForBoundingBox(corridorBoundingBox(request.origin, request.destination, 800)),
      Date.now(),
      undefined,
      // Far above the request ceiling this reader was built with.
      64 * 1024 * 1024,
    );
    // The request ceiling wins: a kilobyte cannot hold a pattern tile, so the read is cut short
    // and says so — which is what the caller's budget must never be able to talk it out of.
    expect(result.complete).toBe(false);
  });
});

describe("a live lookup cannot outlive the budget it entered with", () => {
  it("hands the route's remaining time to the vehicle fetch", async () => {
    /*
     * Run 48's last request before the platform killed it entered this stage with time to spare
     * and spent 1,167ms inside it; run 45's spent 891ms. Both kills arrived immediately after the
     * largest `vehicles` stage in their trail. A budget checked before a stage cannot stop the
     * stage overrunning, so the deadline is handed over.
     */
    let sawTimeout: number | undefined;
    const service = new LiveService({
      env: { BODS_API_KEY: "k", VEHICLE_SALT_SECRET: "s" } as never,
      now: () => new Date("2026-09-04T08:00:00.000Z"),
      fetchImpl: (async (_url: string, init?: { signal?: AbortSignal }) => {
        sawTimeout = init?.signal ? 1 : 0;
        return new Response("<Siri/>", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await service.vehiclesInBoundingBox({ west: -1.6, south: 53.7, east: -1.5, north: 53.8 }, 500);
    // The fetch was given an abort signal, which is what a deadline is made of.
    expect(sawTimeout).toBe(1);
  });
});

describe("patterns arrive after the trips that name them", () => {
  it("asks only for the patterns the corridor's trips actually reference", async () => {
    const { store } = await publish(20);
    const asked: string[][] = [];

    const outcome = await new JourneyService(store).planJourney(
      // An empty slice: with a resolver, the corridor's own patterns are not read at all.
      { ...slice(), patternsById: new Map() },
      {
        ...request,
        resolvePatterns: (ids) => {
          asked.push([...ids]);
          return Promise.resolve({
            patterns: slice().patternsById as Map<string, never>,
            complete: true,
            available: true,
          });
        },
      },
    );

    expect(asked).toHaveLength(1);
    // The fixture's trips are all on one pattern, plus filler on patterns the slice never had.
    expect(asked[0]).toContain("p-a2");
    expect(outcome.diagnostics.patternsRequested).toBe(asked[0]!.length);
    expect(outcome.ok).toBe(true);
  });

  it("refuses when a pattern the trips named could not be read", async () => {
    const { store } = await publish(5);
    const outcome = await new JourneyService(store).planJourney(
      { ...slice(), patternsById: new Map() },
      {
        ...request,
        resolvePatterns: () =>
          Promise.resolve({ patterns: new Map(), complete: false, available: true }),
      },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics.code).toBe("incomplete_read");
    if (!outcome.ok) expect(outcome.reason).toContain("could not read every route");
  });

  /*
   * Run 46: 190 patterns wanted, 92 index buckets read, the whole twelve-mebibyte request budget
   * spent, and the read cut short with 114 of 190 resolved — so the planner refused a journey it
   * had most of the material for. The corridor slice had already read patterns as geometry a
   * moment earlier and this asked the index for them again.
   */
  it("does not ask the index for a pattern the corridor slice already read", async () => {
    const { store } = await publish(20);
    const asked: string[][] = [];

    await new JourneyService(store).planJourney(slice(), {
      ...request,
      resolvePatterns: (ids) => {
        asked.push([...ids]);
        return Promise.resolve({ patterns: new Map(), complete: true, available: true });
      },
    });

    expect(asked).toHaveLength(1);
    for (const id of slice().patternsById.keys()) {
      expect(asked[0]).not.toContain(id);
    }
  });

  it("keeps the slice's own patterns when the index answers with fewer", async () => {
    const { store } = await publish(20);
    // An index that resolves nothing at all: the slice's patterns must survive it, because
    // replacing rather than merging threw away records already in the isolate.
    const outcome = await new JourneyService(store).planJourney(slice(), {
      ...request,
      resolvePatterns: () =>
        Promise.resolve({ patterns: new Map(), complete: true, available: true }),
    });

    expect(outcome.diagnostics.patternsInSlice).toBe(slice().patternsById.size);
    expect(outcome.ok).toBe(true);
  });

  it("falls back to the corridor's own patterns when no index has been published", async () => {
    const { store } = await publish(5);
    // No resolver at all, which is an artifact published before the pattern index existed.
    const outcome = await new JourneyService(store).planJourney(slice(), request);
    expect(outcome.ok).toBe(true);
  });
});
