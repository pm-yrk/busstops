import { describe, expect, it } from "vitest";
import { StopAccessibilitySchema } from "@busstops/contracts";
import {
  bestFact,
  gtfsAccessibilityStatus,
  gtfsStopAccessibilityFacts,
  gtfsTripAccessibilityFacts,
  mergeAccessibilityFacts,
  naptanAccessibilityFacts,
  osmAccessibilityFacts,
  osmAccessibilityStatus,
} from "./accessibility.js";

/**
 * The rule these exist to defend: a missing value is UNKNOWN, never NO.
 *
 * GTFS writes 0 for "no information" and OSM simply omits the tag, and reading either as "not
 * accessible" would put a confident, wrong "No" on tens of thousands of stops — telling a
 * wheelchair user there is no dropped kerb when the truth is that nobody has been to look.
 */

describe("reading a source's accessibility vocabulary", () => {
  it("treats GTFS 0 and absence as no information, not as no", () => {
    expect(gtfsAccessibilityStatus("1")).toBe("yes");
    expect(gtfsAccessibilityStatus("2")).toBe("no");
    expect(gtfsAccessibilityStatus("0")).toBe("unknown");
    expect(gtfsAccessibilityStatus(undefined)).toBe("unknown");
    expect(gtfsAccessibilityStatus("")).toBe("unknown");
  });

  it("keeps OSM's 'limited' as partial rather than rounding it either way", () => {
    expect(osmAccessibilityStatus("yes")).toBe("yes");
    expect(osmAccessibilityStatus("designated")).toBe("yes");
    expect(osmAccessibilityStatus("no")).toBe("no");
    expect(osmAccessibilityStatus("limited")).toBe("partial");
    expect(osmAccessibilityStatus(undefined)).toBe("unknown");
    expect(osmAccessibilityStatus("who knows")).toBe("unknown");
  });
});

describe("NaPTAN", () => {
  it("describes the kind of stop without turning it into a step-free claim", () => {
    const [fact] = naptanAccessibilityFacts({
      atcoCode: "450010001",
      stopType: "BCS",
      modificationDateTime: "2026-01-15T09:00:00",
    });

    expect(fact!.key).toBe("step_free");
    // A bay is built to a standard, but the register says nothing about the approach to it.
    expect(fact!.status).toBe("unknown");
    expect(fact!.detail).toContain("marked bay");
    expect(fact!.source).toBe("naptan");
    expect(fact!.sourceUpdatedAt).toBe("2026-01-15T09:00:00.000Z");
  });

  it("says nothing at all when the register has no stop type", () => {
    expect(naptanAccessibilityFacts({ atcoCode: "450010001" })).toEqual([]);
  });
});

