import { z } from "zod";
import type { Coordinate } from "@busstops/contracts";
import { deterministicUuid } from "@busstops/adapters";
import { isPlausibleEnglandCoordinate } from "@busstops/pipeline-core";

/**
 * Places a passenger would actually name, from OpenStreetMap.
 *
 * Search could find a stop, a route or an operator, and nothing else. "York Minster" matched
 * nothing, because a minster is not a bus stop — and the answer to that is not a special case for
 * York Minster, it is a gazetteer. OpenStreetMap is the source that has these: the stations, the
 * shopping centres, the hospitals, the universities, the parks and the cathedrals, each with a
 * name people use and a position.
 *
 * What this deliberately does not do is pretend a place is a stop. A place has no departures and
 * no ATCO code; what it has is somewhere to plan a journey to. The kind travels with the result
 * so the UI can offer the right action rather than sending someone to a departure board for a
 * cathedral.
 */

export const PLACE_KINDS = [
  "rail_station",
  "bus_station",
  "airport",
  "shopping",
  "attraction",
  "education",
  "hospital",
  "civic",
  "park",
] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

export interface PlaceRecord {
  id: string;
  name: string;
  kind: PlaceKind;
  coordinate: Coordinate;
  /** What to show under the name: the kind in words, and the area when OSM states one. */
  subtitle: string;
  /** Higher sorts first on an equal name match. A station outranks a corner shop. */
  prominence: number;
  osmId: string;
}

/**
 * `out center` gives a way or relation a single point, which is what a search result needs. The
 * adapter's element schema models raw geometry instead, so this is its own shape rather than a
 * widening of that one — a search index has no use for a cathedral's outline.
 */
const CenteredElementSchema = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string()).optional(),
});

export const PlacesResponseSchema = z.object({ elements: z.array(CenteredElementSchema) });

interface KindRule {
  kind: PlaceKind;
  label: string;
  prominence: number;
  matches: (tags: Record<string, string>) => boolean;
}

/**
 * Ordered, and the order is the answer.
 *
 * A building can be tagged several ways at once — Leeds Station is a railway station and a
 * transport interchange and a listed building — and the first rule that matches decides what a
 * passenger is told it is. Transport first, because someone searching a station name is almost
 * always going there to travel.
 */
const RULES: readonly KindRule[] = [
  {
    kind: "rail_station",
    label: "Railway station",
    prominence: 9,
    matches: (t) => t.railway === "station" || t.railway === "halt",
  },
  {
    kind: "bus_station",
    label: "Bus station",
    prominence: 9,
    matches: (t) => t.amenity === "bus_station",
  },
  {
    kind: "airport",
    label: "Airport",
    prominence: 9,
    matches: (t) => t.aeroway === "aerodrome" && t.iata !== undefined,
  },
  {
    kind: "shopping",
    label: "Shopping centre",
    prominence: 7,
    matches: (t) => t.shop === "mall" || t.shop === "department_store",
  },
  {
    kind: "attraction",
    label: "Landmark",
    prominence: 8,
    matches: (t) =>
      t.building === "cathedral" ||
      t.historic === "castle" ||
      t.historic === "cathedral" ||
      t.tourism === "attraction" ||
      t.tourism === "museum" ||
      t.tourism === "gallery",
  },
  {
    kind: "education",
    label: "University or college",
    prominence: 6,
    matches: (t) => t.amenity === "university" || t.amenity === "college",
  },
  {
    kind: "hospital",
    label: "Hospital",
    prominence: 8,
    matches: (t) => t.amenity === "hospital",
  },
  {
    kind: "civic",
    label: "Public building",
    prominence: 5,
    matches: (t) => t.amenity === "townhall" || t.amenity === "theatre" || t.amenity === "library",
  },
  { kind: "park", label: "Park", prominence: 4, matches: (t) => t.leisure === "park" },
];

/** The Overpass selectors the rules above need, as one query for a bounding box. */
export function placesQuery(bbox: {
  south: number;
  west: number;
  north: number;
  east: number;
}): string {
  const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const selectors = [
    '["railway"~"^(station|halt)$"]',
    '["amenity"="bus_station"]',
    '["aeroway"="aerodrome"]["iata"]',
    '["shop"~"^(mall|department_store)$"]',
    '["building"="cathedral"]',
    '["historic"~"^(castle|cathedral)$"]',
    '["tourism"~"^(attraction|museum|gallery)$"]',
    '["amenity"~"^(university|college|hospital|townhall|theatre|library)$"]',
    '["leisure"="park"]',
  ];
  const body = selectors.map((selector) => `  nwr["name"]${selector}(${box});`).join("\n");
  // `out center` rather than `out body`: a search result needs one point, not an outline.
  return `[out:json][timeout:120];\n(\n${body}\n);\nout center tags;`;
}

export interface ExtractPlacesResult {
  places: PlaceRecord[];
  /** Named things that matched no rule, or had no position to put them at. */
  skipped: number;
}

export function placesFromOverpass(payload: unknown): ExtractPlacesResult {
  const parsed = PlacesResponseSchema.safeParse(payload);
  if (!parsed.success) return { places: [], skipped: 1 };

  const places: PlaceRecord[] = [];
  let skipped = 0;

  for (const element of parsed.data.elements) {
    const tags = element.tags ?? {};
    const name = tags.name?.trim();
    if (!name) {
      skipped += 1;
      continue;
    }

    const point =
      element.center ??
      (element.lat !== undefined && element.lon !== undefined
        ? { lat: element.lat, lon: element.lon }
        : null);
    if (!point || !isPlausibleEnglandCoordinate(point)) {
      skipped += 1;
      continue;
    }

    const rule = RULES.find((candidate) => candidate.matches(tags));
    if (!rule) {
      skipped += 1;
      continue;
    }

    /*
     * Where it is, when OSM says. `addr:city` and `addr:suburb` are what disambiguate the four
     * "Victoria Park"s in a county, and without one the subtitle is just the kind.
     */
    const locality = tags["addr:suburb"] ?? tags["addr:city"] ?? tags["addr:town"];

    places.push({
      // From the OSM element, so re-extracting the same place keeps the same id and any link to
      // it keeps working.
      id: deterministicUuid("place", `osm-${element.type}:${element.id}`),
      name,
      kind: rule.kind,
      coordinate: point,
      subtitle: locality ? `${rule.label} · ${locality}` : rule.label,
      prominence: rule.prominence,
      osmId: `${element.type}/${element.id}`,
    });
  }

  return { places, skipped };
}
