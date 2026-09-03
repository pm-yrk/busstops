import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ControlTowerResponse,
  OperatorsResponse,
  ProMetric,
  ProProvenance,
} from "@busstops/contracts";
import { ControlTowerPage } from "./ControlTowerPage.js";
import { OperatorsPage } from "./OperatorsPage.js";
import { ProLayout } from "./ProLayout.js";
import { DataModeBanner, ProMetricTile } from "./ProPrimitives.js";
import { apiClient } from "../lib/api.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const demoProvenance: ProProvenance = {
  dataMode: "demo_snapshot",
  snapshotDate: "2026-08-14",
  notice: "Demonstration snapshot from 2026-08-14. These figures are not live data.",
};

function metric(overrides: Partial<ProMetric> = {}): ProMetric {
  return {
    key: "punctuality",
    label: "Punctuality",
    definition:
      "The share of observed departures leaving between 1 minute early and 5 minutes late.",
    value: 0.72,
    unit: "percent",
    denominator: 1103,
    window: "last 60 minutes",
    freshnessSeconds: 42,
    coverage: 0.86,
    confidence: { level: "medium", score: 0.66, reasons: ["capped by 86% source coverage"] },
    suppressed: false,
    suppressionReason: null,
    baselineValue: 0.75,
    evidence: [],
    ...overrides,
  };
}

