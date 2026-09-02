import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { StopSchema } from "@busstops/contracts";
import { haversineMetres } from "@busstops/pipeline-core";
import { parseCsv, parseCsvLine } from "./csv.js";
import {
  isBusRelatedStopType,
  mapStopType,
  normalizeNaptanCsv,
  parseBearing,
  parseStatus,
  reconcileStops,
  resolveCoordinate,
  NaptanCsvRowSchema,
} from "./naptan.js";
import { deterministicUuid } from "./identity.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/documented/naptan-stops.csv",
);
const fixture = readFileSync(fixturePath, "utf8");
const options = { retrievedAt: "2026-09-02T06:00:00.000Z", sourceVersion: "2026-09-01" };

describe("CSV parsing", () => {
  it("handles quoted commas in stop names", () => {
    expect(parseCsvLine('a,"Boar Lane, The Bull",c')).toEqual(["a", "Boar Lane, The Bull", "c"]);
  });

  it("handles escaped quotes", () => {
    expect(parseCsvLine('a,"St John""s",c')).toEqual(["a", 'St John"s', "c"]);
  });

  it("keeps empty trailing fields", () => {
    expect(parseCsvLine("a,,")).toEqual(["a", "", ""]);
  });

  it("parses the fixture into header-keyed records", () => {
    const records = parseCsv(fixture);
    expect(records.length).toBe(9);
    expect(records[0]?.ATCOCode).toBe("450010001");
    expect(records[1]?.CommonName).toBe("Boar Lane, The Bull");
  });
});

describe("stop type mapping", () => {
  it("recognises bus, coach and tram boarding points", () => {
    expect(isBusRelatedStopType("BCT")).toBe(true);
    expect(isBusRelatedStopType("bcs")).toBe(true);
    expect(isBusRelatedStopType("TMU")).toBe(true);
  });

  it("excludes rail, air and ferry stop types", () => {
    expect(isBusRelatedStopType("RLY")).toBe(false);
    expect(isBusRelatedStopType("AIR")).toBe(false);
    expect(isBusRelatedStopType("FER")).toBe(false);
  });

  it("maps codes to the normalized stop type", () => {
    expect(mapStopType("BCT")).toBe("on_street_bus");
    expect(mapStopType("BCS")).toBe("bus_station_bay");
    expect(mapStopType("TMU")).toBe("tram_stop");
    expect(mapStopType("ZZZ")).toBe("other");
  });
});

describe("bearing parsing", () => {
  it("converts NaPTAN compass letters to degrees", () => {
    expect(parseBearing("N")).toBe(0);
    expect(parseBearing("NE")).toBe(45);
    expect(parseBearing("SW")).toBe(225);
    expect(parseBearing("nw")).toBe(315);
  });

  it("accepts a numeric bearing where a source provides one", () => {
    expect(parseBearing("135")).toBe(135);
  });

  it("returns undefined for missing or nonsense values rather than guessing north", () => {
    expect(parseBearing("")).toBeUndefined();
    expect(parseBearing("   ")).toBeUndefined();
    expect(parseBearing("sideways")).toBeUndefined();
    expect(parseBearing("400")).toBeUndefined();
  });
});

describe("status parsing", () => {
  it("maps NaPTAN status vocabulary", () => {
    expect(parseStatus("active")).toBe("active");
    expect(parseStatus("deleted")).toBe("deleted");
    expect(parseStatus("inactive")).toBe("deleted");
    expect(parseStatus("pending")).toBe("pending");
    expect(parseStatus("")).toBe("active");
  });
});

describe("coordinate resolution", () => {
  const base = NaptanCsvRowSchema.parse({
    ATCOCode: "450010001",
    CommonName: "Test",
    StopType: "BCT",
  });

  it("prefers the published WGS84 pair", () => {
    const coordinate = resolveCoordinate({ ...base, Latitude: "53.7965", Longitude: "-1.5379" })!;
    expect(coordinate.lat).toBeCloseTo(53.7965, 4);
  });

  it("falls back to the OSGB36 grid reference when WGS84 is blank", () => {
    const coordinate = resolveCoordinate({
      ...base,
      Latitude: "",
      Longitude: "",
      Easting: "471600",
      Northing: "173500",
    })!;
    // Reading: roughly 51.45 N, -0.97 E.
    expect(coordinate.lat).toBeCloseTo(51.45, 1);
    expect(coordinate.lon).toBeCloseTo(-0.97, 1);
  });

  it("rejects a zeroed coordinate with no usable grid reference", () => {
    expect(
      resolveCoordinate({ ...base, Latitude: "0", Longitude: "0", Easting: "0", Northing: "0" }),
    ).toBeNull();
  });

  it("rejects a coordinate outside England rather than plotting it", () => {
    expect(resolveCoordinate({ ...base, Latitude: "48.85", Longitude: "2.35" })).toBeNull();
  });
});

