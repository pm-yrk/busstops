import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeparturePredictionSchema, IncidentSchema, StopSchema } from "@busstops/contracts";
import {
  TflArrivalSchema,
  arrivalConfidence,
  arrivalUncertaintySeconds,
  deriveLondonVehiclePosition,
  normalizeTflArrivals,
  normalizeTflDisruption,
  normalizeTflRouteSequence,
  normalizeTflStopPoint,
  parseTflLineString,
  tflUrl,
} from "./tfl.js";
import { deterministicUuid } from "./identity.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/documented",
);
const arrivalsFixture: unknown = JSON.parse(
  readFileSync(join(fixturesDir, "tfl-arrivals.json"), "utf8"),
);
const options = { retrievedAt: "2026-09-02T08:00:05.000Z", now: new Date("2026-09-02T08:00:05Z") };

describe("TfL arrivals", () => {
  const { departures, rejected } = normalizeTflArrivals(arrivalsFixture, options);

  it("normalizes every documented arrival", () => {
    expect(departures).toHaveLength(3);
    expect(rejected).toBe(0);
  });

  it("produces records that satisfy the DeparturePrediction contract", () => {
    for (const departure of departures) {
      expect(DeparturePredictionSchema.safeParse(departure).success).toBe(true);
    }
  });

  it("orders departures by expected time", () => {
    const times = departures.map((d) => d.expectedTime);
    expect(times).toEqual([...times].sort());
  });

  it("marks TfL predictions as live with no timetable time on this endpoint", () => {
    expect(departures[0]?.liveState).toBe("live");
    expect(departures[0]?.scheduledTime).toBeNull();
  });

  it("links the departure to the canonical stop identity", () => {
    expect(departures[0]?.stopId).toBe(deterministicUuid("stop", "490008660N"));
  });

  it("widens uncertainty as the prediction horizon grows", () => {
    expect(arrivalUncertaintySeconds(60)).toBe(30);
    expect(arrivalUncertaintySeconds(500)).toBe(60);
    expect(arrivalUncertaintySeconds(1500)).toBe(180);
    expect(arrivalUncertaintySeconds(3000)).toBe(300);

    const far = departures.find((d) => d.serviceRoutePublicName === "176")!;
    const near = departures.find((d) => d.serviceRoutePublicName === "29")!;
    expect(far.uncertaintySeconds!).toBeGreaterThan(near.uncertaintySeconds!);
  });

  it("lowers confidence for distant predictions", () => {
    const far = departures.find((d) => d.serviceRoutePublicName === "176")!;
    const near = departures.find((d) => d.serviceRoutePublicName === "29")!;
    expect(far.confidence.score).toBeLessThan(near.confidence.score);
    expect(far.confidence.reasons.join(" ")).toMatch(/horizon/);
  });

  it("lowers confidence and flags staleness for an old prediction", () => {
    const stale = normalizeTflArrivals(arrivalsFixture, {
      retrievedAt: "2026-09-02T08:10:00.000Z",
      now: new Date("2026-09-02T08:10:00Z"),
    });
    expect(stale.departures[0]?.qualityFlags).toContain("stale");
    expect(stale.departures[0]?.confidence.level).not.toBe("high");
  });

  it("quarantines malformed entries without discarding the good ones", () => {
    const mixed = [...(arrivalsFixture as unknown[]), { id: "bad", naptanId: 12345 }];
    const result = normalizeTflArrivals(mixed, options);
    expect(result.departures).toHaveLength(3);
    expect(result.rejected).toBe(1);
  });

  it("handles an empty response, which is a normal night-time state", () => {
    expect(normalizeTflArrivals([], options).departures).toEqual([]);
  });

  it("handles a non-array response without throwing", () => {
    expect(normalizeTflArrivals({ error: "rate limited" }, options).departures).toEqual([]);
  });
});

describe("arrival confidence", () => {
  it("is high for a fresh, near prediction", () => {
    expect(arrivalConfidence(120, 5).level).toBe("high");
  });

  it("degrades with age", () => {
    expect(arrivalConfidence(120, 200).score).toBeLessThan(arrivalConfidence(120, 5).score);
  });

  it("never returns a score outside 0..1", () => {
    for (const [horizon, age] of [
      [0, 0],
      [10_000, 10_000],
      [3600, 600],
    ]) {
      const confidence = arrivalConfidence(horizon!, age!);
      expect(confidence.score).toBeGreaterThanOrEqual(0);
      expect(confidence.score).toBeLessThanOrEqual(1);
    }
  });
});

describe("TfL stop points", () => {
  it("normalizes a stop point into the canonical Stop shape", () => {
    const stop = normalizeTflStopPoint(
      {
        naptanId: "490008660N",
        commonName: "Trafalgar Square",
        stopLetter: "N",
        lat: 51.5081,
        lon: -0.1281,
        modes: ["bus"],
        stopType: "NaptanPublicBusCoachTram",
        status: true,
        lines: [{ id: "24", name: "24" }],
      },
      options.retrievedAt,
    )!;

    expect(StopSchema.safeParse(stop).success).toBe(true);
    expect(stop.atcoCode).toBe("490008660N");
    expect(stop.indicator).toBe("N");
    // Same natural key as NaPTAN, so London and non-London stops share one identity space.
    expect(stop.id).toBe(deterministicUuid("stop", "490008660N"));
  });

  it("rejects a stop point outside England instead of plotting it", () => {
    const stop = normalizeTflStopPoint(
      {
        naptanId: "X",
        commonName: "Nowhere",
        stopLetter: "",
        lat: 0,
        lon: 0,
        modes: ["bus"],
        stopType: "",
        status: true,
        lines: [],
      },
      options.retrievedAt,
    );
    expect(stop).toBeNull();
  });
});

