import { describe, expect, it, beforeEach } from "vitest";
import { RAW_TRACE_MAX_AGE_HOURS } from "@busstops/pipeline-core";
import {
  countdownLabel,
  degradationMessage,
  delayLabel,
  distanceLabel,
  formatLondonTime,
  freshnessLabel,
  walkingMinutes,
} from "./format.js";
import {
  addFavourite,
  clearFavourites,
  exportFavourites,
  isFavourited,
  listFavourites,
  removeFavourite,
  toggleFavourite,
} from "./favourites.js";
import {
  appleMapsWalkingUrl,
  googleMapsWalkingUrl,
  suggestPlatform,
  walkingUrlFor,
} from "./navigation-handoff.js";
import { TICKET_REGISTRY, isAllowedTicketDomain, ticketLinkFor } from "./tickets.js";
import {
  clampBoundsToMaxArea,
  boundsArea,
  boundsFromParam,
  haversineMetresBrowser,
  vehicleHref,
} from "./geo.js";
import { RAW_TRACE_MAX_AGE_HOURS_DISPLAY } from "./constants.js";
import { arrivalIntervalSeconds, nextUsefulService, willIMakeIt } from "./will-i-make-it.js";
import { assessBusStopped, STATIONARY_SUGGESTION_SECONDS } from "./bus-stopped.js";
import type { Confidence, DeparturePrediction, VehicleState } from "@busstops/contracts";

const confidence: Confidence = { level: "medium", score: 0.6, reasons: ["test"] };

describe("formatting", () => {
  const now = new Date("2026-09-02T08:00:00Z");

  it("never shows a negative countdown", () => {
    expect(countdownLabel(new Date("2026-09-02T07:55:00Z"), now)).toBe("Due");
  });

  it("shows minutes, then falls back to clock time beyond 90 minutes", () => {
    expect(countdownLabel(new Date("2026-09-02T08:05:00Z"), now)).toBe("5 mins");
    expect(countdownLabel(new Date("2026-09-02T10:00:00Z"), now)).toBe("11:00");
  });

  it("formats London time with DST applied", () => {
    expect(formatLondonTime(new Date("2026-07-15T08:30:00Z"))).toBe("09:30");
  });

  it("phrases delay without double negatives", () => {
    expect(delayLabel(180)).toBe("3 minutes late");
    expect(delayLabel(-180)).toBe("3 minutes early");
    expect(delayLabel(20)).toBe("On time");
    expect(delayLabel(null)).toBe("Delay unknown");
  });

  it("describes distance and walking time sensibly", () => {
    expect(distanceLabel(40)).toBe("40 m");
    expect(distanceLabel(1500)).toBe("1.5 km");
    expect(walkingMinutes(0)).toBe(1);
    expect(walkingMinutes(780)).toBe(10);
  });

  it("describes freshness in human terms", () => {
    expect(freshnessLabel(5)).toBe("just now");
    expect(freshnessLabel(120)).toBe("2 minutes ago");
  });

  it("gives a plain sentence for each degraded state, and nothing when normal", () => {
    expect(degradationMessage("normal")).toBeNull();
    expect(degradationMessage("scheduled_only")).toMatch(/timetabled times/);
    expect(degradationMessage("safe_mode")).toMatch(/safe mode/);
  });
});

describe("favourites", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it("adds, lists and removes without an account", () => {
    expect(listFavourites()).toEqual([]);
    addFavourite({ kind: "stop", id: "450010001", title: "Leeds City Bus Station" });
    expect(isFavourited("stop", "450010001")).toBe(true);
    expect(listFavourites()).toHaveLength(1);

    removeFavourite("stop", "450010001");
    expect(isFavourited("stop", "450010001")).toBe(false);
  });

  it("toggles and does not duplicate", () => {
    toggleFavourite({ kind: "stop", id: "A", title: "A" });
    toggleFavourite({ kind: "stop", id: "A", title: "A" });
    expect(listFavourites()).toHaveLength(0);

    addFavourite({ kind: "stop", id: "A", title: "A" });
    addFavourite({ kind: "stop", id: "A", title: "A" });
    expect(listFavourites()).toHaveLength(1);
  });

  it("exports and clears everything", () => {
    addFavourite({ kind: "stop", id: "A", title: "A" });
    expect(JSON.parse(exportFavourites()).favourites).toHaveLength(1);
    clearFavourites();
    expect(listFavourites()).toEqual([]);
  });

  it("survives corrupted storage rather than breaking the page", () => {
    globalThis.localStorage.setItem("busstops.favourites.v1", "not json");
    expect(listFavourites()).toEqual([]);
  });

  it("ignores records that are not favourites", () => {
    globalThis.localStorage.setItem("busstops.favourites.v1", JSON.stringify([{ nope: true }]));
    expect(listFavourites()).toEqual([]);
  });
});

