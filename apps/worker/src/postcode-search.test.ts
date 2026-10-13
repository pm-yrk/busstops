import { describe, expect, it } from "vitest";
import { ArtifactStore, InMemoryObjectStore } from "@busstops/pipeline-core";
import { SHARDED } from "@busstops/pipeline-static-network";
import { postcodeBucketDataset } from "@busstops/pipeline-postcodes";
import { NetworkReader } from "./network-reader.js";
import { ReadLedger } from "./read-ledger.js";

/**
 * "LS1 4DY" matched nothing at all before this, because the search index holds stops, routes,
 * operators and landmarks and a postcode is none of them.
 *
 * These tests are about which object is opened and what comes back. The absent case is as
 * important as the present one: an outward code with no object, and a deployment with no index at
 * all, both have to answer nothing rather than fail — a search for a place name must not start
 * failing because postcodes exist.
 */
const LS1 = [
  { id: "LS1 4DY", coordinate: { lat: 53.79513, lon: -1.54666 } },
  { id: "LS1 4AP", coordinate: { lat: 53.7949, lon: -1.5461 } },
  { id: "LS1 5RD", coordinate: { lat: 53.7972, lon: -1.5485 } },
  { id: "LS1 6DT", coordinate: { lat: 53.7981, lon: -1.5452 } },
];
const M1 = [{ id: "M1 1AE", coordinate: { lat: 53.48347, lon: -2.23118 } }];

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

async function published(options: { postcodes: boolean }) {
  const recording = recordingStore();
  const artifacts = new ArtifactStore(recording.store);
  await artifacts.publish({
    dataset: SHARDED.index,
    version: "v1",
    records: [
      {
        version: "v1",
        publishedAt: "2026-10-13T00:00:00.000Z",
        partialCoverage: false,
        stopTiles: [],
        patternTiles: [],
        searchTiles: [],
        searchPrefixes: [],
      },
    ],
    schemaVersion: "1.0.0",
  });
  if (options.postcodes) {
    await artifacts.publish({
      dataset: postcodeBucketDataset("LS1"),
      version: "v1",
      records: LS1,
      schemaVersion: "1.0.0",
    });
    await artifacts.publish({
      dataset: postcodeBucketDataset("M1"),
      version: "v1",
      records: M1,
      schemaVersion: "1.0.0",
    });
  }
  return { reader: new NetworkReader(recording.store), reads: recording.reads };
}

describe("finding a postcode", () => {
  it("finds a whole postcode, with the position the source gave it", async () => {
    const { reader } = await published({ postcodes: true });
    const found = await reader.postcodeMatches("LS1 4DY");

    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("postcode");
    expect(found[0]!.title).toBe("LS1 4DY");
    expect(found[0]!.coordinate).toEqual({ lat: 53.79513, lon: -1.54666 });
  });

  it("accepts it written any of the ways people write it", async () => {
    const { reader } = await published({ postcodes: true });
    for (const typed of ["ls1 4dy", "LS14DY", "ls14dy", " LS1  4DY "]) {
      const found = await reader.postcodeMatches(typed);
      expect(
        found.map((entry) => entry.title),
        typed,
      ).toEqual(["LS1 4DY"]);
    }
  });

  it("opens one object, named by the outward code the query already carries", async () => {
    const { reader, reads } = await published({ postcodes: true });
    reads.length = 0;

    await reader.postcodeMatches("LS1 4DY");

    const opened = reads.filter((key) => key.includes("search/postcodes/"));
    expect(opened, "one postcode object, not two").toHaveLength(1);
    expect(opened[0]).toContain("search/postcodes/LS1");
    // And emphatically not the district next door.
    expect(reads.some((key) => key.includes("search/postcodes/M1"))).toBe(false);
  });

  /*
   * A half-typed postcode is the normal case: somebody types the district, then the sector, then
   * the unit. Each of those should narrow rather than return nothing.
   */
  it("narrows as it is typed, and puts the exact match first", async () => {
    const { reader } = await published({ postcodes: true });

    expect((await reader.postcodeMatches("LS1")).length).toBe(4);
    expect((await reader.postcodeMatches("LS1 4")).map((entry) => entry.title)).toEqual([
      "LS1 4AP",
      "LS1 4DY",
    ]);
    expect((await reader.postcodeMatches("LS1 5")).map((entry) => entry.title)).toEqual([
      "LS1 5RD",
    ]);

    // The exact one leads, even though it would sort second alphabetically.
    const exact = await reader.postcodeMatches("LS1 4DY", 5);
    expect(exact[0]!.title).toBe("LS1 4DY");
  });

  /*
   * `LS14` is district LS14 in Leeds *and* the first four characters of `LS1 4DY`, and nothing in
   * the text decides between them. A space does, so a space is trusted; without one, both readings
   * are tried, longer first.
   */
  it("resolves a prefix that could be two different districts", async () => {
    const { reader, reads } = await published({ postcodes: true });

    // With a space, the person has said which: LS1, sector 4.
    reads.length = 0;
    expect((await reader.postcodeMatches("LS1 4")).map((entry) => entry.title)).toEqual([
      "LS1 4AP",
      "LS1 4DY",
    ]);
    expect(reads.filter((key) => key.includes("search/postcodes/"))).toHaveLength(1);

    // Without one, LS14 is tried and has nothing, so LS1 answers.
    reads.length = 0;
    expect((await reader.postcodeMatches("LS14")).map((entry) => entry.title)).toEqual([
      "LS1 4AP",
      "LS1 4DY",
    ]);
    expect(
      reads.filter((key) => key.includes("search/postcodes/")).length,
      "the ambiguity costs one extra small read and only when it is ambiguous",
    ).toBeLessThanOrEqual(2);
  });

  it("holds to the limit it was given", async () => {
    const { reader } = await published({ postcodes: true });
    expect((await reader.postcodeMatches("LS1", 2)).length).toBe(2);
  });

  it("answers nothing for a district with no object, without looking elsewhere", async () => {
    const { reader, reads } = await published({ postcodes: true });
    reads.length = 0;

    expect(await reader.postcodeMatches("EH1 1YZ")).toEqual([]);
    expect(reads.some((key) => key.includes("search/postcodes/LS1"))).toBe(false);
  });

  it("answers nothing, and reads nothing, for something that is not a postcode", async () => {
    const { reader, reads } = await published({ postcodes: true });
    reads.length = 0;

    for (const typed of ["Leeds", "Bradford Interchange", "72", "L", ""]) {
      expect(await reader.postcodeMatches(typed), typed).toEqual([]);
    }
    expect(reads, "a place-name search must not cost a postcode read").toEqual([]);
  });

  it("answers nothing when the index has not been published", async () => {
    const { reader } = await published({ postcodes: false });
    expect(await reader.postcodeMatches("LS1 4DY")).toEqual([]);
  });

  it("records what it cost, so a deployed search can be read back", async () => {
    const { reader } = await published({ postcodes: true });
    const ledger = new ReadLedger(1000);

    await reader.postcodeMatches("LS1 4DY", 5, ledger);

    const note = ledger.toJSON().artifact as Record<string, unknown> | undefined;
    expect(note?.postcodeOutward).toBe("LS1");
    expect(note?.postcodeMatches).toBe(1);
    expect(Number(note?.postcodeChars)).toBeGreaterThan(0);
  });
});
