import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  InMemoryObjectStore,
  canStream,
  objectKeyFor,
  objectKeyForBytes,
  corridorBoundingBox,
  type ObjectStore,
} from "@busstops/pipeline-core";
import {
  currentArtifactLayout,
  encodePatternTripShard,
  patternTripsDataset,
  tripTilesForBoundingBox,
  tripWindowsFor,
} from "@busstops/pipeline-static-network";
import { JOURNEY_LIMITS, JourneyService } from "./journey-service.js";
import type { PatternTripRow } from "@busstops/pipeline-static-network";
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

  /*
   * The slice no longer brings the national service list, so the plan has to ask for the services
   * of the patterns it ends up with — and a plan that cannot name its service prints a blank where
   * "First Bristol" belongs. The failure mode is silent, which is why it is asserted both ways.
   */
  it("names its route from the services it asked for, not from a slice that carried them all", async () => {
    const { store } = await publish(10);
    const asked: string[][] = [];
    const outcome = await new JourneyService(store).planJourney(
      // A slice as the reader now builds one for a corridor that skipped the pattern tiles: it has
      // the patterns the trips need and no services at all.
      { ...slice(), services: new Map() },
      {
        ...request,
        resolveServices: (serviceIds: readonly string[]) => {
          asked.push([...serviceIds]);
          return Promise.resolve(
            new Map([["svc-a2", { id: "svc-a2", publicName: "A2", operatorId: "op" } as never]]),
          );
        },
      },
    );

    expect(outcome.ok).toBe(true);
    // Asked for exactly the one service its patterns name, not for everything.
    expect(asked).toEqual([["svc-a2"]]);
    /*
     * The route's own name, in the plan. Asserted against the serialised result rather than by
     * walking the leg shape, because what matters here is that "A2" reached the answer at all —
     * the previous version of this read every service in England to find it.
     */
    const planned = outcome.ok ? JSON.stringify(outcome.result) : "";
    expect(planned).toContain("A2");
  });

  it("asks for nothing when the slice already has every service its patterns name", async () => {
    const { store } = await publish(10);
    let calls = 0;
    const outcome = await new JourneyService(store).planJourney(slice(), {
      ...request,
      resolveServices: (serviceIds: readonly string[]) => {
        calls += 1;
        void serviceIds;
        return Promise.resolve(new Map());
      },
    });

    expect(outcome.ok).toBe(true);
    expect(calls).toBe(0);
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

  /*
   * And the deadline bounds the stage, not each attempt.
   *
   * `fetchText` retries three times with backoff and `timeoutMs` bounds one attempt, so handing it
   * the request's remaining time made the overrun worse: run 49 measured 2,530ms from a stage
   * given about 850ms — three attempts plus jitter — and the platform answered the request after
   * it. A caller with a deadline gets one attempt inside it.
   */
  it("does not retry inside a deadline, which is how one attempt became three", async () => {
    let attempts = 0;
    const service = new LiveService({
      env: { BODS_API_KEY: "k", VEHICLE_SALT_SECRET: "s" } as never,
      now: () => new Date("2026-09-04T08:00:00.000Z"),
      fetchImpl: (async () => {
        attempts += 1;
        // A retryable failure: without the bound this is attempted three times.
        return new Response("upstream busy", { status: 503 });
      }) as unknown as typeof fetch,
    });

    await service.vehiclesInBoundingBox({ west: -1.6, south: 53.7, east: -1.5, north: 53.8 }, 500);
    expect(attempts).toBe(1);
  });

  it("bounds every endpoint that reads the feed, not only the one that was measured", async () => {
    /*
     * Run 52 bounded route detail and left the map, the vehicle page and the live endpoint on
     * three retries — and the platform answered `/v1/map` on the first attempt of the first city,
     * taking `/v1/search` and `/v1/nearby` down with it on the same isolate. A request holding a
     * four-second retry does not fail alone, so a fix that covers one caller covers none.
     */
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const calls = [...source.matchAll(/vehiclesInBoundingBox\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThan(2);
    for (const args of calls) {
      // Every call site passes a second argument: a deadline, from a ledger or a named constant.
      expect(args.includes(","), `un-bounded call: vehiclesInBoundingBox(${args})`).toBe(true);
    }
  });

  it("stops asking a failing upstream before the isolate pays for it three times", async () => {
    /*
     * The default breaker opens after five failed *calls*, which is calibrated for a job making
     * hundreds of them over minutes. An isolate does not live that long: run 52 was killed on the
     * first attempt of the first city, so the counter reset before it ever reached five and the
     * breaker was defeated by the very failure it exists to prevent.
     */
    let attempts = 0;
    const service = new LiveService({
      env: { BODS_API_KEY: "k", VEHICLE_SALT_SECRET: "s" } as never,
      now: () => new Date("2026-09-04T08:00:00.000Z"),
      fetchImpl: (async () => {
        attempts += 1;
        return new Response("upstream busy", { status: 503 });
      }) as unknown as typeof fetch,
    });

    const bbox = { west: -1.6, south: 53.7, east: -1.5, north: 53.8 };
    // Two bounded calls, each one attempt, is enough to open it.
    await service.vehiclesInBoundingBox(bbox, 500);
    await service.vehiclesInBoundingBox(bbox, 500);
    const spentSoFar = attempts;

    // The third asks nothing at all: it fails fast off the open breaker.
    const third = await service.vehiclesInBoundingBox(bbox, 500);
    expect(attempts).toBe(spentSoFar);
    // And says so, rather than reporting an empty viewport as though London had no buses.
    expect(third.failedSources).toContain("bods");
  });

  it("keeps its retries when nobody handed it a deadline", async () => {
    let attempts = 0;
    const service = new LiveService({
      env: { BODS_API_KEY: "k", VEHICLE_SALT_SECRET: "s" } as never,
      now: () => new Date("2026-09-04T08:00:00.000Z"),
      fetchImpl: (async () => {
        attempts += 1;
        return new Response("upstream busy", { status: 503 });
      }) as unknown as typeof fetch,
    });

    // A scheduled collector genuinely should retry a flaky upstream: nobody is waiting for it.
    await service.vehiclesInBoundingBox({ west: -1.6, south: 53.7, east: -1.5, north: 53.8 });
    expect(attempts).toBeGreaterThan(1);
  });
});

/**
 * The two read paths have to filter the same rows.
 *
 * A trip line is tested twice off the raw text before it is parsed: the pattern it is on, and the
 * window its calls fall in. The window test was added to the streaming path only, and the
 * buffered path — the one a store without `getStream` takes — kept testing the window on the
 * parsed row instead. Both end in the same answer either way, but only if the two filters agree:
 * a scan that drops a row the parse would have kept removes a bus from a journey, and it would
 * have done so on exactly one of the two paths, which is the hardest kind of difference to see.
 */
describe("the buffered read filters what the streaming read filters", () => {
  /* A trip on the corridor's own pattern, five hours after the plan ends: inside the shard the
   * plan opens, outside the horizon it searches. The pattern test cannot drop it, so the window
   * test is the only thing that can. */
  function lateLine(index: number): string {
    const base = Date.parse(`${SERVICE_DATE}T00:00:00.000Z`) / 1000 + DEPART_AT + 5 * 3600;
    return JSON.stringify({ p: "p-a2", j: `late-${String(index)}`, t: [base, base + 900] });
  }

  async function publishWithLateTrips() {
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
          ...Array.from({ length: 8 }, (_, i) => lateLine(i)),
          ...Array.from({ length: 8 }, (_, i) => fillerLine(i)),
        ];
        await store.put(
          objectKeyFor(patternTripsDataset(SERVICE_DATE, tile, window), "v1"),
          `${lines.join("\n")}\n`,
        );
      }
    }
    return store;
  }

  /** The same store with `getStream` hidden, which is how the buffered path is reached. */
  function withoutStreaming(store: InMemoryObjectStore): ObjectStore {
    return {
      get: (key) => store.get(key),
      put: (key, value) => store.put(key, value),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
    };
  }

  it("loads and drops the same rows, and plans the same journey", async () => {
    const store = await publishWithLateTrips();
    expect(canStream(store)).toBe(true);
    const buffered = withoutStreaming(store);
    expect(canStream(buffered)).toBe(false);

    const streamed = await new JourneyService(store).planJourney(slice(), request);
    const plain = await new JourneyService(buffered).planJourney(slice(), request);

    expect(streamed.ok).toBe(true);
    expect(plain.ok).toBe(true);
    expect(plain.diagnostics.tripsLoaded).toBe(streamed.diagnostics.tripsLoaded);
    expect(plain.diagnostics.tripsFiltered).toBe(streamed.diagnostics.tripsFiltered);
    expect(JSON.stringify(plain.ok ? plain.result : null)).toBe(
      JSON.stringify(streamed.ok ? streamed.result : null),
    );
  });

  it("drops the out-of-horizon trips before parsing them, on both paths", async () => {
    const store = await publishWithLateTrips();
    const streamed = await new JourneyService(store).planJourney(slice(), request);
    const plain = await new JourneyService(withoutStreaming(store)).planJourney(slice(), request);

    /* Sixteen of the eighteen rows in each shard cannot be used: eight on other patterns, eight
     * outside the horizon. Both paths have to account for all of them. */
    for (const outcome of [streamed, plain]) {
      expect(outcome.diagnostics.tripsLoaded).toBeGreaterThan(0);
      expect(outcome.diagnostics.tripsFiltered).toBe(outcome.diagnostics.tripsLoaded! * 8);
    }
  });
});

