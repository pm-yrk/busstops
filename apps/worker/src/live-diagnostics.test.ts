import { describe, expect, it } from "vitest";
import { describeFetchFailure, summariseVehicleSource } from "./live-service.js";

/**
 * "Zero buses" has four causes and they need different fixes. The Worker used to collapse all of
 * them into one `catch`, which is why a preview could report zero live vehicles for a week
 * without anyone being able to say whether that was an outage or our own filter.
 */
describe("live source diagnostics", () => {
  const now = new Date("2026-09-04T09:00:00Z");

  it("separates an empty feed from a feed we threw away", () => {
    const empty = summariseVehicleSource("bods", 0, [], now, []);
    expect(empty.outcome).toBe("empty_feed");
    expect(empty.rawRecords).toBe(0);

    const discarded = summariseVehicleSource(
      "bods",
      0,
      [{ reason: "observation 812s old" }, { reason: "observation 903s old" }],
      now,
      [812, 903],
    );
    expect(discarded.outcome).toBe("all_rejected");
    expect(discarded.rawRecords).toBe(2);
    // Bucketed by shape, so a thousand stale records are one line rather than a thousand.
    expect(discarded.rejectedBy).toEqual({ "observation Ns old": 2 });
    expect(discarded.newestRecordAgeSeconds).toBe(812);
    expect(discarded.oldestRecordAgeSeconds).toBe(903);
  });

  it("reports a working source as ok even when some records were dropped", () => {
    const result = summariseVehicleSource(
      "bods",
      12,
      [{ reason: "implausible coordinate" }],
      now,
      [30, 45, 900],
    );
    expect(result.outcome).toBe("ok");
    expect(result.accepted).toBe(12);
    expect(result.rawRecords).toBe(13);
  });

  /*
   * The failure description is published, and an upstream error message can carry the request URL
   * — which carries the API key. Only the class of failure leaves this function.
   */
  it("describes a failure without ever carrying the request through", () => {
    const withKey = new Error(
      "request to https://data.bus-data.dft.gov.uk/api/v1/datafeed/?api_key=SECRETVALUE failed with 403",
    );
    const described = describeFetchFailure(withKey);
    expect(described).toBe("http_403");
    expect(described).not.toContain("SECRETVALUE");
    expect(described).not.toContain("api_key");

    const timeout = new Error("The operation was aborted due to timeout");
    expect(describeFetchFailure(timeout)).toBe("timeout");
    expect(describeFetchFailure("something odd")).toBe("unknown_error");
  });
});
