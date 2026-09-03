import { describe, expect, it, vi } from "vitest";
import type { DailyBriefSnapshot, Recipient } from "@busstops/contracts";
import { deterministicUuid } from "@busstops/adapters";
import { buildSnapshot } from "@busstops/daily-brief";
import { HttpEmailProvider, NoopEmailProvider, providerFromEnv } from "./email-provider.js";
import { runDailyBriefSend } from "./run-brief.js";

const NOW = new Date("2026-09-03T06:00:00.000Z");

function snapshot(coverage = 0.86): DailyBriefSnapshot {
  return buildSnapshot({
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
      denominator: coverage < 0.4 ? 4 : 1103,
      topPerformingRouteIds: [],
      requiresAttentionRouteIds: [],
      biggestDelayBurdenIncident: null,
      biggestAbnormalIncident: null,
      keyEvents: [],
      dataQualityIssues: [],
    },
    today: {
      riskBand: "moderate",
      confidence: { level: "medium", score: 0.6, reasons: [] },
      weatherWindowSummary: "Rain forecast this morning.",
      activeFloodNoticeIds: [],
      plannedRoadworksIds: [],
      highestRiskCorridors: [],
    },
    sourceHealth: [],
    coverage,
  });
}

function recipient(overrides: Partial<Recipient> = {}): Recipient {
  return {
    id: deterministicUuid("operator", overrides.email ?? "a@example.org"),
    organisationId: null,
    email: "a@example.org",
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

function baseInput(overrides: Partial<Parameters<typeof runDailyBriefSend>[0]> = {}) {
  return {
    snapshot: snapshot(),
    coverage: 0.86,
    recipients: [recipient()],
    todaysRecords: [],
    governorState: "green" as const,
    provider: new NoopEmailProvider(),
    baseUrl: "https://busstops.example",
    organisationName: null,
    unsubscribeSecret: "test-secret",
    localTimeFor: () => "07:00",
    now: () => NOW,
    generateToken: (r: Recipient) => `token-${r.id}`,
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

function okProvider(sendSpy = vi.fn()) {
  return {
    name: "test",
    send: async (message: Parameters<HttpEmailProvider["send"]>[0]) => {
      sendSpy(message);
      return { ok: true as const, providerMessageId: "id-1" };
    },
  };
}

describe("email provider", () => {
  it("returns a no-op provider when nothing is configured", () => {
    expect(providerFromEnv({}).name).toBe("none");
    expect(providerFromEnv({ EMAIL_API_KEY: "k" }).name).toBe("none");
  });

  it("builds an HTTP provider once every setting is present", () => {
    const provider = providerFromEnv({
      EMAIL_PROVIDER: "example",
      EMAIL_PROVIDER_ENDPOINT: "https://mail.example/send",
      EMAIL_API_KEY: "k",
      EMAIL_FROM_ADDRESS: "brief@busstops.example",
    });
    expect(provider.name).toBe("example");
  });

  it("sends the credential in a header and never in the body", async () => {
    let capturedBody = "";
    let capturedAuth = "";
    const provider = new HttpEmailProvider({
      name: "test",
      endpoint: "https://mail.example/send",
      apiKey: "super-secret-key",
      fromAddress: "brief@busstops.example",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        capturedBody = String(init.body);
        capturedAuth = String((init.headers as Record<string, string>).Authorization);
        return new Response(JSON.stringify({ id: "x" }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await provider.send({
      to: "a@example.org",
      subject: "s",
      html: "<p>h</p>",
      text: "t",
      listUnsubscribeUrl: "https://busstops.example/unsubscribe?t=1",
    });

    expect(capturedAuth).toContain("super-secret-key");
    expect(capturedBody).not.toContain("super-secret-key");
  });

  it("sets one-click unsubscribe headers so mail clients can offer it natively", async () => {
    let body: Record<string, unknown> = {};
    const provider = new HttpEmailProvider({
      name: "test",
      endpoint: "https://mail.example/send",
      apiKey: "k",
      fromAddress: "brief@busstops.example",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await provider.send({
      to: "a@example.org",
      subject: "s",
      html: "<p>h</p>",
      text: "t",
      listUnsubscribeUrl: "https://busstops.example/unsubscribe?t=1",
    });

    const headers = body.headers as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toBe("<https://busstops.example/unsubscribe?t=1>");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("marks a 5xx retryable and a 4xx not, and never echoes the response body", async () => {
    const make = (status: number) =>
      new HttpEmailProvider({
        name: "test",
        endpoint: "https://mail.example/send",
        apiKey: "k",
        fromAddress: "f@example.org",
        fetchImpl: (async () =>
          new Response("Bearer k leaked in body", { status })) as unknown as typeof fetch,
      });

    const message = {
      to: "a@example.org",
      subject: "s",
      html: "h",
      text: "t",
      listUnsubscribeUrl: "u",
    };

    const server = await make(503).send(message);
    expect(server).toMatchObject({ ok: false, retryable: true });

    const client = await make(422).send(message);
    expect(client).toMatchObject({ ok: false, retryable: false });
    if (!client.ok) expect(client.detail).not.toContain("Bearer");
  });
});

describe("send loop", () => {
  it("records an outcome for every recipient, including refusals", async () => {
    const report = await runDailyBriefSend(
      baseInput({
        provider: okProvider(),
        recipients: [
          recipient({ email: "ok@example.org" }),
          recipient({ email: "unverified@example.org", verifiedAt: null }),
          recipient({ email: "gone@example.org", unsubscribedAt: "2026-08-20T00:00:00.000Z" }),
        ],
      }),
    );

    expect(report.attempted).toBe(3);
    expect(report.records).toHaveLength(3);
    expect(report.sent).toBe(1);
    expect(report.suppressed).toBe(2);
    for (const record of report.records) {
      expect(record.detail, record.outcome).toBeTruthy();
    }
  });

  it("does not send twice for the same snapshot and recipient", async () => {
    const spy = vi.fn();
    const first = await runDailyBriefSend(baseInput({ provider: okProvider(spy) }));
    expect(first.sent).toBe(1);

    const second = await runDailyBriefSend(
      baseInput({ provider: okProvider(spy), todaysRecords: first.records }),
    );
    expect(second.sent).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure a bounded number of times, then stops", async () => {
    let attempts = 0;
    const report = await runDailyBriefSend(
      baseInput({
        provider: {
          name: "test",
          send: async () => {
            attempts += 1;
            return { ok: false as const, retryable: true, detail: "Provider returned 503" };
          },
        },
      }),
    );

    expect(report.failed).toBe(1);
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(3);
  });

  it("does not retry a permanent failure", async () => {
    let attempts = 0;
    await runDailyBriefSend(
      baseInput({
        provider: {
          name: "test",
          send: async () => {
            attempts += 1;
            return { ok: false as const, retryable: false, detail: "Provider returned 422" };
          },
        },
      }),
    );
    expect(attempts).toBe(1);
  });

  it("stores only the token hash, never the token itself", async () => {
    const spy = vi.fn();
    const report = await runDailyBriefSend(baseInput({ provider: okProvider(spy) }));

    expect(report.tokenHashes).toHaveLength(1);
    const hash = report.tokenHashes[0]!.hash;
    expect(hash).not.toContain("token-");
    expect(hash).not.toContain("test-secret");

    // The plaintext token appears in the email, which is where it belongs.
    const message = spy.mock.calls[0]![0] as { html: string };
    expect(message.html).toContain("token-");
  });

  it("skips a thin-data day when the recipient asked to skip", async () => {
    const report = await runDailyBriefSend(
      baseInput({
        snapshot: snapshot(0.15),
        coverage: 0.15,
        provider: okProvider(),
        limitedDataPreferenceFor: () => "skip_when_limited",
      }),
    );

    expect(report.skipped).toBe(1);
    expect(report.sent).toBe(0);
    expect(report.records[0]!.outcome).toBe("skipped_no_data");
  });

  it("sends a labelled limited-data brief when that is the preference", async () => {
    const spy = vi.fn();
    const report = await runDailyBriefSend(
      baseInput({
        snapshot: snapshot(0.15),
        coverage: 0.15,
        provider: okProvider(spy),
        limitedDataPreferenceFor: () => "send_limited",
      }),
    );

    expect(report.sent).toBe(1);
    const message = spy.mock.calls[0]![0] as { subject: string; text: string };
    expect(message.subject).toMatch(/^\[Limited data\]/);
    expect(message.text).toMatch(/LIMITED DATA/);
  });

  it("sends nothing and says so when no provider is configured", async () => {
    const report = await runDailyBriefSend(baseInput());
    expect(report.sent).toBe(0);
    expect(report.suppressed).toBe(1);
    expect(report.notes.join(" ")).toMatch(/No email provider is configured/);
  });

  it("suspends sending in the critical governor state", async () => {
    const spy = vi.fn();
    const report = await runDailyBriefSend(
      baseInput({ provider: okProvider(spy), governorState: "critical" }),
    );
    expect(report.sent).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(report.records[0]!.outcome).toBe("suppressed_quota");
  });
});