describe("normalizeNaptanCsv", () => {
  const result = normalizeNaptanCsv(fixture, options);

  it("keeps only bus, coach and tram stops", () => {
    const codes = result.stops.map((s) => s.atcoCode);
    expect(codes).toContain("450010001");
    expect(codes).toContain("940GZZLUASL");
    expect(codes).not.toContain("9100LEEDS"); // rail station
  });

  it("withdraws stops NaPTAN marks deleted instead of dropping them silently", () => {
    expect(result.withdrawnAtcoCodes).toContain("190020101");
    expect(result.stops.map((s) => s.atcoCode)).not.toContain("190020101");
  });

  it("quarantines a stop with no usable coordinate", () => {
    expect(result.rejected.map((r) => r.atcoCode)).toContain("450010099");
    expect(result.rejected.find((r) => r.atcoCode === "450010099")?.reason).toMatch(/coordinate/);
  });

  it("recovers a stop that only has a grid reference", () => {
    const gridOnly = result.stops.find((s) => s.atcoCode === "340000001");
    expect(gridOnly).toBeDefined();
    expect(gridOnly!.locationCoordinate.lat).toBeCloseTo(51.45, 1);
  });

  it("produces records that satisfy the Stop contract", () => {
    for (const stop of result.stops) {
      const parsed = StopSchema.safeParse(stop);
      expect(parsed.success, `${stop.atcoCode}: ${JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      );
    }
  });

  it("assigns stable internal identity derived from the ATCO code", () => {
    const leeds = result.stops.find((s) => s.atcoCode === "450010001")!;
    expect(leeds.id).toBe(deterministicUuid("stop", "450010001"));

    // Re-running the whole ingest must not renumber anything.
    const rerun = normalizeNaptanCsv(fixture, {
      ...options,
      retrievedAt: "2026-09-03T06:00:00.000Z",
    });
    expect(rerun.stops.find((s) => s.atcoCode === "450010001")!.id).toBe(leeds.id);
  });

  it("preserves provenance and external identifiers", () => {
    const leeds = result.stops.find((s) => s.atcoCode === "450010001")!;
    expect(leeds.provenance.source).toBe("naptan");
    expect(leeds.provenance.sourceVersion).toBe("2026-09-01");
    expect(leeds.provenance.externalIds).toContainEqual({ source: "naptan", id: "450010001" });
    expect(leeds.provenance.externalIds).toContainEqual({ source: "naptan_code", id: "32900001" });
  });

  it("carries indicator, bearing and locality through", () => {
    const leeds = result.stops.find((s) => s.atcoCode === "450010001")!;
    expect(leeds.indicator).toBe("Stand 1");
    expect(leeds.bearing).toBe(45);
    expect(leeds.localityId).toBe(deterministicUuid("locality", "E0035477"));
  });

  it("never invents accessibility or amenity data", () => {
    for (const stop of result.stops) {
      expect(stop.amenities).toEqual([]);
    }
  });

  it("collects locality codes for the NPTG join", () => {
    expect(result.localityCodes.has("E0035477")).toBe(true);
    expect(result.localityCodes.has("E0034004")).toBe(true);
  });

  it("covers London and non-London stops from the same national parse", () => {
    const codes = result.stops.map((s) => s.atcoCode);
    expect(codes.some((c) => c.startsWith("490"))).toBe(true); // London
    expect(codes.some((c) => c.startsWith("450"))).toBe(true); // West Yorkshire
    expect(codes.some((c) => c.startsWith("370"))).toBe(true); // South Yorkshire
  });

  it("handles an empty export without throwing", () => {
    const empty = normalizeNaptanCsv("ATCOCode,CommonName,StopType\n", options);
    expect(empty.stops).toEqual([]);
    expect(empty.rejected).toEqual([]);
  });

  it("handles a malformed export without throwing", () => {
    const malformed = normalizeNaptanCsv("this is not,a valid naptan file\n1,2\n", options);
    expect(malformed.stops).toEqual([]);
  });
});

describe("reconcileStops", () => {
  const base = normalizeNaptanCsv(fixture, options).stops;

  it("reports additions and removals", () => {
    const previous = base.slice(1);
    const result = reconcileStops(previous, base, 25, haversineMetres);
    expect(result.added.map((s) => s.atcoCode)).toEqual([base[0]!.atcoCode]);
    expect(result.removed).toEqual([]);

    const removedResult = reconcileStops(base, previous, 25, haversineMetres);
    expect(removedResult.removed.map((s) => s.atcoCode)).toEqual([base[0]!.atcoCode]);
  });

  it("detects a stop that moved beyond the tolerance", () => {
    const moved = base.map((stop, index) =>
      index === 0
        ? {
            ...stop,
            locationCoordinate: {
              lat: stop.locationCoordinate.lat + 0.002,
              lon: stop.locationCoordinate.lon,
            },
          }
        : stop,
    );
    const result = reconcileStops(base, moved, 25, haversineMetres);
    expect(result.moved).toHaveLength(1);
    expect(result.moved[0]?.movedMetres).toBeGreaterThan(200);
  });

  it("ignores sub-tolerance jitter so surveys do not churn the dataset", () => {
    const jittered = base.map((stop) => ({
      ...stop,
      locationCoordinate: {
        lat: stop.locationCoordinate.lat + 0.00005,
        lon: stop.locationCoordinate.lon,
      },
    }));
    const result = reconcileStops(base, jittered, 25, haversineMetres);
    expect(result.moved).toHaveLength(0);
    expect(result.unchanged).toBe(base.length);
  });

  it("detects renames", () => {
    const renamed = base.map((stop, index) =>
      index === 0 ? { ...stop, name: "Leeds City Bus Station (Renamed)" } : stop,
    );
    const result = reconcileStops(base, renamed, 25, haversineMetres);
    expect(result.renamed).toHaveLength(1);
  });
});
