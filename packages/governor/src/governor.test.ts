import { describe, expect, it } from "vitest";
import {
  BUDGET_REGISTRY,
  DEGRADATION_LADDER,
  GOVERNOR_THRESHOLDS,
  PRESERVED_IN_CRITICAL,
  activeDegradationSteps,
  aggregateState,
  cacheTtlMultiplier,
  capabilityAllowed,
  classify,
  evaluateResource,
  getBudgetResource,
  pollingIntervalMultiplier,
  projectUtilization,
  safeModeActive,
  unverifiedRequiredResources,
  type GovernedCapability,
} from "./index.js";
import type { GovernorState } from "@busstops/contracts";

describe("threshold classification", () => {
  const cases: Array<[number, GovernorState]> = [
    [0, "green"],
    [0.69, "green"],
    [GOVERNOR_THRESHOLDS.amber, "amber"],
    [0.84, "amber"],
    [GOVERNOR_THRESHOLDS.red, "red"],
    [0.94, "red"],
    [GOVERNOR_THRESHOLDS.critical, "critical"],
    [1.4, "critical"],
  ];

  it.each(cases)("classifies utilization %f as %s", (utilization, expected) => {
    expect(classify(utilization, utilization)).toBe(expected);
  });

  it("escalates on projection even when current utilization is low", () => {
    // 20% used after 10% of the period projects to 200% — critical, well before any spend.
    expect(classify(0.2, 2.0)).toBe("critical");
  });
});

describe("projection", () => {
  const resource = BUDGET_REGISTRY[0]!;

  it("projects end-of-period usage linearly", () => {
    const projected = projectUtilization(
      {
        resourceKey: resource.key,
        used: resource.allowance * 0.25,
        periodElapsedFraction: 0.5,
        observedAt: "2026-09-02T12:00:00.000Z",
      },
      resource,
    );
    expect(projected).toBeCloseTo(0.5, 6);
  });

  it("never projects below what is already spent", () => {
    const projected = projectUtilization(
      {
        resourceKey: resource.key,
        used: resource.allowance * 0.9,
        periodElapsedFraction: 1,
        observedAt: "2026-09-02T23:59:00.000Z",
      },
      resource,
    );
    expect(projected).toBeCloseTo(0.9, 6);
  });

  it("handles a zero-elapsed period without dividing by zero", () => {
    const projected = projectUtilization(
      {
        resourceKey: resource.key,
        used: 0,
        periodElapsedFraction: 0,
        observedAt: "2026-09-02T00:00:00.000Z",
      },
      resource,
    );
    expect(projected).toBe(0);
  });
});

describe("evaluateResource", () => {
  it("returns a complete QuotaState with the provider terms URL", () => {
    const state = evaluateResource({
      resourceKey: "cloudflare.workers.requests",
      used: 90_000,
      periodElapsedFraction: 1,
      observedAt: "2026-09-02T23:00:00.000Z",
    });
    expect(state.state).toBe("red");
    expect(state.allowanceUnit).toBe("requests");
    expect(state.allowanceSourceUrl).toContain("cloudflare.com");
  });

  it("reaches critical at or above 95% of the allowance", () => {
    const state = evaluateResource({
      resourceKey: "cloudflare.workers.requests",
      used: 96_000,
      periodElapsedFraction: 1,
      observedAt: "2026-09-02T23:00:00.000Z",
    });
    expect(state.state).toBe("critical");
  });

  it("throws on an unknown resource rather than silently allowing spend", () => {
    expect(() =>
      evaluateResource({
        resourceKey: "nope",
        used: 1,
        periodElapsedFraction: 1,
        observedAt: "2026-09-02T23:00:00.000Z",
      }),
    ).toThrow(/Unknown budget resource/);
  });
});

describe("aggregate state", () => {
  it("takes the worst state across resources", () => {
    expect(aggregateState(["green", "amber", "red"])).toBe("red");
    expect(aggregateState(["green", "green"])).toBe("green");
    expect(aggregateState([])).toBe("green");
    expect(aggregateState(["critical", "green"])).toBe("critical");
  });
});

