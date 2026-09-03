import type {
  Coordinate,
  Operator,
  PublishedMetric,
  RoutePattern,
  ServiceRoute,
  Stop,
} from "@busstops/contracts";
import type { PatternGeometry } from "@busstops/matching";

/**
 * Read-only queries over whatever slice of the network a request has read.
 *
 * These are derivations of static data, not new analysis: the Worker composes what the pipelines
 * published, and heavy national computation stays in the batch.
 *
 * Every function here takes the records it needs rather than a national snapshot. That is the
 * point: a snapshot parameter is an invitation to load the country into an isolate, which is
 * measurably impossible — the national datasets are 292, 198 and 100 MiB against a 128 MiB
 * ceiling. Passing bounded inputs makes the bound visible at every call site.
 */

export interface RouteVariant {
  patternId: string;
  direction: RoutePattern["direction"];
  description: string;
  distanceMetres: number;
  stops: Array<{
    stopId: string;
    atcoCode: string;
    name: string;
    locality: string | null;
    sequence: number;
  }>;
}

/** Every pattern of a service, with its stop sequence resolved to names. */
export function routeVariants(
  patterns: readonly PatternGeometry[],
  stopsById: ReadonlyMap<string, Stop>,
): RouteVariant[] {
  return patterns
    .map((geometry) => {
      const pattern = geometry.pattern;
      const stops = pattern.stopSequence
        .map((stopId, index) => {
          const stop = stopsById.get(stopId);
          if (!stop) return null;
          return {
            stopId,
            atcoCode: stop.atcoCode,
            name: stop.name,
            // NaPTAN gives each stop an NPTG locality *code*, and the pipeline publishes that,
            // but not the gazetteer of names it points into. A code is not something to show a
            // passenger, so the field stays null until those names are published.
            locality: null as string | null,
            sequence: index,
          };
        })
        .filter((entry): entry is RouteVariant["stops"][number] => entry !== null);

      const first = stops[0];
      const last = stops[stops.length - 1];

      return {
        patternId: pattern.id,
        direction: pattern.direction,
        description:
          first && last && first.stopId !== last.stopId
            ? `${first.name} to ${last.name}`
            : (first?.name ?? "Circular"),
        distanceMetres: pattern.distanceMetres,
        stops,
      };
    })
    .sort((a, b) => a.direction.localeCompare(b.direction) || b.stops.length - a.stops.length);
}

/** Services that call at a stop, derived from the patterns read around it. */
export function routesServingStop(
  patterns: readonly PatternGeometry[],
  stopId: string,
  services: ReadonlyMap<string, ServiceRoute>,
  operators: ReadonlyMap<string, Operator>,
): Array<{ id: string; publicName: string; operatorName: string }> {
  const serviceIds = new Set<string>();
  for (const geometry of patterns) {
    if (geometry.pattern.stopSequence.includes(stopId)) {
      serviceIds.add(geometry.pattern.serviceRouteId);
    }
  }

  return [...serviceIds]
    .map((serviceId) => {
      const service = services.get(serviceId);
      if (!service) return null;
      const operator = operators.get(service.operatorId);
      return {
        id: service.id,
        publicName: service.publicName,
        operatorName: operator?.name ?? "Unknown operator",
      };
    })
    .filter(
      (entry): entry is { id: string; publicName: string; operatorName: string } => entry !== null,
    )
    .sort((a, b) => compareRouteNames(a.publicName, b.publicName));
}

export function routesForOperator(
  services: ReadonlyMap<string, ServiceRoute>,
  operatorId: string,
): Array<{ id: string; publicName: string; description: string | null }> {
  return [...services.values()]
    .filter((service) => service.operatorId === operatorId)
    .map((service) => ({
      id: service.id,
      publicName: service.publicName,
      description: service.description ?? null,
    }))
    .sort((a, b) => compareRouteNames(a.publicName, b.publicName));
}

/** "38", "X1", "138" sort the way a passenger expects, not the way a string sort does. */
export function compareRouteNames(a: string, b: string): number {
  const numericA = Number(a.replace(/\D/g, ""));
  const numericB = Number(b.replace(/\D/g, ""));
  if (Number.isFinite(numericA) && Number.isFinite(numericB) && numericA !== numericB) {
    return numericA - numericB;
  }
  return a.localeCompare(b);
}

/**
 * A headway description, only where the timetable actually supports one.
 *
 * A route with three journeys a day has no meaningful "every N minutes", and printing one would
 * be worse than printing nothing — so this returns null rather than a number nobody should act on.
 */
export function describeHeadway(departureTimes: readonly string[]): string | null {
  if (departureTimes.length < 4) return null;

  const sorted = [...departureTimes].sort();
  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = (Date.parse(sorted[index]!) - Date.parse(sorted[index - 1]!)) / 60_000;
    if (Number.isFinite(gap) && gap > 0 && gap < 240) gaps.push(gap);
  }
  if (gaps.length < 3) return null;

  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  const spread = gaps[gaps.length - 1]! - gaps[0]!;

  // An irregular timetable is described as a count, not as a frequency it does not have.
  if (spread > median) {
    return `${departureTimes.length} journeys today, at irregular intervals`;
  }
  return `About every ${Math.round(median)} minutes`;
}

/**
 * Builds a published metric. Suppression is decided here, once, so no caller can accidentally
 * render a headline figure computed from a handful of observations.
 */
export function publishedMetric(input: {
  label: string;
  value: number | null;
  unit: PublishedMetric["unit"];
  denominator: number;
  minimumDenominator: number;
  confidence?: PublishedMetric["confidence"];
  note?: string;
}): PublishedMetric {
  const suppressed = input.value === null || input.denominator < input.minimumDenominator;
  return {
    label: input.label,
    value: suppressed ? null : input.value,
    unit: input.unit,
    denominator: input.denominator,
    suppressed,
    note: suppressed
      ? (input.note ??
        `Based on ${input.denominator} observations; ${input.minimumDenominator} are needed before a figure is published.`)
      : (input.note ?? null),
    confidence: input.confidence ?? null,
  };
}

/** Search entries limited to one kind, used by the area and operator pages. */
export function boundingBoxOf(coordinates: readonly Coordinate[]): {
  west: number;
  south: number;
  east: number;
  north: number;
} | null {
  if (coordinates.length === 0) return null;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const coordinate of coordinates) {
    west = Math.min(west, coordinate.lon);
    east = Math.max(east, coordinate.lon);
    south = Math.min(south, coordinate.lat);
    north = Math.max(north, coordinate.lat);
  }
  return { west, south, east, north };
}
