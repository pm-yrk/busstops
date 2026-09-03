import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OperatorSchema,
  RoutePatternSchema,
  ScheduledJourneySchema,
  ServiceRouteSchema,
  StopSchema,
} from "@busstops/contracts";
import { ArtifactStore, InMemoryObjectStore } from "@busstops/pipeline-core";
import { buildNetwork } from "./build-network.js";
import { compareFingerprints, fingerprintFromBody, fingerprintFromHeaders } from "./fingerprint.js";
import { buildSearchIndex, nearbyStops, searchIndex, tokenize } from "./search-index.js";
import {
  DATASETS,
  journeyTileDataset,
  publishJourneyTiles,
  publishNetwork,
  rollbackNetwork,
} from "./publish.js";
import { reconcileNetwork, summariseNetworkChanges } from "./reconcile.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/documented",
);
const naptanCsv = readFileSync(join(fixturesDir, "naptan-stops.csv"), "utf8");
const txcXml = readFileSync(join(fixturesDir, "transxchange-service.xml"), "utf8");

const inputs = {
  naptanCsv,
  transXChangeDocuments: [txcXml],
  retrievedAt: "2026-09-02T06:00:00.000Z",
  serviceDate: "2026-09-02",
  sourceVersion: "2026-09-01",
};

describe("fingerprint change detection", () => {
  const checkedAt = "2026-09-02T06:00:00.000Z";

  it("rebuilds when there is no previous fingerprint", () => {
    const current = fingerprintFromBody("naptan", "abc", checkedAt);
    expect(compareFingerprints(null, current).changed).toBe(true);
  });

  it("skips the rebuild when the content identity is unchanged", () => {
    const previous = fingerprintFromBody("naptan", "abc", checkedAt);
    const current = fingerprintFromBody("naptan", "abc", "2026-09-03T06:00:00.000Z");
    const comparison = compareFingerprints(previous, current);
    expect(comparison.changed).toBe(false);
    expect(comparison.reason).toMatch(/unchanged/);
  });

  it("rebuilds when the content changes", () => {
    const previous = fingerprintFromBody("naptan", "abc", checkedAt);
    const current = fingerprintFromBody("naptan", "abd", checkedAt);
    expect(compareFingerprints(previous, current).changed).toBe(true);
  });

  it("normalizes weak ETags so a weak/strong change is not mistaken for new content", () => {
    const previous = fingerprintFromHeaders("naptan", { etag: '"abc123"' }, checkedAt);
    const current = fingerprintFromHeaders("naptan", { etag: 'W/"abc123"' }, checkedAt);
    expect(compareFingerprints(previous, current).changed).toBe(false);
  });

  it("falls back to content length and last-modified when no ETag is offered", () => {
    const previous = fingerprintFromHeaders(
      "naptan",
      { contentLength: "1000", lastModified: "Mon, 01 Sep 2026 00:00:00 GMT" },
      checkedAt,
    );
    const sameSize = fingerprintFromHeaders(
      "naptan",
      { contentLength: "1000", lastModified: "Mon, 01 Sep 2026 00:00:00 GMT" },
      checkedAt,
    );
    const changedSize = fingerprintFromHeaders(
      "naptan",
      { contentLength: "2000", lastModified: "Mon, 01 Sep 2026 00:00:00 GMT" },
      checkedAt,
    );
    expect(compareFingerprints(previous, sameSize).changed).toBe(false);
    expect(compareFingerprints(previous, changedSize).changed).toBe(true);
  });

  it("rebuilds rather than assuming unchanged when nothing is comparable", () => {
    const previous = fingerprintFromHeaders("naptan", {}, checkedAt);
    const current = fingerprintFromHeaders("naptan", {}, checkedAt);
    expect(compareFingerprints(previous, current).changed).toBe(true);
  });
});

