import { describe, expect, it } from "vitest";
import { ArtifactStore, InMemoryObjectStore, objectKeyFor } from "@busstops/pipeline-core";

import {
  SHARDED,
  STOP_SERVICES_PREFIX,
  STOP_SERVING_ROUTES_PREFIX,
  PATTERN_INDEX_PREFIX,
  stopServicesBucketFor,
  stopServicesDataset,
  stopServicesShardLines,
  stopServingRoutesBucketFor,
  stopServingRoutesDataset,
  stopServingRoutesShardLines,
  STOP_SERVICES_BUCKETS,
  STOP_SERVING_ROUTES_BUCKETS,
  type NetworkIndexRecord,
  type StopServingOperator,
  type StopServingRoutesRow,
} from "@busstops/pipeline-static-network";
import { NetworkReader } from "./network-reader.js";
import { ReadLedger } from "./read-ledger.js";

/**
 * "Which routes serve this stop?", answered by one object however big the stop is.
 *
 * Two shapes failed before this one and the reasons are different, which is why both are worth
 * stating. Asking the pattern tiles geographically costs bytes: `boxAround` is 1,500 metres
 * against an eighth-of-a-degree grid, so the read opens one pattern-index tile, and a dense one is
 * megabytes of text that has to be walked whether anything is parsed out of it or not — 2.03 MiB
 * measured on the deployment for a Manchester board. Asking `stop-services` for ids and resolving
 * them costs *subrequests*: every service id lives in its own hashed bucket, an interchange has
 * fifty routes, and the deployed probe took Leeds City Bus Station from four of four samples
 * answering to four of four answering 1102 — because an invocation gets fifty subrequests in
 * total, for its index, its departure shards, its operators, its live feed and everything else.
 *
 * So these tests are about which objects are opened and how many, not about how long anything
 * takes: a Node test runner cannot measure Cloudflare's CPU, and the object count is the part that
 * does not depend on this machine.
 */

const OPERATORS: StopServingOperator[] = [
  ["00000000-0000-5000-8000-0000000000a1", "First Leeds"],
  ["00000000-0000-5000-8000-0000000000a2", "Arriva Yorkshire"],
];

/** Forty-eight routes at one stop, which is an ordinary interchange and past every cap. */
const BUSY_STOP = "00000000-0000-5000-8000-00000000f001";
const QUIET_STOP = "00000000-0000-5000-8000-00000000f002";

function servingRow(stopId: string, count: number): StopServingRoutesRow {
  return {
    s: stopId,
    r: Array.from({ length: count }, (_, i) => ({
      id: `00000000-0000-5000-8000-${String(i).padStart(12, "0")}`,
      name: String(i + 1),
      /* Alternating, so an entry's operator identity has to come from its own index. */
      o: i % 2,
    })),
  };
}

function recordingStore() {
  const inner = new InMemoryObjectStore();
  const reads: string[] = [];
  return {
    reads,
    store: {
      async get(key: string) {
        reads.push(key);
        return inner.get(key);
      },
      put: inner.put.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
      listDetailed: inner.listDetailed?.bind(inner),
    },
  };
}

/**
 * An artifact carrying whichever of the two families the case under test needs.
 *
 * Deliberately not built by the publisher: what is being tested is a reader meeting an artifact
 * it did not write, including one written before the family it prefers existed, and a fixture that
 * could only produce today's shape could not express that.
 */
