import { describe, expect, it } from "vitest";
import type { DailyBriefSendRecord, Recipient, SourceHealth } from "@busstops/contracts";
import { deterministicUuid } from "@busstops/adapters";
import { MINIMUM_USEFUL_COVERAGE, buildSnapshot, decideSend, type BriefInput } from "./snapshot.js";
import { renderHtml, renderText, subjectLine } from "./render.js";
import {
  SEND_LIMITS,
  canSend,
  idempotencyKeyFor,
  optIn,
  sendRecord,
  tokenMatches,
  unsubscribe,
  unsubscribeTokenHash,
  verify,
  withinDeliveryWindow,
} from "./subscriptions.js";

const NOW = new Date("2026-09-03T06:00:00.000Z");

const HEALTHY: SourceHealth[] = [
  {
    source: "bods",
    coverageArea: "non_london",
    status: "healthy",
    lastSuccessfulFetchAt: NOW.toISOString(),
    lastAttemptAt: NOW.toISOString(),
    ageSeconds: 12,
    consecutiveFailures: 0,
  },
];

function briefInput(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    organisationId: null,
    scopeAreaIds: [],
    localDate: "2026-09-02",
    generatedAt: NOW,
    artifactVersion: "v1",
    yesterday: {
      networkHealth: 71,
      networkHealthBaseline: 76,
      punctuality: 0.72,
      reliability: 0.93,
      medianDelaySeconds: 168,
      denominator: 1103,
      topPerformingRouteIds: [deterministicUuid("service", "route-a")],
      requiresAttentionRouteIds: [deterministicUuid("service", "route-b")],
      biggestDelayBurdenIncident: null,
      biggestAbnormalIncident: null,
      keyEvents: [],
      dataQualityIssues: [],
    },
    today: {
      riskBand: "moderate",
      confidence: { level: "medium", score: 0.6, reasons: ["8 weeks of comparable history"] },
      weatherWindowSummary: "Rain is forecast between 07:00 and 10:00.",
      activeFloodNoticeIds: [],
      plannedRoadworksIds: [],
      highestRiskCorridors: [
        {
          corridorId: "A58 into Leeds",
          probabilityBand: "35–55%",
          expectedAdditionalMinutesLow: 4,
          expectedAdditionalMinutesHigh: 11,
        },
      ],
    },
    sourceHealth: HEALTHY,
    coverage: 0.86,
    ...overrides,
  };
}

function recipient(overrides: Partial<Recipient> = {}): Recipient {
  return {
    id: deterministicUuid("operator", "recipient-1"),
    organisationId: null,
    email: "ops@example.org",
    verifiedAt: "2026-08-01T09:00:00.000Z",
    optedInAt: "2026-08-01T09:05:00.000Z",
    unsubscribedAt: null,
    timezone: "Europe/London",
    deliveryLocalTime: "07:00",
    scopeAreaIds: [],
    unsubscribeTokenHash: null,
    ...overrides,
  };
}

function context(overrides: Partial<Parameters<typeof canSend>[0]> = {}) {
  return {
    recipient: recipient(),
    snapshotId: deterministicUuid("incident", "snapshot-1"),
    todaysRecords: [] as DailyBriefSendRecord[],
    governorState: "green" as const,
    emailProviderConfigured: true,
    recipientLocalTime: "07:05",
    ...overrides,
  };
}

