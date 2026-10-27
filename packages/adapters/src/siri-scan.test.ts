import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSiriVm } from "./bods-siri.js";
import { scanSiriVehicles } from "./siri-scan.js";
import { opaqueVehicleRef, vehicleRefHasher } from "./identity.js";

/**
 * The scan must agree with the parser it replaces, and survive what producers actually emit.
 *
 * Replacing a DOM parse with a text scan trades 32.43 ms for 1.52 ms on a 437-vehicle viewport —
 * which is the whole reason it exists, because Cloudflare allows a free invocation ten
 * milliseconds and classified this Worker's failures as `exceededCpu`. The trade is only worth
 * making if the answers are the same, and a text scan has failure modes a DOM parser does not:
 * it can read past a field's owner, miss an element that carries an attribute, and hand back
 * undecoded entities. Each of those is a test here, and the first of them was a real bug — the
 * scan reported 436 of 437 vehicles with no rejections, which looks exactly like a feed with one
 * fewer bus in it.
 */

const fixture = readFileSync(
  join(new URL("../../../tests/fixtures/documented", import.meta.url).pathname, "bods-siri-vm.xml"),
  "utf8",
);

/** The fixture's own instant, so nothing is rejected for age. */
const AT = new Date("2026-09-02T09:00:05+01:00");
const SALT = "test-salt";

const scanned = () =>
  scanSiriVehicles(fixture, { vehicleSalt: SALT, nowMs: AT.getTime(), maxAgeSeconds: 600 });

const normalised = () =>
  normalizeSiriVm(fixture, {
    retrievedAt: AT.toISOString(),
    vehicleSalt: SALT,
    now: AT,
    maxAgeSeconds: 600,
  });

describe("the scan against the normaliser it replaces", () => {
  it("keeps the same vehicles, with the same references and positions", () => {
    const scan = scanned();
    const full = normalised();

    expect(scan.vehicles.length, "a different count is a bus gained or lost").toBe(
      full.observations.length,
    );
    expect(scan.vehicles.map((v) => v.vehicleRef).sort()).toEqual(
      full.observations.map((o) => o.vehicleRef).sort(),
    );

    for (const observation of full.observations) {
      const vehicle = scan.vehicles.find((v) => v.vehicleRef === observation.vehicleRef);
      expect(vehicle, observation.vehicleRef).toBeDefined();
      expect(vehicle!.lat).toBe(observation.coordinate.lat);
      expect(vehicle!.lon).toBe(observation.coordinate.lon);
      expect(vehicle!.bearingDegrees ?? null).toBe(observation.bearingDegrees ?? null);
      expect(new Date(vehicle!.observedAtMs).toISOString()).toBe(observation.observedAt);
      expect(vehicle!.publishedLineName ?? null).toBe(observation.publishedLineName ?? null);
      expect(vehicle!.lineRef ?? null).toBe(observation.lineRef ?? null);
      expect(vehicle!.journeyRef ?? null).toBe(observation.journeyRef ?? null);
    }
  });

  it("agrees on the response timestamp", () => {
    expect(scanned().responseTimestamp).toBe("2026-09-02T09:00:05+01:00");
  });

  it("reads every vehicle, including the first and the last", () => {
    /*
     * The bug this file was written for. The cursor started at the index of the opening tag's
     * *content*, so the first search for that tag began past it and found the second vehicle —
     * 436 of 437, no rejections, no error.
     */
    /*
     * Asserted on a feed of its own rather than on the fixture, whose four activities do not all
     * survive the age filter — a count taken from the fixture would be asserting the filter.
     */
    const xml = feed([
      one({ VehicleRef: "FIRST" }),
      one({ VehicleRef: "MIDDLE" }),
      one({ VehicleRef: "LAST" }),
    ]);
    const scan = scanOf(xml);
    expect(scan.vehicles.map((v) => v.vehicleRef)).toEqual([
      opaqueVehicleRef("FIRST", SALT),
      opaqueVehicleRef("MIDDLE", SALT),
      opaqueVehicleRef("LAST", SALT),
    ]);

    /* And on the fixture, the first activity's own line number really is read. */
    expect(scanned().vehicles[0]!.lineRef, "the first activity").toBe("72");
  });

  it("agrees with the normaliser on where each bus is going", () => {
    const scan = scanned();
    const full = normalised();
    for (const vehicle of scan.vehicles) {
      const context = full.journeyContext.get(vehicle.vehicleRef);
      expect(vehicle.destinationName ?? null, vehicle.vehicleRef).toBe(
        context?.destinationName ?? null,
      );
    }
  });

  it("reads a selected bus's own fields only when asked, and agrees then too", () => {
    /*
     * A marker shows a route number and a destination; the origin, direction, operator and block
     * are for the one bus a passenger tapped. Reading them for every vehicle cost a measured
     * 1.5 ms of a 4 ms budget, so they are opt-in — and the opt-in has to produce the same answers
     * the normaliser did, or the selected-bus panel quietly loses a field.
     */
    const plain = scanned();
    expect(plain.vehicles[0]!.operatorRef, "not read without detail").toBeUndefined();
    expect(plain.vehicles[0]!.directionRef).toBeUndefined();

    const detailed = scanSiriVehicles(fixture, {
      vehicleSalt: SALT,
      nowMs: AT.getTime(),
      maxAgeSeconds: 600,
      detail: true,
    });
    const full = normalised();
    for (const vehicle of detailed.vehicles) {
      const context = full.journeyContext.get(vehicle.vehicleRef)!;
      expect(vehicle.operatorRef ?? null).toBe(context.operatorRef ?? null);
      expect(vehicle.directionRef ?? null).toBe(context.directionRef ?? null);
      expect(vehicle.originName ?? null).toBe(context.originName ?? null);
      expect(vehicle.blockRef ?? null).toBe(context.blockRef ?? null);
    }
    expect(detailed.vehicles[0]!.operatorRef).toBe("FLEE");
    expect(detailed.vehicles[0]!.directionRef).toBe("outbound");
    expect(detailed.vehicles[0]!.originName).toBe("Leeds City Bus Station");
  });
});