async function published(options: { enriched: boolean; ids: boolean }) {
  const recording = recordingStore();
  const artifacts = new ArtifactStore(recording.store);

  const index: NetworkIndexRecord = {
    version: "v1",
    publishedAt: "2026-10-22T00:00:00.000Z",
    partialCoverage: false,
    stopTiles: [],
    patternTiles: [],
    searchTiles: [],
    searchPrefixes: [],
    ...(options.ids
      ? {
          stopServicesBuckets: STOP_SERVICES_BUCKETS,
          stopServicesShards: [stopServicesBucketFor(BUSY_STOP), stopServicesBucketFor(QUIET_STOP)],
        }
      : {}),
    ...(options.enriched
      ? {
          stopServingRoutesBuckets: STOP_SERVING_ROUTES_BUCKETS,
          stopServingRoutesShards: [
            stopServingRoutesBucketFor(BUSY_STOP),
            stopServingRoutesBucketFor(QUIET_STOP),
          ],
        }
      : {}),
  } as unknown as NetworkIndexRecord;

  await artifacts.publish({
    dataset: SHARDED.index,
    version: "v1",
    records: [index],
    schemaVersion: "1.0.0",
  });

  const rows = [servingRow(BUSY_STOP, 48), servingRow(QUIET_STOP, 2)];
  for (const row of rows) {
    if (options.enriched) {
      const bucket = stopServingRoutesBucketFor(row.s);
      await recording.store.put(
        objectKeyFor(stopServingRoutesDataset(bucket), "v1"),
        stopServingRoutesShardLines([row], OPERATORS).join("\n"),
      );
    }
    if (options.ids) {
      const bucket = stopServicesBucketFor(row.s);
      await recording.store.put(
        objectKeyFor(stopServicesDataset(bucket), "v1"),
        stopServicesShardLines([{ s: row.s, v: row.r.map((entry) => entry.id) }]).join("\n"),
      );
    }
  }

  return { reader: new NetworkReader(recording.store), reads: recording.reads };
}

