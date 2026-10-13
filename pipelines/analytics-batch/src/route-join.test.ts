import { describe, expect, it } from "vitest";
import type { Operator, ServiceRoute, VehicleObservation } from "@busstops/contracts";
import { joinObservationsToRoutes } from "./route-join.js";

/**
 * Run 69 reported `distinctRoutes: 0` over 247 real vehicles, and the cause was that the join did
 * not exist: the adapter extracted the route identity into a journey context the collector threw
 * away, and the batch passed an empty map. These assert the join and, as importantly, that every
 * way it can fail is counted rather than folded into the same zero.
 */

function observation(over: Partial<VehicleObservation> = {}): VehicleObservation {
  return {
    id: `obs-${over.vehicleRef ?? "1"}-${over.observedAt ?? "a"}`,
    provenance: { source: "bods", retrievedAt: "2026-09-19T12:00:00.000Z", externalIds: [] },
    ingestedAt: "2026-09-19T12:00:00.000Z",
    qualityFlags: [],
    vehicleRef: "veh-1",
    observedAt: "2026-09-19T12:00:00.000Z",
    coordinate: { lat: 53.8, lon: -1.55 },
    ...over,
  };
}

const operators: Operator[] = [
  {
    id: "11111111-1111-5111-8111-111111111111",
    provenance: { source: "naptan", retrievedAt: "2026-09-01T00:00:00.000Z", externalIds: [] },
    ingestedAt: "2026-09-01T00:00:00.000Z",
    qualityFlags: [],
    name: "First Leeds",
    licenceRegistryIds: ["FLDS"],
    ticketDomains: [],
    serviceAreas: [],
    active: true,
  },
  {
    id: "22222222-2222-5222-8222-222222222222",
    provenance: { source: "naptan", retrievedAt: "2026-09-01T00:00:00.000Z", externalIds: [] },
    ingestedAt: "2026-09-01T00:00:00.000Z",
    qualityFlags: [],
    name: "Arriva Yorkshire",
    licenceRegistryIds: ["ARRW"],
    ticketDomains: [],
    serviceAreas: [],
    active: true,
  },
];

function service(id: string, operatorId: string, publicName: string): ServiceRoute {
  return {
    id,
    provenance: { source: "bods", retrievedAt: "2026-09-01T00:00:00.000Z", externalIds: [] },
    ingestedAt: "2026-09-01T00:00:00.000Z",
    qualityFlags: [],
    operatorId,
    publicName,
    mode: "bus",
    coverageArea: "non_london",
    validFrom: "2026-09-01T00:00:00.000Z",
    validTo: null,
  };
}

const services = [
  service("aaaaaaaa-0000-5000-8000-000000000001", operators[0]!.id, "36"),
  // The same public number, a different operator. This is the case that makes name-only wrong.
  service("bbbbbbbb-0000-5000-8000-000000000002", operators[1]!.id, "36"),
];

describe("joining an observed vehicle to the route it was working", () => {
  it("resolves through the operator, never on the line name alone", () => {
    const result = joinObservationsToRoutes({
      observations: [
        observation({ vehicleRef: "a", operatorRef: "FLDS", publishedLineName: "36" }),
        observation({ vehicleRef: "b", operatorRef: "ARRW", publishedLineName: "36" }),
      ],
      operators,
      services,
    });

    /*
     * Two buses on a route numbered 36, run by different operators, must not resolve to the same
     * service. "36" is a route number in most towns in England; joining on it alone would
     * attribute one operator's buses to another's service and the figures would look fine.
     */
    expect(result.routeByVehicle.get("a")).toBe("aaaaaaaa-0000-5000-8000-000000000001");
    expect(result.routeByVehicle.get("b")).toBe("bbbbbbbb-0000-5000-8000-000000000002");
    expect(result.counts.distinctRouteIds).toBe(2);
    expect(result.counts.vehiclesMappedToRouteId).toBe(2);
  });

  it("tells an unknown operator from an unknown line", () => {
    /*
     * Different failures with different fixes. An operator code nothing claims means the network
     * build is missing an operator; a known operator with a line it does not publish means two
     * sources disagree about a line name. Counting them together would hide both.
     */
    const result = joinObservationsToRoutes({
      observations: [
        observation({ vehicleRef: "a", operatorRef: "NOPE", publishedLineName: "36" }),
        observation({ vehicleRef: "b", operatorRef: "FLDS", publishedLineName: "999" }),
      ],
      operators,
      services,
    });

    expect(result.counts.unmappedOperatorRefs).toBe(1);
    expect(result.counts.sampleUnmappedOperators).toEqual(["NOPE"]);
    expect(result.counts.unmappedLineRefs).toBe(1);
    expect(result.counts.sampleUnmappedLines).toEqual(["FLDS:999"]);
    expect(result.counts.vehiclesMappedToRouteId).toBe(0);
    // Both still carried a line, and that is a different fact from carrying none.
    expect(result.counts.vehiclesWithRouteRef).toBe(2);
    expect(result.counts.distinctRouteNames).toBe(2);
  });

  it("counts a vehicle whose feed gave no route at all", () => {
    const result = joinObservationsToRoutes({
      observations: [observation({ vehicleRef: "a" })],
      operators,
      services,
    });
    expect(result.counts.vehicles).toBe(1);
    expect(result.counts.vehiclesWithRouteRef).toBe(0);
    expect(result.counts.vehiclesWithOperatorRef).toBe(0);
    expect(result.routeByVehicle.get("a")).toBeNull();
  });

  it("reproduces run 69: observations with no identity on them can only give zero", () => {
    /*
     * The published observations carried no `lineRef`, `publishedLineName` or `operatorRef`,
     * because the collector discarded the journey context. Against that input the join is
     * correct and the answer is still zero — which is the point: the zero was upstream, and no
     * amount of work here would have moved it.
     */
    const stripped = Array.from({ length: 50 }, (_, index) =>
      observation({ vehicleRef: `veh-${index}` }),
    );
    const result = joinObservationsToRoutes({ observations: stripped, operators, services });
    expect(result.counts.vehicles).toBe(50);
    expect(result.counts.distinctRouteIds).toBe(0);
    expect(result.counts.vehiclesWithRouteRef).toBe(0);
  });

  it("keeps the line name even where the id could not be resolved", () => {
    // A route Pro cannot link to is still a route Pro can name, and dropping the name would
    // lose the only thing a reader could act on.
    const result = joinObservationsToRoutes({
      observations: [
        observation({ vehicleRef: "a", operatorRef: "NOPE", publishedLineName: "X1" }),
      ],
      operators,
      services,
    });
    expect(result.nameByVehicle.get("a")).toBe("X1");
    expect(result.routeByVehicle.get("a")).toBeNull();
  });

  it("matches a line name whatever case and padding the publisher used", () => {
    const result = joinObservationsToRoutes({
      observations: [
        observation({ vehicleRef: "a", operatorRef: "flds", publishedLineName: " 36 " }),
      ],
      operators,
      services,
    });
    expect(result.routeByVehicle.get("a")).toBe("aaaaaaaa-0000-5000-8000-000000000001");
  });
});
