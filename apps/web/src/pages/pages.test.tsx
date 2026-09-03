import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DisruptionsResponse,
  JourneyPlanResponse,
  OperatorDetailResponse,
  ResponseMeta,
  RouteDetailResponse,
} from "@busstops/contracts";
import { DisruptionsPage } from "./DisruptionsPage.js";
import { JourneyPage, clockLabel } from "./JourneyPage.js";
import { OperatorPage } from "./OperatorPage.js";
import { RoutePage } from "./RoutePage.js";
import { apiClient } from "../lib/api.js";

const meta: ResponseMeta = {
  generatedAt: "2026-09-03T09:00:00.000Z",
  observedAt: "2026-09-03T08:59:30.000Z",
  sources: [],
  coverage: 1,
  degradation: "normal",
  governorState: "green",
  attribution: ["Contains public sector information"],
};

afterEach(() => {
  vi.restoreAllMocks();
});

function renderAt(path: string, pattern: string, element: ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RoutePage", () => {
  const response: RouteDetailResponse = {
    meta,
    data: {
      route: {
        id: "00000000-0000-5000-8000-000000000001",
        provenance: { source: "bods", retrievedAt: meta.generatedAt, externalIds: [] },
        ingestedAt: meta.generatedAt,
        qualityFlags: ["ok"],
        operatorId: "00000000-0000-5000-8000-0000000000aa",
        publicName: "72",
        mode: "bus",
        description: "Leeds to Bradford",
        coverageArea: "non_london",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: null,
      },
      operator: {
        id: "00000000-0000-5000-8000-0000000000aa",
        provenance: { source: "bods", retrievedAt: meta.generatedAt, externalIds: [] },
        ingestedAt: meta.generatedAt,
        qualityFlags: ["ok"],
        name: "First West Yorkshire",
        licenceRegistryIds: [],
        ticketDomains: [],
        serviceAreas: ["non_london"],
        active: true,
      },
      variants: [
        {
          patternId: "00000000-0000-5000-8000-0000000000b1",
          direction: "outbound",
          description: "Leeds City Bus Station to Bradford Interchange",
          distanceMetres: 14200,
          stops: [
            {
              stopId: "00000000-0000-5000-8000-0000000000c1",
              atcoCode: "450010001",
              name: "Leeds City Bus Station",
              locality: "Leeds",
              sequence: 0,
            },
            {
              stopId: "00000000-0000-5000-8000-0000000000c2",
              atcoCode: "450010002",
              name: "Bradford Interchange",
              locality: "Bradford",
              sequence: 1,
            },
          ],
        },
      ],
      activeVehicles: [],
      headwaySummary: null,
      reliability: [],
      incidents: [],
      ticketUrl: null,
    },
  };

  it("shows the stop sequence and the operator", async () => {
    vi.spyOn(apiClient, "route").mockResolvedValue(response);
    renderAt("/routes/r1", "/routes/:routeId", <RoutePage />);

    expect(await screen.findByText("Leeds to Bradford")).toBeTruthy();
    expect(screen.getByRole("link", { name: "First West Yorkshire" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Leeds City Bus Station" })).toBeTruthy();
  });

  it("says why no frequency is shown rather than inventing one", async () => {
    vi.spyOn(apiClient, "route").mockResolvedValue(response);
    renderAt("/routes/r1", "/routes/:routeId", <RoutePage />);

    expect(await screen.findByText(/does not support a meaningful frequency/)).toBeTruthy();
  });

  it("distinguishes a feed outage from there genuinely being no buses", async () => {
    vi.spyOn(apiClient, "route").mockResolvedValue({
      ...response,
      meta: { ...meta, degradation: "scheduled_only" },
    });
    renderAt("/routes/r1", "/routes/:routeId", <RoutePage />);

    expect(await screen.findByText(/Live vehicle data is not available/)).toBeTruthy();
    expect(screen.getByText(/timetable below is unaffected/)).toBeTruthy();
  });
});

describe("OperatorPage", () => {
  const response: OperatorDetailResponse = {
    meta,
    data: {
      operator: {
        id: "00000000-0000-5000-8000-0000000000aa",
        provenance: { source: "bods", retrievedAt: meta.generatedAt, externalIds: [] },
        ingestedAt: meta.generatedAt,
        qualityFlags: ["ok"],
        name: "First West Yorkshire",
        licenceRegistryIds: [],
        ticketDomains: [],
        serviceAreas: ["non_london"],
        active: true,
      },
      routes: [
        {
          id: "00000000-0000-5000-8000-000000000001",
          publicName: "72",
          description: "Leeds to Bradford",
        },
      ],
      metrics: [
        {
          label: "Punctuality",
          value: null,
          unit: "percent",
          denominator: 3,
          suppressed: true,
          note: "Based on 3 observations; 20 are needed before a figure is published.",
          confidence: null,
        },
      ],
      rankingEligible: false,
      rankingIneligibleReason: "Not enough published observations to compare this operator.",
      coverageCaveats: ["Coverage outside London comes from the Bus Open Data Service."],
      incidents: [],
    },
  };

  it("shows a dash and the reason instead of a suppressed figure", async () => {
    vi.spyOn(apiClient, "operator").mockResolvedValue(response);
    renderAt("/operators/o1", "/operators/:operatorId", <OperatorPage />);

    expect(await screen.findByText("First West Yorkshire")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText(/20 are needed before a figure is published/)).toBeTruthy();
  });

  it("states that the operator cannot be ranked", async () => {
    vi.spyOn(apiClient, "operator").mockResolvedValue(response);
    renderAt("/operators/o1", "/operators/:operatorId", <OperatorPage />);
    expect(await screen.findByText(/Not enough published observations to compare/)).toBeTruthy();
  });

  it("lists what the data does and does not cover", async () => {
    vi.spyOn(apiClient, "operator").mockResolvedValue(response);
    renderAt("/operators/o1", "/operators/:operatorId", <OperatorPage />);
    expect(await screen.findByText(/Bus Open Data Service/)).toBeTruthy();
  });
});

describe("DisruptionsPage", () => {
  const response: DisruptionsResponse = {
    meta,
    data: {
      byDelayBurden: [],
      byAbnormality: [],
      uncoveredAreas: ["No incident analysis has been published yet."],
    },
  };

  it("offers both rankings and explains how they differ", async () => {
    vi.spyOn(apiClient, "disruptions").mockResolvedValue(response);
    render(
      <MemoryRouter>
        <DisruptionsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("tab", { name: /largest delay burden/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /most abnormal/i })).toBeTruthy();
    expect(screen.getByText(/total passenger time lost/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("tab", { name: /most abnormal/i }));
    expect(screen.getByText(/how far conditions are from normal/i)).toBeTruthy();
  });

  it("never lets an empty list read as nothing being wrong", async () => {
    vi.spyOn(apiClient, "disruptions").mockResolvedValue(response);
    render(
      <MemoryRouter>
        <DisruptionsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/No incident analysis has been published yet/)).toBeTruthy();
    expect(screen.getByText(/does not mean nothing is wrong where we cannot/i)).toBeTruthy();
  });
});

describe("JourneyPage", () => {
  const plan: JourneyPlanResponse = {
    meta,
    data: {
      serviceDate: "2026-09-03",
      options: [
        {
          ranking: "fastest",
          legs: [
            {
              mode: "walk",
              fromStopId: null,
              toStopId: "s1",
              fromName: "Where you are",
              toName: "Leeds City Bus Station",
              departureSeconds: 32_400,
              arrivalSeconds: 32_700,
            },
            {
              mode: "bus",
              fromStopId: "s1",
              toStopId: "s2",
              fromName: "Leeds City Bus Station",
              toName: "Bradford Interchange",
              routeName: "72",
              headsign: "Bradford",
              departureSeconds: 32_760,
              arrivalSeconds: 34_500,
            },
          ],
          departureSeconds: 32_400,
          arrivalSeconds: 34_500,
          arrivalLowSeconds: 34_200,
          arrivalHighSeconds: 35_400,
          totalWalkSeconds: 300,
          changeCount: 0,
          boardingStopId: "s1",
          confidence: { level: "medium", score: 0.6, reasons: ["scheduled data only"] },
        },
      ],
      explanation: null,
      unavailableReason: null,
    },
  };

  it("shows arrival as a range, never a single time", async () => {
    vi.spyOn(apiClient, "search").mockResolvedValue({
      meta,
      data: {
        results: [
          {
            kind: "stop",
            id: "s1",
            title: "Leeds City Bus Station",
            coordinate: { lat: 53.79, lon: -1.54 },
          },
        ],
      },
    });
    vi.spyOn(apiClient, "journey").mockResolvedValue(plan);

    render(
      <MemoryRouter>
        <JourneyPage />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByLabelText("From"), "leeds");
    await userEvent.click(await screen.findByRole("button", { name: /Leeds City Bus Station/ }));
    await userEvent.type(screen.getByLabelText("To"), "leeds");
    await userEvent.click(await screen.findByRole("button", { name: /Leeds City Bus Station/ }));
    await userEvent.click(screen.getByRole("button", { name: /plan journey/i }));

    const arrival = await screen.findByText(/Arrive between/);
    expect(arrival.textContent).toMatch(/Arrive between \d{2}:\d{2} and \d{2}:\d{2}/);
  });

  it("says the journey could not be planned instead of showing an empty list", async () => {
    vi.spyOn(apiClient, "search").mockResolvedValue({
      meta,
      data: {
        results: [
          { kind: "stop", id: "s1", title: "Somewhere", coordinate: { lat: 53.79, lon: -1.54 } },
        ],
      },
    });
    vi.spyOn(apiClient, "journey").mockResolvedValue({
      ...plan,
      data: {
        ...plan.data,
        options: [],
        unavailableReason: "No timetable data is published for this area yet.",
      },
    });

    render(
      <MemoryRouter>
        <JourneyPage />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByLabelText("From"), "some");
    await userEvent.click(await screen.findByRole("button", { name: /Somewhere/ }));
    await userEvent.type(screen.getByLabelText("To"), "some");
    await userEvent.click(await screen.findByRole("button", { name: /Somewhere/ }));
    await userEvent.click(screen.getByRole("button", { name: /plan journey/i }));

    expect(
      await screen.findByText(/No timetable data is published for this area yet/),
    ).toBeTruthy();
  });

  it("accepts a destination handed over from the map or a stop page", async () => {
    vi.spyOn(apiClient, "journey").mockResolvedValue(plan);

    render(
      <MemoryRouter
        initialEntries={[
          "/journey?toLat=53.79650&toLon=-1.53790&toLabel=Leeds%20City%20Bus%20Station",
        ]}
      >
        <JourneyPage />
      </MemoryRouter>,
    );

    // Pre-filled, so the reader does not have to search for the place they just tapped.
    expect(screen.getByText("Leeds City Bus Station")).toBeTruthy();
    expect(screen.queryByLabelText("To")).toBeNull();
  });

  it("ignores a malformed handover rather than half-applying it", () => {
    render(
      <MemoryRouter initialEntries={["/journey?toLat=nonsense&toLabel=Somewhere"]}>
        <JourneyPage />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("To")).toBeTruthy();
  });

  it("tells the reader their location is not stored", () => {
    render(
      <MemoryRouter>
        <JourneyPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/are not stored/)).toBeTruthy();
  });

  it("renders times past midnight as the next day's clock, not as 25:10", () => {
    expect(clockLabel(90_600, "2026-09-03")).toBe("01:10");
    expect(clockLabel(32_400, "2026-09-03")).toBe("09:00");
  });
});
