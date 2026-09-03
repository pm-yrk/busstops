import type {
  Coordinate,
  Operator,
  RoutePattern,
  ScheduledJourney,
  ServiceRoute,
  Stop,
  StopTime,
} from "@busstops/contracts";
import {
  deterministicUuid,
  buildPatternShape,
  buildPatternStops,
  expandJourneysForDate,
  normalizeNaptanCsv,
  parseTransXChange,
  type TransXChangeDocument,
} from "@busstops/adapters";
import { pathLengthMetres, resolveScheduledInstant, simplifyPath } from "@busstops/pipeline-core";

/**
 * Assembles the normalized national network from source documents.
 *
 * Stop identity is NaPTAN's: timetables reference ATCO codes, so a journey whose stops are not
 * in the stop set is reported rather than published with dangling references. That check is
 * what keeps the England-wide graph internally consistent when one source updates before
 * another.
 */

export interface BuildInputs {
  naptanCsv: string;
  /** One TransXChange document per registered service; BODS publishes many small files. */
  transXChangeDocuments: string[];
  retrievedAt: string;
  serviceDate: string;
  isBankHoliday?: boolean;
  sourceVersion?: string;
}

export interface BuildCounts {
  stops: number;
  operators: number;
  services: number;
  patterns: number;
  journeys: number;
  stopsRejected: number;
  stopsWithdrawn: number;
  journeysSkipped: number;
  danglingStopReferences: number;
  parseErrors: number;
}

export interface BuiltNetwork {
  stops: Stop[];
  operators: Operator[];
  services: ServiceRoute[];
  patterns: RoutePattern[];
  journeys: ScheduledJourney[];
  /** Encoded shapes keyed by shapeRef, published as a separate artifact. */
  shapes: Map<string, Array<{ lat: number; lon: number }>>;
  counts: BuildCounts;
  warnings: string[];
}

/**
 * How much of a route's geometry is worth publishing.
 *
 * TransXChange track points follow the road at every vertex the surveyor recorded, which is far
 * more detail than a route line drawn on a map can show. Ten metres is narrower than the line's
 * own width at the closest zoom the app offers, and five decimal places is a little over a metre,
 * which is about the precision a bus route is actually known to. Together they take roughly three
 * quarters off published geometry, and that is the difference between a tile the edge can read
 * and one it cannot.
 *
 * `distanceMetres` is measured from the simplified path, so it is very slightly shorter than the
 * surveyed one. The error is a fraction of a percent over a route, well inside what the product
 * claims when it reports a distance at all.
 */
const SHAPE_TOLERANCE_METRES = 10;
const SHAPE_COORDINATE_DECIMALS = 5;

function publishableShape(points: readonly Coordinate[]): Coordinate[] {
  const factor = 10 ** SHAPE_COORDINATE_DECIMALS;
  const rounded: Coordinate[] = [];
  for (const point of simplifyPath(points, SHAPE_TOLERANCE_METRES)) {
    const next = {
      lat: Math.round(point.lat * factor) / factor,
      lon: Math.round(point.lon * factor) / factor,
    };
    // Rounding can merge neighbours that were a few centimetres apart; a repeated vertex is a
    // zero-length segment, which every consumer would then have to guard against.
    const previous = rounded[rounded.length - 1];
    if (previous && previous.lat === next.lat && previous.lon === next.lon) continue;
    rounded.push(next);
  }
  return rounded;
}

function coverageAreaForAtco(atcoCode: string): "london" | "non_london" {
  // London ATCO codes begin 490 (buses) or 940 (Underground/DLR interchanges).
  return atcoCode.startsWith("490") || atcoCode.startsWith("940") ? "london" : "non_london";
}

