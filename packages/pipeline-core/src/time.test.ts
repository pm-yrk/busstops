import { describe, expect, it } from "vitest";
import {
  baselineWindowStartMinute,
  countdownLabel,
  formatLondonTime,
  freshnessLabel,
  isBritishSummerTime,
  londonDateString,
  londonMinuteOfDay,
  londonOffsetMinutes,
  resolveScheduledInstant,
  serviceDate,
  weekdayType,
} from "./time.js";

describe("London offset and DST", () => {
  it("is GMT in winter and BST in summer", () => {
    expect(londonOffsetMinutes(new Date("2026-01-15T12:00:00Z"))).toBe(0);
    expect(londonOffsetMinutes(new Date("2026-07-15T12:00:00Z"))).toBe(60);
    expect(isBritishSummerTime(new Date("2026-07-15T12:00:00Z"))).toBe(true);
    expect(isBritishSummerTime(new Date("2026-01-15T12:00:00Z"))).toBe(false);
  });

  it("switches at the correct 2026 transition instants", () => {
    // BST begins 01:00 UTC on 29 March 2026; ends 02:00 local (01:00 UTC) 25 October 2026.
    expect(londonOffsetMinutes(new Date("2026-03-29T00:59:00Z"))).toBe(0);
    expect(londonOffsetMinutes(new Date("2026-03-29T01:01:00Z"))).toBe(60);
    expect(londonOffsetMinutes(new Date("2026-10-25T00:59:00Z"))).toBe(60);
    expect(londonOffsetMinutes(new Date("2026-10-25T01:01:00Z"))).toBe(0);
  });
});

describe("local date and service date", () => {
  it("uses the London calendar date, not the UTC one", () => {
    // 23:30 UTC in July is 00:30 the next day in London.
    expect(londonDateString(new Date("2026-07-14T23:30:00Z"))).toBe("2026-07-15");
  });

  it("assigns an after-midnight journey to the previous service day", () => {
    expect(serviceDate(new Date("2026-07-15T00:30:00+01:00"))).toBe("2026-07-14");
    expect(serviceDate(new Date("2026-07-15T03:59:00+01:00"))).toBe("2026-07-14");
  });

  it("assigns an early-morning journey after the boundary to the same day", () => {
    expect(serviceDate(new Date("2026-07-15T04:01:00+01:00"))).toBe("2026-07-15");
    expect(serviceDate(new Date("2026-07-15T09:00:00+01:00"))).toBe("2026-07-15");
  });
});

describe("weekday classification", () => {
  it("classifies weekday, Saturday and Sunday", () => {
    expect(weekdayType(new Date("2026-09-02T09:00:00Z"))).toBe("weekday"); // Wednesday
    expect(weekdayType(new Date("2026-09-05T09:00:00Z"))).toBe("saturday");
    expect(weekdayType(new Date("2026-09-06T09:00:00Z"))).toBe("sunday_or_holiday");
  });

  it("treats a bank holiday as Sunday-type for baseline comparison", () => {
    expect(weekdayType(new Date("2026-12-25T09:00:00Z"))).toBe("sunday_or_holiday");
  });
});

describe("resolveScheduledInstant", () => {
  it("resolves a normal winter time as GMT", () => {
    const instant = resolveScheduledInstant("2026-01-15", "09:30");
    expect(instant.toISOString()).toBe("2026-01-15T09:30:00.000Z");
  });

  it("resolves a summer time through the BST offset", () => {
    const instant = resolveScheduledInstant("2026-07-15", "09:30");
    expect(instant.toISOString()).toBe("2026-07-15T08:30:00.000Z");
  });

  it("handles timetable times past midnight (25:10 on the service date)", () => {
    const instant = resolveScheduledInstant("2026-07-14", "25:10");
    // 01:10 local on 15 July, which is 00:10 UTC in BST.
    expect(instant.toISOString()).toBe("2026-07-15T00:10:00.000Z");
  });

  it("resolves a time on the spring-forward morning without landing in the skipped hour", () => {
    // 01:30 local does not exist on 29 March 2026; the resolver must still yield a real instant.
    const instant = resolveScheduledInstant("2026-03-29", "01:30");
    expect(Number.isNaN(instant.getTime())).toBe(false);
    expect(instant.toISOString()).toMatch(/^2026-03-29T0[01]:30/);
  });

  it("resolves a time on the autumn fall-back morning", () => {
    const instant = resolveScheduledInstant("2026-10-25", "01:30");
    expect(Number.isNaN(instant.getTime())).toBe(false);
  });

  it("rejects a malformed time rather than guessing", () => {
    expect(() => resolveScheduledInstant("2026-01-15", "nine-thirty")).toThrow(
      /Invalid time of day/,
    );
  });
});

describe("baseline windows", () => {
  it("buckets into 15-minute windows of the local day", () => {
    const instant = new Date("2026-07-15T08:37:00Z"); // 09:37 London
    expect(londonMinuteOfDay(instant)).toBe(9 * 60 + 37);
    expect(baselineWindowStartMinute(instant)).toBe(9 * 60 + 30);
  });
});

describe("countdown labels", () => {
  const now = new Date("2026-09-02T08:00:00Z");

  it("never shows a negative countdown", () => {
    expect(countdownLabel(new Date("2026-09-02T07:58:00Z"), now)).toBe("Due");
  });

  it("shows Due inside the final 30 seconds", () => {
    expect(countdownLabel(new Date("2026-09-02T08:00:20Z"), now)).toBe("Due");
  });

  it("shows singular and plural minutes", () => {
    expect(countdownLabel(new Date("2026-09-02T08:01:00Z"), now)).toBe("1 min");
    expect(countdownLabel(new Date("2026-09-02T08:07:00Z"), now)).toBe("7 mins");
  });

  it("falls back to clock time beyond 90 minutes rather than implying false precision", () => {
    const label = countdownLabel(new Date("2026-09-02T10:30:00Z"), now);
    expect(label).toBe("11:30");
  });
});

describe("display formatting", () => {
  it("formats London clock time with DST applied", () => {
    expect(formatLondonTime(new Date("2026-07-15T08:30:00Z"))).toBe("09:30");
    expect(formatLondonTime(new Date("2026-01-15T09:30:00Z"))).toBe("09:30");
  });

  it("describes freshness in human terms", () => {
    expect(freshnessLabel(5)).toBe("just now");
    expect(freshnessLabel(45)).toBe("45 seconds ago");
    expect(freshnessLabel(60)).toBe("1 minute ago");
    expect(freshnessLabel(600)).toBe("10 minutes ago");
    expect(freshnessLabel(3600)).toBe("1 hour ago");
  });
});
