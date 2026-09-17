import type { SearchIndexEntry } from "@busstops/pipeline-static-network";
import { tokenize } from "@busstops/pipeline-static-network";
import type { PlaceRecord } from "./places.js";

/**
 * Where the gazetteer is published, and why it is one object.
 *
 * Stops are sharded because there are 349,531 of them and the national object is 198 MiB against
 * a 128 MiB isolate. Places are not that: the landmarks people search for by name across these
 * areas number in the thousands, which is the same order as the 1,043 services the edge already
 * holds nationally. One object read once and cached is simpler than a second prefix-sharding
 * scheme, and a test holds it to a size that stays true.
 */
export const PLACES_DATASET = "places/gazetteer";

/**
 * The ceiling that keeps that decision honest.
 *
 * If the gazetteer ever outgrows this, the answer is to shard it the way the search index is
 * sharded — not to raise the number. The publish refuses rather than quietly putting a national
 * dataset back into the isolate one release at a time.
 */
export const MAX_GAZETTEER_RECORDS = 40_000;

/**
 * A place as the search ranker sees it.
 *
 * Converted rather than ranked separately, so a query is scored once against everything it could
 * mean and "Leeds" orders its station, its stops and its routes against each other instead of
 * three lists being stapled together.
 */
export function placeAsSearchEntry(place: PlaceRecord): SearchIndexEntry {
  return {
    kind: "place",
    id: place.id,
    title: place.name,
    subtitle: place.subtitle,
    coordinate: place.coordinate,
    tokens: tokenize(place.name),
    // A place has no code to type: nobody searches a cathedral by reference.
    codes: [],
    // Live coverage is a claim about buses. A place has none of its own, and saying `true` here
    // would put a live lozenge on a park.
    hasLiveCoverage: false,
    prominence: place.prominence,
  };
}
