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

  it("never gives back an empty name", () => {
    expect(servicePublicName(undefined, undefined, "___")).toBe("___");
    expect(servicePublicName("", "", "r7")).toBe("r7");
  });
});
