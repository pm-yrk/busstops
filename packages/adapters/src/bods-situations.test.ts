import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DisruptionNoticeSchema } from "@busstops/contracts";
import { normalizeSiriSx, parseSiriSx } from "./bods-situations.js";

const fixture = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../tests/fixtures/documented/bods-siri-sx.xml",
  ),
  "utf8",
);

const NOW = new Date("2026-09-04T09:00:00.000Z");
const options = { retrievedAt: NOW.toISOString(), now: NOW };

describe("BODS SIRI-SX situations", () => {
  it("finds every situation the document offers", () => {
    const parsed = parseSiriSx(fixture);
    expect(parsed.situations).toHaveLength(5);
    expect(parsed.problem).toBeNull();
    expect(parsed.responseTimestamp).toBe("2026-09-04T09:00:00+01:00");
  });

  it("publishes only the notices a passenger could act on", () => {
    const { notices, rejected } = normalizeSiriSx(fixture, options);

    expect(notices.map((notice) => notice.sourceRef)).toEqual(["FL-2026-0912", "SM-2026-4471"]);
    expect(rejected.map((entry) => entry.reason)).toEqual([
      "validity period already ended",
      "closed by the publisher",
      "no Summary",
    ]);
  });

  it("reads the notice as the operator wrote it", () => {
    const notice = normalizeSiriSx(fixture, options).notices.find(
      (candidate) => candidate.sourceRef === "FL-2026-0912",
    )!;

    expect(DisruptionNoticeSchema.safeParse(notice).success).toBe(true);
    expect(notice.summary).toBe("Wellington Street closed — services 16 and 508 diverted");
    expect(notice.description).toContain("Whitehall Road");
    expect(notice.advice).toBe(
      "Please use the Whitehall Road stops while the closure is in place.",
    );
    expect(notice.publisher).toBe("FirstLeeds");
    expect(notice.officialStatus).toBe("official");
    expect(notice.lifecycle).toBe("open");
    expect(notice.startsAt).toBe("2026-09-03T19:00:00.000Z");
    expect(notice.endsAt).toBe("2026-09-11T04:00:00.000Z");
    expect(notice.updatedAt).toBe("2026-09-04T06:41:00.000Z");
    expect(notice.infoLinks).toEqual([
      {
        url: "https://www.example-operator.co.uk/service-updates/wellington-street",
        label: "Operator service update",
      },
    ]);
    expect(notice.attribution).toContain("Open Government Licence");
  });

  it("takes severity from the worst consequence, not the first", () => {
    const notice = normalizeSiriSx(fixture, options).notices.find(
      (candidate) => candidate.sourceRef === "FL-2026-0912",
    )!;
    // The document lists "slight" first and "severe" second.
    expect(notice.severity).toBe("severe");
  });

  it("carries the reason only when the publisher stated one", () => {
    const { notices } = normalizeSiriSx(fixture, options);
    const roadworks = notices.find((notice) => notice.sourceRef === "FL-2026-0912")!;
    const delays = notices.find((notice) => notice.sourceRef === "SM-2026-4471")!;

    expect(roadworks.reason).toEqual({ category: "MiscellaneousReason", value: "roadworks" });
    // SIRI's "unknown" is the absence of a reason, and must not become one.
    expect(delays.reason).toBeNull();
  });

  it("collects the affected lines, stops and places", () => {
    const notice = normalizeSiriSx(fixture, options).notices.find(
      (candidate) => candidate.sourceRef === "FL-2026-0912",
    )!;

    expect(notice.affectedRoutes.map((route) => route.publishedLineName ?? route.lineRef)).toEqual([
      "16",
      "508",
    ]);
    expect(notice.affectedRoutes[0]).toMatchObject({
      lineRef: "16",
      operatorRef: "FLDS",
      operatorName: "First Leeds",
      // Resolution against the published network happens later, and says so until it has.
      serviceRouteId: null,
    });
    expect(notice.affectedStops.map((stop) => stop.atcoCode)).toEqual([
      "45009980001",
      "45009980002",
    ]);
    expect(notice.affectedAreas).toEqual(["Leeds city centre"]);
  });

  it("puts the most recently changed notice first", () => {
    const { notices } = normalizeSiriSx(fixture, options);
    // FL was versioned at 06:41 UTC, SM created at 05:15 UTC.
    expect(notices[0]!.sourceRef).toBe("FL-2026-0912");
  });

  it("keeps an open-ended notice open-ended", () => {
    const notice = normalizeSiriSx(fixture, options).notices.find(
      (candidate) => candidate.sourceRef === "SM-2026-4471",
    )!;
    expect(notice.endsAt).toBeNull();
  });

  it("says why nothing came back, rather than returning a quiet empty list", () => {
    // fast-xml-parser is lenient: prose parses to an empty tree rather than throwing, so the
    // honest complaint about it is the same one as for a well-formed document of the wrong shape.
    expect(normalizeSiriSx("not xml at all", options).rejected).toEqual([
      { reason: "no ServiceDelivery" },
    ]);
    expect(normalizeSiriSx("<Siri><Other/></Siri>", options).rejected).toEqual([
      { reason: "no ServiceDelivery" },
    ]);
    expect(normalizeSiriSx("not xml at all", options).notices).toEqual([]);
  });

  it("reports what the feed offered, so an empty result is attributable", () => {
    const result = normalizeSiriSx(fixture, options);
    expect(result.offered).toBe(5);
    expect(result.notices.length + result.rejected.length).toBe(5);
  });

  it("honours a limit without changing the order", () => {
    const { notices } = normalizeSiriSx(fixture, { ...options, limit: 1 });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.sourceRef).toBe("FL-2026-0912");
  });
});
