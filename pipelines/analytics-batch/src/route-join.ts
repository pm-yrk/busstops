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
  /**
   * How many distinct operator codes the published network is keyed by, and a sample of them.
   *
   * The other side of the comparison, which was never printed. "295 operator refs matched
   * nothing" is half a finding; the half that names the cause is what the published operators are
   * keyed by. Side by side, one line settles whether these are two namespaces or one namespace
   * formatted two ways.
   */
  knownOperatorCodes: number;
  sampleKnownOperatorCodes: string[];
  /**
   * Refs that would have matched had punctuation and case been ignored.
   *
   * Reported, never acted on: a relaxed match applied silently would hide the formatting
   * difference this exists to reveal. A non-zero count means normalise; zero alongside a large
   * `unmappedOperatorRefs` means the two sources genuinely use different identifiers, and the fix
   * belongs in the network build rather than in the join.
   */
  operatorRefsMatchingOnlyWhenRelaxed: number;
  sampleRelaxedOnlyMatches: string[];
  /**
   * `LineRef` and `PublishedLineName` counted separately, which the join itself does not do.
   *
   * It reads `publishedLineName ?? lineRef` and stops, so a run reporting 2,185 distinct "route
   * names" says nothing about which field supplied them. The distinction decides whether a
   * line-level join to `route_id` is even possible.
   */
  distinctLineRefs: number;
  sampleLineRefs: string[];
  distinctPublishedLineNames: number;
  samplePublishedLineNames: string[];
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

  /*
   * A relaxed index, used only to tell a missing operator from a differently-punctuated one.
   *
   * Run 38214849377 reported 295 distinct `operatorRef`s in the feed and not one match against
   * 631 published operators — a total miss, which is the signature of two different identifier
   * spaces rather than of patchy data. The feed's codes (FCYM, NATX, TFCN, ABUS, ATWE) look like
   * National Operator Codes, and the GTFS build records `agency_id` as a registry id, which in a
   * hand-written fixture is also a NOC. One of those two assumptions is wrong and no amount of
   * reasoning from here settles which.
   *
   * So the join reports what it actually holds: a sample of the codes it knows, and whether a
   * relaxed comparison — case-folded, non-alphanumerics stripped — would have matched where the
   * exact one did not. A relaxed hit means formatting; no relaxed hit means the two sides are
   * genuinely different namespaces, and the fix is in the network build rather than here.
   */
  const operatorByRelaxedCode = new Map<string, string>();
  for (const [code, id] of operatorByCode) {
    const relaxed = code.replace(/[^A-Z0-9]/g, "");
    if (relaxed.length > 0 && !operatorByRelaxedCode.has(relaxed)) {
      operatorByRelaxedCode.set(relaxed, id);
    }
  }
  const relaxedOnlyMatches = new Set<string>();

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
  const lineRefs = new Set<string>();
  const publishedNames = new Set<string>();

  for (const observation of input.observations) {
    vehicles.add(observation.vehicleRef);
    const name = observation.publishedLineName ?? observation.lineRef;
    if (name !== undefined) {
      withRouteRef.add(observation.vehicleRef);
      routeNames.add(normaliseName(name));
      nameByVehicle.set(observation.vehicleRef, name);
    }
    /*
     * The two line references kept apart, because the join collapses them and they may not be the
     * same kind of thing.
     *
     * `agency_id` in the BODS GTFS feed turned out to be a BODS-internal operator id (OP10232),
     * not the National Operator Code the live feed sends — so the operator hop cannot be made to
     * work without a third dataset. That makes the line hop worth measuring: if SIRI-VM's
     * `LineRef` is a TransXchange line id rather than a short name, it may share a namespace with
     * the GTFS `route_id`, and an observation could be attributed to a published route with no
     * operator involved at all. `publishedLineName` is "36"; what `lineRef` is has never been
     * looked at, because the join reads whichever is present and stops.
     */
    if (observation.lineRef !== undefined) lineRefs.add(observation.lineRef);
    if (observation.publishedLineName !== undefined) {
      publishedNames.add(observation.publishedLineName);
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
      const code = normaliseName(observation.operatorRef);
      unmappedOperators.add(code);
      // Reported, not used: a relaxed match is a diagnosis, and acting on one here would hide
      // the formatting difference it exists to reveal.
      if (operatorByRelaxedCode.has(code.replace(/[^A-Z0-9]/g, ""))) relaxedOnlyMatches.add(code);
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
      sampleUnmappedOperators: [...unmappedOperators].slice(0, 8),
      sampleUnmappedLines: [...unmappedLines].slice(0, 5),
      /*
       * The other side of the comparison, which has never been printed.
       *
       * "295 operator refs matched nothing" is only half a finding; the half that identifies the
       * cause is what the published operators are keyed by. Printed together, one line settles
       * whether these are two namespaces or one namespace formatted two ways.
       */
      knownOperatorCodes: operatorByCode.size,
      sampleKnownOperatorCodes: [...operatorByCode.keys()].slice(0, 12),
      operatorRefsMatchingOnlyWhenRelaxed: relaxedOnlyMatches.size,
      sampleRelaxedOnlyMatches: [...relaxedOnlyMatches].slice(0, 5),
      /*
       * The two line references, apart. If `lineRef` is a line *identifier* rather than a number
       * on the front, an observation may be attributable to a published route without the broken
       * operator hop — which is the only remaining route to route-level figures that does not need
       * a third dataset.
       */
      distinctLineRefs: lineRefs.size,
      sampleLineRefs: [...lineRefs].slice(0, 10),
      distinctPublishedLineNames: publishedNames.size,
      samplePublishedLineNames: [...publishedNames].slice(0, 10),
    },
  };
}
