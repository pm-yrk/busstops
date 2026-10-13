import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Incident, VehicleState } from "@busstops/contracts";
import { BusStoppedPanel } from "./BusStoppedPanel.js";

const now = new Date("2026-09-03T09:00:00.000Z");

function vehicle(overrides: Partial<VehicleState> = {}): VehicleState {
  return {
    id: "00000000-0000-5000-8000-00000000aaaa",
    provenance: { source: "bods", retrievedAt: now.toISOString(), externalIds: [] },
    ingestedAt: now.toISOString(),
    qualityFlags: ["ok"],
    vehicleRef: "opaque-ref",
    matchedRoutePatternId: null,
    matchedScheduledJourneyId: null,
    position: { lat: 53.8, lon: -1.55 },
    delaySeconds: 120,
    motionState: "stationary",
    nextStopId: null,
    freshnessSeconds: 300,
    matchConfidence: { level: "medium", score: 0.6, reasons: [] },
    ...overrides,
  };
}

function renderPanel(props: Partial<Parameters<typeof BusStoppedPanel>[0]> = {}) {
  return render(
    <MemoryRouter>
      <BusStoppedPanel
        vehicle={vehicle()}
        otherVehiclesMoving={null}
        otherVehiclesObserved={0}
        incidents={[]}
        nearEndOfRoute={false}
        now={now}
        nextServices={[]}
        alternativeStop={null}
        walkingUrl={null}
        operatorContactUrl={null}
        operatorName={null}
        {...props}
      />
    </MemoryRouter>,
  );
}

function officialIncident(): Incident {
  return {
    id: "00000000-0000-5000-8000-00000000dddd",
    provenance: { source: "national_highways", retrievedAt: now.toISOString(), externalIds: [] },
    ingestedAt: now.toISOString(),
    qualityFlags: [],
    type: "road_closure",
    startedAt: now.toISOString(),
    endedAt: null,
    geometry: { corridorId: "corridor-1" },
    affectedRouteIds: [],
    affectedVehicleRefs: [],
    severity: "elevated",
    confidence: { level: "high", score: 0.9, reasons: [] },
    evidence: [],
    officialStatus: "official",
    lifecycle: "active",
    narrative: "A96 closed northbound for emergency repairs.",
  };
}

describe("a lookup that has not landed is not an empty answer", () => {
  it("does not say there are no departures while it is still looking", () => {
    renderPanel({ contextState: "loading" });
    expect(screen.queryByText(/no other departures to suggest/i)).toBeNull();
    expect(screen.getByText(/looking for another way on/i)).toBeTruthy();
  });

  it("says the lookup failed rather than reporting nothing nearby", () => {
    renderPanel({ contextState: "unavailable" });
    expect(screen.queryByText(/no other departures to suggest/i)).toBeNull();
    expect(screen.getByText(/could not look up other departures/i)).toBeTruthy();
    expect(screen.getByText(/could not check what else is moving nearby/i)).toBeTruthy();
  });

  it("offers a retry only when the lookup actually failed", async () => {
    const onRetryContext = vi.fn();
    const { unmount } = renderPanel({ contextState: "unavailable", onRetryContext });
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetryContext).toHaveBeenCalledTimes(1);
    unmount();

    renderPanel({ contextState: "loading", onRetryContext });
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("withholds a claim about the traffic it has not looked at", () => {
    // `otherVehiclesMoving: false` with nothing observed would otherwise read as congestion.
    renderPanel({ contextState: "loading", otherVehiclesMoving: false, otherVehiclesObserved: 0 });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/also stationary/i);
    expect(text).not.toMatch(/traffic in the area/i);
  });

  it("still shows an official incident, which arrives with the vehicle and not the lookup", () => {
    renderPanel({
      contextState: "loading",
      incidents: [officialIncident()],
    });
    expect(screen.getByText(/A96 closed northbound/i)).toBeTruthy();
  });

  it("keeps saying nothing is due when it genuinely looked and found nothing", () => {
    renderPanel({ contextState: "ready" });
    expect(screen.getByText(/no other departures to suggest/i)).toBeTruthy();
  });
});

describe("BusStoppedPanel", () => {
  it("never claims a breakdown or a cancellation", () => {
    renderPanel();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/broken down|breakdown|cancelled|cancellation/i);
  });

  it("lists several possible explanations rather than picking one", () => {
    renderPanel({ otherVehiclesMoving: true, otherVehiclesObserved: 4 });
    const explanations = screen.getByRole("heading", { name: /what could explain it/i });
    expect(explanations).toBeTruthy();
    expect(screen.getAllByText(/Possible|Official evidence/).length).toBeGreaterThan(0);
  });

  it("says other buses are moving when they are, and when they are not", () => {
    // Scoped to the observations block: the same fact also appears as supporting evidence for
    // one of the plausible explanations, which is a different statement.
    const observations = () =>
      within(screen.getByRole("heading", { name: /what we can see/i }).parentElement!);

    const { unmount } = renderPanel({ otherVehiclesMoving: true, otherVehiclesObserved: 3 });
    expect(observations().getByText(/Other buses nearby are moving/)).toBeTruthy();
    unmount();

    renderPanel({ otherVehiclesMoving: false, otherVehiclesObserved: 5 });
    expect(observations().getByText(/also stationary/)).toBeTruthy();
    expect(observations().getByText(/usually means traffic/)).toBeTruthy();
  });

  it("admits when it cannot tell whether other buses are moving", () => {
    renderPanel({ otherVehiclesMoving: null });
    expect(screen.getByText(/cannot tell whether other buses/)).toBeTruthy();
  });

  it("shows a last-seen time, not a coordinate", () => {
    renderPanel();
    const observation = screen.getByText(/Last reliable position at/);
    expect(observation.textContent).toMatch(/\d{2}:\d{2}/);
    expect(observation.textContent).not.toMatch(/53\.8|-1\.55/);
  });

  it("says plainly when it has no position at all", () => {
    renderPanel({ vehicle: null });
    expect(screen.getByText(/no recent position for this bus/)).toBeTruthy();
  });

  it("offers the next useful services when there are any", () => {
    renderPanel({
      nextServices: [
        {
          routeName: "72",
          destination: "Bradford Interchange",
          expectedTime: "2026-09-03T09:12:00.000Z",
          live: true,
        },
      ],
    });
    expect(screen.getByText("72")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("says so when there is nothing else to suggest", () => {
    renderPanel({ nextServices: [] });
    expect(screen.getByText(/No other departures to suggest/)).toBeTruthy();
  });

  it("keeps emergency guidance to contacting the emergency services", () => {
    renderPanel();
    const guidance = screen.getByText(/immediate danger/);
    expect(guidance.textContent).toMatch(/999/);
    // No medical or vulnerability advice, and nothing that asks the reader to disclose a status.
    expect(guidance.textContent).not.toMatch(/medical|disability|vulnerable/i);
  });

  it("can be dismissed by the reader", async () => {
    const onDismiss = vi.fn();
    renderPanel({ onDismiss });
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
