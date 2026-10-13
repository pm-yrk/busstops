import { z } from "zod";
import type { Coordinate, RoadClass, RoadSegment } from "@busstops/contracts";
import { isPlausibleEnglandCoordinate } from "@busstops/pipeline-core";
import { deterministicUuid } from "./identity.js";

/**
 * OpenStreetMap adapter — road graph, walking network and speed-limit context (ODbL).
 *
 * Extraction runs on a schedule into cached artifacts; the public Overpass endpoint is never
 * called per user request, per the provider's usage policy and docs/05_DATA_SOURCES.md.
 */

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors, ODbL";
export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/**
 * Who is asking, which Overpass requires rather than prefers.
 *
 * Both extractions failed identically and instantly with `406` across all six areas — not a
 * malformed query, which would fail one at a time, but the request being refused before it was
 * read. Overpass's usage policy asks every consumer to identify itself, and its operators enforce
 * that on generic or absent user agents; Node sends `undici` by default. A contact URL is part of
 * what the policy asks for, so an operator with a problem can find the project rather than block
 * the traffic.
 */
export const OVERPASS_USER_AGENT =
  "BusStops/0.1 (England bus intelligence; +https://github.com/pm-yrk/busstops)";

export const OVERPASS_HEADERS: Record<string, string> = {
  "user-agent": OVERPASS_USER_AGENT,
  accept: "application/json",
};

export const OverpassElementSchema = z.union([
  z.object({
    type: z.literal("node"),
    id: z.number(),
    lat: z.number(),
    lon: z.number(),
    tags: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal("way"),
    id: z.number(),
    nodes: z.array(z.number()),
    tags: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal("relation"),
    id: z.number(),
    members: z.array(z.unknown()).optional(),
    tags: z.record(z.string()).optional(),
  }),
]);

export const OverpassResponseSchema = z.object({
  version: z.number().optional(),
  generator: z.string().optional(),
  elements: z.array(OverpassElementSchema),
});
export type OverpassResponse = z.infer<typeof OverpassResponseSchema>;

const HIGHWAY_TO_ROAD_CLASS: Record<string, RoadClass> = {
  motorway: "motorway",
  motorway_link: "motorway",
  trunk: "trunk",
  trunk_link: "trunk",
  primary: "primary",
  primary_link: "primary",
  secondary: "secondary",
  secondary_link: "secondary",
  tertiary: "local",
  tertiary_link: "local",
  unclassified: "local",
  residential: "local",
  living_street: "local",
  service: "other",
};

export function mapRoadClass(highwayTag: string): RoadClass {
  return HIGHWAY_TO_ROAD_CLASS[highwayTag] ?? "other";
}

/** Ways a bus can plausibly use. Footpaths and cycleways belong to the walking graph instead. */
export function isBusRoutableHighway(highwayTag: string): boolean {
  return highwayTag in HIGHWAY_TO_ROAD_CLASS && highwayTag !== "service";
}

export function isWalkableHighway(tags: Record<string, string>): boolean {
  const highway = tags.highway;
  if (!highway) return false;
  if (["motorway", "motorway_link", "trunk", "trunk_link"].includes(highway)) return false;
  if (tags.foot === "no" || tags.access === "private") return false;
  return (
    highway in HIGHWAY_TO_ROAD_CLASS ||
    ["footway", "path", "pedestrian", "steps", "track", "cycleway"].includes(highway)
  );
}

/**
 * Parses an OSM `maxspeed` tag. Returns mph, since UK speed limits are posted in mph, and null
 * when the tag is absent or unparseable — a guessed limit would create false speed anomalies.
 */
export function parseMaxSpeedMph(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();

  if (trimmed === "national") return null; // ambiguous without road class and vehicle type
  if (trimmed.startsWith("gb:")) {
    // e.g. "GB:nsl_single" (60), "GB:nsl_dual" (70), "GB:motorway" (70)
    if (trimmed.includes("nsl_single")) return 60;
    if (trimmed.includes("nsl_dual") || trimmed.includes("motorway")) return 70;
    return null;
  }

  const mphMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*mph$/);
  if (mphMatch) return Number(mphMatch[1]);

  const kmhMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*(?:km\/h|kph)?$/);
  if (kmhMatch) return Number(kmhMatch[1]) / 1.609344;

  return null;
}

