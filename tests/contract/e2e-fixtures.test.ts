import { describe, expect, it } from "vitest";
import {
  ControlTowerResponseSchema,
  MapResponseSchema,
  StopDeparturesResponseSchema,
} from "@busstops/contracts";
import { EMPTY_MAP, MAP_WITH_TRAFFIC, PRO_CONTROL_TOWER, STOP_RESPONSE } from "../e2e/fixtures.js";

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
});
