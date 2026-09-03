import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { VehicleObservationSchema } from "@busstops/contracts";
import { bodsDatafeedUrl, normalizeSiriVm, parseSiriVm } from "./bods-siri.js";
import { dailyRotationSalt, opaqueVehicleRef } from "./identity.js";

const fixture = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../tests/fixtures/documented/bods-siri-vm.xml",
  ),
  "utf8",
);

const options = {
  retrievedAt: "2026-09-02T08:00:05.000Z",
  vehicleSalt: "test-salt",
  now: new Date("2026-09-02T08:00:05Z"),
};

describe("parseSiriVm", () => {
  it("extracts all vehicle activities from the documented structure", () => {
    const result = parseSiriVm(fixture);
    expect(result.activities).toHaveLength(4);
    expect(result.responseTimestamp).toBe("2026-09-02T09:00:05+01:00");
  });

  it("tolerates namespace prefixes producers add", () => {
    const prefixed = fixture
      .replace(/<Siri /, "<siri:Siri ")
      .replace(/<\/Siri>/, "</siri:Siri>")
      .replace(/<ServiceDelivery>/g, "<siri:ServiceDelivery>")
      .replace(/<\/ServiceDelivery>/g, "</siri:ServiceDelivery>");
    expect(parseSiriVm(prefixed).activities.length).toBeGreaterThan(0);
  });

  it("returns an empty result for unparseable XML rather than throwing", () => {
    const result = parseSiriVm("<Siri><broken>");
    expect(result.activities).toEqual([]);
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  it("returns an empty result for a well-formed document with no deliveries", () => {
    const result = parseSiriVm(
      '<?xml version="1.0"?><Siri><ServiceDelivery><ResponseTimestamp>2026-09-02T09:00:00Z</ResponseTimestamp></ServiceDelivery></Siri>',
    );
    expect(result.activities).toEqual([]);
    expect(result.responseTimestamp).toBe("2026-09-02T09:00:00Z");
  });

  it("handles a single activity that is not wrapped in an array", () => {
    const single = `<?xml version="1.0"?><Siri><ServiceDelivery><VehicleMonitoringDelivery>
      <VehicleActivity><RecordedAtTime>2026-09-02T09:00:00+01:00</RecordedAtTime>
      <MonitoredVehicleJourney><VehicleRef>A-1</VehicleRef>
      <VehicleLocation><Longitude>-1.5</Longitude><Latitude>53.8</Latitude></VehicleLocation>
      </MonitoredVehicleJourney></VehicleActivity></VehicleMonitoringDelivery></ServiceDelivery></Siri>`;
    expect(parseSiriVm(single).activities).toHaveLength(1);
  });
});

describe("normalizeSiriVm", () => {
  const result = normalizeSiriVm(fixture, options);

  it("accepts plausible observations and rejects the rest", () => {
    expect(result.observations).toHaveLength(2);
    const rejectedReasons = result.rejected.map((r) => r.reason).join(" ");
    expect(rejectedReasons).toMatch(/implausible coordinate/);
    expect(rejectedReasons).toMatch(/old/);
  });

  it("produces records that satisfy the VehicleObservation contract", () => {
    for (const observation of result.observations) {
      const parsed = VehicleObservationSchema.safeParse(observation);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it("rejects the null-island position rather than showing a bus in the ocean", () => {
    expect(result.rejected.some((r) => r.vehicleRef === "BADD-00001")).toBe(true);
  });

  it("rejects an observation older than the freshness window", () => {
    expect(result.rejected.some((r) => r.vehicleRef === "STAL-77777")).toBe(true);
  });

  it("rejects a timestamp meaningfully in the future, which means a broken producer clock", () => {
    const future = fixture.replace("2026-09-02T09:00:00+01:00", "2026-09-02T10:00:00+01:00");
    const futureResult = normalizeSiriVm(future, options);
    expect(futureResult.rejected.some((r) => r.reason.includes("future"))).toBe(true);
  });

  it("never republishes the operator's vehicle code", () => {
    const serialized = JSON.stringify(result.observations);
    expect(serialized).not.toContain("FLEE-30412");
    expect(serialized).not.toContain("SCEM-22103");
  });

  it("hashes the vehicle reference with the rotating salt", () => {
    const expected = opaqueVehicleRef("FLEE-30412", "test-salt");
    expect(result.observations.some((o) => o.vehicleRef === expected)).toBe(true);
  });

  it("produces a different reference on a different service day", () => {
    const mondaySalt = dailyRotationSalt("2026-09-01", "secret");
    const tuesdaySalt = dailyRotationSalt("2026-09-02", "secret");
    expect(opaqueVehicleRef("FLEE-30412", mondaySalt)).not.toBe(
      opaqueVehicleRef("FLEE-30412", tuesdaySalt),
    );
  });

  it("keeps the same reference within one service day so tracking works during a session", () => {
    const salt = dailyRotationSalt("2026-09-02", "secret");
    expect(opaqueVehicleRef("FLEE-30412", salt)).toBe(opaqueVehicleRef("FLEE-30412", salt));
  });

  it("carries journey context needed to match a vehicle to a route", () => {
    const vehicleRef = opaqueVehicleRef("FLEE-30412", "test-salt");
    const context = result.journeyContext.get(vehicleRef)!;
    expect(context.publishedLineName).toBe("72");
    expect(context.directionRef).toBe("outbound");
    expect(context.destinationName).toBe("Bradford Interchange");
    expect(context.datedVehicleJourneyRef).toBe("VJ_72_0915");
  });

  it("falls back to LineRef when PublishedLineName is absent", () => {
    const withoutPublished = fixture.replace(/<PublishedLineName>72<\/PublishedLineName>/, "");
    const fallback = normalizeSiriVm(withoutPublished, options);
    const vehicleRef = opaqueVehicleRef("FLEE-30412", "test-salt");
    expect(fallback.journeyContext.get(vehicleRef)?.publishedLineName).toBe("72");
  });

  it("parses the bearing and drops an out-of-range one", () => {
    const leeds = result.observations.find((o) => o.coordinate.lat > 53.7)!;
    expect(leeds.bearingDegrees).toBe(225);

    const badBearing = normalizeSiriVm(
      fixture.replace("<Bearing>225</Bearing>", "<Bearing>999</Bearing>"),
      options,
    );
    const withoutBearing = badBearing.observations.find((o) => o.coordinate.lat > 53.7)!;
    expect(withoutBearing.bearingDegrees).toBeUndefined();
  });

  it("flags an ageing but still usable observation as stale", () => {
    const later = normalizeSiriVm(fixture, {
      ...options,
      retrievedAt: "2026-09-02T08:03:00.000Z",
      now: new Date("2026-09-02T08:03:00Z"),
    });
    const leeds = later.observations.find((o) => o.coordinate.lat > 53.7)!;
    expect(leeds.qualityFlags).toContain("stale");
  });

  it("handles an empty feed, which is a normal overnight state", () => {
    const empty = normalizeSiriVm(
      '<?xml version="1.0"?><Siri><ServiceDelivery><VehicleMonitoringDelivery></VehicleMonitoringDelivery></ServiceDelivery></Siri>',
      options,
    );
    expect(empty.observations).toEqual([]);
  });
});

describe("bodsDatafeedUrl", () => {
  const bbox = { west: -1.6, south: 53.7, east: -1.5, north: 53.85 };

  it("requests only the viewport, never a national feed", () => {
    const url = bodsDatafeedUrl(bbox, "KEY");
    expect(url).toContain("boundingBox=-1.60000%2C53.70000%2C-1.50000%2C53.85000");
  });

  it("attaches the api key when configured and omits it otherwise", () => {
    expect(bodsDatafeedUrl(bbox, "KEY")).toContain("api_key=KEY");
    expect(bodsDatafeedUrl(bbox, undefined)).not.toContain("api_key");
  });
});
