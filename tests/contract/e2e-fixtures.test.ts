import { describe, expect, it } from "vitest";
import {
  ControlTowerResponseSchema,
  DisruptionsResponseSchema,
  MapResponseSchema,
  RouteDetailResponseSchema,
  StopDeparturesResponseSchema,
  VehicleDetailResponseSchema,
} from "@busstops/contracts";
import {
  DISRUPTIONS_RESPONSE,
  EMPTY_MAP,
  ROUTE_DETAIL,
  VEHICLE_DETAIL,
  MAP_WITH_TRAFFIC,
  PRO_CONTROL_TOWER,
  STOP_RESPONSE,
} from "../e2e/fixtures.js";

/**
 * The end-to-end fixtures must satisfy the same contracts the real API does.
 *
 * Without this, a fixture can drift from the schema and the browser suite quietly starts testing
 * a shape the server would never send — which is how an end-to-end suite goes green while the
 * real page is broken.
 */

describe("end-to-end fixtures match the published contracts", () => {
  it("stop departures", () => {
    const result = StopDeparturesResponseSchema.safeParse(STOP_RESPONSE);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("map viewport", () => {
    const result = MapResponseSchema.safeParse(EMPTY_MAP);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("map viewport with traffic in it", () => {
    const result = MapResponseSchema.safeParse(MAP_WITH_TRAFFIC);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("Pro control tower", () => {
    const result = ControlTowerResponseSchema.safeParse(PRO_CONTROL_TOWER.data);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("the disruptions board", () => {
    /*
     * This one was missing, and the fixture had drifted a long way: it still carried the old
     * shape — a `national_highways` source, an `active` lifecycle, an `elevated` severity, a
     * `headline` where the contract wants a `summary`, and no attribution at all. The board
     * rejected it and rendered its error boundary, and the art bench screenshotted that page for
     * days while passing, because the only error it looked for was a heading the boundary does
     * not use. Both gaps are closed: the fixture is checked here and the bench now refuses any
     * error state, whatever it is called.
     */
    const result = DisruptionsResponseSchema.safeParse(DISRUPTIONS_RESPONSE);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("route detail", () => {
    const result = RouteDetailResponseSchema.safeParse(ROUTE_DETAIL);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("vehicle detail", () => {
    const result = VehicleDetailResponseSchema.safeParse(VEHICLE_DETAIL);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });
});
