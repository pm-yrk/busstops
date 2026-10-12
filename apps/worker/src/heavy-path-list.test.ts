import { describe, expect, it } from "vitest";
import { isHeavyPath } from "./index.js";

/**
 * Which endpoints queue behind the read gate, held as a list rather than as a pattern.
 *
 * The list is the kind of thing that drifts: it was written from the endpoints known to read
 * megabytes, and `/v1/search` — which scans the prefix shards at about 5 MiB each — was missed,
 * which is how the deployed flow walk came to fail on its own first step for three runs. So both
 * directions are pinned: every heavy endpoint is on it, and the cheap ones are not.
 */
describe("the endpoints the read gate admits", () => {
  it("gates everything that reads a published artifact by the mebibyte", () => {
    for (const path of [
      "/v1/map",
      "/v1/journeys",
      "/v1/nearby",
      "/v1/search",
      "/v1/routes/0c0b2f8a-0000-4000-8000-000000000001",
      "/v1/stops/450010510",
      "/v1/operators/0c0b2f8a-0000-4000-8000-000000000002",
      "/v1/vehicles/abc123",
    ]) {
      expect(isHeavyPath(path), `${path} reads megabytes and must be gated`).toBe(true);
    }
  });

  /*
   * The diagnostics endpoint is the one that must never be gated, and the reason is not
   * performance: it is the endpoint that reports a saturated isolate, so putting it behind the
   * saturation means the one request that could tell you is the one that cannot get through.
   */
  it("never gates the endpoint that reports the gate's own state", () => {
    expect(isHeavyPath("/v1/diagnostics/gate")).toBe(false);
    expect(isHeavyPath("/v1/diagnostics/live")).toBe(false);
  });

  it("leaves the cheap endpoints alone", () => {
    for (const path of [
      "/v1/sources/health",
      "/v1/disruptions",
      "/v1/unsubscribe",
      "/v1/pro/control-tower",
      "/v1/pro/routes",
    ]) {
      expect(isHeavyPath(path), `${path} answers cheaply and must not queue`).toBe(false);
    }
  });

  /* A prefix match must not be a suffix match: another path ending in one of these is not it. */
  it("matches on the endpoint, not on a path that merely contains one", () => {
    expect(isHeavyPath("/v1/other/v1/map")).toBe(false);
    expect(isHeavyPath("/v1/maps")).toBe(false);
    expect(isHeavyPath("/v1/routes")).toBe(false);
  });
});
