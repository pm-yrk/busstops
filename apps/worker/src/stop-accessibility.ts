import type { AccessibilityFact, Stop, StopAccessibility } from "@busstops/contracts";
import { mergeAccessibilityFacts, naptanAccessibilityFacts } from "@busstops/adapters";

/**
 * What can honestly be said about one stop's accessibility right now.
 *
 * Two sources contribute today: NaPTAN, through the stop record the network publishes, and the
 * amenity list the ingest carries when a source stated one. The other two the model supports —
 * GTFS `wheelchair_boarding` and OpenStreetMap's survey tags — are named as not yet available on
 * this deployment rather than silently omitted, because "we have not wired that up" and "nobody
 * has recorded anything" are different sentences and the passenger is owed the right one.
 *
 * Nothing here defaults. A stop with no data produces a card that says so.
 */

/** The published amenity keys that are accessibility facts rather than comfort. */
const AMENITY_KEYS: Record<string, AccessibilityFact["key"]> = {
  shelter: "shelter",
  seating: "seating",
  step_free: "step_free",
  tactile_paving: "tactile_paving",
  real_time_display: "real_time_display",
  lighting: "lighting",
};

export function stopAccessibility(stop: Stop): StopAccessibility {
  const naptanFacts = naptanAccessibilityFacts({
    atcoCode: stop.atcoCode,
    stopType: stop.stopType,
  });

  /*
   * Amenities are only ever published when a source asserted them, so each one is a real fact
   * with a real provenance string. An amenity that is absent from the list produces nothing —
   * the list is what somebody recorded, not an inventory of everything that could be there.
   */
  const amenityFacts: AccessibilityFact[] = stop.amenities.flatMap((amenity) => {
    const key = AMENITY_KEYS[amenity.key];
    if (!key) return [];
    return [
      {
        key,
        status: amenity.value ? ("yes" as const) : ("no" as const),
        source: "naptan" as const,
        sourceField: `amenities.${amenity.key}`,
        sourceUpdatedAt: null,
        provenance: amenity.provenance,
        confidence: "high" as const,
      },
    ];
  });

  const merged = mergeAccessibilityFacts(stop.atcoCode, [
    { source: "naptan", facts: [...naptanFacts, ...amenityFacts] },
  ]);

  return {
    ...merged,
    sourcesConsulted: [
      ...merged.sourcesConsulted,
      // Named, not omitted: a reader can tell "nothing recorded" from "not wired up yet".
      { source: "gtfs_stop", outcome: "not_available" },
      { source: "osm", outcome: "not_available" },
    ],
  };
}
