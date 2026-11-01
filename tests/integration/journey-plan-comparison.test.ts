import { describe, expect, it } from "vitest";
import {
  comparableCorpora,
  comparePlans,
  type Corpus,
  type Option,
} from "../../scripts/lib/compare-plans.js";

/**
 * The gate on a replacement planner, tested on cases built by hand.
 *
 * Part B replaces the journey search, and the one failure that a CPU figure cannot show is a
 * planner that fits the budget by answering worse journeys. This comparison is what catches that,
 * so it needs to be right about each way it can happen — and each way is a case below rather than
 * a reading of one real corpus, because a real corpus happens to contain whichever of them it
 * contains.
 */

function option(over: Partial<Option> = {}): Option {
  return {
    arrivalSeconds: 36_000,
    changeCount: 0,
    rides: [
      {
        routeId: "svc-1",
        fromStopId: "stop-a",
        toStopId: "stop-b",
        departureSeconds: 34_200,
        arrivalSeconds: 36_000,
      },
    ],
    ...over,
  };
}

function corpus(entries: Corpus["entries"]): Corpus {
  return { version: "v1", serviceDate: "2026-10-27", entries };
}

describe("holding a candidate planner against the deployed one", () => {
  it("agrees completely with itself", () => {
    const only = corpus([{ query: "q", options: [option()] }]);
    const comparison = comparePlans(only, only);
    expect(comparison.sameBestItinerary).toBe("100.0%");
    expect(comparison.sameFastestArrival).toBe("100.0%");
    expect(comparison.sameFewestChanges).toBe("100.0%");
    expect(comparison.journeyLost).toBe("0.0%");
    expect(comparison.materiallyWorse).toBe("0.0%");
    expect(comparison.failed).toBe(false);
  });

  it("fails on a lost journey, which is the worst outcome there is", () => {
    const comparison = comparePlans(
      corpus([{ query: "q", options: [option()] }]),
      corpus([{ query: "q", options: [] }]),
    );
    expect(comparison.journeyLost).toBe("100.0%");
    expect(comparison.failed).toBe(true);
    expect(comparison.disagreements).toEqual([{ query: "q", verdict: "journey lost" }]);
  });

  it("fails on a query the candidate does not answer at all", () => {
    const comparison = comparePlans(corpus([{ query: "q", options: [option()] }]), corpus([]));
    expect(comparison.journeyLost).toBe("100.0%");
    expect(comparison.failed).toBe(true);
  });

  it("fails on an answer that arrives materially later", () => {
    const comparison = comparePlans(
      corpus([{ query: "q", options: [option()] }]),
      corpus([{ query: "q", options: [option({ arrivalSeconds: 36_000 + 301 })] }]),
    );
    expect(comparison.materiallyWorse).toBe("100.0%");
    expect(comparison.failed).toBe(true);
    expect(comparison.disagreements[0]).toMatchObject({ laterSeconds: 301 });
  });

  it("forgives an answer that arrives inside the noise band", () => {
    const comparison = comparePlans(
      corpus([{ query: "q", options: [option()] }]),
      corpus([{ query: "q", options: [option({ arrivalSeconds: 36_000 + 300 })] }]),
    );
    expect(comparison.materiallyWorse).toBe("0.0%");
    expect(comparison.failed).toBe(false);
    /* Still not the same itinerary, and still not the same fastest arrival. */
    expect(comparison.sameBestItinerary).toBe("0.0%");
    expect(comparison.sameFastestArrival).toBe("0.0%");
  });

  it("fails on speed bought with an extra change, even arriving earlier", () => {
    const comparison = comparePlans(
      corpus([{ query: "q", options: [option()] }]),
      corpus([{ query: "q", options: [option({ arrivalSeconds: 35_000, changeCount: 1 })] }]),
    );
    expect(comparison.materiallyWorse).toBe("100.0%");
    expect(comparison.sameFewestChanges).toBe("0.0%");
    expect(comparison.failed).toBe(true);
  });

  it("separates the same arrival from the same ride", () => {
    const other = option({
      rides: [
        {
          routeId: "svc-2",
          fromStopId: "stop-c",
          toStopId: "stop-d",
          departureSeconds: 34_500,
          arrivalSeconds: 36_000,
        },
      ],
    });
    const comparison = comparePlans(
      corpus([{ query: "q", options: [option()] }]),
      corpus([{ query: "q", options: [other] }]),
    );
    expect(comparison.sameBestItinerary).toBe("0.0%");
    expect(comparison.sameFastestArrival).toBe("100.0%");
    expect(comparison.failed).toBe(false);
  });

  it("counts a journey found where there was none, and does not call it agreement", () => {
    const comparison = comparePlans(
      corpus([{ query: "q", options: [] }]),
      corpus([{ query: "q", options: [option()] }]),
    );
    expect(comparison.journeysGained).toBe(1);
    expect(comparison.comparable).toBe(0);
    expect(comparison.sameBestItinerary).toBe("n/a");
    expect(comparison.failed).toBe(false);
  });

  it("does not count an unanswerable query in the denominator", () => {
    const comparison = comparePlans(
      corpus([
        { query: "answerable", options: [option()] },
        { query: "not", options: [] },
      ]),
      corpus([
        { query: "answerable", options: [option()] },
        { query: "not", options: [] },
      ]),
    );
    expect(comparison.queries).toBe(2);
    expect(comparison.comparable).toBe(1);
    expect(comparison.sameBestItinerary).toBe("100.0%");
  });

  it("compares the fastest and the fewest changes across every option, not only the first", () => {
    const comparison = comparePlans(
      corpus([{ query: "q", options: [option(), option({ arrivalSeconds: 35_000 })] }]),
      corpus([{ query: "q", options: [option(), option({ arrivalSeconds: 35_500 })] }]),
    );
    /* The shown option is identical; the second-best is not, so the fastest arrival differs. */
    expect(comparison.sameBestItinerary).toBe("100.0%");
    expect(comparison.sameFastestArrival).toBe("0.0%");
  });
});

