import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Operator } from "@busstops/contracts";
import { TicketHandoff } from "./TicketHandoff.js";
import { WaitingHelp, type WaitingHelpProps } from "./WaitingHelp.js";

/**
 * The two pieces of passenger help, and the lines neither of them may cross.
 *
 * "Bus Stopped?" existed only on the vehicle page, reached by clicking a bus on the live map — so
 * a passenger standing at a stop whose bus had not come was offered nothing at all. And the ticket
 * registry is empty on purpose: an unverified ticket link sends somebody to the wrong place with
 * our name on it. Both of these are therefore as much about what is *not* said as what is.
 */

const NOW = new Date("2026-10-04T09:00:00.000Z");

function departure(route: string, destination: string, minutes: number, live = true) {
  return {
    id: `dep-${route}-${minutes}`,
    provenance: { source: "bods", retrievedAt: NOW.toISOString(), externalIds: [] },
    ingestedAt: NOW.toISOString(),
    qualityFlags: [],
    stopId: "stop-1",
    scheduledJourneyId: null,
    routePatternId: null,
    serviceRoutePublicName: route,
    destinationName: destination,
    scheduledTime: new Date(NOW.getTime() + minutes * 60_000).toISOString(),
    expectedTime: new Date(NOW.getTime() + minutes * 60_000).toISOString(),
    liveState: live ? "live" : "scheduled_only",
    uncertaintySeconds: 60,
    confidence: { level: "high", score: 0.9, reasons: [] },
  } as never;
}

function help(overrides: Partial<WaitingHelpProps> = {}) {
  const props: WaitingHelpProps = {
    stop: {
      id: "stop-1",
      atcoCode: "450010001",
      name: "Leeds City Bus Station",
      locationCoordinate: { lat: 53.7965, lon: -1.5379 },
    } as never,
    departures: [departure("36", "Roundhay Park", 4), departure("72", "Bradford", 11, false)],
    routes: [
      { id: "r-36", publicName: "36", operatorId: "op-1", operatorName: "First West Yorkshire" },
      { id: "r-72", publicName: "72", operatorId: "op-1", operatorName: "First West Yorkshire" },
    ],
    disruptions: [],
    degradation: "normal",
    now: NOW,
    ageSeconds: 30,
    nearby: [{ id: "stop-2", title: "Vicar Lane", distanceMetres: 240 }],
    nearbyFailed: false,
    walkingUrl: "https://example.test/walk",
    ...overrides,
  };
  render(
    <MemoryRouter>
      <WaitingHelp {...props} />
    </MemoryRouter>,
  );
}

describe("help for a passenger whose bus has not come", () => {
  it("offers every next action from what the board already knows", () => {
    help();

    // What is due, with route, destination and how long.
    expect(screen.getByText(/Roundhay Park/)).toBeTruthy();
    expect(screen.getByText(/4 min/)).toBeTruthy();
    // A timetabled row is marked as timetabled rather than passed off as observed.
    expect(screen.getByText(/timetabled/)).toBeTruthy();
    // Another stop to try, with how far.
    expect(screen.getByRole("link", { name: "Vicar Lane" })).toBeTruthy();
    expect(screen.getByText(/240 m away/)).toBeTruthy();
    // Another route from here.
    expect(screen.getByRole("link", { name: /72/ })).toBeTruthy();
    // A journey re-plan, starting from this stop.
    const replan = screen.getByRole("link", { name: /Plan a different journey/ });
    expect(replan.getAttribute("href")).toContain("fromLat=53.79650");
    expect(replan.getAttribute("href")).toContain("fromLabel=Leeds%20City%20Bus%20Station");
    // And who runs it, as a link rather than a label.
    expect(
      screen.getByRole("link", { name: /First West Yorkshire — who runs this service/ }),
    ).toBeTruthy();
  });

  /*
   * The line this feature must not cross. A bus missing from a board has not been cancelled as far
   * as we can see, and a passenger who walks away on our say-so misses the one that turns up two
   * minutes later.
   */
  it("never says a service is cancelled", () => {
    help({ departures: [] });

    // The only mention of the word is the sentence saying we cannot know.
    expect(screen.getByText(/not necessarily been cancelled/)).toBeTruthy();
    const assertions = screen
      .getAllByText(/cancel/i)
      .map((node) => node.textContent ?? "")
      .filter((text) => /\b(is|was|has been|have been)\s+cancelled/i.test(text));
    expect(assertions, "something on the panel asserts a cancellation").toEqual([]);
  });

  it("tells a missing timetable from a quiet hour", () => {
    help({
      departures: [],
      timetableCoverage: { read: 0, missing: 3, serviceDates: ["2026-10-04"] },
    });
    expect(screen.getByText(/no timetable published for today/)).toBeTruthy();
    expect(screen.getByText(/gap on our side/)).toBeTruthy();
  });

  it("says the board is timetabled when live tracking is not available", () => {
    help({ degradation: "scheduled_only" });
    expect(screen.getByText(/Live tracking is not available/)).toBeTruthy();
  });

  /* A lookup that failed is not an absence of nearby stops, and must not read as one. */
  it("tells a failed nearby lookup from there being no nearby stop", () => {
    help({ nearby: null, nearbyFailed: true });
    expect(screen.getByText(/could not look up nearby stops/)).toBeTruthy();
    expect(screen.getByText(/rather than there being none/)).toBeTruthy();
  });

  it("says there is none when the lookup came back empty", () => {
    help({ nearby: [], nearbyFailed: false });
    expect(screen.getByText(/no other stop within a few minutes/)).toBeTruthy();
  });
});

const OPERATOR = {
  id: "00000000-0000-5000-8000-000000000001",
  name: "First West Yorkshire",
  licenceRegistryIds: ["FWYO"],
  ticketDomains: [],
  serviceAreas: [],
  active: true,
} as unknown as Operator;

describe("the ticket hand-off", () => {
  /*
   * The registry is empty, so nothing claims to sell a ticket. What the operator publishes in the
   * national dataset is their own address, and that is offered as exactly that.
   */
  it("offers the operator's published site, and does not call it a ticket shop", () => {
    render(
      <TicketHandoff
        operator={{ ...OPERATOR, contactUrl: "https://www.firstbus.co.uk/" } as Operator}
        routeName="36"
      />,
    );

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://www.firstbus.co.uk/");
    // The hostname is in the text, so a poisoned feed cannot disguise where it leads.
    expect(link.textContent).toContain("firstbus.co.uk");
    expect(screen.getByText(/own website, as they publish it/)).toBeTruthy();
    expect(screen.queryByText(/Buy a ticket/)).toBeNull();
    // External, and not carrying our referrer.
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("refuses a plaintext address rather than sending a passenger to it", () => {
    render(
      <TicketHandoff
        operator={{ ...OPERATOR, contactUrl: "http://www.firstbus.co.uk/" } as Operator}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  /* Omitted cleanly, which is the requirement: no empty heading, no dead button. */
  it("renders nothing at all when there is no honest destination", () => {
    const { container } = render(<TicketHandoff operator={OPERATOR} />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing when there is no operator", () => {
    const { container } = render(<TicketHandoff operator={null} />);
    expect(container.textContent).toBe("");
  });
});