export interface OsmNormalizeOptions {
  retrievedAt: string;
  /** Corridor grouping key builder; defaults to the road name or the way id. */
  corridorKey?: (tags: Record<string, string>, wayId: number) => string;
  pathLengthMetres: (path: readonly Coordinate[]) => number;
}

export interface OsmNormalizeResult {
  segments: RoadSegment[];
  /** Adjacency for the walking graph: node id -> connected node ids with distance. */
  walkingGraph: Map<number, Array<{ node: number; metres: number }>>;
  nodes: Map<number, Coordinate>;
  rejected: number;
}

export function normalizeOverpass(
  payload: unknown,
  options: OsmNormalizeOptions,
): OsmNormalizeResult {
  const parsed = OverpassResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return { segments: [], walkingGraph: new Map(), nodes: new Map(), rejected: 1 };
  }

  const nodes = new Map<number, Coordinate>();
  for (const element of parsed.data.elements) {
    if (element.type === "node") {
      const coordinate = { lat: element.lat, lon: element.lon };
      if (isPlausibleEnglandCoordinate(coordinate)) nodes.set(element.id, coordinate);
    }
  }

  const segments: RoadSegment[] = [];
  const walkingGraph = new Map<number, Array<{ node: number; metres: number }>>();
  let rejected = 0;

  const addWalkEdge = (from: number, to: number, metres: number) => {
    const existing = walkingGraph.get(from);
    if (existing) existing.push({ node: to, metres });
    else walkingGraph.set(from, [{ node: to, metres }]);
  };

  for (const element of parsed.data.elements) {
    if (element.type !== "way") continue;
    const tags = element.tags ?? {};
    const highway = tags.highway;
    if (!highway) continue;

    const path = element.nodes
      .map((id) => nodes.get(id))
      .filter((c): c is Coordinate => c !== undefined);

    if (path.length < 2) {
      rejected += 1;
      continue;
    }

    if (isWalkableHighway(tags)) {
      const oneway = tags.oneway === "yes" && highway === "cycleway";
      for (let i = 0; i < element.nodes.length - 1; i++) {
        const a = element.nodes[i]!;
        const b = element.nodes[i + 1]!;
        const from = nodes.get(a);
        const to = nodes.get(b);
        if (!from || !to) continue;
        const metres = options.pathLengthMetres([from, to]);
        addWalkEdge(a, b, metres);
        // Walking is bidirectional on everything except a few cycleway cases.
        if (!oneway) addWalkEdge(b, a, metres);
      }
    }

    if (!isBusRoutableHighway(highway)) continue;

    const lengthMetres = options.pathLengthMetres(path);
    if (lengthMetres <= 0) {
      rejected += 1;
      continue;
    }

    const speedLimitMph = parseMaxSpeedMph(tags.maxspeed);
    const corridorId =
      options.corridorKey?.(tags, element.id) ?? tags.ref ?? tags.name ?? `way-${element.id}`;

    segments.push({
      id: deterministicUuid("segment", `osm-way:${element.id}`),
      provenance: {
        source: "osm",
        retrievedAt: options.retrievedAt,
        externalIds: [{ source: "osm", id: `way/${element.id}` }],
      },
      ingestedAt: options.retrievedAt,
      qualityFlags: [],
      osmWayIds: [String(element.id)],
      shapeRef: `osm:way/${element.id}`,
      direction: tags.oneway === "yes" ? "forward" : "bidirectional",
      lengthMetres,
      roadClass: mapRoadClass(highway),
      ...(speedLimitMph === null ? {} : { speedLimitMph, speedLimitProvenance: "osm:maxspeed" }),
      corridorId,
    });
  }

  return { segments, walkingGraph, nodes, rejected };
}

/** Overpass QL for the road and walking network in a bounding box. Run on a schedule only. */
export function overpassQuery(bbox: {
  south: number;
  west: number;
  north: number;
  east: number;
}): string {
  const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `[out:json][timeout:180];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|footway|path|pedestrian|steps)$"](${box});
);
out body;
>;
out skel qt;`;
}
