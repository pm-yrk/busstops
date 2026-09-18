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
import { LiveMapPage } from "./LiveMapPage.js";
import { OperatorPage } from "./OperatorPage.js";
import { RoutePage } from "./RoutePage.js";
import { SearchPage } from "./SearchPage.js";
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
      disruptions: [],
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

  /*
   * One stop, one URL.
   *
   * This page linked to a stop by its internal UUID while everywhere else linked by ATCO code.
   * Both resolve, which is why it went unnoticed — and it meant a link shared from a route page
   * looked nothing like the same link shared from the map or from a departure board.
   */
  it("links to stops by the code on the pole, not by an internal identifier", async () => {
    vi.spyOn(apiClient, "route").mockResolvedValue(response);
    renderAt("/routes/r1", "/routes/:routeId", <RoutePage />);

    const link = await screen.findByRole("link", { name: "Leeds City Bus Station" });
    expect(link).toHaveAttribute("href", "/stops/450010001");

    for (const anchor of screen.getAllByRole("link")) {
      // No stop link may carry a UUID: that is the shape the bug had.
      expect(anchor.getAttribute("href") ?? "").not.toMatch(/^\/stops\/[0-9a-f]{8}-/);
    }
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
      official: [],
      sourcesQueried: [],
      officialCollectedAt: null,
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
              fromCoordinate: { lat: 53.7955, lon: -1.5478 },
              toCoordinate: { lat: 53.7971, lon: -1.5401 },
              departureSeconds: 32_400,
              arrivalSeconds: 32_700,
              departAtExpected: "2026-09-03T09:00:00.000Z",
              arriveAtExpected: "2026-09-03T09:05:00.000Z",
            },
            {
              mode: "bus",
              fromStopId: "s1",
              toStopId: "s2",
              fromName: "Leeds City Bus Station",
              toName: "Bradford Interchange",
              fromCoordinate: { lat: 53.7971, lon: -1.5401 },
              toCoordinate: { lat: 53.7929, lon: -1.7514 },
              routeId: "service-72",
              routePatternId: "pattern-72-outbound",
              routeName: "72",
              headsign: "Bradford",
              departureSeconds: 32_760,
              arrivalSeconds: 34_500,
              departAtExpected: "2026-09-03T09:06:00.000Z",
              arriveAtExpected: "2026-09-03T09:35:00.000Z",
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

describe("the live map's deep link", () => {
  /**
   * The viewport the page asked the API for, which is the only observable that says where the
   * map actually opened.
   */
  function bboxFromFirstCall(): string {
    const call = vi.mocked(apiClient.map).mock.calls[0];
    const bounds = call?.[0] as { west: number; south: number; east: number; north: number };
    return [bounds.west, bounds.south, bounds.east, bounds.north].join(",");
  }

  function renderLive(path: string) {
    vi.spyOn(apiClient, "map").mockImplementation(
      () => new Promise(() => {}) as ReturnType<typeof apiClient.map>,
    );
    return renderAt(path, "/live", <LiveMapPage />);
  }

  it("opens on the viewport the URL names", () => {
    renderLive("/live?bbox=-1.12,53.94,-1.03,53.99");
    // York, not the Leeds default.
    expect(bboxFromFirstCall()).toBe("-1.12,53.94,-1.03,53.99");
  });

  it("opens on the default camera when no viewport is named", () => {
    renderLive("/live");
    expect(bboxFromFirstCall()).toBe("-1.6,53.775,-1.49,53.825");
  });

  /*
   * A half-understood bbox would frame somewhere nobody asked for. Every one of these falls back
   * to the default rather than being corrected into a viewport of its own.
   */
  it.each([
    ["too few numbers", "/live?bbox=-1.12,53.94,-1.03"],
    ["not numbers", "/live?bbox=york,please,now,thanks"],
    ["inverted west and east", "/live?bbox=-1.03,53.94,-1.12,53.99"],
    ["inverted south and north", "/live?bbox=-1.12,53.99,-1.03,53.94"],
    ["off the planet", "/live?bbox=-400,53.94,-1.03,53.99"],
  ])("ignores a bbox that is %s", (_why, path) => {
    renderLive(path);
    expect(bboxFromFirstCall()).toBe("-1.6,53.775,-1.49,53.825");
  });
});

/*
 * Every result goes to the thing it is.
 *
 * Only a stop did. A route and an operator linked to `/search?q=<their own title>` — back to this
 * page, with the same query, for the same results. It looked like a broken link and was in fact a
 * link to where you already were.
 */
describe("search results go somewhere", () => {
  const results = [
    {
      kind: "stop" as const,
      id: "00000000-0000-5000-8000-0000000000c1",
      title: "Leeds City Bus Station",
      coordinate: { lat: 53.79, lon: -1.54 },
    },
    {
      kind: "route" as const,
      id: "00000000-0000-5000-8000-0000000000e1",
      title: "36",
      subtitle: "Transdev",
    },
    {
      kind: "operator" as const,
      id: "00000000-0000-5000-8000-0000000000a1",
      title: "First West Yorkshire",
    },
  ];

  it("sends a stop, a route and an operator to their own pages", async () => {
    vi.spyOn(apiClient, "search").mockResolvedValue({ meta, data: { results } });

    render(
      <MemoryRouter initialEntries={["/search?q=leeds"]}>
        <Routes>
          <Route path="/search" element={<SearchPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const stop = await screen.findByRole("link", { name: /Leeds City Bus Station/ });
    expect(stop).toHaveAttribute("href", "/stops/00000000-0000-5000-8000-0000000000c1");

    expect(screen.getByRole("link", { name: /36/ })).toHaveAttribute(
      "href",
      "/routes/00000000-0000-5000-8000-0000000000e1",
    );
    expect(screen.getByRole("link", { name: /First West Yorkshire/ })).toHaveAttribute(
      "href",
      "/operators/00000000-0000-5000-8000-0000000000a1",
    );

    // And none of them back to the page they are already on.
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).not.toMatch(/^\/search/);
    }
  });
});
