import { describe, expect, it } from "vitest";
import { MAX_ROUTE_NAME_LENGTH, servicePublicName } from "./gtfs-network.js";

/*
 * The route badge on a departure board. England's real archive produced
 * "Golden_Tours_Hop_On_Hop_Off" at York Rail Station — a GTFS route_id rendered as a service
 * number, in a badge sized for three characters, telling a passenger to look out for a bus that
 * does not exist under that name.
 */
describe("the name a departure board puts in the route badge", () => {
  it("uses the number on the front of the bus when the feed publishes one", () => {
    expect(servicePublicName("36", "Leeds - Ripon - Newcastle", "ARR_36_IN")).toBe("36");
    expect(servicePublicName("X84", undefined, "FIRST_X84")).toBe("X84");
    // Whitespace in a feed is not a name.
    expect(servicePublicName("  1A  ", undefined, "r1")).toBe("1A");
  });

  it("falls back to the description before the identifier", () => {
    expect(servicePublicName(undefined, "Airport Shuttle", "YSS_AIR_01")).toBe("Airport Shuttle");
    expect(servicePublicName("", "Airport Shuttle", "YSS_AIR_01")).toBe("Airport Shuttle");
  });

  /* The real one. An id is the last resort and must not arrive looking like a key. */
  it("humanises an identifier rather than showing it raw", () => {
    expect(servicePublicName(undefined, undefined, "Golden_Tours_Hop_On_Hop_Off")).toBe(
      "Golden Tours Hop On Hop",
    );
    expect(servicePublicName(undefined, undefined, "ARR-36")).toBe("ARR 36");
    expect(servicePublicName(undefined, undefined, "op.route:7")).toBe("op route 7");
  });

  it("never returns something too long for the badge it goes in", () => {
    const long = servicePublicName(
      undefined,
      "The Coastal Express Between Scarborough And Whitby",
      "x",
    );
    expect(long.length).toBeLessThanOrEqual(MAX_ROUTE_NAME_LENGTH);
    // Cut at a word, not mid-syllable.
    expect(long.endsWith(" ")).toBe(false);
    expect(long).toBe("The Coastal Express");
  });

  it("takes a hard cut rather than returning almost nothing", () => {
    // One word longer than the badge: breaking at the (absent) space would leave an empty string.
    const single = servicePublicName(undefined, undefined, "Llanfairpwllgwyngyllgogerychwyrn");
    expect(single.length).toBe(MAX_ROUTE_NAME_LENGTH);
  });

  /*
   * The one run 37 actually failed on. The first fix cleaned `route_id` and trusted the name
   * columns; York's board then served `Golden_Tours_Hop_On_Hop_Off` from a rebuilt national
   * artifact, because that feed puts its key in `route_short_name`. Against the old function
   * every assertion in this block fails — the first returns the raw twenty-seven characters.
   */
  it("cleans an identifier that arrived in the column meant for the number", () => {
    expect(servicePublicName("Golden_Tours_Hop_On_Hop_Off", undefined, "GT1")).toBe(
      "Golden Tours Hop On Hop",
    );
    expect(servicePublicName(undefined, "PARK_AND_RIDE", "x")).toBe("PARK AND RIDE");
    expect(servicePublicName("FIRST:X84", undefined, "x")).toBe("FIRST X84");
  });

  it("caps every column at the badge, not only the description and the identifier", () => {
    for (const [short, long, id] of [
      ["The Sightseeing Circular Tour Of The City", undefined, "a"],
      [undefined, "The Sightseeing Circular Tour Of The City", "b"],
      [undefined, undefined, "The_Sightseeing_Circular_Tour_Of_The_City"],
    ] as Array<[string | undefined, string | undefined, string]>) {
      const name = servicePublicName(short, long, id);
      expect(name.length).toBeLessThanOrEqual(MAX_ROUTE_NAME_LENGTH);
      expect(name).not.toMatch(/[_:]/);
      expect(name.trim()).toBe(name);
    }
  });

  it("leaves a real number and a real description alone", () => {
    // The cleaning must not be something a passenger can see happening to an ordinary name.
    expect(servicePublicName("36", undefined, "x")).toBe("36");
    expect(servicePublicName("X84", undefined, "x")).toBe("X84");
    expect(servicePublicName("1A", undefined, "x")).toBe("1A");
    expect(servicePublicName("Park & Ride", undefined, "x")).toBe("Park & Ride");
    expect(servicePublicName(undefined, "Leeds - Ripon", "x")).toBe("Leeds - Ripon");
  });

  it("never gives back an empty name", () => {
    expect(servicePublicName(undefined, undefined, "___")).toBe("___");
    expect(servicePublicName("", "", "r7")).toBe("r7");
  });
});