/** One activity, with whatever overrides a case needs. */
function feed(activities: string[], head = ""): string {
  return `<?xml version="1.0"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="2.0">
  <ServiceDelivery>
    <ResponseTimestamp>2026-09-02T09:00:05Z</ResponseTimestamp>${head}
    <VehicleMonitoringDelivery version="2.0">
${activities.join("\n")}
    </VehicleMonitoringDelivery>
  </ServiceDelivery>
</Siri>`;
}

function activity(fields: Record<string, string>, wrapper = "VehicleActivity"): string {
  const body = Object.entries(fields)
    .map(([tag, value]) => `        <${tag}>${value}</${tag}>`)
    .join("\n");
  return `      <${wrapper}>\n${body}\n      </VehicleActivity>`;
}

const one = (overrides: Record<string, string> = {}) =>
  activity({
    RecordedAtTime: "2026-09-02T09:00:00Z",
    LineRef: "72",
    PublishedLineName: "72",
    OperatorRef: "FLEE",
    DestinationName: "Bradford Interchange",
    VehicleLocation: "<Longitude>-1.5379</Longitude><Latitude>53.7965</Latitude>",
    Bearing: "225",
    VehicleRef: "FLEE-30412",
    ...overrides,
  });

const scanOf = (xml: string, options: Record<string, unknown> = {}) =>
  scanSiriVehicles(xml, {
    vehicleSalt: SALT,
    nowMs: Date.parse("2026-09-02T09:00:05Z"),
    maxAgeSeconds: 600,
    ...options,
  });

describe("what producers actually emit", () => {
  it("reads namespace-prefixed tags", () => {
    const xml = feed([
      `      <siri:VehicleActivity>
        <siri:RecordedAtTime>2026-09-02T09:00:00Z</siri:RecordedAtTime>
        <siri:MonitoredVehicleJourney>
          <siri:PublishedLineName>X1</siri:PublishedLineName>
          <siri:VehicleLocation><siri:Longitude>-1.54</siri:Longitude><siri:Latitude>53.79</siri:Latitude></siri:VehicleLocation>
          <siri:VehicleRef>NS-1</siri:VehicleRef>
        </siri:MonitoredVehicleJourney>
      </siri:VehicleActivity>`,
    ]);
    const scan = scanOf(xml);
    expect(scan.vehicles).toHaveLength(1);
    expect(scan.vehicles[0]!.publishedLineName).toBe("X1");
    expect(scan.vehicles[0]!.lat).toBe(53.79);
  });

  it("reads an element that carries attributes", () => {
    /*
     * `<VehicleActivity>` and `<VehicleActivity xmlns="…">` are the same element, and a scan that
     * matched only the bare form would return an empty viewport — a map with no buses on it, from
     * a feed full of them.
     */
    const xml = feed([one()]).replace(
      "<VehicleActivity>",
      '<VehicleActivity xmlns:x="urn:x" x:seq="1">',
    );
    expect(scanOf(xml).vehicles).toHaveLength(1);

    const inner = feed([one()]).replace("<Latitude>", '<Latitude units="degrees">');
    expect(scanOf(inner).vehicles[0]!.lat).toBe(53.7965);
  });

  it("does not match a longer tag that ends with the name it wants", () => {
    const xml = feed([
      one({
        VehicleLocation:
          "<GridLatitude>99.9</GridLatitude><Longitude>-1.5379</Longitude><Latitude>53.7965</Latitude>",
      }),
    ]);
    expect(scanOf(xml).vehicles[0]!.lat, "GridLatitude is not Latitude").toBe(53.7965);
  });

  it("decodes the predefined XML entities in passenger text", () => {
    const xml = feed([one({ DestinationName: "Bath &amp; Wells" })]);
    expect(scanOf(xml).vehicles[0]!.destinationName).toBe("Bath & Wells");
  });

  it("never reads a field from the next vehicle", () => {
    /*
     * The failure a text scan has and a DOM parser does not. The first activity has no bearing and
     * no line name; without a bound on the search it would borrow the second one's and show a bus
     * pointing the wrong way on a route it is not running.
     */
    const xml = feed([
      one({ Bearing: "", PublishedLineName: "", LineRef: "", VehicleRef: "A-1" }),
      one({ Bearing: "90", PublishedLineName: "99", LineRef: "99", VehicleRef: "B-2" }),
    ]);
    const scan = scanOf(xml);
    expect(scan.vehicles).toHaveLength(2);
    const first = scan.vehicles.find((v) => v.vehicleRef === opaqueVehicleRef("A-1", SALT))!;
    expect(first.bearingDegrees).toBeUndefined();
    expect(first.publishedLineName).toBeUndefined();
    const second = scan.vehicles.find((v) => v.vehicleRef === opaqueVehicleRef("B-2", SALT))!;
    expect(second.bearingDegrees).toBe(90);
    expect(second.publishedLineName).toBe("99");
  });

  it("falls back to LineRef when there is no published name", () => {
    const xml = feed([one({ PublishedLineName: "" })]);
    expect(scanOf(xml).vehicles[0]!.publishedLineName).toBe("72");
  });
});

