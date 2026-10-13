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
/**
 * What people call a station, as opposed to what OpenStreetMap files it under.
 *
 * OSM names Leeds railway station "Leeds". A passenger searching "Leeds Station" therefore matched
 * one of its two words, scored 21.5, and lost to "Leeds City Bus & Coach Station" on 34 — which
 * contains both words and is a different building a quarter of a mile away. Nothing about the
 * ranking was wrong; the name simply is not the one anybody types.
 *
 * So the spoken forms are recorded as exact-match keys. They are added only where the name does
 * not already carry the word, so "Bristol Temple Meads" and "Victoria Coach Station" gain nothing
 * and cannot collide with themselves.
 */
const SPOKEN_SUFFIXES: Partial<Record<PlaceRecord["kind"], readonly string[]>> = {
  rail_station: ["station", "railway station"],
  bus_station: ["bus station"],
  airport: ["airport"],
};

function spokenNames(place: PlaceRecord): string[] {
  const suffixes = SPOKEN_SUFFIXES[place.kind];
  if (!suffixes) return [];
  const name = place.name.toLowerCase();
  return suffixes
    .filter((suffix) => !name.includes(suffix.split(" ").at(-1)!))
    .map((suffix) => `${name} ${suffix}`);
}

export function placeAsSearchEntry(place: PlaceRecord): SearchIndexEntry {
  const spoken = spokenNames(place);
  return {
    kind: "place",
    id: place.id,
    title: place.name,
    subtitle: place.subtitle,
    coordinate: place.coordinate,
    // The spoken words are matchable too, so a partial query still reaches the place.
    tokens: [...new Set([...tokenize(place.name), ...spoken.flatMap((name) => tokenize(name))])],
    /*
     * Nobody searches a cathedral by reference, so a place has no code in the ATCO sense. What it
     * can have is the name people actually say, and `codes` is exactly the exact-match channel
     * that belongs to: "leeds station" typed in full should win outright rather than by a point.
     */
    codes: spoken,
    // Live coverage is a claim about buses. A place has none of its own, and saying `true` here
    // would put a live lozenge on a park.
    hasLiveCoverage: false,
    prominence: place.prominence,
  };
}