describe("navigation handoff", () => {
  const stop = { lat: 53.7965, lon: -1.5379, label: "Leeds City Bus Station" };

  it("builds a walking-mode Google Maps URL", () => {
    const url = googleMapsWalkingUrl(stop)!;
    expect(url).toContain("travelmode=walking");
    expect(url).toContain("destination=53.796500%2C-1.537900");
  });

  it("builds a walking-mode Apple Maps URL", () => {
    const url = appleMapsWalkingUrl(stop)!;
    expect(url).toContain("dirflg=w");
    expect(url).toContain("daddr=53.796500%2C-1.537900");
  });

  it("encodes labels so a stop name cannot break out of the URL", () => {
    const url = appleMapsWalkingUrl({ ...stop, label: "Stop A & B?query=x" })!;
    expect(url).not.toContain("&query=x");
    expect(url).toContain("%26");
  });

  it("refuses invalid coordinates rather than producing a broken link", () => {
    expect(googleMapsWalkingUrl({ lat: 999, lon: 0 })).toBeNull();
    expect(appleMapsWalkingUrl({ lat: Number.NaN, lon: 0 })).toBeNull();
  });

  it("suggests a platform from the user agent but allows either", () => {
    expect(suggestPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("apple");
    expect(suggestPlatform("Mozilla/5.0 (Linux; Android 14)")).toBe("google");
    expect(walkingUrlFor("google", stop)).toContain("google.com");
    expect(walkingUrlFor("apple", stop)).toContain("maps.apple.com");
  });
});

describe("ticket links", () => {
  it("allows only https URLs on allowlisted domains", () => {
    expect(isAllowedTicketDomain("https://www.firstbus.co.uk/tickets")).toBe(true);
    expect(isAllowedTicketDomain("http://www.firstbus.co.uk/tickets")).toBe(false);
    expect(isAllowedTicketDomain("https://evil.example/tickets")).toBe(false);
    expect(isAllowedTicketDomain("javascript:alert(1)")).toBe(false);
    expect(isAllowedTicketDomain("not a url")).toBe(false);
  });

  it("returns no link while the registry is unverified, rather than guessing one", () => {
    expect(ticketLinkFor("FLEE", "72")).toBeNull();
    expect(TICKET_REGISTRY).toHaveLength(0);
  });
});

describe("browser geometry", () => {
  it("measures distance consistently with the pipeline", () => {
    const metres = haversineMetresBrowser(
      { lat: 53.7955, lon: -1.5491 },
      { lat: 53.7965, lon: -1.5379 },
    );
    expect(metres).toBeGreaterThan(720);
    expect(metres).toBeLessThan(790);
  });

  it("shrinks an oversized viewport around its centre instead of sending a rejected request", () => {
    const england = { west: -6.5, south: 49.8, east: 2.1, north: 55.9 };
    const clamped = clampBoundsToMaxArea(england, 1.5);
    expect(boundsArea(clamped)).toBeLessThanOrEqual(1.5001);

    // The centre is preserved, so the user keeps looking at what they were looking at.
    expect((clamped.north + clamped.south) / 2).toBeCloseTo((england.north + england.south) / 2, 6);
    expect((clamped.east + clamped.west) / 2).toBeCloseTo((england.east + england.west) / 2, 6);
  });

  it("leaves a viewport within the cap untouched", () => {
    const city = { west: -1.6, south: 53.7, east: -1.5, north: 53.85 };
    expect(clampBoundsToMaxArea(city, 1.5)).toEqual(city);
  });
});

/*
 * The dead end every route page led to.
 *
 * `/v1/vehicles/:ref` needs a viewport because the live feeds are area-scoped. That is a fact
 * about the upstream. Requiring the *caller* to have a map viewport was a design choice, and it
 * meant the route page — which has vehicle coordinates and no map — sent every "buses running
 * now" link to "This link needs a map area".
 */
describe("links to a bus", () => {
  it("prefers the viewport the bus was actually seen in", () => {
    const href = vehicleHref("v-1", {
      bounds: { west: -1.6, south: 53.7, east: -1.5, north: 53.85 },
      coordinate: { lat: 53.8, lon: -1.55 },
    });
    expect(href).toContain("/vehicles/v-1?bbox=");
    expect(boundsFromParam(decodeURIComponent(href.split("bbox=")[1]!))).toEqual({
      west: -1.6,
      south: 53.7,
      east: -1.5,
      north: 53.85,
    });
  });

  it("builds a box from the bus's own position when there is no map to borrow one from", () => {
    const href = vehicleHref("v-2", { coordinate: { lat: 53.8, lon: -1.55 } });
    const bounds = boundsFromParam(decodeURIComponent(href.split("bbox=")[1]!));
    expect(bounds).not.toBeNull();
    expect(bounds!.west).toBeLessThan(-1.55);
    expect(bounds!.east).toBeGreaterThan(-1.55);
    expect(bounds!.south).toBeLessThan(53.8);
    expect(bounds!.north).toBeGreaterThan(53.8);
    // Inside the API's maximum area, or the request it produces is rejected instead of answered.
    expect(boundsArea(bounds!)).toBeLessThan(1.5);
  });

  it("escapes a reference rather than pasting it into a path", () => {
    expect(vehicleHref("a/b c", { coordinate: { lat: 53.8, lon: -1.55 } })).toContain(
      "/vehicles/a%2Fb%20c?",
    );
  });

  it("refuses a bbox that is not four numbers in the right order", () => {
    expect(boundsFromParam(null)).toBeNull();
    expect(boundsFromParam("1,2,3")).toBeNull();
    expect(boundsFromParam("a,b,c,d")).toBeNull();
    // East of west and north of south, or the box is inside out.
    expect(boundsFromParam("-1.5,53.7,-1.6,53.85")).toBeNull();
    expect(boundsFromParam("-1.6,53.85,-1.5,53.7")).toBeNull();
    expect(boundsFromParam("-1.6,53.7,-1.5,53.85")).toEqual({
      west: -1.6,
      south: 53.7,
      east: -1.5,
      north: 53.85,
    });
  });
});

describe("privacy copy matches the enforced policy", () => {
  it("quotes the same raw-retention cap the pipeline enforces", () => {
    // If the policy changes, the promise shown to users changes with it.
    expect(RAW_TRACE_MAX_AGE_HOURS_DISPLAY).toBe(RAW_TRACE_MAX_AGE_HOURS);
  });
});

function departure(overrides: Partial<DeparturePrediction> = {}): DeparturePrediction {
  return {
    id: "00000000-0000-5000-8000-00000000aaaa",
    provenance: { source: "tfl", retrievedAt: "2026-09-02T08:00:00.000Z", externalIds: [] },
    ingestedAt: "2026-09-02T08:00:00.000Z",
    qualityFlags: [],
    stopId: "00000000-0000-5000-8000-00000000bbbb",
    scheduledJourneyId: null,
    routePatternId: null,
    serviceRoutePublicName: "72",
    destinationName: "Bradford",
    scheduledTime: null,
    expectedTime: "2026-09-02T08:10:00.000Z",
    liveState: "live",
    uncertaintySeconds: 60,
    confidence,
    ...overrides,
  };
}

describe("will I make it?", () => {
  const now = new Date("2026-09-02T08:00:00Z");

  it("says you should make it with comfortable spare time", () => {
    const result = willIMakeIt({
      walkingSeconds: 180,
      arrivalLowSeconds: 540,
      arrivalHighSeconds: 660,
      confidence,
    });
    expect(result.verdict).toBe("should_make_it");
    expect(result.headline).toBe("You should make it");
    expect(result.detail).toMatch(/to spare/);
  });

  it("says it may be tight when only the optimistic case works", () => {
    const result = willIMakeIt({
      walkingSeconds: 300,
      arrivalLowSeconds: 330,
      arrivalHighSeconds: 420,
      confidence,
    });
    expect(result.verdict).toBe("tight");
  });

  it("says you'll probably miss it when even the latest arrival is too soon", () => {
    const result = willIMakeIt({
      walkingSeconds: 600,
      arrivalLowSeconds: 120,
      arrivalHighSeconds: 240,
      confidence,
    });
    expect(result.verdict).toBe("probably_miss");
    expect(result.detail).toMatch(/short/);
  });

  it("derives the arrival interval from the prediction's own uncertainty", () => {
    const interval = arrivalIntervalSeconds(departure(), now)!;
    expect(interval.low).toBe(540);
    expect(interval.high).toBe(660);
  });

  it("never returns a negative interval for a bus that is already due", () => {
    const interval = arrivalIntervalSeconds(
      departure({ expectedTime: "2026-09-02T07:59:00.000Z" }),
      now,
    )!;
    expect(interval.low).toBeGreaterThanOrEqual(0);
  });

  it("finds the next useful service and skips cancellations", () => {
    const first = departure({ id: "00000000-0000-5000-8000-00000000aaa1" });
    const cancelled = departure({
      id: "00000000-0000-5000-8000-00000000aaa2",
      expectedTime: "2026-09-02T08:15:00.000Z",
      liveState: "cancelled",
    });
    const next = departure({
      id: "00000000-0000-5000-8000-00000000aaa3",
      expectedTime: "2026-09-02T08:25:00.000Z",
    });

    expect(nextUsefulService([first, cancelled, next], first)?.id).toBe(next.id);
  });

  it("returns null when there is no later service", () => {
    const only = departure();
    expect(nextUsefulService([only], only)).toBeNull();
  });
});

describe("bus stopped?", () => {
  const baseVehicle: VehicleState = {
    id: "00000000-0000-5000-8000-00000000cccc",
    provenance: { source: "bods", retrievedAt: "2026-09-02T08:00:00.000Z", externalIds: [] },
    ingestedAt: "2026-09-02T08:00:00.000Z",
    qualityFlags: [],
    vehicleRef: "abc",
    matchedRoutePatternId: null,
    matchedScheduledJourneyId: null,
    position: { lat: 53.8, lon: -1.55 },
    delaySeconds: 300,
    motionState: "stationary",
    nextStopId: null,
    freshnessSeconds: 300,
    matchConfidence: confidence,
  };

  const now = new Date("2026-09-02T08:05:00Z");

  it("never claims a breakdown or cancellation", () => {
    const assessment = assessBusStopped({
      vehicle: baseVehicle,
      otherVehiclesMoving: true,
      otherVehiclesObserved: 3,
      incidents: [],
      nearEndOfRoute: false,
      now,
    });
    const text = JSON.stringify(assessment);
    expect(text).not.toMatch(/broken down|breakdown|cancelled/i);
  });

  it("enumerates several plausible states rather than picking one", () => {
    const assessment = assessBusStopped({
      vehicle: baseVehicle,
      otherVehiclesMoving: false,
      otherVehiclesObserved: 2,
      incidents: [],
      nearEndOfRoute: true,
      now,
    });
    expect(assessment.plausibleStates.length).toBeGreaterThan(1);
    expect(assessment.plausibleStates.map((s) => s.explanation)).toContain("terminus_or_layover");
    expect(assessment.plausibleStates.map((s) => s.explanation)).toContain("congestion");
  });

  it("marks an official incident as official and everything else as not", () => {
    const assessment = assessBusStopped({
      vehicle: baseVehicle,
      otherVehiclesMoving: false,
      otherVehiclesObserved: 1,
      incidents: [
        {
          id: "00000000-0000-5000-8000-00000000dddd",
          provenance: { source: "tfl", retrievedAt: "2026-09-02T08:00:00.000Z", externalIds: [] },
          ingestedAt: "2026-09-02T08:00:00.000Z",
          qualityFlags: [],
          type: "road_closure",
          startedAt: "2026-09-02T07:30:00.000Z",
          endedAt: null,
          geometry: { corridorId: "x" },
          affectedRouteIds: [],
          affectedVehicleRefs: [],
          severity: "elevated",
          confidence: { level: "high", score: 0.9, reasons: [] },
          evidence: [],
          officialStatus: "official",
          lifecycle: "active",
          narrative: "Road closed for emergency repairs.",
        },
      ],
      nearEndOfRoute: false,
      now,
    });

    const official = assessment.plausibleStates.filter((s) => s.official);
    expect(official).toHaveLength(1);
    expect(official[0]?.explanation).toBe("official_incident");
  });

  it("suggests the panel only once a bus has been stationary long enough", () => {
    const brief = assessBusStopped({
      vehicle: { ...baseVehicle, freshnessSeconds: 30 },
      otherVehiclesMoving: null,
      otherVehiclesObserved: 0,
      incidents: [],
      nearEndOfRoute: false,
      now,
    });
    expect(brief.suggestPanel).toBe(false);

    const sustained = assessBusStopped({
      vehicle: { ...baseVehicle, freshnessSeconds: STATIONARY_SUGGESTION_SECONDS + 10 },
      otherVehiclesMoving: null,
      otherVehiclesObserved: 0,
      incidents: [],
      nearEndOfRoute: false,
      now,
    });
    expect(sustained.suggestPanel).toBe(true);
  });

  it("always offers at least one explanation, even with nothing to go on", () => {
    const assessment = assessBusStopped({
      vehicle: null,
      otherVehiclesMoving: null,
      otherVehiclesObserved: 0,
      incidents: [],
      nearEndOfRoute: false,
      now,
    });
    expect(assessment.plausibleStates).toHaveLength(1);
    expect(assessment.plausibleStates[0]?.explanation).toBe("gps_problem");
  });
});

/*
 * "Bus Stopped?" could not reason, by construction.
 *
 * The vehicle page passed `otherVehiclesMoving={null}`, `otherVehiclesObserved={0}`,
 * `nextServices={[]}` and `alternativeStop={null}` — hard-coded — so every branch that
 * distinguishes a jam from a breakdown was unreachable and a passenger was always told "we cannot
 * tell why from the data available". These are the branches the real context unlocks.
 */
describe("bus stopped, with the context it was never given", () => {
  const stationary = {
    vehicleRef: "v1",
    motionState: "stationary" as const,
    freshnessSeconds: 30,
    delaySeconds: 600,
    position: { lat: 53.8, lon: -1.55 },
    matchedRoutePatternId: null,
    matchedScheduledJourneyId: null,
    nextStopId: null,
    matchConfidence: { level: "high" as const, reasons: [] },
  };
  const base = {
    vehicle: stationary as never,
    incidents: [],
    nearEndOfRoute: false,
    now: new Date("2026-09-18T09:00:00.000Z"),
  };

  it("calls a street full of stopped buses congestion rather than one stopped bus", () => {
    const assessment = assessBusStopped({
      ...base,
      otherVehiclesMoving: false,
      otherVehiclesObserved: 4,
    });
    expect(assessment.plausibleStates.map((state) => state.explanation)).toContain("congestion");
    expect(assessment.plausibleStates.some((state) => state.supportedBy.includes("4"))).toBe(true);
  });

  it("says a stop looks specific to this bus when the others around it are moving", () => {
    const assessment = assessBusStopped({
      ...base,
      otherVehiclesMoving: true,
      otherVehiclesObserved: 4,
    });
    expect(assessment.summary.length).toBeGreaterThan(0);
    expect(assessment.plausibleStates.map((state) => state.explanation)).not.toContain(
      "congestion",
    );
  });

  /*
   * Zero buses nearby is not evidence that nothing is moving, which is why the page sends null
   * rather than false when it found no peers. Reading an empty street as a jam would invent a
   * cause out of an absence of data.
   */
  it("does not read an empty street as congestion", () => {
    const assessment = assessBusStopped({
      ...base,
      otherVehiclesMoving: null,
      otherVehiclesObserved: 0,
    });
    expect(assessment.plausibleStates.map((state) => state.explanation)).not.toContain(
      "congestion",
    );
  });
});