export function buildNetwork(inputs: BuildInputs): BuiltNetwork {
  const warnings: string[] = [];

  const naptan = normalizeNaptanCsv(inputs.naptanCsv, {
    retrievedAt: inputs.retrievedAt,
    ...(inputs.sourceVersion === undefined ? {} : { sourceVersion: inputs.sourceVersion }),
  });
  const stopsByAtco = new Map(naptan.stops.map((stop) => [stop.atcoCode, stop]));

  const operators = new Map<string, Operator>();
  const services: ServiceRoute[] = [];
  const patterns: RoutePattern[] = [];
  const journeys: ScheduledJourney[] = [];
  const shapes = new Map<string, Array<{ lat: number; lon: number }>>();

  let parseErrors = 0;
  let journeysSkipped = 0;
  let danglingStopReferences = 0;

  for (const xml of inputs.transXChangeDocuments) {
    const document = parseTransXChange(xml);
    parseErrors += document.parseErrors.length;
    if (document.services.length === 0) {
      warnings.push("TransXChange document contained no services");
      continue;
    }

    collectOperators(document, operators, inputs.retrievedAt);

    for (const service of document.services) {
      const operatorId = resolveOperatorId(document, service.operatorRef);
      const publicName = service.lines[0]?.name ?? service.serviceCode;
      const serviceId = deterministicUuid("service", service.serviceCode);
      const anyStop = document.stopPoints[0]?.atcoCode ?? "";

      services.push({
        id: serviceId,
        provenance: {
          source: "bods",
          ...(inputs.sourceVersion === undefined ? {} : { sourceVersion: inputs.sourceVersion }),
          retrievedAt: inputs.retrievedAt,
          externalIds: [{ source: "bods", id: service.serviceCode }],
        },
        ingestedAt: inputs.retrievedAt,
        qualityFlags: [],
        operatorId,
        publicName,
        mode: service.mode === "coach" ? "coach" : service.mode === "tram" ? "tram" : "bus",
        ...(service.destination === undefined
          ? {}
          : { description: `${service.origin ?? ""} to ${service.destination}`.trim() }),
        coverageArea: coverageAreaForAtco(anyStop),
        validFrom: service.startDate ? `${service.startDate}T00:00:00.000Z` : inputs.retrievedAt,
        validTo: service.endDate ? `${service.endDate}T23:59:59.000Z` : null,
      });

      for (const pattern of service.journeyPatterns) {
        const patternStops = buildPatternStops(pattern, document.journeyPatternSections);
        if (patternStops.length < 2) {
          warnings.push(`pattern ${pattern.id} on ${service.serviceCode} has fewer than two stops`);
          continue;
        }

        const missing = patternStops.filter((s) => !stopsByAtco.has(s.atcoCode));
        if (missing.length > 0) {
          danglingStopReferences += missing.length;
          warnings.push(
            `pattern ${pattern.id} references ${missing.length} stop(s) absent from NaPTAN ` +
              `(e.g. ${missing[0]!.atcoCode})`,
          );
          continue;
        }

        /*
         * The shape is keyed by the route it follows, scoped to the service that publishes it.
         *
         * It used to be keyed by the journey pattern id alone, and a TransXChange journey pattern
         * id is only unique inside its own document — every operator numbers theirs jp_1, JP63 and
         * so on. Nationally that collapsed 48,448 patterns onto 515 shapes: most patterns were
         * drawn with some other operator's geometry, and every pattern sharing a key landed in
         * the same tiles. One tile collected so many copies of the same polyline that serialising
         * it threw `Invalid string length`, and the next was refused by object storage as too
         * large, which is how the defect finally surfaced.
         *
         * Keying by route is also the deduplication the old key was reaching for. Patterns on one
         * route differ in which stops they call at, not in where the road goes, so the geometry is
         * built once and shared — which is both correct and most of the size problem.
         */
        const shapeRef = `route:${service.serviceCode}:${pattern.routeRef ?? pattern.id}`;
        let shape = shapes.get(shapeRef);
        if (!shape) {
          const built = publishableShape(buildPatternShape(pattern, document));
          if (built.length >= 2) {
            shapes.set(shapeRef, built);
            shape = built;
          }
        }
        const shapePoints = shape ?? [];

        patterns.push({
          id: deterministicUuid("pattern", `${service.serviceCode}:${pattern.id}`),
          provenance: {
            source: "bods",
            retrievedAt: inputs.retrievedAt,
            externalIds: [{ source: "bods", id: pattern.id }],
          },
          ingestedAt: inputs.retrievedAt,
          qualityFlags: shapePoints.length < 2 ? ["low_confidence"] : [],
          serviceRouteId: serviceId,
          direction: pattern.direction,
          stopSequence: patternStops.map((s) => stopsByAtco.get(s.atcoCode)!.id),
          shapeRef,
          distanceMetres: shapePoints.length >= 2 ? pathLengthMetres(shapePoints) : 0,
          validFrom: service.startDate ? `${service.startDate}T00:00:00.000Z` : inputs.retrievedAt,
          validTo: service.endDate ? `${service.endDate}T23:59:59.000Z` : null,
        });
      }
    }

    const expanded = expandJourneysForDate(
      document,
      inputs.serviceDate,
      inputs.isBankHoliday ?? false,
    );
    journeysSkipped += expanded.skipped.length;

    for (const journey of expanded.journeys) {
      const stopTimes: StopTime[] = [];
      let dangling = false;

      for (const stopTime of journey.stopTimes) {
        const stop = stopsByAtco.get(stopTime.atcoCode);
        if (!stop) {
          dangling = true;
          break;
        }
        stopTimes.push({
          stopId: stop.id,
          sequence: stopTime.sequence,
          scheduledArrival: resolveScheduledInstant(
            journey.serviceDate,
            stopTime.arrivalTimeOfDay,
          ).toISOString(),
          scheduledDeparture: resolveScheduledInstant(
            journey.serviceDate,
            stopTime.departureTimeOfDay,
          ).toISOString(),
          isTimingPoint: stopTime.isTimingPoint,
          pickupAllowed: stopTime.pickupAllowed,
          dropOffAllowed: stopTime.dropOffAllowed,
        });
      }

      if (dangling || stopTimes.length < 2) {
        danglingStopReferences += 1;
        continue;
      }

      journeys.push({
        id: deterministicUuid(
          "journey",
          `${journey.serviceCode}:${journey.vehicleJourneyCode}:${journey.serviceDate}`,
        ),
        provenance: {
          source: "bods",
          retrievedAt: inputs.retrievedAt,
          externalIds: [{ source: "bods", id: journey.vehicleJourneyCode }],
        },
        ingestedAt: inputs.retrievedAt,
        qualityFlags: [],
        routePatternId: deterministicUuid(
          "pattern",
          `${journey.serviceCode}:${journey.journeyPatternId}`,
        ),
        serviceDate: journey.serviceDate,
        tripId: journey.vehicleJourneyCode,
        stopTimes,
        state: "scheduled",
      });
    }
  }

  return {
    stops: naptan.stops,
    operators: [...operators.values()],
    services,
    patterns,
    journeys,
    shapes,
    counts: {
      stops: naptan.stops.length,
      operators: operators.size,
      services: services.length,
      patterns: patterns.length,
      journeys: journeys.length,
      stopsRejected: naptan.rejected.length,
      stopsWithdrawn: naptan.withdrawnAtcoCodes.length,
      journeysSkipped,
      danglingStopReferences,
      parseErrors,
    },
    warnings,
  };
}

function collectOperators(
  document: TransXChangeDocument,
  operators: Map<string, Operator>,
  retrievedAt: string,
): void {
  for (const operator of document.operators) {
    const key = operator.nationalOperatorCode ?? operator.code ?? operator.id;
    const id = deterministicUuid("operator", key);
    if (operators.has(id)) continue;
    operators.set(id, {
      id,
      provenance: {
        source: "bods",
        retrievedAt,
        externalIds: [{ source: "bods", id: key }],
      },
      ingestedAt: retrievedAt,
      qualityFlags: [],
      name: operator.name,
      licenceRegistryIds: [operator.nationalOperatorCode, operator.code].filter(
        (value): value is string => value !== undefined,
      ),
      ticketDomains: [],
      serviceAreas: [],
      active: true,
    });
  }
}

function resolveOperatorId(
  document: TransXChangeDocument,
  operatorRef: string | undefined,
): string {
  const operator =
    document.operators.find((o) => o.id === operatorRef) ?? document.operators[0] ?? null;
  const key = operator
    ? (operator.nationalOperatorCode ?? operator.code ?? operator.id)
    : (operatorRef ?? "unknown");
  return deterministicUuid("operator", key);
}
