import { describe, expect, it } from "vitest";
import { searchIndex } from "@busstops/pipeline-static-network";
import type { PlaceRecord } from "./places.js";
import {
  MAX_GAZETTEER_RECORDS,
  PLACES_DATASET,
  placeAsSearchEntry,
  placesFromOverpass,
  placesQuery,
} from "./index.js";

/**
 * "York Minster" matched nothing, because a minster is not a bus stop.
 *
 * The answer to that is a gazetteer, not a special case for York Minster — and the thing a
 * gazetteer must not do is pretend a place is a stop. A place has no ATCO code and no next bus;
 * what it has is somewhere to plan a journey to, and the kind is what lets the UI offer that
 * rather than a departure board for a cathedral.
 */

function element(
  type: "node" | "way" | "relation",
  id: number,
  tags: Record<string, string>,
  at: { lat: number; lon: number } = { lat: 53.962, lon: -1.082 },
) {
  return type === "node"
    ? { type, id, lat: at.lat, lon: at.lon, tags }
    : { type, id, center: at, tags };
}

describe("the places gazetteer", () => {
  it("finds a cathedral, which is the search that failed", () => {
    const { places } = placesFromOverpass({
      elements: [
        element("way", 1, {
          name: "York Minster",
          building: "cathedral",
          amenity: "place_of_worship",
        }),
      ],
    });

    expect(places).toHaveLength(1);
    expect(places[0]!.name).toBe("York Minster");
    expect(places[0]!.kind).toBe("attraction");
    expect(places[0]!.coordinate).toEqual({ lat: 53.962, lon: -1.082 });
  });

  it("finds the other places issue #2 names", () => {
    const { places } = placesFromOverpass({
      elements: [
        element("node", 2, { name: "Leeds", railway: "station" }),
        element("way", 3, { name: "Manchester Arndale", shop: "mall" }),
        element("way", 4, { name: "Bullring", shop: "mall" }),
        element("relation", 5, { name: "Bristol Temple Meads", railway: "station" }),
      ],
    });
    expect(places.map((place) => place.kind)).toEqual([
      "rail_station",
      "shopping",
      "shopping",
      "rail_station",
    ]);
  });

  /*
   * A building is tagged several ways at once, and the first rule that matches decides what a
   * passenger is told it is. Transport first: somebody searching a station name is going there to
   * travel, not to look at the architecture.
   */
  it("calls a station a station even when it is also a listed landmark", () => {
    const { places } = placesFromOverpass({
      elements: [
        element("way", 6, {
          name: "Bristol Temple Meads",
          railway: "station",
          tourism: "attraction",
        }),
      ],
    });
    expect(places[0]!.kind).toBe("rail_station");
  });

  it("skips anything with no name, no position or no kind", () => {
    const result = placesFromOverpass({
      elements: [
        element("way", 7, { railway: "station" }),
        { type: "way" as const, id: 8, tags: { name: "Nowhere", railway: "station" } },
        element("node", 9, { name: "A corner shop", shop: "convenience" }),
      ],
    });
    expect(result.places).toEqual([]);
    expect(result.skipped).toBe(3);
  });

  it("refuses a payload it cannot read rather than publishing an empty gazetteer", () => {
    expect(placesFromOverpass({ nope: 1 })).toEqual({ places: [], skipped: 1 });
  });

  it("gives the same place the same identifier every time it is extracted", () => {
    const payload = { elements: [element("way", 10, { name: "Leeds", railway: "station" })] };
    expect(placesFromOverpass(payload).places[0]!.id).toBe(
      placesFromOverpass(payload).places[0]!.id,
    );
  });

  it("asks Overpass for one point per place, not an outline", () => {
    const query = placesQuery({ west: -1.13, south: 53.93, east: -1.03, north: 53.99 });
    expect(query).toContain("out center tags");
    expect(query).toContain('["building"="cathedral"]');
    expect(query).toContain('["railway"~"^(station|halt)$"]');
    // Every selector is name-scoped: an unnamed park is not something anyone searches for.
    for (const line of query.split("\n").filter((l) => l.trim().startsWith("nwr"))) {
      expect(line).toContain('nwr["name"]');
    }
  });
});

describe("a place in the search index", () => {
  const place = placesFromOverpass({
    elements: [
      element("way", 11, {
        name: "York Minster",
        building: "cathedral",
        "addr:city": "York",
      }),
    ],
  }).places[0]!;

  it("is ranked with everything else rather than stapled on afterwards", () => {
    const entry = placeAsSearchEntry(place);
    expect(entry.kind).toBe("place");
    expect(entry.tokens).toContain("york");
    expect(entry.tokens).toContain("minster");
    expect(entry.coordinate).toEqual(place.coordinate);
  });

  it("never claims live coverage, because a cathedral has no buses of its own", () => {
    expect(placeAsSearchEntry(place).hasLiveCoverage).toBe(false);
  });

  it("has no code to type, so a code search can never match one by accident", () => {
    expect(placeAsSearchEntry(place).codes).toEqual([]);
  });

  it("says where it is under the name when OSM states it", () => {
    expect(placeAsSearchEntry(place).subtitle).toBe("Landmark · York");
  });
});

describe("the gazetteer stays something the edge can hold", () => {
  it("names one object and a ceiling, because the edge reads it whole", () => {
    expect(PLACES_DATASET).toBe("places/gazetteer");
    // Same order as the 1,043 services the isolate already holds nationally. Outgrowing this
    // means sharding it, not raising it.
    expect(MAX_GAZETTEER_RECORDS).toBeLessThanOrEqual(50_000);
  });
});

describe("what people call a station, not what OSM files it under", () => {
  function place(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
    return {
      id: "00000000-0000-5000-8000-0000000000e1",
      name: "Leeds",
      kind: "rail_station",
      coordinate: { lat: 53.7955, lon: -1.5491 },
      subtitle: "Railway station",
      prominence: 9,
      osmId: "node/1",
      ...overrides,
    };
  }

  it("lets a rail station be found by the name people type", () => {
    const entry = placeAsSearchEntry(place());
    expect(entry.title).toBe("Leeds");
    expect(entry.codes).toContain("leeds station");
    expect(entry.codes).toContain("leeds railway station");
    expect(entry.tokens).toContain("station");
  });

  it("beats a differently-named bus station on the query that names neither", () => {
    const index = {
      builtAt: "2026-01-01T00:00:00.000Z",
      entries: [
        placeAsSearchEntry(place()),
        placeAsSearchEntry(
          place({
            id: "00000000-0000-5000-8000-0000000000e2",
            name: "Leeds City Bus & Coach Station",
            kind: "bus_station",
            subtitle: "Bus station",
          }),
        ),
      ],
    };
    const [top] = searchIndex(index, "Leeds Station", { limit: 3 });
    expect(top?.entry.title).toBe("Leeds");
  });

  it("adds nothing to a name that already says it, so it cannot collide with itself", () => {
    const meads = placeAsSearchEntry(
      place({ name: "Bristol Temple Meads Station", subtitle: "Railway station" }),
    );
    expect(meads.codes).toEqual([]);

    const coach = placeAsSearchEntry(
      place({ name: "Victoria Coach Station", kind: "bus_station", subtitle: "Bus station" }),
    );
    expect(coach.codes).toEqual([]);
  });

  it("leaves places that are not transport alone", () => {
    const minster = placeAsSearchEntry(
      place({ name: "York Minster", kind: "attraction", subtitle: "Landmark" }),
    );
    expect(minster.codes).toEqual([]);
    expect(minster.tokens).toEqual(["york", "minster"]);
  });
});