describe("snapshot", () => {
  it("computes the change against the baseline rather than leaving it to the renderer", () => {
    const snapshot = buildSnapshot(briefInput());
    expect(snapshot.yesterday.networkHealthChangeVsBaseline).toBe(-5);
  });

  it("is deterministic: the same input yields the same id and narrative", () => {
    const first = buildSnapshot(briefInput());
    const second = buildSnapshot(briefInput());
    expect(second.id).toBe(first.id);
    expect(second.narrative).toBe(first.narrative);
  });

  it("withholds route rankings when coverage cannot support comparing them", () => {
    const snapshot = buildSnapshot(briefInput({ coverage: 0.2 }));
    expect(snapshot.yesterday.topPerformingRouteIds).toEqual([]);
    expect(snapshot.yesterday.requiresAttentionRouteIds).toEqual([]);
  });

  it("withholds route rankings when there are too few observations", () => {
    const input = briefInput();
    const snapshot = buildSnapshot({
      ...input,
      yesterday: { ...input.yesterday, denominator: 8 },
    });
    expect(snapshot.yesterday.requiresAttentionRouteIds).toEqual([]);
  });

  it("states the coverage caveat rather than presenting partial data as complete", () => {
    const snapshot = buildSnapshot(briefInput({ coverage: 0.6 }));
    expect(snapshot.coverageCaveat).toMatch(/60% of this scope reported usable data/);
    expect(snapshot.coverageCaveat).toMatch(/unmeasured, not necessarily running well/);
  });

  it("names an unhealthy source in the caveat", () => {
    const snapshot = buildSnapshot(
      briefInput({
        sourceHealth: [{ ...HEALTHY[0]!, source: "tfl", status: "stale" }],
      }),
    );
    expect(snapshot.coverageCaveat).toMatch(/tfl was stale/);
  });

  it("says there was not enough data instead of describing performance it cannot see", () => {
    const input = briefInput();
    const snapshot = buildSnapshot({
      ...input,
      coverage: 0.1,
      yesterday: { ...input.yesterday, denominator: 3 },
    });
    expect(snapshot.narrative).toMatch(/not enough data yesterday/);
    expect(snapshot.narrative).not.toMatch(/Punctuality was/);
  });

  it("phrases investigation priorities as suggestions, never as instructions", () => {
    const snapshot = buildSnapshot(briefInput());
    const text = snapshot.today.investigationPriorities.join(" ");
    expect(text).toMatch(/worth looking at|may be worth reviewing/i);
    expect(text).not.toMatch(/\b(reallocate|dispatch|hold the|instruct|must )\b/i);
  });

  it("says nothing stands out rather than manufacturing a priority", () => {
    const input = briefInput();
    const snapshot = buildSnapshot({
      ...input,
      today: { ...input.today, highestRiskCorridors: [] },
      yesterday: { ...input.yesterday, requiresAttentionRouteIds: [] },
    });
    expect(snapshot.today.investigationPriorities).toEqual([
      "Nothing stands out as needing attention from the data available today.",
    ]);
  });
});

describe("send decision on thin data", () => {
  it("sends a labelled limited-data brief when that is the preference", () => {
    const snapshot = buildSnapshot(briefInput({ coverage: 0.2 }));
    const decision = decideSend(snapshot, 0.2, "send_limited");
    expect(decision.action).toBe("send_limited");
    expect(decision.reason).toMatch(/clearly labelled as limited-data/);
  });

  it("skips instead when the recipient asked to skip", () => {
    const snapshot = buildSnapshot(briefInput({ coverage: 0.2 }));
    expect(decideSend(snapshot, 0.2, "skip_when_limited").action).toBe("skip");
  });

  it("sends normally when coverage is adequate", () => {
    const snapshot = buildSnapshot(briefInput());
    expect(decideSend(snapshot, 0.86, "skip_when_limited").action).toBe("send");
    expect(MINIMUM_USEFUL_COVERAGE).toBeLessThan(0.86);
  });
});

