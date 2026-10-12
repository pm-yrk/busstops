import { render, screen } from "@testing-library/react";
import type { ProMetric } from "@busstops/contracts";
import { describe, expect, it } from "vitest";
import { ProMetricTile } from "./ProPrimitives.js";

/**
 * A reader has to be able to tell three things apart on a Pro card: a count of what was seen, a
 * statistic computed over it, and an example that is neither. These hold that no two of them can
 * ever read the same, and that the example badge stays the loudest of them.
 */
function tile(overrides: Partial<ProMetric>): ProMetric {
  return {
    key: "active_vehicles",
    label: "Buses observed",
    definition: "Distinct vehicles that reported a usable position in the window.",
    value: 1284,
    unit: "count",
    denominator: 4100,
    window: "last 60 minutes",
    freshnessSeconds: 120,
    coverage: 0.9,
    confidence: null,
    suppressed: false,
    suppressionReason: null,
    baselineValue: null,
    evidence: ["segment_metrics"],
    illustrative: false,
    ...overrides,
  } as ProMetric;
}

describe("how a Pro figure says where it came from", () => {
  it("calls a direct count observed", () => {
    render(<ProMetricTile metric={tile({ basis: "observed" })} />);
    expect(screen.getByText("Observed")).toBeTruthy();
    expect(screen.queryByText("Calculated")).toBeNull();
    expect(screen.queryByText("Example figure")).toBeNull();
  });

  it("calls a derived statistic calculated", () => {
    render(<ProMetricTile metric={tile({ basis: "calculated" })} />);
    expect(screen.getByText("Calculated")).toBeTruthy();
    expect(screen.queryByText("Observed")).toBeNull();
  });

  /*
   * The cautious default. An older deployment's response carries no `basis`, and reading a missing
   * field as "observed" would promote every figure to the stronger claim.
   */
  it("reads a missing basis as calculated rather than observed", () => {
    const metric = tile({});
    delete (metric as { basis?: unknown }).basis;
    render(<ProMetricTile metric={metric} />);
    expect(screen.getByText("Calculated")).toBeTruthy();
    expect(screen.queryByText("Observed")).toBeNull();
  });

  /*
   * The one that matters most: an example must never also be labelled as a measurement of any
   * kind, whatever `basis` happens to say.
   */
  it("shows only the example badge on an illustrative figure", () => {
    render(<ProMetricTile metric={tile({ illustrative: true, basis: "observed" })} />);
    expect(screen.getByText("Example figure")).toBeTruthy();
    expect(screen.queryByText("Observed")).toBeNull();
    expect(screen.queryByText("Calculated")).toBeNull();
  });
});