describe("what the scan refuses, and why", () => {
  const rejects = (overrides: Record<string, string>, reason: string, options = {}) => {
    const scan = scanOf(feed([one(overrides)]), options);
    expect(scan.vehicles, reason).toHaveLength(0);
    expect(scan.rejected[reason], JSON.stringify(scan.rejected)).toBe(1);
    expect(scan.rejectedCount).toBe(1);
  };

  it("refuses a vehicle with no reference", () =>
    rejects({ VehicleRef: "" }, "missing VehicleRef"));

  it("refuses a position outside England", () =>
    rejects(
      { VehicleLocation: "<Longitude>2.35</Longitude><Latitude>48.85</Latitude>" },
      "implausible coordinate",
    ));

  it("refuses a position that will not parse", () =>
    rejects(
      { VehicleLocation: "<Longitude>x</Longitude><Latitude>y</Latitude>" },
      "implausible coordinate",
    ));

  it("refuses a timestamp it cannot read", () =>
    rejects({ RecordedAtTime: "not-a-time" }, "unparseable RecordedAtTime"));

  it("refuses an observation older than the budget", () =>
    rejects({ RecordedAtTime: "2026-09-02T08:00:00Z" }, "observation too old"));

  it("refuses a timestamp from a broken producer clock", () =>
    rejects({ RecordedAtTime: "2026-09-02T09:30:00Z" }, "observation timestamp in the future"));

  it("counts the age of every record it saw, accepted or not", () => {
    /*
     * "No buses because the feed was empty" and "no buses because every record was twenty minutes
     * old" are different faults, and the degradation message depends on telling them apart.
     */
    const xml = feed([one({ RecordedAtTime: "2026-09-02T08:00:00Z" }), one()]);
    const scan = scanOf(xml);
    expect(scan.recordAgeSeconds).toHaveLength(2);
    expect(scan.recordAgeSeconds).toContain(3605);
  });

  it("keeps only what is inside the viewport when asked", () => {
    const xml = feed([
      one({ VehicleRef: "IN-1" }),
      one({
        VehicleRef: "OUT-1",
        VehicleLocation: "<Longitude>-2.24</Longitude><Latitude>53.48</Latitude>",
      }),
    ]);
    const scan = scanOf(xml, {
      within: { west: -1.6, east: -1.5, south: 53.7, north: 53.85 },
    });
    expect(scan.vehicles).toHaveLength(1);
    expect(scan.rejected["outside the viewport"]).toBe(1);
  });

  it("stops at the caller's limit and says the list is partial", () => {
    const xml = feed([
      one({ VehicleRef: "A" }),
      one({ VehicleRef: "B" }),
      one({ VehicleRef: "C" }),
    ]);
    const scan = scanOf(xml, { limit: 2 });
    expect(scan.vehicles).toHaveLength(2);
    expect(scan.truncated).toBe(true);
    expect(scanOf(xml).truncated).toBe(false);
  });

  it("returns nothing, and says so, for a document with no activities", () => {
    const scan = scanOf(feed([]));
    expect(scan.vehicles).toHaveLength(0);
    expect(scan.responseTimestamp).toBe("2026-09-02T09:00:05Z");
  });

  it("does not throw on a truncated document", () => {
    const xml = feed([one()]).slice(0, 400);
    expect(() => scanOf(xml)).not.toThrow();
  });
});

describe("the folded salt", () => {
  it("hashes identically to the one-shot form", () => {
    const hash = vehicleRefHasher(SALT);
    for (const id of ["FLEE-30412", "", "a", "x".repeat(200), "Köln-1", "歐洲-2"]) {
      expect(hash(id), id).toBe(opaqueVehicleRef(id, SALT));
    }
  });

  it("is still salted, so the same vehicle differs between days", () => {
    expect(vehicleRefHasher("monday")("FLEE-1")).not.toBe(vehicleRefHasher("tuesday")("FLEE-1"));
  });

  it("never republishes the operator's own code", () => {
    const scan = scanned();
    for (const vehicle of scan.vehicles) {
      expect(vehicle.vehicleRef).not.toContain("FLEE");
      expect(fixture).toContain("FLEE-");
    }
  });
});
