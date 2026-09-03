import { describe, expect, it } from "vitest";
import {
  BoundingBoxSchema,
  CoordinateSchema,
  ENGLAND_BOUNDS,
  MAP_QUERY_LIMITS,
  MapQuerySchema,
  SOURCE_REGISTRY,
  SourceRegistryEntrySchema,
  StopSchema,
  attributionsFor,
  getSourceRegistryEntry,
} from "./index.js";

describe("coordinate and bbox validation", () => {
  it("rejects out-of-range coordinates", () => {
    expect(CoordinateSchema.safeParse({ lat: 91, lon: 0 }).success).toBe(false);
    expect(CoordinateSchema.safeParse({ lat: 51.5, lon: -0.12 }).success).toBe(true);
  });

  it("rejects an inverted bounding box", () => {
    expect(BoundingBoxSchema.safeParse({ west: 1, south: 0, east: -1, north: 1 }).success).toBe(
      false,
    );
  });

  it("covers England within the declared plausibility bounds", () => {
    // Berwick-upon-Tweed (north), Penzance (south-west), Lowestoft (east).
    const extremes = [
      { lat: 55.77, lon: -2.0 },
      { lat: 50.12, lon: -5.54 },
      { lat: 52.48, lon: 1.75 },
    ];
    for (const c of extremes) {
      expect(c.lat).toBeGreaterThanOrEqual(ENGLAND_BOUNDS.south);
      expect(c.lat).toBeLessThanOrEqual(ENGLAND_BOUNDS.north);
      expect(c.lon).toBeGreaterThanOrEqual(ENGLAND_BOUNDS.west);
      expect(c.lon).toBeLessThanOrEqual(ENGLAND_BOUNDS.east);
    }
  });
});

describe("map query limits", () => {
  it("rejects a zoom below the national floor so no national payload is requested", () => {
    const query = {
      bbox: { west: -6, south: 50, east: 2, north: 55 },
      zoom: MAP_QUERY_LIMITS.minZoom - 1,
      layers: ["stops"],
    };
    expect(MapQuerySchema.safeParse(query).success).toBe(false);
  });

  it("accepts a normal city viewport", () => {
    const parsed = MapQuerySchema.safeParse({
      bbox: { west: -1.56, south: 53.79, east: -1.5, north: 53.82 },
      zoom: 15,
      layers: ["stops", "vehicles"],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("source registry", () => {
  it("has a valid, complete entry for every required source", () => {
    const required = [
      "bods",
      "tfl",
      "naptan",
      "national_highways",
      "street_manager",
      "osm",
      "open_meteo",
      "environment_agency",
    ];
    for (const source of required) {
      const entry = getSourceRegistryEntry(source);
      expect(entry, `missing registry entry for ${source}`).toBeDefined();
      expect(SourceRegistryEntrySchema.safeParse(entry).success).toBe(true);
    }
  });

  it("never records a credential value, only an env var name", () => {
    for (const entry of SOURCE_REGISTRY) {
      if (entry.credentialEnvName !== null) {
        expect(entry.credentialEnvName).toMatch(/^[A-Z0-9_]+$/);
      }
    }
  });

  it("only claims live verification when a real response was inspected", () => {
    for (const entry of SOURCE_REGISTRY) {
      if (entry.contractVerification.method === "live_response") {
        expect(entry.contractVerification.at).not.toBeNull();
      }
    }
  });

  it("produces de-duplicated attribution strings", () => {
    const attributions = attributionsFor(["naptan", "nptg", "osm"]);
    expect(attributions).toContain("© OpenStreetMap contributors, ODbL");
    expect(new Set(attributions).size).toBe(attributions.length);
  });
});

describe("stop schema", () => {
  it("requires canonical NaPTAN identity", () => {
    const base = {
      id: "0f8fad5b-d9cb-469f-a165-70867728950e",
      provenance: { source: "naptan", retrievedAt: "2026-09-02T06:00:00.000Z", externalIds: [] },
      ingestedAt: "2026-09-02T06:00:05.000Z",
      qualityFlags: [],
      name: "Leeds City Bus Station",
      locationCoordinate: { lat: 53.7965, lon: -1.5379 },
      stopType: "bus_station_bay",
    };
    expect(StopSchema.safeParse(base).success).toBe(false);
    expect(StopSchema.safeParse({ ...base, atcoCode: "450012345" }).success).toBe(true);
  });
});