describe("degradation ladder", () => {
  it("applies steps in documented order as pressure rises", () => {
    expect(activeDegradationSteps("green")).toHaveLength(0);
    expect(activeDegradationSteps("amber").map((s) => s.order)).toEqual([1, 2]);
    expect(activeDegradationSteps("red").map((s) => s.order)).toEqual([1, 2, 3, 4]);
    expect(activeDegradationSteps("critical").map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("is ordered and complete", () => {
    expect(DEGRADATION_LADDER.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("capability gating", () => {
  const optional: GovernedCapability[] = [
    "optional_animation",
    "optional_export",
    "email_preview",
    "historical_enrichment",
    "model_recalculation",
    "fine_grained_aggregates",
    "daily_brief_send",
    "live_vehicle_polling",
  ];

  it("allows every optional capability while green", () => {
    for (const capability of optional) {
      expect(capabilityAllowed(capability, "green").allowed, capability).toBe(true);
    }
  });

  it("disables optional previews and exports first, at amber", () => {
    expect(capabilityAllowed("optional_export", "amber").allowed).toBe(false);
    expect(capabilityAllowed("email_preview", "amber").allowed).toBe(false);
    // Daily Brief sending survives amber — previews are suspended before real sends.
    expect(capabilityAllowed("daily_brief_send", "amber").allowed).toBe(true);
  });

  it("pauses enrichment and recalculation at red but keeps sending briefs", () => {
    expect(capabilityAllowed("historical_enrichment", "red").allowed).toBe(false);
    expect(capabilityAllowed("model_recalculation", "red").allowed).toBe(false);
    expect(capabilityAllowed("daily_brief_send", "red").allowed).toBe(true);
  });

  it("stops non-essential sends and polling at critical", () => {
    expect(capabilityAllowed("daily_brief_send", "critical").allowed).toBe(false);
    expect(capabilityAllowed("live_vehicle_polling", "critical").allowed).toBe(false);
  });

  it("preserves deletion, unsubscribe, security and source health even at critical", () => {
    for (const capability of PRESERVED_IN_CRITICAL) {
      expect(capabilityAllowed(capability, "critical").allowed, capability).toBe(true);
    }
  });
});

describe("load shedding multipliers", () => {
  it("increases cache TTL monotonically with pressure", () => {
    const multipliers = (["green", "amber", "red", "critical"] as GovernorState[]).map(
      cacheTtlMultiplier,
    );
    expect(multipliers).toEqual([1, 2, 4, 8]);
  });

  it("stops polling entirely at critical", () => {
    expect(pollingIntervalMultiplier("critical")).toBe(Number.POSITIVE_INFINITY);
    expect(pollingIntervalMultiplier("green")).toBe(1);
  });
});

describe("safe mode", () => {
  it("activates only at critical", () => {
    expect(safeModeActive("red")).toBe(false);
    expect(safeModeActive("critical")).toBe(true);
  });
});

describe("budget registry integrity", () => {
  it("has unique keys and positive allowances", () => {
    const keys = BUDGET_REGISTRY.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const resource of BUDGET_REGISTRY) {
      expect(resource.allowance).toBeGreaterThan(0);
      expect(resource.selfImposedCeilingFraction).toBeLessThanOrEqual(1);
    }
  });

  /*
   * This test used to assert that at least one required allowance was unverified, which was true
   * while none had been checked. All required allowances have since been verified against the
   * providers' published terms, so that assertion now fails against a correct registry.
   *
   * What actually needs guarding is the mechanism, not the transient state: the gate must select
   * exactly the resources that are required AND unverified, and it must ignore optional ones.
   */
  it("selects exactly the required allowances that are still unverified", () => {
    const unverified = unverifiedRequiredResources();

    for (const resource of unverified) {
      expect(resource.requiredForDeploy).toBe(true);
      expect(resource.verifiedAt).toBeNull();
    }

    // Nothing required and verified may appear, and nothing optional may appear at all.
    const expected = BUDGET_REGISTRY.filter(
      (resource) => resource.requiredForDeploy && resource.verifiedAt === null,
    ).map((resource) => resource.key);
    expect(unverified.map((resource) => resource.key)).toEqual(expected);
  });

  it("does not let an optional unverified allowance block deployment", () => {
    // Email, Open-Meteo and Environment Agency allowances are unverified and must stay that way
    // while those capabilities are switched off. Blocking on them would gate the deploy on
    // quotas for features that make no requests.
    const optionalUnverified = BUDGET_REGISTRY.filter(
      (resource) => !resource.requiredForDeploy && resource.verifiedAt === null,
    );
    expect(optionalUnverified.length).toBeGreaterThan(0);

    const blocking = unverifiedRequiredResources().map((resource) => resource.key);
    for (const resource of optionalUnverified) {
      expect(blocking).not.toContain(resource.key);
    }
  });

  it("has every deployment-required allowance verified with a note", () => {
    // The deployable state: preflight's deploy gate passes only when this holds.
    for (const resource of BUDGET_REGISTRY.filter((r) => r.requiredForDeploy)) {
      expect(
        resource.verifiedAt,
        `${resource.key} must be verified before deploying`,
      ).not.toBeNull();
      expect(resource.verifiedNote, `${resource.key} must record how it was verified`).toBeTruthy();
    }
  });
});

describe("unmetered resources", () => {
  it("never throttles a resource the provider does not meter", () => {
    const state = evaluateResource({
      resourceKey: "github.actions.minutes",
      // Wildly over the placeholder allowance, which is not a real quota.
      used: 999_999,
      periodElapsedFraction: 0.1,
      observedAt: "2026-09-03T09:00:00.000Z",
    });

    expect(state.state).toBe("green");
    expect(state.utilizationFraction).toBe(0);
    expect(state.metered).toBe(false);
  });

  it("records why a resource is unmetered, so the condition is not lost", () => {
    const actions = getBudgetResource("github.actions.minutes")!;
    expect(actions.metered).toBe(false);
    expect(actions.unmeteredBecause).toMatch(/public repositories/i);
    // The condition that could make it metered again is stated, not merely implied.
    expect(actions.unmeteredBecause).toMatch(/private/i);
  });

  it("reports a null verification time rather than pretending an unchecked figure was checked", () => {
    const unverified = BUDGET_REGISTRY.find((resource) => resource.verifiedAt === null);
    expect(unverified).toBeDefined();

    const state = evaluateResource({
      resourceKey: unverified!.key,
      used: 1,
      periodElapsedFraction: 0.5,
      observedAt: "2026-09-03T09:00:00.000Z",
    });
    expect(state.allowanceVerifiedAt).toBeNull();
  });

  it("carries a note for every allowance that claims to be verified", () => {
    for (const resource of BUDGET_REGISTRY) {
      if (resource.verifiedAt !== null) {
        expect(resource.verifiedNote, resource.key).toBeTruthy();
      }
    }
  });

  it("models the BODS limit as the published interval, not an invented daily quota", () => {
    const bods = getBudgetResource("upstream.bods.requests")!;
    // Once every five seconds is twelve a minute.
    expect(bods.period).toBe("minute");
    expect(bods.allowance).toBe(12);
    expect(bods.verifiedNote).toMatch(/five seconds/i);
  });

  it("keeps the TfL registered-product rate limit", () => {
    const tfl = getBudgetResource("upstream.tfl.requests")!;
    expect(tfl.allowance).toBe(500);
    expect(tfl.period).toBe("minute");
  });

  it("tracks no resource the platform does not use", () => {
    // KV was bound but never read; its entries went with the binding.
    expect(BUDGET_REGISTRY.some((resource) => resource.key.startsWith("cloudflare.kv"))).toBe(
      false,
    );
  });
});
