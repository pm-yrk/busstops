import type { Operator, ServiceRoute, VehicleObservation } from "@busstops/contracts";

/**
 * Joining an observed vehicle to the route it was working.
 *
 * Run 69 published a national summary reporting `distinctRoutes: 0` over 247 samples from 247
 * real vehicles, and the cause was not a weak join — there was no join at all. The chain broke
 * twice: the SIRI adapter extracted `LineRef`, `PublishedLineName` and `OperatorRef` into a
 * journey context that the live collector discarded one call later, and the batch then passed
 * `routeByVehicle: new Map()` into the run. Every sample was built with `routeId: null`, so zero
 * was the only answer the summary could have given.
 *
 * With the identity now carried on the observation, this is the resolution: the publisher's
 * operator code against the operators' licence registry ids, then that operator's routes by
 * public name. Both halves are sourced — nothing is matched on a name alone, because "36" is a
 * route number in most towns in England and joining on it without the operator would attribute
 * one operator's buses to another's service.
 *
 * Every outcome is counted rather than silently dropped. An unresolved reference is a fact about
 * the join, and reporting only the successes is how "we map most routes" survives being untrue.
 */

export interface RouteJoinResult {
  /** Vehicle reference → resolved `ServiceRoute` id, or null where it could not be resolved. */
  routeByVehicle: Map<string, string | null>;
  /** Public line name per vehicle, kept even where the id could not be resolved. */
  nameByVehicle: Map<string, string>;
  counts: RouteJoinCounts;
}

export interface RouteJoinCounts {
  /** Distinct vehicles seen in the observations. */
  vehicles: number;
  /** Vehicles whose observations carried any route reference at all. */
  vehiclesWithRouteRef: number;
  /** Vehicles whose observations carried an operator reference. */
  vehiclesWithOperatorRef: number;
  /** Vehicles resolved all the way to a published `ServiceRoute` id. */
  vehiclesMappedToRouteId: number;
  /** Distinct published route ids the join produced. */
  distinctRouteIds: number;
  /** Distinct public line names seen, resolved or not. */
  distinctRouteNames: number;
  /** Operator codes the feed gave that no published operator claims. */
  unmappedOperatorRefs: number;
  /**
   * References that named an operator we know but a line that operator does not publish.
   * Distinguished from the above because they are different failures: one is a missing operator
   * in the network build, the other is a line name that does not agree between two sources.
   */
  unmappedLineRefs: number;
  /** A few of each, so the report names them rather than only counting them. */
  sampleUnmappedOperators: string[];
  sampleUnmappedLines: string[];
}

export interface RouteJoinInput {
  observations: readonly VehicleObservation[];
  operators: readonly Operator[];
  services: readonly ServiceRoute[];
}

/** Line names differ in case and padding between publishers; identity does not. */
function normaliseName(value: string): string {
  return value.trim().toUpperCase();
}

export function joinObservationsToRoutes(input: RouteJoinInput): RouteJoinResult {
  /*
   * Operator code → operator id, from the licence registry ids the network build recorded.
   *
   * An operator can hold several codes, and the same code must not be claimed by two operators;
   * where it is, first wins and the collision is invisible — which is acceptable here because
   * the alternative is dropping a real route, and a duplicated NOC is a fault in the operator
   * dataset rather than in this join.
   */
  const operatorByCode = new Map<string, string>();
  for (const operator of input.operators) {
    for (const code of operator.licenceRegistryIds) {
      const key = normaliseName(code);
      if (!operatorByCode.has(key)) operatorByCode.set(key, operator.id);
    }
  }

  // (operator id, public name) → route id. Never name alone: "36" is a route number everywhere.
  const routeByOperatorAndName = new Map<string, string>();
  for (const service of input.services) {
    const key = `${service.operatorId}|${normaliseName(service.publicName)}`;
    if (!routeByOperatorAndName.has(key)) routeByOperatorAndName.set(key, service.id);
  }

  const routeByVehicle = new Map<string, string | null>();
  const nameByVehicle = new Map<string, string>();
  const withRouteRef = new Set<string>();
  const withOperatorRef = new Set<string>();
  const mapped = new Set<string>();
  const routeIds = new Set<string>();
  const routeNames = new Set<string>();
  const unmappedOperators = new Set<string>();
  const unmappedLines = new Set<string>();
  const vehicles = new Set<string>();

  for (const observation of input.observations) {
    vehicles.add(observation.vehicleRef);
    const name = observation.publishedLineName ?? observation.lineRef;
    if (name !== undefined) {
      withRouteRef.add(observation.vehicleRef);
      routeNames.add(normaliseName(name));
      nameByVehicle.set(observation.vehicleRef, name);
    }
    if (observation.operatorRef !== undefined) withOperatorRef.add(observation.vehicleRef);

    // Already resolved from an earlier observation of the same vehicle: nothing to redo.
    if (routeByVehicle.get(observation.vehicleRef)) continue;

    if (name === undefined || observation.operatorRef === undefined) {
      if (!routeByVehicle.has(observation.vehicleRef)) {
        routeByVehicle.set(observation.vehicleRef, null);
      }
      continue;
    }

    const operatorId = operatorByCode.get(normaliseName(observation.operatorRef));
    if (operatorId === undefined) {
      unmappedOperators.add(normaliseName(observation.operatorRef));
      routeByVehicle.set(observation.vehicleRef, null);
      continue;
    }

    const routeId = routeByOperatorAndName.get(`${operatorId}|${normaliseName(name)}`);
    if (routeId === undefined) {
      unmappedLines.add(`${observation.operatorRef}:${name}`);
      routeByVehicle.set(observation.vehicleRef, null);
      continue;
    }

    routeByVehicle.set(observation.vehicleRef, routeId);
    mapped.add(observation.vehicleRef);
    routeIds.add(routeId);
  }

  return {
    routeByVehicle,
    nameByVehicle,
    counts: {
      vehicles: vehicles.size,
      vehiclesWithRouteRef: withRouteRef.size,
      vehiclesWithOperatorRef: withOperatorRef.size,
      vehiclesMappedToRouteId: mapped.size,
      distinctRouteIds: routeIds.size,
      distinctRouteNames: routeNames.size,
      unmappedOperatorRefs: unmappedOperators.size,
      unmappedLineRefs: unmappedLines.size,
      sampleUnmappedOperators: [...unmappedOperators].slice(0, 5),
      sampleUnmappedLines: [...unmappedLines].slice(0, 5),
    },
  };
}
