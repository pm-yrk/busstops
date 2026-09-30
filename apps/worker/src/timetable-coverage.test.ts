import { describe, expect, it } from "vitest";
import { serviceDatesForBoard } from "./stop-departures.js";

/**
 * The board must never report a gap in our data as a fact about the bus service.
 *
 * "No departures in the next hour" is a statement about buses, and a passenger standing at a
 * stop reads it as "don't wait here". It was being shown in two completely different situations:
 * the timetable is published and has nothing due, and no timetable for today was ever published.
 *
 * The second is what Matt saw. Departure shards are keyed `departures/<serviceDate>/<bucket>`
 * and the national build publishes exactly `[today, tomorrow]`, so an artifact more than a day
 * or two old has no shard for today and every stop outside London reads a key that is absent.
 * Proven by run 73: a same-day artifact on 26 September returned real departures at eight
 * stops across England, and the identical code returned none four days later.
 */

describe("the service dates a board asks for", () => {
  it("spans yesterday, today and tomorrow, which is what makes it safe across BST", () => {
    /*
     * The one-hour bug this guards against. London is UTC+1 in summer, so just after midnight
     * BST is still *yesterday* in UTC — 00:30 on 1 July BST is 23:30 on 30 June UTC. A board
     * that asked only for the UTC date would look for a shard that does not describe the day the
     * passenger is standing in.
     *
     * Asking for the day either side costs two extra reads and makes the question unanswerable
     * wrongly: whichever side of midnight either clock is on, the right shard is in the set.
     */
    const midnightBst = new Date("2026-06-30T23:30:00.000Z"); // 00:30 on 1 July, London time
    expect(serviceDatesForBoard(midnightBst)).toEqual(["2026-06-29", "2026-06-30", "2026-07-01"]);

    // And in winter, when London is UTC, the same span still brackets the day.
    const winter = new Date("2026-01-15T00:30:00.000Z");
    expect(serviceDatesForBoard(winter)).toEqual(["2026-01-14", "2026-01-15", "2026-01-16"]);
  });

  it("always offers the day the passenger is in, on both sides of the BST boundary", () => {
    /*
     * Walked across the spring-forward instant an hour at a time. The London date at every one
     * of these moments must be among the dates the board asks for, or a passenger somewhere gets
     * an empty board on a day the buses are running.
     */
    for (let hour = 0; hour < 48; hour += 1) {
      const at = new Date(Date.parse("2026-03-28T00:00:00.000Z") + hour * 3_600_000);
      const londonDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(at);
      expect(
        serviceDatesForBoard(at),
        `London date ${londonDate} at ${at.toISOString()}`,
      ).toContain(londonDate);
    }
  });

  it("does the same across the autumn fall-back", () => {
    for (let hour = 0; hour < 48; hour += 1) {
      const at = new Date(Date.parse("2026-10-24T00:00:00.000Z") + hour * 3_600_000);
      const londonDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(at);
      expect(serviceDatesForBoard(at)).toContain(londonDate);
    }
  });
});
