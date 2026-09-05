import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AccessibilityFact, DisruptionNotice, StopAccessibility } from "@busstops/contracts";
import { AccessibilityCard } from "./AccessibilityCard.js";
import { OfficialNotices } from "./OfficialNotices.js";

/**
 * These cover the two claims the product must never get wrong: that an unrecorded accessibility
 * fact is not a "no", and that an empty disruption list says which kind of empty it is.
 */

function fact(overrides: Partial<AccessibilityFact> = {}): AccessibilityFact {
  return {
    key: "shelter",
    status: "yes",
    source: "naptan",
    sourceField: "amenities.shelter",
    sourceUpdatedAt: null,
    provenance: "NaPTAN stop record",
    confidence: "high",
    ...overrides,
  } as AccessibilityFact;
}

function accessibility(facts: AccessibilityFact[]): StopAccessibility {
  return {
    atcoCode: "450010001",
    facts,
    sourcesConsulted: [
      { source: "naptan", outcome: facts.length > 0 ? "had_data" : "no_record" },
      { source: "osm", outcome: "not_available" },
    ],
  };
}

describe("AccessibilityCard", () => {
  it("shows what a source published, with the source named", () => {
    render(<AccessibilityCard accessibility={accessibility([fact()])} />);

    expect(screen.getByRole("heading", { name: /Accessibility at this stop/ })).toBeTruthy();
    expect(screen.getByText("Shelter")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText(/NaPTAN, the national stop register/)).toBeTruthy();
  });

  it("calls an unrecorded fact 'Not recorded', never 'No'", async () => {
    render(
      <AccessibilityCard
        accessibility={accessibility([fact({ key: "wheelchair_boarding", status: "unknown" })])}
      />,
    );

    // Hidden behind a disclosure so the card leads with what is known, but present and honest.
    await userEvent.click(screen.getByRole("button", { name: /has not been recorded/ }));
    expect(screen.getByText("Not recorded")).toBeTruthy();
    expect(screen.queryByText("No")).toBeNull();
  });

  it("says an empty card means nobody recorded anything, not that the stop is inaccessible", () => {
    render(<AccessibilityCard accessibility={accessibility([])} />);
    expect(screen.getByText(/it means nobody has recorded it/)).toBeTruthy();
  });

  it("names the facts no source mentioned at all", async () => {
    render(<AccessibilityCard accessibility={accessibility([fact()])} />);
    await userEvent.click(screen.getByRole("button", { name: /has not been recorded/ }));
    expect(screen.getByText(/No source has said anything about/)).toBeTruthy();
  });

  it("keeps the bus separate from the stop", () => {
    render(<AccessibilityCard accessibility={accessibility([fact()])} />);
    expect(screen.getByRole("heading", { name: /The buses that call here/ })).toBeTruthy();
    expect(screen.getByText(/a fact about the vehicle, not about this stop/)).toBeTruthy();
  });

  it("offers no overall score", () => {
    render(
      <AccessibilityCard
        accessibility={accessibility([
          fact(),
          fact({ key: "seating", status: "yes" }),
          fact({ key: "lighting", status: "no" }),
        ])}
      />,
    );
    // Nothing that reads as a rating: no percentage, no "out of", no star.
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByText(/out of/i)).toBeNull();
  });

  it("marks a fact matched by position rather than identity", () => {
    render(
      <AccessibilityCard
        accessibility={accessibility([
          fact({ source: "osm", confidence: "medium", provenance: "From OpenStreetMap" }),
        ])}
      />,
    );
    expect(screen.getByText(/matched by position, not by identity/)).toBeTruthy();
  });

  it("says which sources this deployment has not consulted", () => {
    render(<AccessibilityCard accessibility={accessibility([fact()])} />);
    expect(screen.getByText(/Not yet consulted on this deployment/)).toBeTruthy();
  });
});