/**
 * Whether the two corpora are about the same question, which the percentages cannot say.
 *
 * The corpus job records five runs in sequence, each reading the clock for its own service date.
 * A job that started at 23:5x and finished after midnight recorded its baseline on 31 October and
 * its candidates on 1 November, and the comparison reported 30% same best itinerary and 30%
 * materially worse — a Saturday timetable held against a Sunday's. The only clue was that a second
 * candidate reported exactly the same figures, which is what a moved baseline looks like.
 *
 * Both dates were in the report already. Nothing read them.
 */
describe("whether two corpora can be compared at all", () => {
  const corpus = (over: Partial<Corpus> = {}): Corpus => ({
    version: "2026-10-22T12:49:08.474Z",
    serviceDate: "2026-10-31",
    entries: [],
    ...over,
  });

  it("accepts two corpora of the same day and the same published network", () => {
    expect(comparableCorpora(corpus(), corpus())).toEqual({ ok: true });
  });

  it("refuses a comparison across two service dates", () => {
    const refused = comparableCorpora(corpus(), corpus({ serviceDate: "2026-11-01" }));
    expect(refused.ok).toBe(false);
    expect(refused).toMatchObject({
      reason: "the two corpora were recorded for different service dates",
      baseline: "2026-10-31",
      candidate: "2026-11-01",
    });
  });

  it("refuses a comparison across two artifact versions", () => {
    const refused = comparableCorpora(corpus(), corpus({ version: "2026-09-30T16:56:04.815Z" }));
    expect(refused.ok).toBe(false);
    expect(refused).toMatchObject({
      reason: "the two corpora were recorded against different artifact versions",
    });
  });

  it("refuses when one of them does not say which day it is about", () => {
    /* An absent date cannot be shown to match, and a comparison that assumed it did is the bug. */
    expect(comparableCorpora(corpus(), corpus({ serviceDate: undefined })).ok).toBe(false);
  });
});