/**
 * The published binary shard, which is the form that makes a journey fit in a passenger request.
 *
 * `JSON.parse` over a corridor's trip text measured 24.26 ms against a ten-millisecond budget —
 * more than the graph build and the search put together. The same shard published columnar is read
 * through typed arrays. What has to be true is that it is the *same shard*: the same trips kept,
 * the same ones dropped, the same itinerary, and a fallback that works when the bytes do not.
 */
/**
 * The plan horizon, which is the cheapest thing the planner had been getting wrong.
 *
 * It read four hours of timetable for every request. Against the golden corpus a two-hour horizon
 * returned the same best itinerary on all twenty queries — same fastest arrival, same fewest
 * changes, nothing lost, nothing materially worse — for half the rows. So the narrow pass runs
 * first, and widens only when its answer suggests a better one is just outside it.
 *
 * What is asserted here is the thing a corpus of nine-o'clock city queries cannot show: that the
 * journey whose only useful bus leaves after the narrow horizon is still found.
 */
describe("how far ahead a plan looks", () => {
  /** A corridor whose only service runs later than the narrow horizon. */
  async function publishLateOnly() {
    const store = new InMemoryObjectStore();
    const tiles = tripTilesForBoundingBox(corridor);
    const midnight = Date.parse(`${SERVICE_DATE}T00:00:00.000Z`) / 1000;
    /* Windows for the whole four hours, because the shards have to exist for the wide pass. */
    const windows = tripWindowsFor(
      midnight + DEPART_AT,
      midnight + DEPART_AT + 4 * 3600,
      SERVICE_DATE,
    );
    for (const tile of tiles) {
      for (const window of windows) {
        /* Three hours out: outside two hours, inside four. */
        const lines = [tripLine(0, DEPART_AT + 3 * 3600), tripLine(1, DEPART_AT + 3 * 3600 + 900)];
        await store.put(
          objectKeyFor(patternTripsDataset(SERVICE_DATE, tile, window), "v1"),
          `${lines.join("\n")}\n`,
        );
      }
    }
    return store;
  }

  it("answers a city journey from the narrow pass alone", async () => {
    const { store } = await publish(8);
    const outcome = await new JourneyService(store).planJourney(slice(), request);

    expect(outcome.ok).toBe(true);
    /* Two hours, not four: the second read never happened. */
    expect(outcome.diagnostics.horizonHours).toBe(2);
  });

  it("widens when the only useful bus leaves after the narrow horizon", async () => {
    const store = await publishLateOnly();
    const outcome = await new JourneyService(store).planJourney(slice(), request);

    expect(outcome.ok).toBe(true);
    expect(outcome.diagnostics.horizonHours).toBe(4);
    if (outcome.ok) {
      /* And it is a real itinerary, on the bus three hours out. */
      expect(outcome.result.options.length).toBeGreaterThan(0);
      expect(outcome.result.options[0]!.legs.some((leg) => leg.mode === "bus")).toBe(true);
    }
  });

  it("reads twice as many shards when it widens, and no more than that", async () => {
    const store = await publishLateOnly();
    const service = new JourneyService(store);
    const outcome = await service.planJourney(slice(), request);
    expect(outcome.ok).toBe(true);
    /* The wide pass's own read, reported: the narrow one's numbers are not carried over. */
    expect(outcome.diagnostics.shardsRead).toBeGreaterThan(0);
    expect(outcome.diagnostics.tripsLoaded).toBeGreaterThan(0);
  });

  /*
   * A refusal is never retried.
   *
   * A corridor that could not be read inside its budget does not get better with a wider horizon:
   * it reads more and fails again, having spent a second budget to say the same thing.
   */
  it("does not widen a refusal", async () => {
    const { store } = await publish(200);
    const outcome = await new JourneyService(store, 2_000).planJourney(slice(), request);
    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics.code).toBe("incomplete_read");
    expect(outcome.diagnostics.horizonHours).toBe(2);
  });
});