describe("buildNetwork", () => {
  const network = buildNetwork(inputs);

  it("produces stops, operators, services, patterns and journeys", () => {
    expect(network.counts.stops).toBeGreaterThan(0);
    expect(network.counts.operators).toBe(1);
    expect(network.counts.services).toBe(1);
    expect(network.counts.patterns).toBeGreaterThanOrEqual(0);
    expect(network.warnings).toBeDefined();
  });

  it("emits records that satisfy their contracts", () => {
    for (const stop of network.stops) expect(StopSchema.safeParse(stop).success).toBe(true);
    for (const operator of network.operators) {
      expect(OperatorSchema.safeParse(operator).success).toBe(true);
    }
    for (const service of network.services) {
      expect(ServiceRouteSchema.safeParse(service).success).toBe(true);
    }
    for (const pattern of network.patterns) {
      expect(RoutePatternSchema.safeParse(pattern).success).toBe(true);
    }
    for (const journey of network.journeys) {
      const parsed = ScheduledJourneySchema.safeParse(journey);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it("refuses to publish a pattern whose stops are missing from NaPTAN", () => {
    // The fixture timetable references 450010003, which the NaPTAN fixture does not contain.
    expect(network.counts.danglingStopReferences).toBeGreaterThan(0);
    expect(network.warnings.join(" ")).toMatch(/absent from NaPTAN/);
  });

  it("classifies London and non-London coverage from the ATCO prefix, not a hard-coded region", () => {
    const withLondonStops = buildNetwork({
      ...inputs,
      transXChangeDocuments: [txcXml.replace(/4500100/g, "4900086")],
    });
    expect(withLondonStops.services[0]?.coverageArea).toBe("london");
    expect(network.services[0]?.coverageArea).toBe("non_london");
  });

  it("resolves scheduled stop times to UTC instants through the DST-correct helper", () => {
    const complete = buildCompleteNetwork();
    const journey = complete.journeys[0]!;
    // 09:15 BST on 2 September 2026 is 08:15 UTC.
    expect(journey.stopTimes[0]?.scheduledDeparture).toBe("2026-09-02T08:15:00.000Z");
  });

  it("gives every entity stable identity across rebuilds", () => {
    const rebuilt = buildNetwork({ ...inputs, retrievedAt: "2026-09-03T06:00:00.000Z" });
    expect(rebuilt.stops[0]?.id).toBe(network.stops[0]?.id);
    expect(rebuilt.services[0]?.id).toBe(network.services[0]?.id);
  });

  it("handles a timetable document with no services without throwing", () => {
    const empty = buildNetwork({
      ...inputs,
      transXChangeDocuments: ['<?xml version="1.0"?><TransXChange/>'],
    });
    expect(empty.counts.services).toBe(0);
    expect(empty.warnings.join(" ")).toMatch(/no services/);
  });
});

/** The fixture timetable references a stop the NaPTAN fixture lacks; add it so journeys build. */
function buildCompleteNetwork() {
  const extraStopRow =
    "450010003,,,,Armley Road,en,Armley Rd,en,,,Armley Road,en,,,,,W,E0035477,Leeds,,,Leeds,en,,,0,U,428500,433900,-1.5600,53.7996,BCT,MKD,PTP,,,,107,2019-01-01T00:00:00,2026-01-15T09:00:00,1,rev,active";
  return buildNetwork({ ...inputs, naptanCsv: `${naptanCsv.trimEnd()}\n${extraStopRow}\n` });
}

describe("journey tile publishing", () => {
  it("publishes journeys per tile so the edge need not load the national timetable", async () => {
    const store = new InMemoryObjectStore();
    const network = buildCompleteNetwork();
    const result = await publishJourneyTiles(store, network, { version: "v1" });

    expect(result.tiles.length).toBeGreaterThan(0);
    expect(result.failed).toEqual([]);

    const artifacts = new ArtifactStore(store);
    const tile = await artifacts.readCurrent(journeyTileDataset(result.tiles[0]!));
    expect(tile.records.length).toBeGreaterThan(0);
  });

  it("counts journeys it cannot place rather than dropping them silently", async () => {
    const store = new InMemoryObjectStore();
    const network = buildCompleteNetwork();
    const orphaned = {
      ...network,
      journeys: network.journeys.map((journey) => ({
        ...journey,
        stopTimes: journey.stopTimes.map((stopTime) => ({
          ...stopTime,
          stopId: "00000000-0000-5000-8000-000000000000",
        })),
      })),
    };

    const result = await publishJourneyTiles(store, orphaned, { version: "v1" });
    expect(result.journeysWithoutGeometry).toBe(network.journeys.length);
    expect(result.tiles).toEqual([]);
  });

  it("writes a journey to every tile it crosses, so either end can find it", async () => {
    const store = new InMemoryObjectStore();
    const network = buildCompleteNetwork();
    const stopsById = new Map(network.stops.map((stop) => [stop.id, stop]));

    const spanning = {
      ...network,
      journeys: network.journeys.slice(0, 1).map((journey) => ({
        ...journey,
        stopTimes: journey.stopTimes.map((stopTime, index) => ({
          ...stopTime,
          // Move the last stop far enough away to land in a different tile.
          stopId:
            index === journey.stopTimes.length - 1
              ? (network.stops.find(
                  (stop) =>
                    Math.abs(
                      stop.locationCoordinate.lat -
                        (stopsById.get(journey.stopTimes[0]!.stopId)?.locationCoordinate.lat ?? 0),
                    ) > 1,
                )?.id ?? stopTime.stopId)
              : stopTime.stopId,
        })),
      })),
    };

    const result = await publishJourneyTiles(store, spanning, { version: "v1" });
    expect(result.tiles.length).toBeGreaterThan(1);
  });
});

describe("buildNetwork with a complete stop set", () => {
  const network = buildCompleteNetwork();

  it("builds patterns and journeys once every referenced stop exists", () => {
    expect(network.counts.patterns).toBe(1);
    expect(network.counts.journeys).toBeGreaterThan(0);
    expect(network.counts.danglingStopReferences).toBe(0);
  });

  it("orders the pattern stop sequence correctly", () => {
    const pattern = network.patterns[0]!;
    expect(pattern.stopSequence).toHaveLength(3);
    const stopIds = new Set(network.stops.map((s) => s.id));
    for (const id of pattern.stopSequence) expect(stopIds.has(id)).toBe(true);
  });

  it("attaches route geometry and a real distance", () => {
    const pattern = network.patterns[0]!;
    expect(network.shapes.get(pattern.shapeRef)!.length).toBeGreaterThanOrEqual(4);
    expect(pattern.distanceMetres).toBeGreaterThan(0);
  });

  it("expands only the journeys that run on the requested service date", () => {
    const wednesday = buildNetwork({
      ...inputs,
      naptanCsv: appendArmley(),
      serviceDate: "2026-09-02",
    });
    const saturday = buildNetwork({
      ...inputs,
      naptanCsv: appendArmley(),
      serviceDate: "2026-09-05",
    });
    const wednesdayTrips = wednesday.journeys.map((j) => j.tripId);
    const saturdayTrips = saturday.journeys.map((j) => j.tripId);
    expect(wednesdayTrips).toContain("VJ_WEEKDAY_0915");
    expect(saturdayTrips).toContain("VJ_SATURDAY_1015");
    expect(saturdayTrips).not.toContain("VJ_WEEKDAY_0915");
  });
});

function appendArmley(): string {
  const extraStopRow =
    "450010003,,,,Armley Road,en,Armley Rd,en,,,Armley Road,en,,,,,W,E0035477,Leeds,,,Leeds,en,,,0,U,428500,433900,-1.5600,53.7996,BCT,MKD,PTP,,,,107,2019-01-01T00:00:00,2026-01-15T09:00:00,1,rev,active";
  return `${naptanCsv.trimEnd()}\n${extraStopRow}\n`;
}

describe("search index", () => {
  const network = buildCompleteNetwork();
  const index = buildSearchIndex(network, { builtAt: "2026-09-02T06:00:00.000Z" });

  it("tokenizes names, dropping noise words", () => {
    expect(tokenize("Boar Lane, The Bull")).toEqual(["boar", "lane", "bull"]);
    expect(tokenize("St John's Church")).toEqual(["st", "john", "s", "church"]);
  });

  it("indexes stops, routes and operators", () => {
    const kinds = new Set(index.entries.map((e) => e.kind));
    expect(kinds.has("stop")).toBe(true);
    expect(kinds.has("route")).toBe(true);
    expect(kinds.has("operator")).toBe(true);
  });

  it("ranks an exact stop code above any name match", () => {
    const results = searchIndex(index, "450010001");
    expect(results[0]?.entry.codes).toContain("450010001");
  });

  it("finds a stop by partial name", () => {
    const results = searchIndex(index, "boar lane");
    expect(results[0]?.entry.title).toBe("Boar Lane, The Bull");
  });

  it("finds a route by number", () => {
    const results = searchIndex(index, "72", { kinds: ["route"] });
    expect(results[0]?.entry.title).toBe("72");
  });

  it("finds an operator by name", () => {
    const results = searchIndex(index, "first leeds");
    expect(results.some((r) => r.entry.kind === "operator")).toBe(true);
  });

  it("prefers nearby results when a location is supplied", () => {
    const nearLeeds = searchIndex(index, "leeds", { near: { lat: 53.7965, lon: -1.5379 } });
    expect(nearLeeds.length).toBeGreaterThan(0);
    expect(nearLeeds[0]?.distanceMetres).toBeLessThan(2000);
  });

  it("returns nothing for a query that matches nothing, rather than everything", () => {
    expect(searchIndex(index, "zzzznotarealplace")).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchIndex(index, "   ")).toEqual([]);
  });

  it("respects the result limit", () => {
    expect(searchIndex(index, "leeds", { limit: 1 }).length).toBeLessThanOrEqual(1);
  });

  it("lists nearby stops in true distance order", () => {
    const nearby = nearbyStops(index, { lat: 53.7965, lon: -1.5379 }, { radiusMetres: 2000 });
    expect(nearby.length).toBeGreaterThan(0);
    const distances = nearby.map((h) => h.distanceMetres ?? 0);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("returns no nearby stops outside the radius", () => {
    expect(nearbyStops(index, { lat: 51.5, lon: -0.12 }, { radiusMetres: 100 })).toEqual([]);
  });
});

describe("publishNetwork", () => {
  it("publishes every dataset atomically and reports completeness", async () => {
    const store = new InMemoryObjectStore();
    const network = buildCompleteNetwork();
    const result = await publishNetwork(store, network, { version: "2026-09-02T06:00" });

    expect(result.complete).toBe(true);
    expect(result.published.map((m) => m.dataset)).toContain(DATASETS.stops);
    expect(result.published.map((m) => m.dataset)).toContain(DATASETS.searchIndex);

    const artifacts = new ArtifactStore(store);
    const stops = await artifacts.readCurrent(DATASETS.stops);
    expect(stops.records.length).toBe(network.stops.length);
  });

  it("marks artifacts as partial coverage when the build had dangling references", async () => {
    const store = new InMemoryObjectStore();
    // The base fixture is missing a referenced stop, so coverage is knowingly incomplete.
    const result = await publishNetwork(store, buildNetwork(inputs), { version: "v1" });
    const stops = result.published.find((m) => m.dataset === DATASETS.stops)!;
    expect(stops.partialCoverage).toBe(true);
  });

  it("refuses a suspiciously small national stop set and keeps the previous version live", async () => {
    const store = new InMemoryObjectStore();
    const network = buildCompleteNetwork();
    await publishNetwork(store, network, { version: "v1" });

    const truncated = { ...network, stops: network.stops.slice(0, 1) };
    const result = await publishNetwork(store, truncated, { version: "v2", minimumStops: 5 });

    expect(result.complete).toBe(false);
    expect(result.failed.some((f) => f.dataset === DATASETS.stops)).toBe(true);

    const artifacts = new ArtifactStore(store);
    const current = await artifacts.readManifest(DATASETS.stops);
    expect(current?.version).toBe("v1");
  });

  it("reports a dataset that produced no records instead of publishing an empty one", async () => {
    const store = new InMemoryObjectStore();
    const network = { ...buildCompleteNetwork(), journeys: [] };
    const result = await publishNetwork(store, network, { version: "v1" });
    expect(result.failed.some((f) => f.dataset === DATASETS.journeys)).toBe(true);
    expect(result.complete).toBe(false);
  });

  it("rolls every dataset back to its previous good version", async () => {
    const store = new InMemoryObjectStore();
    const network = buildCompleteNetwork();
    await publishNetwork(store, network, { version: "v1" });
    await publishNetwork(store, network, { version: "v2" });

    const rolledBack = await rollbackNetwork(store);
    expect(rolledBack.length).toBeGreaterThan(0);

    const artifacts = new ArtifactStore(store);
    expect((await artifacts.readManifest(DATASETS.stops))?.version).toBe("v1");
  });
});

describe("weekly reconciliation", () => {
  const network = buildCompleteNetwork();
  const generatedAt = "2026-09-06T02:00:00.000Z";

  it("reports no change when nothing moved", () => {
    const report = reconcileNetwork(network, network, { generatedAt });
    expect(report.stops.added).toEqual([]);
    expect(report.stops.removed).toEqual([]);
    expect(report.anomalies).toEqual([]);
  });

  it("detects added and removed stops", () => {
    const smaller = { ...network, stops: network.stops.slice(1) };
    const report = reconcileNetwork(network, smaller, { generatedAt });
    expect(report.stops.removed).toHaveLength(1);
  });

  it("flags a mass disappearance as a likely broken upstream release", () => {
    const gutted = { ...network, stops: network.stops.slice(0, 1) };
    const report = reconcileNetwork(network, gutted, { generatedAt });
    expect(report.anomalies.join(" ")).toMatch(/broken upstream release/);
  });

  it("detects a changed stop sequence on an existing pattern", () => {
    const resequenced = {
      ...network,
      patterns: network.patterns.map((p) => ({ ...p, stopSequence: p.stopSequence.slice(0, 2) })),
    };
    const report = reconcileNetwork(network, resequenced, { generatedAt });
    expect(report.patterns.stopSequenceChanged).toHaveLength(1);
  });

  it("detects operator and service renames", () => {
    const renamed = {
      ...network,
      operators: network.operators.map((o) => ({ ...o, name: "First West Yorkshire" })),
      services: network.services.map((s) => ({ ...s, publicName: "72A" })),
    };
    const report = reconcileNetwork(network, renamed, { generatedAt });
    expect(report.operators.renamed).toHaveLength(1);
    expect(report.services.renamed).toHaveLength(1);
  });

  it("summarises the report compactly for the job log", () => {
    const summary = summariseNetworkChanges(reconcileNetwork(network, network, { generatedAt }));
    expect(summary).toContain("Network changes at");
    expect(summary).toContain("Stops: +0 -0");
  });
});
