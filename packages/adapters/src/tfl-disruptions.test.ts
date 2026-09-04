import { describe, expect, it } from "vitest";
import { DisruptionNoticeSchema } from "@busstops/contracts";
import { normalizeTflLineStatuses, normalizeTflRoadDisruptions } from "./tfl-disruptions.js";

const options = { retrievedAt: "2026-09-04T09:00:00.000Z" };

/**
 * Shaped from the TfL Unified API's published responses for `/Line/Mode/bus/Status?detail=true`
 * and `/Road/all/Disruption`. The cases here are the ones that decide whether the list is worth
 * reading: a good service (which is not a notice), a severe one, a stated reason and an absent
 * one, and a status whose severity code TfL has not documented for buses.
 */
const lineStatuses = [
  {
    id: "88",
    name: "88",
    modeName: "bus",
    lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: "Good Service" }],
  },
  {
    id: "38",
    name: "38",
    modeName: "bus",
    lineStatuses: [
      {
        id: 3811,
        statusSeverity: 6,
        statusSeverityDescription: "Severe Delays",
        reason:
          "Route 38: Severe delays between Victoria and Clapton Pond due to a burst water main at Angel.",
        created: "2026-09-04T07:12:00Z",
        validityPeriods: [{ fromDate: "2026-09-04T07:00:00Z", isNow: true }],
        disruption: {
          category: "RealTime",
          categoryDescription: "Burst water main",
          description: "Buses are being diverted via Pentonville Road.",
          additionalInfo: "Use routes 30 or 73 between Angel and Islington.",
        },
      },
    ],
  },
  {
    id: "N15",
    name: "N15",
    modeName: "bus",
    lineStatuses: [
      {
        statusSeverity: 9,
        statusSeverityDescription: "Minor Delays",
        // No reason, no disruption block: the notice must carry no cause at all.
        validityPeriods: [{ fromDate: "2026-09-04T05:00:00Z", isNow: true }],
      },
    ],
  },
  {
    id: "X99",
    name: "X99",
    modeName: "bus",
    // 42 is not in TfL's bus severity table; counted as rejected rather than shown as something.
    lineStatuses: [{ statusSeverity: 42, statusSeverityDescription: "Who knows" }],
  },
];

describe("TfL bus line statuses as disruption notices", () => {
  it("drops a good service rather than listing it as a disruption", () => {
    const { notices } = normalizeTflLineStatuses(lineStatuses, options);
    expect(notices.some((notice) => notice.summary.startsWith("88:"))).toBe(false);
  });

  it("counts an undocumented severity as rejected rather than guessing at it", () => {
    const result = normalizeTflLineStatuses(lineStatuses, options);
    expect(result.rejected).toBe(1);
    expect(result.notices.some((notice) => notice.summary.startsWith("X99:"))).toBe(false);
  });

  it("reads a severe delay as TfL published it", () => {
    const notice = normalizeTflLineStatuses(lineStatuses, options).notices.find((candidate) =>
      candidate.summary.startsWith("38:"),
    )!;

    expect(DisruptionNoticeSchema.safeParse(notice).success).toBe(true);
    expect(notice.severity).toBe("severe");
    expect(notice.summary).toBe("38: Severe Delays");
    expect(notice.description).toBe("Buses are being diverted via Pentonville Road.");
    expect(notice.advice).toBe("Use routes 30 or 73 between Angel and Islington.");
    expect(notice.reason).toEqual({
      category: "tflDisruptionCategory",
      value: "Burst water main",
    });
    expect(notice.startsAt).toBe("2026-09-04T07:00:00.000Z");
    expect(notice.affectedRoutes[0]).toMatchObject({ lineRef: "38", operatorRef: "TFL" });
    expect(notice.infoLinks[0]!.url).toBe("https://tfl.gov.uk/bus/route/38/");
    expect(notice.attribution).toContain("TfL Open Data");
  });

  it("leaves the cause null when TfL gave none", () => {
    const notice = normalizeTflLineStatuses(lineStatuses, options).notices.find((candidate) =>
      candidate.summary.startsWith("N15:"),
    )!;
    expect(notice.reason).toBeNull();
    expect(notice.description).toBeUndefined();
  });

  it("puts the worst first", () => {
    const { notices } = normalizeTflLineStatuses(lineStatuses, options);
    expect(notices[0]!.summary).toBe("38: Severe Delays");
  });

  it("answers an unrecognisable payload with nothing, not a crash", () => {
    expect(normalizeTflLineStatuses({ nope: true }, options).notices).toEqual([]);
    expect(normalizeTflLineStatuses(null, options).offered).toBe(0);
  });
});

describe("TfL road disruptions as notices", () => {
  const roads = [
    {
      id: "TIMS-1234",
      category: "PlannedWorks",
      subCategory: "Utility Works",
      severity: "Serious",
      location: "A501 Euston Road eastbound at Tottenham Court Road",
      comments: "Lane one of two closed for utility works.",
      currentUpdate: "Expect delays of up to 15 minutes.",
      startDateTime: "2026-09-01T22:00:00Z",
      endDateTime: "2026-09-20T05:00:00Z",
      lastModifiedTime: "2026-09-04T06:00:00Z",
      status: "Active",
      url: "https://tfl.gov.uk/traffic/status/",
    },
    // Nothing to name it by: rejected rather than shown as a blank line in the list.
    { id: "TIMS-EMPTY", severity: "Minimal" },
  ];

  it("reads a road closure as published", () => {
    const result = normalizeTflRoadDisruptions(roads, options);
    expect(result.rejected).toBe(1);
    expect(result.notices).toHaveLength(1);

    const notice = result.notices[0]!;
    expect(DisruptionNoticeSchema.safeParse(notice).success).toBe(true);
    expect(notice.source).toBe("tfl_disruption");
    expect(notice.severity).toBe("moderate");
    expect(notice.summary).toBe("A501 Euston Road eastbound at Tottenham Court Road");
    expect(notice.advice).toBe("Expect delays of up to 15 minutes.");
    expect(notice.reason).toEqual({ category: "tflRoadCategory", value: "Utility Works" });
    expect(notice.endsAt).toBe("2026-09-20T05:00:00.000Z");
    expect(notice.infoLinks[0]!.url).toBe("https://tfl.gov.uk/traffic/status/");
  });

  it("keeps severity unknown when TfL used a word it does not publish a meaning for", () => {
    const { notices } = normalizeTflRoadDisruptions(
      [{ id: "x", location: "Somewhere", severity: "Peculiar" }],
      options,
    );
    expect(notices[0]!.severity).toBe("unknown");
  });
});
