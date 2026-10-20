import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StopDeparturesResponse } from "@busstops/contracts";
import { SelectedStopBoard } from "./SelectedStopBoard.js";
import { SelectedVehicleBoard } from "./SelectedVehicleBoard.js";
import { apiClient } from "../lib/api.js";

/**
 * The two panels the map opens, and the proximity hint one of them gained.
 *
 * Selection itself happens inside a WebGL canvas, which jsdom does not have — the click plumbing is
 * covered by the end-to-end pass against a real renderer. What is worth asserting here is that the
 * panels a selection opens still open, and that the distance hint is proximity and nothing more.
 */

const meta = {
  generatedAt: "2026-09-03T09:00:00.000Z",
  observedAt: "2026-09-03T08:59:30.000Z",
  sources: [],
  coverage: 1,
  degradation: "normal" as const,
  governorState: "green" as const,
  attribution: ["Contains public sector information"],
};

/** Boar Lane, Leeds. */
const STOP_COORDINATE = { lat: 53.7965, lon: -1.5445 };

function stopResponse(): StopDeparturesResponse {
  return {
    meta,
    data: {
      stop: {
        id: "00000000-0000-5000-8000-0000000000d1",
        provenance: { source: "naptan", retrievedAt: meta.generatedAt, externalIds: [] },
        ingestedAt: meta.generatedAt,
        qualityFlags: ["ok"],
        atcoCode: "450010001",
        naptanCode: null,
        name: "Boar Lane",
        indicator: "Stand A",
        localityName: "Leeds",
        locationCoordinate: STOP_COORDINATE,
        stopType: "BCT",
        status: "active",
        amenities: [],
        accessibility: [],
      },
      departures: [],
      routes: [],
      timetableCoverage: { from: null, to: null },
    },
  } as unknown as StopDeparturesResponse;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function renderStopBoard(userCoordinate: { lat: number; lon: number } | null) {
  vi.spyOn(apiClient, "stop").mockResolvedValue(stopResponse());
  return render(
    <MemoryRouter>
      <SelectedStopBoard atcoCode="450010001" onClose={() => {}} userCoordinate={userCoordinate} />
    </MemoryRouter>,
  );
}

describe("the arrival board a selected stop opens", () => {
  it("still opens, with or without a known location", async () => {
    renderStopBoard(null);
    await waitFor(() => expect(screen.getByText("Boar Lane")).toBeTruthy());
    expect(screen.getByRole("link", { name: /everything about this stop/i })).toBeTruthy();
  });

  it("says nothing about distance when location is unknown", async () => {
    renderStopBoard(null);
    await waitFor(() => expect(screen.getByText("Boar Lane")).toBeTruthy());
    expect(screen.queryByText(/from you/i)).toBeNull();
  });

  /*
   * About 230 m away: close enough that walking to it is a real option, which is the only question
   * the hint is there to help with.
   */
  it("says how far away it is, and roughly how long to walk it", async () => {
    renderStopBoard({ lat: 53.7945, lon: -1.5445 });
    await waitFor(() => expect(screen.getByText(/from you/i)).toBeTruthy());

    const hint = screen.getByText(/from you/i).textContent ?? "";
    expect(hint).toMatch(/\d+ m from you/);
    expect(hint).toMatch(/about \d+ min walk/);
  });

  /*
   * Suppressed across town. "2.4 km from you · about 31 min walk" at a stop somebody tapped on the
   * other side of the city is arithmetic, not help, and not an option they were weighing.
   */
  it("stays quiet about a stop too far to walk to", async () => {
    renderStopBoard({ lat: 53.86, lon: -1.5445 });
    await waitFor(() => expect(screen.getByText("Boar Lane")).toBeTruthy());
    expect(screen.queryByText(/from you/i)).toBeNull();
  });

  /*
   * Proximity only, by construction: the board is given one coordinate and the stop's own, and has
   * nothing else to reason from. It cannot infer which bus somebody wants, which bus they are on,
   * or whether a bus near them is theirs — and this asserts the hint says none of those things.
   */
  it("claims nothing about which bus is yours", async () => {
    renderStopBoard({ lat: 53.7945, lon: -1.5445 });
    await waitFor(() => expect(screen.getByText(/from you/i)).toBeTruthy());

    const hint = screen.getByText(/from you/i).textContent ?? "";
    expect(hint).not.toMatch(/your bus|catch|on board|boarding/i);
  });
});

describe("the board a selected bus opens", () => {
  /*
   * It no longer fetches: the page owns the one selected-vehicle lookup and hands the answer to
   * both the card and the map, so a tap costs one request rather than two identical ones against
   * the endpoint that reads a live feed.
   */
  it("renders what it is given without asking for it", async () => {
    const vehicle = vi.spyOn(apiClient, "vehicle");

    render(
      <MemoryRouter>
        <SelectedVehicleBoard
          bounds={{ west: -1.6, south: 53.775, east: -1.49, north: 53.825 }}
          onClose={() => {}}
          detail={null}
          loading
          error={null}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/loading this bus/i)).toBeTruthy();
    expect(vehicle, "the card must not fetch; the page does").not.toHaveBeenCalled();
  });

  it("shows the error it is handed, and keeps the map usable", () => {
    render(
      <MemoryRouter>
        <SelectedVehicleBoard
          bounds={{ west: -1.6, south: 53.775, east: -1.49, north: 53.825 }}
          onClose={() => {}}
          detail={null}
          loading={false}
          error="This bus could not be loaded. The map is still usable."
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/map is still usable/i)).toBeTruthy();
  });
});