describe("rendering", () => {
  const options = {
    baseUrl: "https://busstops.example",
    unsubscribeUrl: "https://busstops.example/unsubscribe?t=abc",
    organisationName: "West Yorkshire Combined Authority",
    limitedData: false,
  };

  it("renders the same figures in HTML and plain text", () => {
    const snapshot = buildSnapshot(briefInput());
    const html = renderHtml(snapshot, options);
    const text = renderText(snapshot, options);

    for (const figure of ["71", "72%", "93%", "168s"]) {
      expect(html, `html ${figure}`).toContain(figure);
      expect(text, `text ${figure}`).toContain(figure);
    }
  });

  it("includes the unsubscribe link in both parts", () => {
    const snapshot = buildSnapshot(briefInput());
    expect(renderHtml(snapshot, options)).toContain(options.unsubscribeUrl);
    expect(renderText(snapshot, options)).toContain(options.unsubscribeUrl);
  });

  it("uses live text and a table layout, not an image of a dashboard", () => {
    const html = renderHtml(buildSnapshot(briefInput()), options);
    expect(html).toContain("<table");
    expect(html).not.toMatch(/<img/i);
    // Every table used for layout is marked presentational so screen readers skip it.
    const layoutTables = html.match(/<table role="presentation"/g) ?? [];
    expect(layoutTables.length).toBeGreaterThan(0);
  });

  it("inlines its styles, because email clients strip stylesheets", () => {
    const html = renderHtml(buildSnapshot(briefInput()), options);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).toContain('style="');
  });

  it("escapes text that came from data, so a crafted name cannot inject markup", () => {
    const input = briefInput();
    const snapshot = buildSnapshot({
      ...input,
      today: {
        ...input.today,
        weatherWindowSummary: '<script>alert("x")</script> & rain',
      },
    });
    const html = renderHtml(snapshot, options);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; rain");
  });

  it("carries the limited-data label into both parts when set", () => {
    const snapshot = buildSnapshot(briefInput({ coverage: 0.2 }));
    const limited = { ...options, limitedData: true };
    expect(renderHtml(snapshot, limited)).toMatch(/Limited data/);
    expect(renderText(snapshot, limited)).toMatch(/LIMITED DATA/);
    expect(subjectLine(snapshot, true)).toMatch(/^\[Limited data\]/);
  });

  it("puts the headline facts in the subject line", () => {
    const snapshot = buildSnapshot(briefInput());
    const subject = subjectLine(snapshot, false);
    expect(subject).toContain("2026-09-02");
    expect(subject).toContain("network health 71");
    expect(subject).toContain("moderate risk today");
  });

  it("states why the email was sent and that unsubscribing is immediate", () => {
    const snapshot = buildSnapshot(briefInput());
    expect(renderHtml(snapshot, options)).toMatch(/because you asked us to/);
    expect(renderText(snapshot, options)).toMatch(/takes effect immediately/);
  });
});

describe("send guards", () => {
  it("allows a verified, opted-in recipient inside their delivery window", () => {
    const decision = canSend(context());
    expect(decision.allowed).toBe(true);
  });

  it("refuses an unverified address", () => {
    const decision = canSend(context({ recipient: recipient({ verifiedAt: null }) }));
    expect(decision).toMatchObject({ allowed: false, reason: "not_verified" });
  });

  it("refuses a recipient with no recorded opt-in", () => {
    const decision = canSend(context({ recipient: recipient({ optedInAt: null }) }));
    expect(decision).toMatchObject({ allowed: false, reason: "not_opted_in" });
  });

  it("refuses an unsubscribed recipient, whatever else is true of them", () => {
    const decision = canSend(
      context({
        recipient: recipient({
          unsubscribedAt: "2026-08-20T00:00:00.000Z",
          optedInAt: "2026-08-21T00:00:00.000Z",
        }),
      }),
    );
    expect(decision).toMatchObject({ allowed: false, reason: "unsubscribed" });
  });

  it("refuses to send the same snapshot to the same recipient twice", () => {
    const snapshotId = deterministicUuid("incident", "snapshot-1");
    const recipientId = recipient().id;
    const decision = canSend(
      context({
        todaysRecords: [sendRecord({ recipientId, snapshotId, attemptedAt: NOW, outcome: "sent" })],
      }),
    );
    expect(decision).toMatchObject({ allowed: false, reason: "already_sent" });
  });

  it("allows a retry after a failure, since nothing was delivered", () => {
    const snapshotId = deterministicUuid("incident", "snapshot-1");
    const recipientId = recipient().id;
    const decision = canSend(
      context({
        todaysRecords: [
          sendRecord({ recipientId, snapshotId, attemptedAt: NOW, outcome: "failed" }),
        ],
      }),
    );
    expect(decision.allowed).toBe(true);
  });

  it("stops before the provider's free limit, not after it", () => {
    const records = Array.from({ length: SEND_LIMITS.selfImposedDailyCap }, (_, index) =>
      sendRecord({
        recipientId: `r-${index}`,
        snapshotId: "s",
        attemptedAt: NOW,
        outcome: "sent",
      }),
    );
    const decision = canSend(context({ todaysRecords: records }));
    expect(decision).toMatchObject({ allowed: false, reason: "daily_cap_reached" });
    expect(SEND_LIMITS.selfImposedDailyCap).toBeLessThan(SEND_LIMITS.dailySendCap);
  });

  it("halves the cap under budget pressure", () => {
    const records = Array.from({ length: SEND_LIMITS.selfImposedDailyCap / 2 }, (_, index) =>
      sendRecord({
        recipientId: `r-${index}`,
        snapshotId: "s",
        attemptedAt: NOW,
        outcome: "sent",
      }),
    );
    expect(canSend(context({ todaysRecords: records, governorState: "green" })).allowed).toBe(true);
    expect(canSend(context({ todaysRecords: records, governorState: "amber" }))).toMatchObject({
      allowed: false,
      reason: "daily_cap_reached",
    });
  });

  it("suspends sending entirely in the critical governor state", () => {
    expect(canSend(context({ governorState: "critical" }))).toMatchObject({
      allowed: false,
      reason: "governor_suspended",
    });
  });

  it("works with no email provider configured, by refusing rather than failing", () => {
    const decision = canSend(context({ emailProviderConfigured: false }));
    expect(decision).toMatchObject({ allowed: false, reason: "no_provider" });
    if (!decision.allowed) expect(decision.detail).toMatch(/Pro remains fully usable/);
  });

  it("respects the recipient's requested delivery time", () => {
    expect(canSend(context({ recipientLocalTime: "13:00" }))).toMatchObject({
      allowed: false,
      reason: "outside_delivery_window",
    });
  });

  it("treats times either side of midnight as close together", () => {
    expect(
      withinDeliveryWindow({
        ...context({ recipient: recipient({ deliveryLocalTime: "23:50" }) }),
        recipientLocalTime: "00:10",
      }),
    ).toBe(true);
  });
});

