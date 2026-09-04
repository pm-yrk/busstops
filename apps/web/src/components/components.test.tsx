import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Confidence, DeparturePrediction } from "@busstops/contracts";
import { ArrivalBoard, describeState } from "./ArrivalBoard.js";
import { LoadingBus } from "./LoadingBus.js";
import { Wordmark } from "./Wordmark.js";
import {
  ComparisonBar,
  ConfidenceChip,
  DataAge,
  EmptyState,
  ErrorState,
  MetricTile,
  ServiceBanner,
  StateLozenge,
} from "./primitives.js";
import { PixelBusSide } from "./pixel/PixelArt.js";
import { HomePage } from "../pages/HomePage.js";
import { MethodologyPage } from "../pages/MethodologyPage.js";

const confidence: Confidence = { level: "high", score: 0.9, reasons: ["fresh live data"] };
const now = new Date("2026-09-02T08:00:00Z");

function departure(overrides: Partial<DeparturePrediction> = {}): DeparturePrediction {
  return {
    id: `id-${Math.random()}`,
    provenance: { source: "tfl", retrievedAt: "2026-09-02T08:00:00.000Z", externalIds: [] },
    ingestedAt: "2026-09-02T08:00:00.000Z",
    qualityFlags: [],
    stopId: "00000000-0000-5000-8000-00000000bbbb",
    scheduledJourneyId: null,
    routePatternId: null,
    serviceRoutePublicName: "72",
    destinationName: "Bradford Interchange",
    scheduledTime: null,
    expectedTime: "2026-09-02T08:05:00.000Z",
    liveState: "live",
    uncertaintySeconds: 60,
    confidence,
    ...overrides,
  };
}

describe("Wordmark", () => {
  it("announces the brand once, with the full stop as part of the name", () => {
    render(<Wordmark as="h1" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Bus Stops.");
  });

  it("hides the decorative split lettering from assistive technology", () => {
    const { container } = render(<Wordmark variant="stacked" size="hero" />);
    // The visible text is aria-hidden; the accessible name comes from the single sr-only span.
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByText("Bus Stops.")).toHaveClass("visually-hidden");
  });
});

describe("pixel art", () => {
  it("is decorative by default, so rows do not announce a bus each time", () => {
    const { container } = render(<PixelBusSide />);
    const sprite = container.querySelector("img")!;
    expect(sprite.getAttribute("aria-hidden")).toBe("true");
    expect(sprite.getAttribute("role")).toBe("presentation");
    expect(sprite.getAttribute("alt")).toBe("");
  });

  it("becomes an image with a name when given a title", () => {
    render(<PixelBusSide title="Bus approaching" />);
    expect(screen.getByRole("img", { name: "Bus approaching" })).toBeInTheDocument();
  });
});

describe("LoadingBus", () => {
  it("announces loading politely", () => {
    render(<LoadingBus label="Loading departures" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading departures");
  });

  it("yields to a plain message once the caller's deadline passes", () => {
    render(<LoadingBus timedOut />);
    expect(screen.getByRole("status")).toHaveTextContent(/taking longer than usual/i);
  });
});

describe("ArrivalBoard", () => {
  it("shows the stop, its code and the NEXT BUS heading", () => {
    render(
      <ArrivalBoard
        stopName="Leeds City Bus Station"
        stopCode="32900001"
        departures={[departure()]}
        now={now}
        ageSeconds={12}
      />,
    );

    expect(screen.getByRole("heading", { name: "Leeds City Bus Station" })).toBeInTheDocument();
    expect(screen.getByText("Stop 32900001")).toBeInTheDocument();
    expect(screen.getByText("NEXT BUS")).toBeInTheDocument();
  });

  it("is a real table, so the rows are readable in order by a screen reader", () => {
    render(
      <ArrivalBoard
        stopName="Leeds City Bus Station"
        stopCode="32900001"
        departures={[
          departure(),
          departure({ serviceRoutePublicName: "X1", destinationName: "Sheffield Interchange" }),
        ]}
        now={now}
        ageSeconds={12}
      />,
    );

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + two departures
    expect(within(table).getByText("Bradford Interchange")).toBeInTheDocument();
    expect(within(table).getByText("Sheffield Interchange")).toBeInTheDocument();
  });

  it("shows a countdown that never goes negative", () => {
    render(
      <ArrivalBoard
        stopName="Stop"
        stopCode="1"
        departures={[departure({ expectedTime: "2026-09-02T07:50:00.000Z" })]}
        now={now}
        ageSeconds={5}
      />,
    );

    // "Due" is also the column heading, so assert on the countdown cell itself.
    const row = within(screen.getByRole("table")).getAllByRole("row")[1]!;
    expect(within(row).getByText("Due")).toBeInTheDocument();
    expect(within(row).queryByText(/^-/)).toBeNull();
  });

  it("labels live, timetable and cancelled states in words, not colour alone", () => {
    render(
      <ArrivalBoard
        stopName="Stop"
        stopCode="1"
        departures={[
          departure({ liveState: "live" }),
          departure({ liveState: "scheduled_only", serviceRoutePublicName: "12" }),
          departure({ liveState: "cancelled", serviceRoutePublicName: "13" }),
        ]}
        now={now}
        ageSeconds={5}
      />,
    );

    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Timetable")).toBeInTheDocument();
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
  });

  it("marks a stale row as last known rather than presenting it as live", () => {
    expect(describeState(departure({ qualityFlags: ["stale"] })).label).toBe("Last known");
  });

  it("states its own age, and says timetable only when there is no live data", () => {
    const { rerender } = render(
      <ArrivalBoard
        stopName="Stop"
        stopCode="1"
        departures={[departure()]}
        now={now}
        ageSeconds={45}
      />,
    );
    expect(screen.getByText(/Updated 45 seconds ago/)).toBeInTheDocument();

    rerender(
      <ArrivalBoard
        stopName="Stop"
        stopCode="1"
        departures={[departure()]}
        now={now}
        ageSeconds={null}
      />,
    );
    expect(screen.getByText("Timetable only")).toBeInTheDocument();
  });

  it("explains an empty board differently when degraded", () => {
    const { rerender } = render(
      <ArrivalBoard stopName="Stop" stopCode="1" departures={[]} now={now} ageSeconds={5} />,
    );
    expect(screen.getByText(/No departures in the next hour/)).toBeInTheDocument();

    rerender(
      <ArrivalBoard
        stopName="Stop"
        stopCode="1"
        departures={[]}
        now={now}
        ageSeconds={5}
        degraded
      />,
    );
    expect(screen.getByText(/No live departures available right now/)).toBeInTheDocument();
  });

  it("offers view all departures when the caller provides the action", async () => {
    let clicked = false;
    render(
      <ArrivalBoard
        stopName="Stop"
        stopCode="1"
        departures={[departure()]}
        now={now}
        ageSeconds={5}
        onViewAll={() => {
          clicked = true;
        }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /view all departures/i }));
    expect(clicked).toBe(true);
  });
});