describe("ProMetricTile", () => {
  it("shows the denominator, window and coverage beside the figure", () => {
    render(<ProMetricTile metric={metric()} />);
    expect(screen.getByText("72%")).toBeTruthy();
    expect(screen.getByText("1,103")).toBeTruthy();
    expect(screen.getByText("last 60 minutes")).toBeTruthy();
    expect(screen.getByText("86%")).toBeTruthy();
  });

  it("compares against the baseline rather than presenting the figure alone", () => {
    render(<ProMetricTile metric={metric()} />);
    expect(screen.getByText(/below its baseline of 75%/)).toBeTruthy();
  });

  it("shows a dash and the reason for a suppressed figure, never a zero", () => {
    render(
      <ProMetricTile
        metric={metric({
          value: null,
          suppressed: true,
          suppressionReason: "Based on 4 observations; 20 are needed before a figure is published.",
        })}
      />,
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText(/20 are needed/)).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("reveals how the figure is measured on request", async () => {
    render(<ProMetricTile metric={metric()} />);
    await userEvent.click(screen.getByRole("button", { name: /how this is measured/i }));
    expect(screen.getByText(/1 minute early and 5 minutes late/)).toBeTruthy();
    expect(screen.getByText(/capped by 86% source coverage/)).toBeTruthy();
  });
});

describe("DataModeBanner", () => {
  it("states the snapshot date prominently when the data is not live", () => {
    render(<DataModeBanner provenance={demoProvenance} />);
    const banner = screen.getByTestId("pro-data-mode");
    expect(within(banner).getByText(/Demonstration snapshot — 2026-08-14/)).toBeTruthy();
    expect(within(banner).getByText(/not live data/)).toBeTruthy();
  });

  it("shows nothing at all when the data is live", () => {
    render(<DataModeBanner provenance={{ dataMode: "live", snapshotDate: null, notice: null }} />);
    expect(screen.queryByTestId("pro-data-mode")).toBeNull();
  });
});

describe("ProLayout", () => {
  it("offers every Pro section with no sign-in anywhere", () => {
    render(
      <MemoryRouter initialEntries={["/pro"]}>
        <Routes>
          <Route path="/pro" element={<ProLayout />}>
            <Route index element={<p>content</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    for (const label of [
      "Control Tower",
      "Live Operations",
      "Routes",
      "Operators",
      "Congestion",
      "Analytics",
      "Reports",
      "Daily Brief",
      "Settings",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }

    expect(screen.queryByText(/sign in|log in|create an account/i)).toBeNull();
  });
});

describe("ControlTowerPage", () => {
  const tower: ControlTowerResponse = {
    provenance: demoProvenance,
    scope: {
      areaId: null,
      operatorId: null,
      routeId: null,
      windowMinutes: 60,
      boundingBox: null,
    },
    generatedAt: "2026-09-03T09:00:00.000Z",
    headline: [
      metric({
        key: "network_health",
        label: "Network health",
        value: 71,
        unit: "points",
        baselineValue: 76,
      }),
    ],
    sourceHealth: {
      healthy: 2,
      degraded: 1,
      stale: 1,
      down: 0,
      problems: [
        { source: "national_highways", status: "stale", detail: "Last fetch 41 minutes ago" },
      ],
    },
    priorityExceptions: [],
    biggestDelayBurden: [],
    mostAbnormal: [],
    routesRequiringAttention: [],
    outlook: "Nothing unusual is showing across the network right now.",
    intelligenceSummary: ["Live source coverage is 62%."],
    coverageWarning:
      "Only 62% of live sources are reporting normally. Read every figure below with that in mind.",
  };

  it("leads with the coverage warning, before any headline figure", async () => {
    vi.spyOn(apiClient, "proControlTower").mockResolvedValue({ data: tower });
    const { container } = render(
      <MemoryRouter>
        <ControlTowerPage />
      </MemoryRouter>,
    );

    await screen.findByText(/Only 62% of live sources/);

    const warning = container.querySelector(".pro-coverage-warning");
    const firstMetric = container.querySelector(".pro-metric");
    expect(warning).toBeTruthy();
    expect(firstMetric).toBeTruthy();
    // The warning must precede the figures in document order, not merely exist somewhere.
    expect(warning!.compareDocumentPosition(firstMetric!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("says the outlook is generated by a fixed rule, not written by a model", async () => {
    vi.spyOn(apiClient, "proControlTower").mockResolvedValue({ data: tower });
    render(
      <MemoryRouter>
        <ControlTowerPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/No model writes it/)).toBeTruthy();
  });

  it("names an unhealthy source rather than only counting it", async () => {
    vi.spyOn(apiClient, "proControlTower").mockResolvedValue({ data: tower });
    render(
      <MemoryRouter>
        <ControlTowerPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/national_highways/)).toBeTruthy();
    expect(screen.getByText(/Last fetch 41 minutes ago/)).toBeTruthy();
    expect(screen.getByText(/unmeasured rather than clear/)).toBeTruthy();
  });
});

describe("OperatorsPage", () => {
  const operators: OperatorsResponse = {
    provenance: demoProvenance,
    scope: {
      areaId: null,
      operatorId: null,
      routeId: null,
      windowMinutes: 1440,
      boundingBox: null,
    },
    generatedAt: "2026-09-03T09:00:00.000Z",
    scorecards: [
      {
        operatorId: "big",
        operatorName: "First West Yorkshire",
        raw: [metric({ key: "punctuality_raw", label: "Punctuality (as measured)" })],
        contextAdjusted: [
          metric({ key: "punctuality_adjusted", label: "Punctuality (adjusted)", value: 0.74 }),
        ],
        contextFactors: ["Higher share of city-centre journeys"],
        rankingEligible: true,
        rankingIneligibleReason: null,
        coverageCaveats: ["Coverage varies by operator."],
      },
      {
        operatorId: "small",
        operatorName: "Yorkshire Tiger",
        raw: [metric({ key: "punctuality_raw", value: null, suppressed: true, denominator: 12 })],
        contextAdjusted: [
          metric({ key: "punctuality_adjusted", value: null, suppressed: true, denominator: 12 }),
        ],
        contextFactors: [],
        rankingEligible: false,
        rankingIneligibleReason: "Only 12 comparable observations. At least 20 are needed.",
        coverageCaveats: ["Most of this operator's service is unmeasured."],
      },
    ],
    comparabilityWarning: "Raw and adjusted figures are shown together on purpose.",
  };

  it("shows raw and adjusted figures together, never one alone", async () => {
    vi.spyOn(apiClient, "proOperators").mockResolvedValue({ data: operators });
    render(
      <MemoryRouter>
        <OperatorsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Punctuality (as measured)")).toBeTruthy();
    expect(screen.getByText("Punctuality (adjusted)")).toBeTruthy();
    expect(screen.getByText(/shown together on purpose/)).toBeTruthy();
  });

  it("keeps a non-comparable operator out of the ranked list, with its reason", async () => {
    vi.spyOn(apiClient, "proOperators").mockResolvedValue({ data: operators });
    const { container } = render(
      <MemoryRouter>
        <OperatorsPage />
      </MemoryRouter>,
    );

    await screen.findByText("First West Yorkshire");

    const scorecards = container.querySelector("#ops-comparable")!.closest("section")!;
    expect(within(scorecards).queryByText("Yorkshire Tiger")).toBeNull();

    // The section heading and the lozenge both say it; both are intentional.
    expect(screen.getByText(/Only 12 comparable observations/)).toBeTruthy();
    expect(screen.getAllByText("Not comparable").length).toBeGreaterThan(0);
  });
});
