import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RAW_TRACE_MAX_AGE_HOURS,
  RETENTION_CLASSES,
  evaluateExpiry,
  getRetentionClass,
  mandatoryExpiryClasses,
  pruningOrder,
} from "./retention.js";
import { StageRecorder, parseRecords } from "./quarantine.js";

describe("retention policy", () => {
  it("caps raw traces at 48 hours, with a 24-hour target", () => {
    expect(RAW_TRACE_MAX_AGE_HOURS).toBeLessThanOrEqual(48);
    expect(getRetentionClass("raw_trace")?.maxAgeHours).toBe(RAW_TRACE_MAX_AGE_HOURS);
  });

  it("expires a raw trace older than the cap", () => {
    const now = new Date("2026-09-02T12:00:00Z");
    const old = evaluateExpiry("raw_trace", "2026-08-31T00:00:00Z", now);
    expect(old.expired).toBe(true);
    const recent = evaluateExpiry("raw_trace", "2026-09-02T06:00:00Z", now);
    expect(recent.expired).toBe(false);
  });

  it("keeps aggregates for their documented horizons", () => {
    expect(getRetentionClass("aggregate_5min")?.maxAgeHours).toBe(30 * 24);
    expect(getRetentionClass("aggregate_15min")?.maxAgeHours).toBe(90 * 24);
    expect(getRetentionClass("aggregate_hourly")?.maxAgeHours).toBe(365 * 24);
  });

  it("rolls fine-grained data up before pruning it", () => {
    expect(getRetentionClass("raw_trace")?.rollUpTargetKey).toBe("aggregate_5min");
    expect(getRetentionClass("aggregate_5min")?.rollUpTargetKey).toBe("aggregate_15min");
    expect(getRetentionClass("aggregate_daily")?.rollUpBeforePruning).toBe(false);
  });

  it("prunes the largest, least valuable classes first", () => {
    const order = pruningOrder().map((c) => c.key);
    expect(order.indexOf("raw_trace")).toBeLessThan(order.indexOf("aggregate_daily"));
    expect(order.indexOf("aggregate_5min")).toBeLessThan(order.indexOf("aggregate_hourly"));
  });

  it("marks raw expiry as mandatory so it runs even under quota pressure", () => {
    const mandatory = mandatoryExpiryClasses().map((c) => c.key);
    expect(mandatory).toContain("raw_trace");
    expect(mandatory).toContain("vehicle_state_current");
  });

  it("defines no long-horizon raw class, so no Replay archive is possible", () => {
    for (const retentionClass of RETENTION_CLASSES) {
      if (retentionClass.key.startsWith("raw") || retentionClass.key.includes("trace")) {
        expect(retentionClass.maxAgeHours).toBeLessThanOrEqual(48);
      }
      expect(retentionClass.key).not.toMatch(/replay/i);
    }
  });

  it("throws on an unknown class rather than defaulting to keeping data", () => {
    expect(() => evaluateExpiry("mystery", "2026-09-02T00:00:00Z", new Date())).toThrow(
      /Unknown retention class/,
    );
  });
});

describe("quarantine", () => {
  const schema = z.object({ id: z.string(), lat: z.number() });

  it("accepts good records and quarantines bad ones without failing the job", () => {
    const outcome = parseRecords(
      [
        { id: "a", lat: 53.8 },
        { id: "b", lat: "not a number" },
        { id: "c", lat: 51.5 },
      ],
      schema,
    );
    expect(outcome.accepted).toHaveLength(2);
    expect(outcome.quarantined).toHaveLength(1);
    expect(outcome.quarantined[0]?.reason).toContain("lat");
    expect(outcome.quarantined[0]?.index).toBe(1);
  });

  it("flags suspected schema drift when a large share of a big batch is rejected", () => {
    const records = Array.from({ length: 100 }, (_, i) =>
      i < 40 ? { id: `x${i}` } : { id: `x${i}`, lat: 53 },
    );
    const outcome = parseRecords(records, schema);
    expect(outcome.rejectionRate).toBeCloseTo(0.4, 2);
    expect(outcome.schemaDriftSuspected).toBe(true);
  });

  it("does not call drift on a tiny batch, where the rate is noise", () => {
    const outcome = parseRecords([{ id: "a" }, { id: "b", lat: 53 }], schema);
    expect(outcome.schemaDriftSuspected).toBe(false);
  });

  it("bounds the quarantine so it never becomes a copy of the feed", () => {
    const records = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    const outcome = parseRecords(records, schema);
    expect(outcome.quarantined.length).toBeLessThanOrEqual(100);
    for (const record of outcome.quarantined) {
      expect(record.sample.length).toBeLessThanOrEqual(500);
    }
  });

  it("handles an empty batch without dividing by zero", () => {
    const outcome = parseRecords([], schema);
    expect(outcome.rejectionRate).toBe(0);
    expect(outcome.schemaDriftSuspected).toBe(false);
  });
});

describe("stage recorder", () => {
  it("records counts, rejections and timing per stage", async () => {
    const recorder = new StageRecorder();
    const accepted = await recorder.run("normalize", 10, async () => ({
      accepted: [1, 2, 3],
      rejected: 7,
    }));
    expect(accepted).toEqual([1, 2, 3]);
    const summary = recorder.summary();
    expect(summary[0]?.stage).toBe("normalize");
    expect(summary[0]?.input).toBe(10);
    expect(summary[0]?.rejected).toBe(7);
    expect(recorder.totalRejected()).toBe(7);
  });
});
