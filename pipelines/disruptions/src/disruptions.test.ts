import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectDisruptions } from "./collect.js";

const siriSx = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../tests/fixtures/documented/bods-siri-sx.xml",
  ),
  "utf8",
);

const RETRIEVED_AT = "2026-09-04T09:00:00.000Z";
const NOW = new Date(RETRIEVED_AT);

const lineStatuses = [
  {
    id: "38",
    name: "38",
    lineStatuses: [
      {
        statusSeverity: 6,
        statusSeverityDescription: "Severe Delays",
        created: "2026-09-04T07:12:00Z",
        validityPeriods: [{ fromDate: "2026-09-04T07:00:00Z", isNow: true }],
      },
    ],
  },
  { id: "88", name: "88", lineStatuses: [{ statusSeverity: 10 }] },
];

/** A fetch that answers by URL, so each source can be made to succeed or fail independently. */
function fetchStub(answers: {
  siri?: () => Response;
  status?: () => Response;
  road?: () => Response;
}): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("siri-sx")) {
      return answers.siri?.() ?? new Response("", { status: 500 });
    }
    if (url.includes("/Line/Mode/bus/Status")) {
      return answers.status?.() ?? new Response("[]", { status: 200 });
    }
    if (url.includes("/Road/all/Disruption")) {
      return answers.road?.() ?? new Response("[]", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const base = {
  bodsApiKey: "test-key",
  tflAppKey: "test-app-key",
  retrievedAt: RETRIEVED_AT,
  now: NOW,
};

describe("collecting official disruption notices", () => {
  it("gathers every publisher into one list, and says who answered", async () => {
    const result = await collectDisruptions({
      ...base,
      fetchImpl: fetchStub({
        siri: () => new Response(siriSx, { status: 200 }),
        status: () => new Response(JSON.stringify(lineStatuses), { status: 200 }),
        road: () => new Response("[]", { status: 200 }),
      }),
    });

    expect(result.notices.map((notice) => notice.source)).toEqual(
      expect.arrayContaining(["bods_situations", "tfl_status"]),
    );
    expect(result.sources.map((source) => [source.source, source.outcome])).toEqual([
      ["bods_situations", "ok"],
      ["tfl_status", "ok"],
      // A real answer of "nothing on the roads right now" is "empty", not a failure.
      ["tfl_disruption", "empty"],
    ]);
  });

  it("puts the most severe notice first, so a cap never drops a suspension", async () => {
    const result = await collectDisruptions({
      ...base,
      fetchImpl: fetchStub({
        siri: () => new Response(siriSx, { status: 200 }),
        status: () => new Response(JSON.stringify(lineStatuses), { status: 200 }),
      }),
    });
    expect(result.notices[0]!.severity).toBe("severe");
  });

  it("reports the cap rather than hiding it", async () => {
    const result = await collectDisruptions({
      ...base,
      maxNotices: 1,
      fetchImpl: fetchStub({
        siri: () => new Response(siriSx, { status: 200 }),
        status: () => new Response(JSON.stringify(lineStatuses), { status: 200 }),
      }),
    });
    expect(result.notices).toHaveLength(1);
    expect(result.dropped).toBeGreaterThan(0);
  });

  it("tells a failed source from an empty one", async () => {
    const result = await collectDisruptions({
      ...base,
      fetchImpl: fetchStub({
        siri: () => new Response("upstream exploded", { status: 503 }),
        status: () => new Response(JSON.stringify(lineStatuses), { status: 200 }),
        road: () => new Response("[]", { status: 200 }),
      }),
    });

    const bods = result.sources.find((source) => source.source === "bods_situations")!;
    expect(bods.outcome).toBe("failed");
    expect(bods.error).toBe("http_503");
    // London still answered: one failing publisher must never blank the board.
    expect(result.notices.some((notice) => notice.source === "tfl_status")).toBe(true);
  });

  it("never puts a URL or a key in the failure it reports", async () => {
    const result = await collectDisruptions({
      ...base,
      fetchImpl: fetchStub({ siri: () => new Response("no", { status: 401 }) }),
    });
    const errors = result.sources.map((source) => source.error ?? "").join(" ");
    expect(errors).not.toContain("api_key");
    expect(errors).not.toContain("test-key");
    // No URL: the class names the status, not the endpoint it came from.
    expect(errors).not.toContain("://");
    expect(errors).not.toContain("bus-data");
    expect(errors).toContain("http_401");
  });

  it("says a source is unconfigured rather than pretending it was quiet", async () => {
    const result = await collectDisruptions({
      ...base,
      bodsApiKey: undefined,
      tflAppKey: undefined,
      fetchImpl: fetchStub({}),
    });
    expect(result.sources.every((source) => source.outcome === "not_configured")).toBe(true);
    expect(result.notices).toEqual([]);
  });
});
