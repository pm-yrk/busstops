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
import { BandStrip, DataModeBanner, ProMetricTile, ProTableWrap } from "./ProPrimitives.js";
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
    illustrative: false,
    ...overrides,
  };
}

describe("ProMetricTile", () => {
  it("shows the denominator, window and coverage beside the figure", () => {
    render(<ProMetricTile metric={metric()} />);
    /*
     * The figure and its unit are two elements now — "72" set large with "%" small beside it, so
     * the number is what the eye lands on — so this reads the tile's text the way a person does
     * rather than looking for one node containing both.
     */
    const tile = screen.getByTestId("metric-punctuality");
    expect(tile.querySelector(".pro-metric__value")?.textContent).toBe("72%");
    expect(screen.getByText("1,103")).toBeTruthy();
    expect(screen.getByText("last 60 minutes")).toBeTruthy();
    expect(screen.getByText("86%")).toBeTruthy();
  });

  it("tells a withheld figure from one this pipeline does not produce", () => {
    /*
     * Two different suppressions that read identically as "amber text under a dash", and only
     * one of them would be filled by waiting. A reader who cannot tell them apart will keep
     * waiting for a number that is never coming.
     */
    const withheld = metric({
      value: null,
      suppressed: true,
      suppressionReason: "Based on 3 observations; 20 are needed before a figure is published.",
    });
    const { unmount } = render(<ProMetricTile metric={withheld} />);
    expect(screen.getByTestId("metric-punctuality").dataset.state).toBe("withheld");
    unmount();

    const unmeasured = metric({
      value: null,
      suppressed: true,
      suppressionReason:
        "Not measured yet. This figure compares actual against scheduled time, and the " +
        "intelligence pipeline currently measures road-segment traversals only — it does not " +
        "read the timetable.",
    });
    render(<ProMetricTile metric={unmeasured} />);
    expect(screen.getByTestId("metric-punctuality").dataset.state).toBe("unmeasured");
  });

  it("makes an example figure impossible to mistake for a measurement", () => {
    /*
     * This badge is the whole safety mechanism for the demo preview. If it ever stops rendering,
     * simulated numbers sit on the page looking exactly like measured ones — so it is asserted
     * by its own words, not only by a class.
     */
    render(<ProMetricTile metric={metric({ illustrative: true })} />);
    const tile = screen.getByTestId("metric-punctuality");
    expect(tile.dataset.state).toBe("illustrative");
    expect(screen.getByText("Example figure")).toBeInTheDocument();
    expect(screen.getByText(/Illustrative value, not a measurement/i)).toBeInTheDocument();
  });

  it("marks a measured figure as measured", () => {
    render(<ProMetricTile metric={metric()} />);
    expect(screen.getByTestId("metric-punctuality").dataset.state).toBe("measured");
    // And carries the mark from the shared vocabulary, so Pro reads as the same design system.
    expect(
      screen.getByTestId("metric-punctuality").querySelector(".pro-metric__mark"),
    ).toBeTruthy();
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

describe("BandStrip", () => {
  /*
   * The zero band is the point of the component. A legend that lists "0 down" beside "4 healthy"
   * makes a reader check a thing that is not there, and on a strip it draws a band of no width
   * with a border, which reads as one more source.
   */
  it("leaves out a band nothing falls into", () => {
    const { container } = render(
      <BandStrip
        label="Sources by health"
        bands={[
          { tone: "healthy", label: "healthy", count: 4 },
          { tone: "abnormal", label: "stale", count: 0 },
          { tone: "highly_abnormal", label: "down", count: 1 },
        ]}
      />,
    );

    expect(container.querySelectorAll(".pro-severity__band--healthy").length).toBe(2);
    expect(container.querySelector(".pro-severity__band--abnormal")).toBeNull();
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByText("down")).toBeTruthy();
  });

  it("draws nothing at all rather than an empty frame when every band is zero", () => {
    const { container } = render(
      <BandStrip
        label="Sources by health"
        bands={[{ tone: "healthy", label: "healthy", count: 0 }]}
      />,
    );
    expect(container.querySelector(".pro-severity")).toBeNull();
  });
});

describe("ProTableWrap", () => {
  /*
   * The regression this exists for: every Pro table is wider than a phone, so its wrapper scrolls,
   * and a wrapper that scrolls without taking focus hides its right-hand columns from a keyboard
   * entirely. It only surfaced once the tables had rows — an empty table does not overflow — so
   * populating Pro for the demo is what introduced it.
   */
  it("can be reached and scrolled by keyboard, and says what it is", () => {
    render(
      <ProTableWrap label="Route performance">
        <table>
          <tbody>
            <tr>
              <td>4</td>
            </tr>
          </tbody>
        </table>
      </ProTableWrap>,
    );

    const region = screen.getByRole("region", { name: "Route performance" });
    expect(region.tabIndex).toBe(0);
  });
});

describe("what Pro says about the age of its own figures", () => {
  /*
   * `dataMode: "live"` was doing two jobs and only admitting to one. It says the figures come from
   * real observations rather than the demonstration snapshot; it says nothing about when those
   * observations were. The deployed Pro has reported "live" with its newest settled window a
   * fortnight old, and the only place that appeared was a sentence among the coverage caveats — so
   * an operations dashboard looked current while describing a period two weeks gone.
   */
  const at = (iso: string) => new Date(iso);

  it("says nothing when a live measurement is recent", () => {
    render(
      <DataModeBanner
        provenance={{
          dataMode: "live",
          snapshotDate: null,
          notice: null,
          measuredAt: "2026-10-04T09:00:00.000Z",
        }}
        now={at("2026-10-04T09:40:00.000Z")}
      />,
    );
    expect(screen.queryByTestId("pro-data-mode")).toBeNull();
  });

  it("says how old a live measurement is, in hours, once it is not recent", () => {
    render(
      <DataModeBanner
        provenance={{
          dataMode: "live",
          snapshotDate: null,
          notice: null,
          measuredAt: "2026-10-04T03:00:00.000Z",
        }}
        now={at("2026-10-04T09:00:00.000Z")}
      />,
    );
    expect(screen.getByTestId("pro-data-mode").textContent).toContain("6 hours");
    // Still credited as real data, because it is.
    expect(screen.getByTestId("pro-data-mode").textContent).toContain("Real observations");
  });

  it("says it in days when it is a fortnight, which is what the deployment reported", () => {
    render(
      <DataModeBanner
        provenance={{
          dataMode: "live",
          snapshotDate: null,
          notice: null,
          measuredAt: "2026-09-20T14:25:00.000Z",
        }}
        now={at("2026-10-04T09:00:00.000Z")}
      />,
    );
    expect(screen.getByTestId("pro-data-mode").textContent).toContain("14 days");
    expect(screen.getByTestId("pro-data-mode").textContent).toContain("not as the state of the");
  });

  /* Nothing measured is a different fact from measured long ago, and must not borrow its wording. */
  it("says nothing when there is no measurement to date", () => {
    render(
      <DataModeBanner
        provenance={{ dataMode: "live", snapshotDate: null, notice: null, measuredAt: null }}
        now={at("2026-10-04T09:00:00.000Z")}
      />,
    );
    expect(screen.queryByTestId("pro-data-mode")).toBeNull();
  });

  it("still labels the demonstration snapshot as a snapshot", () => {
    render(
      <DataModeBanner
        provenance={{
          dataMode: "demo_snapshot",
          snapshotDate: "2026-08-14",
          notice: "Demonstration snapshot from 2026-08-14.",
          measuredAt: null,
        }}
        now={at("2026-10-04T09:00:00.000Z")}
      />,
    );
    const banner = screen.getByTestId("pro-data-mode");
    expect(banner.textContent).toContain("Demonstration snapshot");
    expect(banner.textContent).toContain("2026-08-14");
    expect(banner.textContent).not.toContain("Real observations");
  });
});