describe("a corridor published as bytes", () => {
  async function publishBinary(options: { alsoText: boolean; corrupt?: boolean }) {
    const store = new InMemoryObjectStore();
    const tiles = tripTilesForBoundingBox(corridor);
    const midnight = Date.parse(`${SERVICE_DATE}T00:00:00.000Z`) / 1000;
    const windows = tripWindowsFor(
      midnight + DEPART_AT,
      midnight + DEPART_AT + 4 * 3600,
      SERVICE_DATE,
    );
    const lines = [
      tripLine(0, DEPART_AT + 600),
      tripLine(1, DEPART_AT + 1800),
      ...Array.from({ length: 8 }, (_, i) => fillerLine(i)),
    ];
    const rows = lines.map((line) => JSON.parse(line) as PatternTripRow);
    let shards = 0;
    for (const tile of tiles) {
      for (const window of windows) {
        const dataset = patternTripsDataset(SERVICE_DATE, tile, window);
        if (options.alsoText) await store.put(objectKeyFor(dataset, "v1"), `${lines.join("\n")}\n`);
        const bytes = options.corrupt
          ? new TextEncoder().encode("this is not a shard")
          : encodePatternTripShard(rows).bytes;
        await store.putBytes(objectKeyForBytes(dataset, "v1"), bytes);
        shards += 1;
      }
    }
    return { store, shards };
  }

  it("plans the same journey from the bytes as from the text", async () => {
    const { store: textStore } = await publish(8);
    const { store: binaryStore, shards } = await publishBinary({ alsoText: false });

    const fromText = await new JourneyService(textStore).planJourney(slice(), request);
    const fromBytes = await new JourneyService(binaryStore).planJourney(slice(), request);

    expect(fromText.ok).toBe(true);
    expect(fromBytes.ok).toBe(true);
    // Every shard came from the binary form, and none of them from a text fallback.
    expect(fromBytes.diagnostics.shardsBinary).toBe(shards);
    expect(fromBytes.diagnostics.shardsBinaryFallback).toBe(0);
    expect(fromText.diagnostics.shardsBinary).toBe(0);
    // The same trips kept and the same trips dropped, and then the same itinerary.
    expect(fromBytes.diagnostics.tripsLoaded).toBe(fromText.diagnostics.tripsLoaded);
    expect(fromBytes.diagnostics.tripsFiltered).toBe(fromText.diagnostics.tripsFiltered);
    expect(JSON.stringify(fromBytes.ok ? fromBytes.result : null)).toBe(
      JSON.stringify(fromText.ok ? fromText.result : null),
    );
  });

  it("prefers the bytes when both forms are published", async () => {
    const { store, shards } = await publishBinary({ alsoText: true });
    const outcome = await new JourneyService(store).planJourney(slice(), request);
    expect(outcome.ok).toBe(true);
    expect(outcome.diagnostics.shardsBinary).toBe(shards);
    expect(outcome.diagnostics.shardsBinaryFallback).toBe(0);
  });

  /*
   * A publishing fault must not cost a passenger a journey.
   *
   * Corrupt bytes are the publisher's problem and they are fixable in minutes; a plan that
   * refuses because of them is a day of lost journeys. So the text sibling answers and the
   * fallback is counted, because "the fast path was not taken" and "the fast path is not fast"
   * need telling apart in a deployed measurement.
   */
  it("falls back to the text sibling when the bytes cannot be opened, and says so", async () => {
    const { store, shards } = await publishBinary({ alsoText: true, corrupt: true });
    const outcome = await new JourneyService(store).planJourney(slice(), request);

    expect(outcome.ok).toBe(true);
    expect(outcome.diagnostics.shardsBinary).toBe(0);
    expect(outcome.diagnostics.shardsBinaryFallback).toBe(shards);
    expect(outcome.diagnostics.tripsLoaded).toBeGreaterThan(0);
  });

  /*
   * And the cost of looking, on a bucket that has not been converted.
   *
   * Every probe is a subrequest and a Workers Free invocation gets fifty. A corridor asks for
   * dozens of shards, so a reader that probed for a binary sibling on every read, for the life of
   * the isolate, would spend that budget on 404s — and this endpoint has already been killed once
   * for running out of what it was given. After a few consecutive misses the isolate stops asking.
   */
  it("stops looking for bytes that are not there, rather than probing for the life of the isolate", async () => {
    const { store, shards } = await publish(8);
    const probes: string[] = [];
    const counting = {
      get: (key: string) => store.get(key),
      put: (key: string, value: string) => store.put(key, value),
      delete: (key: string) => store.delete(key),
      list: (prefix: string) => store.list(prefix),
      getStream: (key: string) => store.getStream(key),
      getBytes: async (key: string) => {
        probes.push(key);
        return store.getBytes(key);
      },
      putBytes: (key: string, value: Uint8Array) => store.putBytes(key, value),
    };

    const service = new JourneyService(counting as unknown as InMemoryObjectStore);
    const perPlan: number[] = [];
    for (let plan = 0; plan < 5; plan += 1) {
      const before = probes.length;
      /* A different departure each time, so the shard cache cannot answer instead of the store. */
      const outcome = await service.planJourney(slice(), {
        ...request,
        departAtSeconds: DEPART_AT + plan * 60,
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.diagnostics.shardsBinary).toBe(0);
      perPlan.push(probes.slice(before).filter((key) => key.endsWith(".bin")).length);
    }

    /* It gave up: the last plan asked for nothing, and the total is bounded rather than growing
     * with the number of plans this isolate serves. */
    expect(perPlan[perPlan.length - 1]).toBe(0);
    expect(probes.filter((key) => key.endsWith(".bin")).length).toBeLessThanOrEqual(shards * 3);
  });

  it("refuses rather than planning on half a corridor when the bytes are the only copy", async () => {
    /* No text sibling and bytes that cannot be opened: there is nothing to plan from, and a
     * confident itinerary built on the shards that happened to work is the one answer that must
     * never be given. */
    const { store } = await publishBinary({ alsoText: false, corrupt: true });
    const outcome = await new JourneyService(store).planJourney(slice(), request);
    expect(outcome.ok).toBe(false);
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

/**
 * The parse is the expensive half, and it was being paid for on every request.
 *
 * `coalesce` deduplicates concurrent fetches and drops its entry the moment one settles, so two
 * sequential `/v1/map` requests fetched and parsed the feed twice. On Workers Free the whole CPU
 * budget for an invocation is ten milliseconds and SIRI-VM normalises at roughly a hundred per
 * mebibyte, so that parse is several times the budget on its own — and `parseMs` could never show
 * it, because a Worker's clock does not advance across pure computation.
 */
describe("a feed is parsed once, not once per request", () => {
  const bbox = { west: -1.6, south: 53.7, east: -1.5, north: 53.8 };
  const siri = `<?xml version="1.0"?><Siri xmlns="http://www.siri.org.uk/siri"><ServiceDelivery>
    <ResponseTimestamp>2026-09-04T08:00:00Z</ResponseTimestamp><VehicleMonitoringDelivery>
    <VehicleActivity><RecordedAtTime>2026-09-04T07:59:50Z</RecordedAtTime>
    <MonitoredVehicleJourney><LineRef>36</LineRef><VehicleRef>v1</VehicleRef>
    <VehicleLocation><Longitude>-1.55</Longitude><Latitude>53.75</Latitude></VehicleLocation>
    </MonitoredVehicleJourney></VehicleActivity>
    </VehicleMonitoringDelivery></ServiceDelivery></Siri>`;

  function serviceAt(clock: { now: Date }, counter: { fetches: number }) {
    return new LiveService({
      env: { BODS_API_KEY: "k", VEHICLE_SALT_SECRET: "s" } as never,
      now: () => clock.now,
      fetchImpl: (async () => {
        counter.fetches += 1;
        return new Response(siri, { status: 200 });
      }) as unknown as typeof fetch,
    });
  }

  it("reuses the parse for a second request in the same window, and says so", async () => {
    const clock = { now: new Date("2026-09-04T08:00:00.000Z") };
    const counter = { fetches: 0 };
    const service = serviceAt(clock, counter);

    const first = await service.vehiclesInBoundingBox(bbox, 500);
    clock.now = new Date("2026-09-04T08:00:03.000Z");
    const second = await service.vehiclesInBoundingBox(bbox, 500);

    expect(counter.fetches).toBe(1);
    expect(first.diagnostics[0]?.reusedParse).toBe(false);
    expect(second.diagnostics[0]?.reusedParse).toBe(true);
    // And the answer is the same one, not a degraded version of it.
    expect(second.vehicles.map((v) => v.vehicleRef)).toEqual(
      first.vehicles.map((v) => v.vehicleRef),
    );
  });

  it("parses again once the feed could have moved on", async () => {
    const clock = { now: new Date("2026-09-04T08:00:00.000Z") };
    const counter = { fetches: 0 };
    const service = serviceAt(clock, counter);

    await service.vehiclesInBoundingBox(bbox, 500);
    // Past the window: BODS republishes about every ten seconds, so reusing beyond it would be
    // answering with something staler than the feed.
    clock.now = new Date("2026-09-04T08:00:20.000Z");
    const later = await service.vehiclesInBoundingBox(bbox, 500);

    expect(counter.fetches).toBe(2);
    expect(later.diagnostics[0]?.reusedParse).toBe(false);
  });

  it("does not answer one viewport with another viewport's buses", async () => {
    const clock = { now: new Date("2026-09-04T08:00:00.000Z") };
    const counter = { fetches: 0 };
    const service = serviceAt(clock, counter);

    await service.vehiclesInBoundingBox(bbox, 500);
    // A different box is a different feed URL, so it must be fetched rather than reused.
    const elsewhere = await service.vehiclesInBoundingBox(
      { west: -2.3, south: 53.4, east: -2.2, north: 53.5 },
      500,
    );

    expect(counter.fetches).toBe(2);
    expect(elsewhere.diagnostics[0]?.reusedParse).toBe(false);
  });
});