describe("consent and unsubscribe", () => {
  it("refuses to opt in an unverified address", () => {
    const result = optIn(recipient({ verifiedAt: null, optedInAt: null }), NOW);
    expect(result).toHaveProperty("error");
  });

  it("records verification and opt-in as separate audited events", () => {
    const verified = verify(recipient({ verifiedAt: null, optedInAt: null }), NOW);
    expect(verified.consent.action).toBe("verify");

    const opted = optIn(verified.recipient, NOW);
    expect(opted).not.toHaveProperty("error");
    if ("consent" in opted) {
      expect(opted.consent.action).toBe("opt_in");
      expect(opted.recipient.optedInAt).toBe(NOW.toISOString());
    }
  });

  it("honours unsubscribe immediately and clears the opt-in", () => {
    const result = unsubscribe(recipient(), NOW);
    expect(result.recipient.unsubscribedAt).toBe(NOW.toISOString());
    expect(result.recipient.optedInAt).toBeNull();
    expect(result.consent.action).toBe("opt_out");
  });

  it("spends the unsubscribe token, so a leaked link cannot be replayed", () => {
    const result = unsubscribe(recipient({ unsubscribeTokenHash: "abc" }), NOW);
    expect(result.recipient.unsubscribeTokenHash).toBeNull();
  });

  it("succeeds quietly when a link is followed twice", () => {
    const first = unsubscribe(recipient(), NOW);
    const second = unsubscribe(first.recipient, new Date("2026-09-03T07:00:00.000Z"));
    expect(second.alreadyUnsubscribed).toBe(true);
    // The original timestamp is what the audit needs, not the time of the second click.
    expect(second.recipient.unsubscribedAt).toBe(NOW.toISOString());
  });

  it("stores only a hash of the unsubscribe token", () => {
    const hash = unsubscribeTokenHash("token-value", "secret");
    expect(hash).not.toContain("token-value");
    expect(hash).not.toContain("secret");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces different hashes for different tokens and different secrets", () => {
    expect(unsubscribeTokenHash("a", "s")).not.toBe(unsubscribeTokenHash("b", "s"));
    expect(unsubscribeTokenHash("a", "s1")).not.toBe(unsubscribeTokenHash("a", "s2"));
  });

  it("matches a correct token and rejects anything else", () => {
    const stored = unsubscribeTokenHash("token", "secret");
    expect(tokenMatches(unsubscribeTokenHash("token", "secret"), stored)).toBe(true);
    expect(tokenMatches(unsubscribeTokenHash("other", "secret"), stored)).toBe(false);
    expect(tokenMatches("short", stored)).toBe(false);
    expect(tokenMatches(stored, null)).toBe(false);
  });

  it("keys idempotency on the snapshot and the recipient together", () => {
    expect(idempotencyKeyFor("s1", "r1")).toBe(idempotencyKeyFor("s1", "r1"));
    expect(idempotencyKeyFor("s1", "r1")).not.toBe(idempotencyKeyFor("s2", "r1"));
    expect(idempotencyKeyFor("s1", "r1")).not.toBe(idempotencyKeyFor("s1", "r2"));
  });
});