function notice(overrides: Partial<DisruptionNotice> = {}): DisruptionNotice {
  return {
    id: "bods-sx:X1",
    source: "bods_situations",
    sourceRef: "X1",
    publisher: "FirstLeeds",
    officialStatus: "official",
    lifecycle: "open",
    severity: "severe",
    summary: "Wellington Street closed",
    reason: null,
    startsAt: "2026-09-04T06:00:00.000Z",
    endsAt: null,
    updatedAt: "2026-09-04T07:00:00.000Z",
    affectedRoutes: [],
    affectedStops: [],
    affectedAreas: [],
    infoLinks: [],
    attribution: "Bus Open Data Service",
    provenance: { source: "bods", retrievedAt: "2026-09-04T09:00:00.000Z", externalIds: [] },
    ...overrides,
  } as DisruptionNotice;
}

describe("OfficialNotices", () => {
  const now = new Date("2026-09-04T09:00:00.000Z");

  it("shows an operator's notice as theirs, not as ours", () => {
    render(
      <MemoryRouter>
        <OfficialNotices notices={[notice()]} sourcesQueried={[]} collectedAt={null} now={now} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Wellington Street closed")).toBeTruthy();
    expect(screen.getByText(/Bus Stops repeats these; it does not write them/)).toBeTruthy();
  });

  it("says a cause was not given rather than leaving the field blank", () => {
    render(
      <MemoryRouter>
        <OfficialNotices notices={[notice()]} sourcesQueried={[]} collectedAt={null} now={now} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Not given by the publisher")).toBeTruthy();
  });

  it("says an open-ended notice has no end time", () => {
    render(
      <MemoryRouter>
        <OfficialNotices notices={[notice()]} sourcesQueried={[]} collectedAt={null} now={now} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/no end time given/)).toBeTruthy();
  });

  it("distinguishes 'nothing to report' from 'nobody answered'", () => {
    const { rerender } = render(
      <MemoryRouter>
        <OfficialNotices
          notices={[]}
          sourcesQueried={[
            {
              source: "bods_situations",
              outcome: "empty",
              records: 0,
              queriedAt: "2026-09-04T08:55:00.000Z",
            },
          ]}
          collectedAt="2026-09-04T08:55:00.000Z"
          now={now}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(/No current official disruption notices were returned at/),
    ).toBeTruthy();

    rerender(
      <MemoryRouter>
        <OfficialNotices
          notices={[]}
          sourcesQueried={[
            {
              source: "bods_situations",
              outcome: "failed",
              records: 0,
              queriedAt: "2026-09-04T08:55:00.000Z",
              error: "http_503",
            },
          ]}
          collectedAt="2026-09-04T08:55:00.000Z"
          now={now}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No disruption source could be reached/)).toBeTruthy();
  });

  it("says when no source has been queried at all", () => {
    render(
      <MemoryRouter>
        <OfficialNotices notices={[]} sourcesQueried={[]} collectedAt={null} now={now} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/has been queried yet on this deployment/)).toBeTruthy();
  });

  it("lists what each publisher said", async () => {
    render(
      <MemoryRouter>
        <OfficialNotices
          notices={[notice()]}
          sourcesQueried={[
            {
              source: "bods_situations",
              outcome: "ok",
              records: 3,
              queriedAt: "2026-09-04T08:55:00.000Z",
            },
            {
              source: "tfl_status",
              outcome: "failed",
              records: 0,
              queriedAt: "2026-09-04T08:55:00.000Z",
              error: "timeout",
            },
          ]}
          collectedAt="2026-09-04T08:55:00.000Z"
          now={now}
        />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByText("Which sources were asked"));
    expect(screen.getByText("3 notices")).toBeTruthy();
    expect(screen.getByText(/could not be reached \(timeout\)/)).toBeTruthy();
  });

  it("links an affected stop to its page", () => {
    render(
      <MemoryRouter>
        <OfficialNotices
          notices={[
            notice({ affectedStops: [{ atcoCode: "450010001", name: "Wellington Street" }] }),
          ]}
          sourcesQueried={[]}
          collectedAt={null}
          now={now}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Wellington Street" });
    expect(link.getAttribute("href")).toBe("/stops/450010001");
  });
});