describe("primitives", () => {
  it("shows confidence with its reason, not just a level", () => {
    render(
      <ConfidenceChip
        confidence={{ level: "low", score: 0.2, reasons: ["prediction is 5 minutes old"] }}
      />,
    );
    expect(screen.getByText("Low confidence")).toBeInTheDocument();
    expect(screen.getByText(/prediction is 5 minutes old/)).toBeInTheDocument();
  });

  it("marks ageing data as stale for screen readers too", () => {
    render(<DataAge seconds={600} />);
    expect(screen.getByText(/older than usual/)).toBeInTheDocument();
  });

  it("shows a metric with its denominator and window, not a bare number", () => {
    render(
      <MetricTile
        label="Punctuality"
        value="82"
        unit="%"
        denominator="1,240 observations"
        window="last 24 hours"
        confidence={confidence}
      />,
    );
    expect(screen.getByText("Punctuality")).toBeInTheDocument();
    expect(screen.getByText(/1,240 observations · last 24 hours/)).toBeInTheDocument();
    expect(screen.getByText("High confidence")).toBeInTheDocument();
  });

  it("shows the service banner only when degraded", () => {
    const { rerender, container } = render(
      <ServiceBanner meta={{ degradation: "normal", governorState: "green" }} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(<ServiceBanner meta={{ degradation: "stale_data", governorState: "amber" }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/older than usual/i);
  });

  it("renders empty and error states with a way forward", async () => {
    let retried = false;
    render(
      <>
        <EmptyState title="Nothing here" description="Try something else." />
        <ErrorState description="It broke." onRetry={() => (retried = true)} />
      </>,
    );

    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("It broke.");
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(retried).toBe(true);
  });

  it("puts the comparison value in text as well as in the bar", () => {
    render(
      <ComparisonBar label="Journey time" value={14.2} comparison={9.5} max={20} unit=" min" />,
    );
    expect(screen.getByText(/14.2/)).toBeInTheDocument();
    expect(screen.getByText(/vs 9.5 min typical/)).toBeInTheDocument();
  });

  it("renders a state lozenge with its text", () => {
    render(<StateLozenge tone="warning">Timetable only</StateLozenge>);
    expect(screen.getByText("Timetable only")).toBeInTheDocument();
  });
});

describe("HomePage", () => {
  it("puts the wordmark, one promise and one primary cue above the fold", () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Bus Stops.");
    expect(screen.getByText(/Know where your bus really is/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open the live map/i })).toHaveAttribute(
      "href",
      "/live",
    );
  });

  it("keeps the explanatory content in the DOM rather than behind an animation", () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    // Reduced-motion and screen-reader users must not be waiting on a scroll reveal.
    expect(screen.getByRole("heading", { name: "Bus Stops Live" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bus Stops Pro" })).toBeInTheDocument();
    expect(screen.getByText(/Bus Open Data Service/)).toBeInTheDocument();
  });
});

describe("MethodologyPage", () => {
  it("lists every source from the shared registry, so it cannot drift from the code", () => {
    render(
      <MemoryRouter>
        <MethodologyPage />
      </MemoryRouter>,
    );

    const table = screen.getByRole("table");
    expect(within(table).getByText("Bus Open Data Service (BODS)")).toBeInTheDocument();
    expect(within(table).getByText("Transport for London Unified API")).toBeInTheDocument();
    expect(within(table).getByText("NaPTAN")).toBeInTheDocument();
  });

  it("states plainly where a contract was verified only against documentation", () => {
    render(
      <MemoryRouter>
        <MethodologyPage />
      </MemoryRouter>,
    );
    expect(screen.getAllByText("Against published documentation only").length).toBeGreaterThan(0);
  });

  it("says what the product deliberately does not do", () => {
    render(
      <MemoryRouter>
        <MethodologyPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/does not replay history/i)).toBeInTheDocument();
    expect(screen.getByText(/does not identify drivers/i)).toBeInTheDocument();
  });
});