describe("a busy interchange's serving routes", () => {
  it("answers forty-eight routes from one object, with the right operator on each", async () => {
    const { reader, reads } = await published({ enriched: true, ids: true });
    reads.length = 0;

    const ledger = new ReadLedger(1_000);
    const serving = await reader.servingRoutesAtStop(BUSY_STOP, Date.now(), ledger);

    expect(serving, "the artifact declares the family, so this must not be null").not.toBeNull();
    expect(serving!.routes).toHaveLength(48);
    expect(serving!.complete).toBe(true);

    /* One object for the whole list. This is the assertion the design exists for. */
    const serving_reads = reads.filter((key) => key.includes(STOP_SERVING_ROUTES_PREFIX));
    expect(serving_reads).toHaveLength(1);

    /* And nothing else at all: no geographic scan, no per-service fan-out, no national object. */
    expect(reads.filter((key) => key.includes(PATTERN_INDEX_PREFIX))).toEqual([]);
    expect(reads.filter((key) => key.includes("network/services-bucket/"))).toEqual([]);
    expect(reads.filter((key) => key.includes("network/services/"))).toEqual([]);
    expect(reads.filter((key) => key.includes("network/operators/"))).toEqual([]);
    expect(reads.filter((key) => key.includes(STOP_SERVICES_PREFIX))).toEqual([]);

    /*
     * Identity, not just names. Several operators run a "1", so a board that collapsed routes by
     * their public name would link a passenger to somebody else's timetable. Each entry carries
     * its own canonical operator id, and the alternating fixture proves the index is read per
     * entry rather than once per row.
     */
    const first = serving!.routes.find((route) => route.publicName === "1")!;
    const second = serving!.routes.find((route) => route.publicName === "2")!;
    expect(first.operatorId).toBe(OPERATORS[0]![0]);
    expect(first.operatorName).toBe("First Leeds");
    expect(second.operatorId).toBe(OPERATORS[1]![0]);
    expect(second.operatorName).toBe("Arriva Yorkshire");
    for (const route of serving!.routes) {
      expect(route.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(route.operatorId).not.toBe("");
      expect(route.operatorName).not.toBe("Unknown operator");
    }
  });

  /*
   * The quiet stop is the defect the family was built for in the first place, and it must keep
   * working: a stop with nothing due used to read a whole pattern-index tile to discover that two
   * routes call there, because its own departures named no patterns to ask for by id.
   */
  it("answers a quiet stop from the same one object", async () => {
    const { reader, reads } = await published({ enriched: true, ids: true });
    reads.length = 0;

    const serving = await reader.servingRoutesAtStop(QUIET_STOP, Date.now(), new ReadLedger(1_000));

    expect(serving!.routes.map((route) => route.publicName)).toEqual(["1", "2"]);
    expect(serving!.complete).toBe(true);
    expect(reads.filter((key) => key.includes(STOP_SERVING_ROUTES_PREFIX))).toHaveLength(1);
    expect(reads.filter((key) => key.includes(PATTERN_INDEX_PREFIX))).toEqual([]);
  });

  it("says a stop nothing calls at has no routes, and that that is the whole truth", async () => {
    const { reader } = await published({ enriched: true, ids: true });

    /* A bucket the publish did not write: nothing hashed there, which is an answer about the stop. */
    const serving = await reader.servingRoutesAtStop(
      "00000000-0000-5000-8000-0000000000ff",
      Date.now(),
      new ReadLedger(1_000),
    );
    expect(serving).not.toBeNull();
    expect(serving!.routes).toEqual([]);
    expect(serving!.complete).toBe(true);
  });
});

/**
 * Deploy order, which is the failure this family's separate prefix exists to prevent.
 *
 * The Worker ships before the data does. A reader that knows the enriched family will meet
 * artifacts published before it existed for as long as it takes the next national build to run —
 * and the wrong behaviour there is not an error but a quietly empty route list, which reads as a
 * fact about the bus service rather than as a fact about our rollout.
 */
describe("a new reader meeting an older artifact", () => {
  it("declines the enriched path rather than reporting no routes", async () => {
    const { reader, reads } = await published({ enriched: false, ids: true });
    reads.length = 0;

    const serving = await reader.servingRoutesAtStop(BUSY_STOP, Date.now(), new ReadLedger(1_000));

    /*
     * Null, not an empty list. The caller has to be able to tell "this artifact cannot answer"
     * from "no routes serve this stop", because it falls back on the first and publishes the
     * second.
     */
    expect(serving).toBeNull();
    expect(reads.filter((key) => key.includes(STOP_SERVING_ROUTES_PREFIX))).toEqual([]);

    /* And the path it falls back to still answers, from the family that artifact does carry. */
    const ids = await reader.servicesCallingAtStop(BUSY_STOP, Date.now(), new ReadLedger(1_000));
    expect(ids.available).toBe(true);
    expect(ids.serviceIds).toHaveLength(48);
  });

  it("never reads an id-only row as though it were an enriched one", async () => {
    /*
     * The other direction of the same mistake. These are separate objects under separate
     * prefixes, so the enriched reader cannot be handed id-only rows at all — which is the
     * property being pinned. Were both formats one family keyed by a version flag, a reader that
     * ignored the flag would take each entry's string where it expected a triple and attribute
     * every route to "Unknown operator", or take an id-only array and find no routes.
     */
    const { reader } = await published({ enriched: false, ids: true });
    const bucket = stopServicesBucketFor(BUSY_STOP);
    expect(stopServicesDataset(bucket)).not.toBe(stopServingRoutesDataset(bucket));
    expect(await reader.servingRoutesAtStop(BUSY_STOP, Date.now())).toBeNull();
  });

  it("is also safe when the artifact has only the enriched family", async () => {
    /*
     * An older Worker meeting a newer artifact is the mirror case, and it is safe for the same
     * reason: it has never heard of this prefix and keeps reading what it knows. What has to hold
     * here is that publishing one family does not disturb the other, so the id index stays
     * answerable on its own.
     */
    const { reader } = await published({ enriched: true, ids: false });

    const serving = await reader.servingRoutesAtStop(BUSY_STOP, Date.now());
    expect(serving!.routes).toHaveLength(48);

    const ids = await reader.servicesCallingAtStop(BUSY_STOP, Date.now());
    expect(ids.available, "no id buckets are declared, so that path must decline").toBe(false);
  });
});