describe("GTFS", () => {
  it("publishes a stop's wheelchair boarding as the operator stated it", () => {
    const [fact] = gtfsStopAccessibilityFacts({
      atcoCode: "450010001",
      wheelchairBoarding: "1",
      feedUpdatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(fact).toMatchObject({ key: "wheelchair_boarding", status: "yes", source: "gtfs_stop" });
  });

  it("says the feed carries no information rather than saying no", () => {
    const [fact] = gtfsStopAccessibilityFacts({ atcoCode: "450010001", wheelchairBoarding: "0" });
    expect(fact!.status).toBe("unknown");
    expect(fact!.provenance).toContain("carries no wheelchair boarding information");
  });

  it("keeps the vehicle's accessibility separate from the stop's", () => {
    const [fact] = gtfsTripAccessibilityFacts({ wheelchairAccessible: "1" });
    expect(fact!.key).toBe("wheelchair_accessible_service");
    expect(fact!.source).toBe("gtfs_trip");
  });
});

describe("OpenStreetMap", () => {
  it("produces no fact at all for a tag nobody has set", () => {
    const facts = osmAccessibilityFacts({ tags: {}, matchedBy: "naptan_ref" });
    expect(facts).toEqual([]);
  });

  it("reads the tags a surveyor did set", () => {
    const facts = osmAccessibilityFacts({
      tags: { shelter: "yes", bench: "no", lit: "yes", tactile_paving: "limited" },
      matchedBy: "naptan_ref",
      sourceUpdatedAt: "2026-08-01T00:00:00.000Z",
    });

    const byKey = Object.fromEntries(facts.map((fact) => [fact.key, fact.status]));
    expect(byKey).toEqual({
      shelter: "yes",
      seating: "no",
      lighting: "yes",
      tactile_paving: "partial",
    });
    expect(facts.every((fact) => fact.confidence === "high")).toBe(true);
  });

  it("lowers confidence when the node was matched by proximity rather than identity", () => {
    const facts = osmAccessibilityFacts({
      tags: { shelter: "yes" },
      matchedBy: "proximity",
      distanceMetres: 12.4,
    });
    expect(facts[0]!.confidence).toBe("medium");
    expect(facts[0]!.provenance).toContain("12 m away");
  });

  it("reports a kerb as both its presence and its height", () => {
    const facts = osmAccessibilityFacts({
      tags: { kerb: "raised", "kerb:height": "0.14" },
      matchedBy: "naptan_ref",
    });
    expect(facts.filter((fact) => fact.key === "raised_kerb")).toHaveLength(2);
    expect(facts.find((fact) => fact.key === "kerb")!.detail).toBe("raised");
    expect(facts.find((fact) => fact.sourceField === "kerb:height")!.detail).toBe("0.14");
  });

  it("reports a flush kerb as no raised kerb, which is a real observation", () => {
    const facts = osmAccessibilityFacts({ tags: { kerb: "flush" }, matchedBy: "naptan_ref" });
    expect(facts.find((fact) => fact.key === "kerb")!.status).toBe("no");
    expect(facts.some((fact) => fact.key === "raised_kerb")).toBe(false);
  });

  it("keeps a surface as the material it is, not as a verdict", () => {
    const paved = osmAccessibilityFacts({ tags: { surface: "asphalt" }, matchedBy: "naptan_ref" });
    const rough = osmAccessibilityFacts({ tags: { surface: "gravel" }, matchedBy: "naptan_ref" });
    expect(paved[0]).toMatchObject({ key: "surface", status: "yes", detail: "asphalt" });
    expect(rough[0]).toMatchObject({ key: "surface", status: "partial", detail: "gravel" });
  });

  it("does not flatten a departures board into a boolean", () => {
    const realtime = osmAccessibilityFacts({
      tags: { departures_board: "realtime" },
      matchedBy: "naptan_ref",
    });
    const timetable = osmAccessibilityFacts({
      tags: { departures_board: "timetable" },
      matchedBy: "naptan_ref",
    });
    expect(realtime[0]!.status).toBe("yes");
    expect(timetable[0]).toMatchObject({ status: "partial", detail: "timetable" });
  });
});

describe("merging what the sources said", () => {
  const naptan = naptanAccessibilityFacts({ atcoCode: "450010001", stopType: "BCT" });
  const gtfs = gtfsStopAccessibilityFacts({ atcoCode: "450010001", wheelchairBoarding: "0" });
  const osm = osmAccessibilityFacts({
    tags: { wheelchair: "yes", shelter: "yes" },
    matchedBy: "naptan_ref",
  });

  it("produces a valid published set", () => {
    const merged = mergeAccessibilityFacts("450010001", [
      { source: "naptan", facts: naptan },
      { source: "gtfs_stop", facts: gtfs },
      { source: "osm", facts: osm },
    ]);
    expect(StopAccessibilitySchema.safeParse(merged).success).toBe(true);
  });

  it("prefers a surveyor who looked over a register with no column for it", () => {
    const merged = mergeAccessibilityFacts("450010001", [
      { source: "gtfs_stop", facts: gtfs },
      { source: "osm", facts: osm },
    ]);
    // GTFS is the higher-priority source, but it said "unknown" and OSM said "yes".
    expect(bestFact(merged, "wheelchair_boarding")).toMatchObject({
      status: "yes",
      source: "osm",
    });
  });

  it("keeps the losing facts, because a disagreement is worth seeing", () => {
    const merged = mergeAccessibilityFacts("450010001", [
      { source: "gtfs_stop", facts: gtfs },
      { source: "osm", facts: osm },
    ]);
    expect(merged.facts.filter((fact) => fact.key === "wheelchair_boarding")).toHaveLength(2);
  });

  it("records a source that was asked and had nothing, apart from one never asked", () => {
    const merged = mergeAccessibilityFacts("450010001", [
      { source: "naptan", facts: naptan },
      { source: "osm", facts: [] },
    ]);
    expect(merged.sourcesConsulted).toEqual([
      { source: "naptan", outcome: "had_data" },
      { source: "osm", outcome: "no_record" },
    ]);
  });

  it("never turns an absence into a no, whatever the combination", () => {
    const merged = mergeAccessibilityFacts("450010001", [
      { source: "gtfs_stop", facts: gtfsStopAccessibilityFacts({ atcoCode: "x" }) },
      { source: "osm", facts: osmAccessibilityFacts({ tags: {}, matchedBy: "proximity" }) },
    ]);
    expect(merged.facts.some((fact) => fact.status === "no")).toBe(false);
  });
});
