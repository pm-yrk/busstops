import type {
  AccessibilityFact,
  AccessibilitySource,
  AccessibilityStatus,
  StopAccessibility,
} from "@busstops/contracts";
import { SOURCE_PRIORITY } from "@busstops/contracts";

/**
 * Turning what sources publish into accessibility facts, without inventing any.
 *
 * Every function here follows the same rule: an absent value produces no fact at all, or a fact
 * with status `unknown` where saying "the register has no value for this" is itself useful. None
 * of them ever produces `no` from an absence.
 *
 * The temptation this is written against is real and specific: GTFS `wheelchair_boarding` is `0`
 * for the overwhelming majority of stops, and `0` means "no accessibility information". Reading
 * it as "not accessible" would put a confident, wrong "No" on tens of thousands of stops.
 */

/** GTFS accessibility enums. 1 is yes, 2 is no, and 0 or absent is *no information*. */
export function gtfsAccessibilityStatus(value: string | undefined): AccessibilityStatus {
  if (value === "1") return "yes";
  if (value === "2") return "no";
  return "unknown";
}

/** OSM's yes/no/limited vocabulary, which does distinguish "partial". */
export function osmAccessibilityStatus(value: string | undefined): AccessibilityStatus {
  if (value === undefined) return "unknown";
  const normalised = value.trim().toLowerCase();
  if (normalised === "yes" || normalised === "designated") return "yes";
  if (normalised === "no") return "no";
  if (normalised === "limited" || normalised === "partial") return "partial";
  return "unknown";
}

export interface NaptanAccessibilityInput {
  atcoCode: string;
  /** NaPTAN's own columns, as published. Blank means the register has no value. */
  busStopType?: string;
  stopType?: string;
  modificationDateTime?: string;
}

/**
 * What NaPTAN can actually tell us.
 *
 * Less than people expect. The national CSV export carries stop identity, position, bearing and
 * type; it does not carry a kerb height or a tactile paving flag. What it does say is whether the
 * stop is a marked bay in a bus station or a pole on a pavement, which bears on step-free access
 * — and that inference is exactly the kind this model is built to refuse. So the register
 * contributes what it states and nothing else, and the gaps are published as gaps.
 */
export function naptanAccessibilityFacts(input: NaptanAccessibilityInput): AccessibilityFact[] {
  const facts: AccessibilityFact[] = [];
  const updatedAt = input.modificationDateTime ? new Date(input.modificationDateTime) : null;
  const sourceUpdatedAt =
    updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.toISOString() : null;

  /*
   * A marked bay in a bus station (BCS/BCQ/BCE/BST) is a boarding point built to a standard; a
   * pole on a pavement (BCT) is not. That is a real difference and it is what NaPTAN states, so
   * it is published as the stop's *type*, described plainly — not translated into a step-free
   * claim NaPTAN never made.
   */
  const stopType = input.stopType?.toUpperCase();
  if (stopType && stopType.length > 0) {
    const isBay = ["BCS", "BCQ", "BCE", "BST"].includes(stopType);
    facts.push({
      key: "step_free",
      // Even a bay only tells us the boarding point is built; it does not tell us the approach to
      // it is step-free, so the register can never take this above "unknown".
      status: "unknown",
      detail: isBay
        ? "A marked bay in a bus station or interchange"
        : "An on-street stop, usually a pole or shelter on the pavement",
      source: "naptan",
      sourceField: "StopType",
      sourceUpdatedAt,
      provenance:
        "NaPTAN records the kind of boarding point, not whether the approach to it is step-free.",
      confidence: "high",
    });
  }

  return facts;
}

export interface GtfsStopAccessibilityInput {
  atcoCode: string;
  wheelchairBoarding?: string;
  feedUpdatedAt?: string | null;
}

export function gtfsStopAccessibilityFacts(input: GtfsStopAccessibilityInput): AccessibilityFact[] {
  const status = gtfsAccessibilityStatus(input.wheelchairBoarding);
  return [
    {
      key: "wheelchair_boarding",
      status,
      source: "gtfs_stop",
      sourceField: "stops.wheelchair_boarding",
      sourceUpdatedAt: input.feedUpdatedAt ?? null,
      provenance:
        status === "unknown"
          ? "The operator's timetable feed carries no wheelchair boarding information for this stop."
          : "Published by the operator in its timetable feed.",
      confidence: "high",
    },
  ];
}

export interface GtfsTripAccessibilityInput {
  wheelchairAccessible?: string;
  feedUpdatedAt?: string | null;
}

/** About the bus, not the stop. Kept separate for exactly that reason. */
export function gtfsTripAccessibilityFacts(input: GtfsTripAccessibilityInput): AccessibilityFact[] {
  const status = gtfsAccessibilityStatus(input.wheelchairAccessible);
  return [
    {
      key: "wheelchair_accessible_service",
      status,
      source: "gtfs_trip",
      sourceField: "trips.wheelchair_accessible",
      sourceUpdatedAt: input.feedUpdatedAt ?? null,
      provenance:
        status === "unknown"
          ? "The operator's timetable feed does not say whether this journey is run by an accessible vehicle."
          : "Published by the operator for this journey.",
      confidence: "high",
    },
  ];
}

