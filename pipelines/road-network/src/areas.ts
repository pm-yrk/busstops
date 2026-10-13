import type { BoundingBox } from "@busstops/contracts";

/**
 * Where road segments are extracted, and why it is not everywhere.
 *
 * The rest of this platform is England-wide because its sources are national files that can be
 * downloaded once. OpenStreetMap's road network is not one of those: the public Overpass endpoint
 * is a shared volunteer service whose usage policy asks for modest, targeted queries, and asking
 * it for every road in England would be both a breach of that policy and a job no free runner
 * finishes. A national extract exists — Geofabrik's England PBF — and reading it needs a PBF
 * parser and several gigabytes of working memory, which is a different piece of work.
 *
 * So this is a stated, bounded coverage rather than a quiet one: the urban areas where bus
 * congestion is actually the question, each a box a single Overpass query can answer, and every
 * artifact published carries the list so Pro can say which parts of the country its figures cover
 * instead of implying all of it.
 *
 * Adding an area is adding a line here. The cost is one Overpass query per area per extraction,
 * and extraction is not on a fast schedule — the road network changes over months.
 */

export interface RoadArea {
  id: string;
  name: string;
  bbox: BoundingBox;
}

/** Roughly the built-up core of each, which is where a bus loses its time. */
export const ROAD_AREAS: readonly RoadArea[] = [
  {
    id: "leeds",
    name: "Leeds",
    bbox: { west: -1.62, south: 53.75, east: -1.46, north: 53.85 },
  },
  {
    id: "manchester",
    name: "Manchester",
    bbox: { west: -2.31, south: 53.44, east: -2.17, north: 53.52 },
  },
  {
    id: "birmingham",
    name: "Birmingham",
    bbox: { west: -1.96, south: 52.43, east: -1.83, north: 52.52 },
  },
  {
    id: "bristol",
    name: "Bristol",
    bbox: { west: -2.66, south: 51.42, east: -2.53, north: 51.5 },
  },
  {
    id: "york",
    name: "York",
    bbox: { west: -1.13, south: 53.93, east: -1.03, north: 53.99 },
  },
  {
    id: "london-central",
    name: "Central London",
    bbox: { west: -0.21, south: 51.46, east: -0.04, north: 51.55 },
  },
];

/** One line a Pro response can show, so the coverage is never left to be inferred. */
export function describeCoverage(areas: readonly RoadArea[] = ROAD_AREAS): string {
  return `Road-level figures cover ${areas.map((area) => area.name).join(", ")}. Elsewhere the road network has not been extracted, so no segment is reported rather than a segment being reported as clear.`;
}