describe("TfL route sequences", () => {
  const sequence = {
    lineId: "24",
    lineName: "24",
    direction: "inbound",
    isOutboundOnly: false,
    mode: "bus",
    lineStrings: ["[[[-0.1281,51.5081],[-0.1290,51.5090],[-0.1300,51.5100]]]"],
    stopPointSequences: [
      {
        lineId: "24",
        branchId: 0,
        direction: "inbound",
        stopPoint: [
          {
            id: "490008660N",
            name: "Trafalgar Square",
            lat: 51.5081,
            lon: -0.1281,
            stopLetter: "N",
          },
          { id: "490000254S", name: "Whitehall", lat: 51.5055, lon: -0.126, stopLetter: "S" },
        ],
      },
    ],
  };

  it("extracts the ordered stop sequence and shape", () => {
    const result = normalizeTflRouteSequence(sequence)!;
    expect(result.stopAtcoCodes).toEqual(["490008660N", "490000254S"]);
    expect(result.shape).toHaveLength(3);
    expect(result.direction).toBe("inbound");
  });

  it("de-duplicates stops that appear on multiple branches", () => {
    const branched = {
      ...sequence,
      stopPointSequences: [...sequence.stopPointSequences, ...sequence.stopPointSequences],
    };
    expect(normalizeTflRouteSequence(branched)!.stopAtcoCodes).toEqual([
      "490008660N",
      "490000254S",
    ]);
  });

  it("parses lineStrings from GeoJSON lon/lat order", () => {
    const shape = parseTflLineString("[[[-0.1281,51.5081],[-0.129,51.509]]]");
    expect(shape[0]).toEqual({ lat: 51.5081, lon: -0.1281 });
  });

  it("drops malformed lineStrings rather than throwing", () => {
    expect(parseTflLineString("not json")).toEqual([]);
    expect(parseTflLineString("[[[999,999]]]")).toEqual([]);
  });

  it("returns null for a payload that does not match the documented shape", () => {
    expect(normalizeTflRouteSequence({ unexpected: true })).toBeNull();
  });
});

describe("TfL disruptions", () => {
  it("normalizes a disruption as an official incident", () => {
    const incident = normalizeTflDisruption(
      {
        category: "RealTime",
        categoryDescription: "RealTime",
        description: "Oxford Street closed westbound due to a burst water main.",
        created: "2026-09-02T07:30:00Z",
        affectedStops: [{ id: "490008660N" }],
      },
      options,
    )!;

    expect(IncidentSchema.safeParse(incident).success).toBe(true);
    expect(incident.officialStatus).toBe("official");
    expect(incident.confidence.level).toBe("high");
    expect(incident.narrative).toMatch(/burst water main/);
  });

  it("returns null for an unrecognised payload", () => {
    expect(normalizeTflDisruption({ nope: 1 }, options)).toBeNull();
  });
});

describe("London vehicle position inference", () => {
  const arrivals = (arrivalsFixture as unknown[]).map((a) => TflArrivalSchema.parse(a));

  it("reports the stop being approached rather than fabricating a coordinate", () => {
    const inferred = deriveLondonVehiclePosition(arrivals)!;
    expect(inferred.approachingStopAtcoCode).toBe("490008660N");
    expect(inferred.secondsToStop).toBe(60);
    expect(inferred).not.toHaveProperty("coordinate");
  });

  it("always marks the result as inferred, never observed", () => {
    const inferred = deriveLondonVehiclePosition(arrivals)!;
    expect(inferred.inferred).toBe(true);
    expect(inferred.confidence.level).not.toBe("high");
    expect(inferred.confidence.reasons.join(" ")).toMatch(/does not publish raw vehicle positions/);
  });

  it("returns null when no arrival names a vehicle", () => {
    const anonymous = arrivals.map((a) => ({ ...a, vehicleId: "" }));
    expect(deriveLondonVehiclePosition(anonymous)).toBeNull();
  });
});

describe("tflUrl", () => {
  it("attaches the app key when one is configured", () => {
    const url = tflUrl("/StopPoint/490008660N/Arrivals", "SECRETKEY");
    expect(url).toContain("app_key=SECRETKEY");
  });

  it("omits the key entirely when none is configured, rather than sending an empty one", () => {
    const url = tflUrl("/StopPoint/490008660N/Arrivals", undefined);
    expect(url).not.toContain("app_key");
  });

  it("encodes query parameters safely", () => {
    const url = tflUrl("/StopPoint/Search", undefined, { query: "Oxford Circus & Regent St" });
    expect(url).toContain("Oxford+Circus+%26+Regent+St");
  });
});
