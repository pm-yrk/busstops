import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { JourneyStrip, type JourneyStripLeg } from "./JourneyStrip.js";

/**
 * The strip draws the plan the planner produced. These hold it to that: every place, time, route
 * number and headsign on the screen has to have come from a leg, and a change may only be marked
 * where one actually happens.
 */
function walk(from: string, to: string, minutes: number): JourneyStripLeg {
  return {
    mode: "walk",
    fromName: from,
    toName: to,
    departureLabel: "09:00",
    arrivalLabel: "09:09",
    minutes,
  };
}

function ride(route: string, from: string, to: string, headsign: string | null): JourneyStripLeg {
  return {
    mode: "bus",
    fromName: from,
    toName: to,
    routeName: route,
    headsign,
    departureLabel: "09:12",
    arrivalLabel: "09:41",
    minutes: 29,
  };
}

describe("JourneyStrip", () => {
  it("shows the walk, the bus, where it is going and the arrival", () => {
    render(
      <JourneyStrip
        legs={[
          walk("Your starting point", "Leeds City Bus Station", 9),
          ride("757", "Leeds City Bus Station", "Leeds Bradford Airport", "Bradford"),
        ]}
      />,
    );

    expect(screen.getByText(/walk 9 min/i)).toBeTruthy();
    expect(screen.getByText("757")).toBeTruthy();
    expect(screen.getByText(/towards Bradford/i)).toBeTruthy();
    expect(screen.getByText("Leeds Bradford Airport")).toBeTruthy();
    expect(screen.getByText("09:41")).toBeTruthy();
  });

  it("marks a change only where one happens", () => {
    const direct = render(<JourneyStrip legs={[walk("A", "B", 4), ride("36", "B", "C", null)]} />);
    expect(direct.queryByText(/change/i)).toBeNull();
    direct.unmount();

    render(
      <JourneyStrip
        legs={[
          walk("A", "B", 4),
          ride("36", "B", "C", null),
          walk("C", "D", 3),
          ride("X1", "D", "E", null),
        ]}
      />,
    );
    expect(screen.getAllByText(/^change$/i)).toHaveLength(1);
  });

  it("says nothing about a headsign the planner did not give", () => {
    render(<JourneyStrip legs={[ride("12", "A", "B", null)]} />);
    expect(screen.queryByText(/towards/i)).toBeNull();
  });

  it("draws nothing at all for a plan with no legs", () => {
    const { container } = render(<JourneyStrip legs={[]} />);
    expect(container.querySelector(".journey-strip")).toBeNull();
  });
});

/**
 * A plan a passenger cannot act on is half a feature. These hold the two ways out of it: the
 * service they are told to board opens its route, and a stop they are told to stand at opens its
 * board. Both are driven by the ids the planner returned — never by the names, because the ends
 * of a journey are a pin or a postcode and have no stop to open.
 */
describe("getting out of a journey plan", () => {
  it("opens the route from the number, by id rather than by the number on the front", () => {
    render(
      <MemoryRouter>
        <JourneyStrip
          legs={[
            {
              ...ride("36", "Leeds City Bus Station", "Harrogate Bus Station", "Ripon"),
              routeId: "a7f1c2d4-0000-4000-8000-000000000036",
              fromStopId: "450010510",
              toStopId: "320010240",
            },
          ]}
        />
      </MemoryRouter>,
    );

    const routeLink = screen.getByRole("link", { name: /Route 36/ });
    expect(routeLink.getAttribute("href")).toBe("/routes/a7f1c2d4-0000-4000-8000-000000000036");

    expect(screen.getByRole("link", { name: "Leeds City Bus Station" }).getAttribute("href")).toBe(
      "/stops/450010510",
    );
  });

  it("leaves the ends of the journey as plain text, because a pin has no board", () => {
    render(
      <MemoryRouter>
        <JourneyStrip
          legs={[
            { ...walk("Your starting point", "Leeds City Bus Station", 9), toStopId: "450010510" },
            {
              ...ride("36", "Leeds City Bus Station", "Harrogate Bus Station", "Ripon"),
              fromStopId: "450010510",
            },
          ]}
        />
      </MemoryRouter>,
    );

    // The asked-for origin is not a stop and must not offer a board.
    expect(screen.queryByRole("link", { name: "Your starting point" })).toBeNull();
    expect(screen.getByText("Your starting point")).toBeTruthy();
    // No route id, so the number is still shown — just not as a link.
    expect(screen.queryByRole("link", { name: /Route 36/ })).toBeNull();
    expect(screen.getByText("36")).toBeTruthy();
  });
});
