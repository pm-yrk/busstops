import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVICE_DATE_HORIZON_DAYS,
  MAX_SERVICE_DATE_HORIZON_DAYS,
  serviceDateHorizon,
  serviceDateHorizonFromEnv,
} from "./service-dates.js";

describe("the service-date horizon", () => {
  it("publishes today and the days after it, in order", () => {
    expect(serviceDateHorizon(new Date("2026-10-01T09:00:00Z"), 5)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ]);
  });

  /*
   * The regression. Two days was a correctly-published artifact that could not say what was due at
   * any stop in England on its third day, and the preview had no refresh to save it.
   */
  it("reaches past tomorrow, which two days did not", () => {
    const dates = serviceDateHorizon(
      new Date("2026-10-01T09:00:00Z"),
      DEFAULT_SERVICE_DATE_HORIZON_DAYS,
    );
    expect(dates).toContain("2026-10-03");
    expect(dates.length).toBeGreaterThan(2);
  });

  it("crosses a month and a year without arithmetic of its own", () => {
    expect(serviceDateHorizon(new Date("2026-12-30T23:59:00Z"), 4)).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  /*
   * Both spills are written during the one GTFS pass and published afterwards, so the horizon is
   * peak disk. A build that fills the disk publishes nothing, which is worse than a short horizon.
   */
  it("refuses a horizon the free tier could not hold", () => {
    expect(serviceDateHorizon(new Date("2026-10-01T00:00:00Z"), 400)).toHaveLength(
      MAX_SERVICE_DATE_HORIZON_DAYS,
    );
    expect(serviceDateHorizon(new Date("2026-10-01T00:00:00Z"), 0)).toHaveLength(1);
  });

  /*
   * The offset is how a live artifact goes from two days to a week without being rebuilt: a second
   * pass publishes the days the first one did not, at the version already serving traffic.
   */
  it("can start further out, so a second pass extends an artifact instead of repeating it", () => {
    expect(serviceDateHorizon(new Date("2026-10-01T09:00:00Z"), 3, 2)).toEqual([
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ]);
  });

  it("takes the horizon from the environment, and ignores a value it cannot read", () => {
    const at = new Date("2026-10-01T09:00:00Z");
    expect(serviceDateHorizonFromEnv(at, { SERVICE_DATE_HORIZON_DAYS: "3" }).serviceDates).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
    ]);
    expect(serviceDateHorizonFromEnv(at, { SERVICE_DATE_HORIZON_DAYS: "nonsense" }).days).toBe(
      DEFAULT_SERVICE_DATE_HORIZON_DAYS,
    );
    expect(serviceDateHorizonFromEnv(at, {}).serviceDates).toHaveLength(
      DEFAULT_SERVICE_DATE_HORIZON_DAYS,
    );
  });
});
