import { describe, expect, it } from "vitest";
import {
  BUDGET_REGISTRY,
  GOVERNOR_THRESHOLDS,
  PRESERVED_IN_CRITICAL,
  activeDegradationSteps,
  aggregateState,
  cacheTtlMultiplier,
  capabilityAllowed,
  classify,
  evaluateResource,
  pollingIntervalMultiplier,
  safeModeActive,
} from "@busstops/governor";
import {
  RAW_TRACE_MAX_AGE_HOURS,
  evaluateExpiry,
  mandatoryExpiryClasses,
  pruningOrder,
} from "@busstops/pipeline-core";
import { planPruning, projectStorage, takeInventory } from "@busstops/pipeline-analytics-batch";
import { planCollection } from "@busstops/pipeline-live-collection";
import { SEND_LIMITS, canSend } from "@busstops/daily-brief";

/**
 * Free-tier drills (docs/13_FREE_TIER_RULES.md, docs/18_ROADMAP.md P9 exit criteria).
 *
 * These simulate crossing each budget threshold and assert what the platform actually does. The
 * point is not that the thresholds are configured — a unit test covers that — but that every
 * subsystem responds coherently to the same pressure, because a governor that tightens the API
 * while a scheduled job keeps spending is not a governor.
 */

const NOW = new Date("2026-09-03T09:00:00.000Z");

describe("threshold classification", () => {
  it("crosses each band at the documented utilisation", () => {
    expect(classify(0.5, 0.5)).toBe("green");
    expect(classify(GOVERNOR_THRESHOLDS.amber, GOVERNOR_THRESHOLDS.amber)).toBe("amber");
    expect(classify(GOVERNOR_THRESHOLDS.red, GOVERNOR_THRESHOLDS.red)).toBe("red");
    expect(classify(GOVERNOR_THRESHOLDS.critical, GOVERNOR_THRESHOLDS.critical)).toBe("critical");
  });

  it("acts on the projection, not only on today's usage", () => {
    // Comfortable now, certain to breach by period end: that must already be critical.
    expect(classify(0.3, 1.4)).toBe("critical");
  });

  it("takes the worst state across resources rather than an average", () => {
    expect(aggregateState(["green", "green", "critical"])).toBe("critical");
    expect(aggregateState(["green", "amber"])).toBe("amber");
  });
});

describe("the whole platform responds coherently to pressure", () => {
  const cadence = {
    sourceKey: "bods",
    sourceUpdateIntervalSeconds: 10,
    baseIntervalSeconds: 60,
    maxRequestsPerRun: 12,
    dailyRequestBudget: 100_000,
  };

  it("green: full service", () => {
    expect(cacheTtlMultiplier("green")).toBe(1);
    expect(pollingIntervalMultiplier("green")).toBe(1);
    expect(safeModeActive("green")).toBe(false);
    expect(planCollection(cadence, "green").suspended).toBe(false);
    expect(activeDegradationSteps("green")).toEqual([]);
  });

  it("amber: caches lengthen, polling slows, optional detail is dropped", () => {
    expect(cacheTtlMultiplier("amber")).toBeGreaterThan(1);
    expect(pollingIntervalMultiplier("amber")).toBeGreaterThan(1);
    expect(planCollection(cadence, "amber").intervalSeconds).toBeGreaterThan(
      planCollection(cadence, "green").intervalSeconds,
    );

    const steps = activeDegradationSteps("amber").map((step) => step.action.toLowerCase());
    expect(steps.join(" ")).toMatch(/cache ttl|polling/);
    // Nothing essential is shed this early.
    expect(steps.join(" ")).not.toMatch(/scheduled-only/);
  });

  it("red: historical enrichment pauses and fine aggregates roll up", () => {
    const steps = activeDegradationSteps("red").map((step) => step.action.toLowerCase());
    expect(steps.join(" ")).toMatch(/historical enrichment|recalculation/);
    expect(steps.join(" ")).toMatch(/roll up|prune/);
    expect(planCollection(cadence, "red").intervalSeconds).toBeGreaterThan(
      planCollection(cadence, "amber").intervalSeconds,
    );
  });

  it("critical: safe mode, collection suspended, sends stopped, essentials preserved", () => {
    expect(safeModeActive("critical")).toBe(true);
    expect(planCollection(cadence, "critical").suspended).toBe(true);
    expect(pollingIntervalMultiplier("critical")).toBe(Number.POSITIVE_INFINITY);

    // Email stops before any paid overage, not after.
    const decision = canSend({
      recipient: {
        id: "00000000-0000-5000-8000-00000000aaaa",
        organisationId: null,
        email: "a@example.org",
        verifiedAt: "2026-08-01T00:00:00.000Z",
        optedInAt: "2026-08-01T00:00:00.000Z",
        unsubscribedAt: null,
        timezone: "Europe/London",
        deliveryLocalTime: "09:00",
        scopeAreaIds: [],
        unsubscribeTokenHash: null,
      },
      snapshotId: "snapshot",
      todaysRecords: [],
      governorState: "critical",
      emailProviderConfigured: true,
      recipientLocalTime: "09:00",
    });
    expect(decision).toMatchObject({ allowed: false, reason: "governor_suspended" });

    // And the things a passenger actually needs still work.
    for (const capability of PRESERVED_IN_CRITICAL) {
      expect(capabilityAllowed(capability, "critical").allowed, capability).toBe(true);
    }
  });

  it("never spends more than the self-imposed ceiling, which is below the real limit", () => {
    for (const resource of BUDGET_REGISTRY) {
      expect(resource.selfImposedCeilingFraction).toBeLessThanOrEqual(1);
      expect(resource.selfImposedCeilingFraction).toBeGreaterThan(0);
    }
    expect(SEND_LIMITS.selfImposedDailyCap).toBeLessThan(SEND_LIMITS.dailySendCap);
  });

  it("reports a resource's state from its own measured usage", () => {
    const resource = BUDGET_REGISTRY[0]!;
    const state = evaluateResource({
      resourceKey: resource.key,
      used: resource.allowance * 0.9,
      periodElapsedFraction: 0.9,
    });
    expect(["red", "critical"]).toContain(state.state);
  });
});