/** The OSM tags that describe a bus stop's physical accessibility. */
export interface OsmStopTags {
  wheelchair?: string;
  tactile_paving?: string;
  kerb?: string;
  "kerb:height"?: string;
  surface?: string;
  shelter?: string;
  covered?: string;
  bench?: string;
  lit?: string;
  departures_board?: string;
  passenger_information_display?: string;
  [key: string]: string | undefined;
}

export interface OsmAccessibilityInput {
  tags: OsmStopTags;
  /** How the OSM node was tied to this stop, which decides the confidence. */
  matchedBy: "naptan_ref" | "proximity";
  distanceMetres?: number;
  sourceUpdatedAt?: string | null;
}

/**
 * OSM's tags, read one at a time.
 *
 * An untagged node produces nothing. This is the source most likely to be read as "no": a bus
 * stop with no `shelter` tag is overwhelmingly a stop nobody has surveyed, not a stop with no
 * shelter — so an absent tag yields no fact rather than a negative one.
 */
export function osmAccessibilityFacts(input: OsmAccessibilityInput): AccessibilityFact[] {
  const facts: AccessibilityFact[] = [];
  const confidence = input.matchedBy === "naptan_ref" ? "high" : "medium";
  const provenance =
    input.matchedBy === "naptan_ref"
      ? "From OpenStreetMap, on a node carrying this stop's NaPTAN reference."
      : `From OpenStreetMap, on the nearest mapped stop${
          input.distanceMetres === undefined ? "" : ` (${Math.round(input.distanceMetres)} m away)`
        }.`;

  const add = (
    key: AccessibilityFact["key"],
    tag: string,
    status: AccessibilityStatus,
    detail?: string,
  ): void => {
    if (status === "unknown" && detail === undefined) return;
    facts.push({
      key,
      status,
      ...(detail === undefined ? {} : { detail }),
      source: "osm",
      sourceField: tag,
      sourceUpdatedAt: input.sourceUpdatedAt ?? null,
      provenance,
      confidence,
    });
  };

  const tags = input.tags;
  add("wheelchair_boarding", "wheelchair", osmAccessibilityStatus(tags.wheelchair));
  add("tactile_paving", "tactile_paving", osmAccessibilityStatus(tags.tactile_paving));
  add("shelter", "shelter", osmAccessibilityStatus(tags.shelter));
  add("covered", "covered", osmAccessibilityStatus(tags.covered));
  add("seating", "bench", osmAccessibilityStatus(tags.bench));
  add("lighting", "lit", osmAccessibilityStatus(tags.lit));
  add(
    "real_time_display",
    "departures_board",
    // OSM writes a *kind* here — "realtime", "timetable", "yes" — not a plain boolean.
    tags.departures_board === undefined
      ? "unknown"
      : tags.departures_board === "realtime"
        ? "yes"
        : tags.departures_board === "no"
          ? "no"
          : "partial",
    tags.departures_board,
  );

  /*
   * The kerb is two facts, because OSM records two things: whether there is a raised kerb at all,
   * and how high it is. A passenger who needs a ramp cares about the second.
   */
  if (tags.kerb !== undefined) {
    const raised = tags.kerb === "raised" || tags.kerb === "rolled";
    add("kerb", "kerb", raised ? "yes" : tags.kerb === "flush" ? "no" : "unknown", tags.kerb);
    if (raised) add("raised_kerb", "kerb", "yes", tags.kerb);
  }
  if (tags["kerb:height"] !== undefined) {
    add("raised_kerb", "kerb:height", "yes", tags["kerb:height"]);
  }
  if (tags.surface !== undefined) {
    // A surface is a material, not a yes or a no. It is reported as what it is.
    const smooth = ["asphalt", "concrete", "paving_stones", "paved"].includes(tags.surface);
    add("surface", "surface", smooth ? "yes" : "partial", tags.surface);
  }

  return facts;
}

/**
 * Merges facts from several sources into one published set.
 *
 * Within a key the highest-priority source wins, except that a definite answer from a lower
 * priority beats an `unknown` from a higher one — a mapper who went and looked is more use than a
 * register that has no column for it. Every fact that loses is still kept in the list, because a
 * disagreement between sources is information a reader deserves to see.
 */
export function mergeAccessibilityFacts(
  atcoCode: string,
  contributions: ReadonlyArray<{
    source: AccessibilitySource;
    facts: readonly AccessibilityFact[];
  }>,
): StopAccessibility {
  const all = contributions.flatMap((contribution) => contribution.facts);

  const rank = (fact: AccessibilityFact): number => {
    const sourceRank = SOURCE_PRIORITY.indexOf(fact.source);
    // A definite answer sorts ahead of an unknown regardless of where it came from.
    const known = fact.status === "unknown" ? 1 : 0;
    return known * 100 + (sourceRank === -1 ? SOURCE_PRIORITY.length : sourceRank);
  };

  const sorted = [...all].sort((a, b) => rank(a) - rank(b));

  return {
    atcoCode,
    facts: sorted,
    sourcesConsulted: contributions.map((contribution) => ({
      source: contribution.source,
      outcome: contribution.facts.length > 0 ? ("had_data" as const) : ("no_record" as const),
    })),
  };
}

/** The best answer for one key, or undefined when no source said anything about it. */
export function bestFact(
  accessibility: StopAccessibility,
  key: AccessibilityFact["key"],
): AccessibilityFact | undefined {
  return accessibility.facts.find((fact) => fact.key === key);
}