describe("retention drill", () => {
  it("expires a raw trace at the ceiling, and never keeps one beyond it", () => {
    const justInside = new Date(
      NOW.getTime() - (RAW_TRACE_MAX_AGE_HOURS - 1) * 3_600_000,
    ).toISOString();
    const justOutside = new Date(
      NOW.getTime() - (RAW_TRACE_MAX_AGE_HOURS + 1) * 3_600_000,
    ).toISOString();

    expect(evaluateExpiry("raw_trace", justInside, NOW).expired).toBe(false);
    expect(evaluateExpiry("raw_trace", justOutside, NOW).expired).toBe(true);
  });

  it("keeps raw expiry mandatory, so it runs even under the worst budget pressure", () => {
    const mandatory = mandatoryExpiryClasses().map((entry) => entry.key);
    expect(mandatory).toContain("raw_trace");
    expect(mandatory).toContain("vehicle_state_current");
  });

  it("prunes the cheapest-to-lose data first", () => {
    const order = pruningOrder().map((entry) => entry.key);
    expect(order.indexOf("raw_trace")).toBeLessThan(order.indexOf("aggregate_daily"));
    expect(order.indexOf("aggregate_5min")).toBeLessThan(order.indexOf("aggregate_hourly"));
    expect(order[order.length - 1]).toBe("incident_summary");
  });

  it("derives the coarser aggregate before deleting the finer one", () => {
    const expired = new Date(NOW.getTime() - 60 * 24 * 3_600_000).toISOString();
    const candidate = {
      key: "data/aggregate-1",
      retentionClassKey: "aggregate_5min",
      timestamp: expired,
      approximateBytes: 1024,
    };

    // Not yet rolled up: held, not deleted, because nothing can re-fetch it.
    expect(planPruning([candidate], NOW).deletions).toHaveLength(0);
    // Rolled up: safe to delete.
    expect(planPruning([candidate], NOW, new Set([candidate.key])).deletions).toHaveLength(1);
  });

  it("still deletes a raw trace at its ceiling even if the roll-up never ran", () => {
    const plan = planPruning(
      [
        {
          key: "data/raw-1",
          retentionClassKey: "raw_trace",
          timestamp: new Date(NOW.getTime() - 72 * 3_600_000).toISOString(),
          approximateBytes: 4096,
        },
      ],
      NOW,
    );
    expect(plan.deletions).toHaveLength(1);
    expect(plan.notes.join(" ")).toMatch(/retention ceiling/);
  });

  it("has no retention class that keeps anything indefinitely", () => {
    for (const entry of pruningOrder()) {
      expect(Number.isFinite(entry.maxAgeHours), entry.key).toBe(true);
      expect(entry.maxAgeHours).toBeGreaterThan(0);
    }
  });
});

describe("storage projection drill", () => {
  function inventory(bytes: number, dayOffset: number) {
    return takeInventory(
      [
        {
          retentionClassKey: "raw_trace",
          objectCount: 100,
          bytes,
          oldestTimestamp: null,
          newestTimestamp: null,
        },
      ],
      new Date(NOW.getTime() + dayOffset * 86_400_000),
    );
  }

  it("names the date storage fills at the observed growth rate", () => {
    const projection = projectStorage(inventory(500_000_000, 4), {
      limitBytes: 1_000_000_000,
      history: [inventory(100_000_000, 0)],
      daysRemainingInPeriod: 20,
    });

    expect(projection.dailyGrowthBytes).toBeCloseTo(100_000_000, -3);
    expect(projection.projectedFullOn).not.toBeNull();
    expect(projection.state).toBe("critical");
  });

  it("stays green when growth will not reach the limit within the period", () => {
    const projection = projectStorage(inventory(101_000_000, 4), {
      limitBytes: 10_000_000_000,
      history: [inventory(100_000_000, 0)],
      daysRemainingInPeriod: 20,
    });
    expect(projection.state).toBe("green");
  });

  it("refuses to project from a single measurement", () => {
    const projection = projectStorage(inventory(100_000_000, 0), {
      limitBytes: 1_000_000_000,
      history: [],
      daysRemainingInPeriod: 20,
    });
    expect(projection.dailyGrowthBytes).toBeNull();
    expect(projection.notes.join(" ")).toMatch(/cannot be measured/);
  });
});
