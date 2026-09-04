import type { Page } from "@playwright/test";

/**
 * Deterministic API responses for the end-to-end suite.
 *
 * These live here rather than in the app: nothing in the shipped bundle knows about them, so a
 * fixture can never leak into a production data path. They exist to pin the interface states the
 * tests are about — stale, degraded, suppressed, empty — which cannot be produced on demand from
 * a live feed.
 */

export const META = {
  generatedAt: "2026-09-03T09:00:00.000Z",
  observedAt: "2026-09-03T08:59:30.000Z",
  sources: [
    {
      source: "bods",
      coverageArea: "non_london",
      status: "healthy",
      lastSuccessfulFetchAt: "2026-09-03T08:59:30.000Z",
      lastAttemptAt: "2026-09-03T08:59:30.000Z",
      ageSeconds: 30,
      consecutiveFailures: 0,
    },
  ],
  coverage: 1,
  degradation: "normal",
  governorState: "green",
  attribution: ["Contains public sector information licensed under the Open Government Licence"],
};

export const STOP_ID = "00000000-0000-5000-8000-0000000000c1";

export const STOP_RESPONSE = {
  meta: META,
  data: {
    stop: {
      id: STOP_ID,
      provenance: { source: "naptan", retrievedAt: META.generatedAt, externalIds: [] },
      ingestedAt: META.generatedAt,
      qualityFlags: ["ok"],
      atcoCode: "450010001",
      naptanCode: "leedsjw",
      name: "Leeds City Bus Station",
      indicator: "Stand 12",
      locationCoordinate: { lat: 53.7965, lon: -1.5379 },
      bearing: 90,
      stopType: "on_street_bus",
      localityId: null,
      amenities: [{ key: "shelter", value: true, provenance: "naptan" }],
      active: true,
      naptanStatus: "active",
      supersededByStopId: null,
    },
    departures: [
      {
        id: "00000000-0000-5000-8000-0000000000d1",
        provenance: { source: "bods", retrievedAt: META.generatedAt, externalIds: [] },
        ingestedAt: META.generatedAt,
        qualityFlags: ["ok"],
        stopId: STOP_ID,
        scheduledJourneyId: null,
        routePatternId: null,
        serviceRoutePublicName: "72",
        destinationName: "Bradford Interchange",
        scheduledTime: "2026-09-03T09:03:00.000Z",
        expectedTime: "2026-09-03T09:05:00.000Z",
        liveState: "live",
        uncertaintySeconds: 60,
        confidence: { level: "high", score: 0.85, reasons: ["fresh live position"] },
      },
      {
        id: "00000000-0000-5000-8000-0000000000d2",
        provenance: { source: "bods", retrievedAt: META.generatedAt, externalIds: [] },
        ingestedAt: META.generatedAt,
        qualityFlags: ["ok"],
        stopId: STOP_ID,
        scheduledJourneyId: null,
        routePatternId: null,
        serviceRoutePublicName: "16",
        destinationName: "Beeston",
        scheduledTime: "2026-09-03T09:12:00.000Z",
        expectedTime: "2026-09-03T09:12:00.000Z",
        liveState: "scheduled_only",
        uncertaintySeconds: 300,
        confidence: { level: "low", score: 0.3, reasons: ["timetable only"] },
      },
    ],
    routes: [
      {
        id: "00000000-0000-5000-8000-0000000000e1",
        publicName: "72",
        operatorName: "First West Yorkshire",
      },
    ],
  },
};

export const PRO_CONTROL_TOWER = {
  meta: META,
  data: {
    provenance: {
      dataMode: "demo_snapshot",
      snapshotDate: "2026-08-14",
      notice:
        "Demonstration snapshot from 2026-08-14. These figures are a fixed historical example, not live data.",
    },
    scope: {
      areaId: null,
      operatorId: null,
      routeId: null,
      windowMinutes: 60,
      boundingBox: null,
    },
    generatedAt: META.generatedAt,
    headline: [
      {
        key: "network_health",
        label: "Network health",
        definition:
          "A weighted composite of punctuality, reliability, excess delay, headway adherence, incidents and coverage, scored out of 100.",
        value: 71,
        unit: "points",
        denominator: 1103,
        window: "last 60 minutes",
        freshnessSeconds: null,
        coverage: 0.86,
        confidence: { level: "medium", score: 0.66, reasons: ["capped by 86% source coverage"] },
        suppressed: false,
        suppressionReason: null,
        baselineValue: 76,
        evidence: ["punctuality", "coverage"],
      },
      {
        key: "punctuality",
        label: "Punctuality",
        definition:
          "The share of observed departures leaving between 1 minute early and 5 minutes late against the timetable.",
        value: null,
        unit: "percent",
        denominator: 4,
        window: "last 60 minutes",
        freshnessSeconds: null,
        coverage: 0.86,
        confidence: null,
        suppressed: true,
        suppressionReason: "Based on 4 observations; 20 are needed before a figure is published.",
        baselineValue: null,
        evidence: [],
      },
      /*
       * Enough tiles to fill the three-column grid at tablet width. Two was not enough: the grid
       * is `auto-fit`, so with empty tracks collapsed each tile got a third more room than it
       * really has and the layout test passed on a page the deployed Pro could not reproduce.
       * A fixture that is easier to lay out than the real response is a test that does not run.
       */
      {
        key: "active_vehicles",
        label: "Buses observed",
        definition: "Distinct vehicles that reported a usable position in the window.",
        value: 1642,
        unit: "count",
        denominator: 1642,
        window: "last 60 minutes",
        freshnessSeconds: null,
        coverage: 0.86,
        confidence: null,
        suppressed: false,
        suppressionReason: null,
        baselineValue: null,
        evidence: [],
      },
      {
        key: "reliability",
        label: "Reliability",
        definition: "The share of scheduled departures that were observed running at all.",
        value: 0.93,
        unit: "percent",
        denominator: 1189,
        window: "last 60 minutes",
        freshnessSeconds: null,
        coverage: 0.86,
        confidence: null,
        suppressed: false,
        suppressionReason: null,
        baselineValue: 0.95,
        evidence: [],
      },
      {
        key: "median_delay",
        label: "Median delay",
        definition: "The middle value of actual minus scheduled time across observed departures.",
        value: 168,
        unit: "seconds",
        denominator: 1103,
        window: "last 60 minutes",
        freshnessSeconds: null,
        coverage: 0.86,
        confidence: null,
        suppressed: false,
        suppressionReason: null,
        baselineValue: 132,
        evidence: [],
      },
      {
        key: "abnormal_disruptions",
        label: "Abnormal disruptions",
        definition: "Situations outside the normal range for this time and place.",
        value: 3,
        unit: "count",
        denominator: 5,
        window: "last 60 minutes",
        freshnessSeconds: null,
        coverage: 0.86,
        confidence: null,
        suppressed: false,
        suppressionReason: null,
        baselineValue: null,
        evidence: [],
      },
    ],
    sourceHealth: {
      healthy: 2,
      degraded: 0,
      stale: 1,
      down: 0,
      problems: [
        {
          source: "national_highways",
          status: "stale",
          detail: "Last successful fetch 41 minutes ago",
        },
      ],
    },
    priorityExceptions: [],
    biggestDelayBurden: [],
    mostAbnormal: [],
    routesRequiringAttention: [],
    outlook: "Nothing unusual is showing across the network right now.",
    intelligenceSummary: ["Live source coverage is 62%."],
    coverageWarning:
      "Only 62% of live sources are reporting normally. Read every figure below with that in mind.",
  },
};

export const EMPTY_MAP = {
  meta: { ...META, degradation: "scheduled_only", coverage: 0 },
  data: {
    stops: [],
    vehicles: [],
    incidents: [],
    disruptions: [],
    truncated: { stops: false, vehicles: false, incidents: false },
  },
};

const PRO_SCOPE = {
  areaId: null,
  operatorId: null,
  routeId: null,
  windowMinutes: 60,
  boundingBox: null,
};

const DEMO_PROVENANCE = PRO_CONTROL_TOWER.data.provenance;

export const PRO_CONGESTION = {
  meta: META,
  data: {
    provenance: DEMO_PROVENANCE,
    scope: PRO_SCOPE,
    generatedAt: META.generatedAt,
    biggestDelays: [],
    mostAbnormal: [],
    causationNotice:
      "Roadworks and incidents shown alongside a hotspot were active nearby at the same time. That is corroboration, not a demonstrated cause of the delay.",
  },
};

export const PRO_EMPTY_SECTION = {
  meta: META,
  data: {
    provenance: DEMO_PROVENANCE,
    scope: PRO_SCOPE,
    generatedAt: META.generatedAt,
  },
};

/** Routes every API call to a fixture, so no test depends on an upstream being reachable. */
export async function mockApi(page: Page, overrides: Record<string, unknown> = {}): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");

    const body =
      (overrides[path] as unknown) ??
      (path.startsWith("/v1/stops/")
        ? STOP_RESPONSE
        : path === "/v1/pro/control-tower"
          ? PRO_CONTROL_TOWER
          : path === "/v1/pro/congestion"
            ? PRO_CONGESTION
            : path === "/v1/pro/live-operations"
              ? {
                  meta: META,
                  data: {
                    ...PRO_EMPTY_SECTION.data,
                    items: [],
                    feedProblems: [],
                    availableFilters: { operators: [], eventTypes: [], severities: [] },
                  },
                }
              : path === "/v1/pro/routes"
                ? {
                    meta: META,
                    data: { ...PRO_EMPTY_SECTION.data, rows: [], comparabilityWarning: null },
                  }
                : path === "/v1/pro/operators"
                  ? {
                      meta: META,
                      data: {
                        ...PRO_EMPTY_SECTION.data,
                        scorecards: [],
                        comparabilityWarning: null,
                      },
                    }
                  : path === "/v1/pro/analytics"
                    ? {
                        meta: META,
                        data: {
                          ...PRO_EMPTY_SECTION.data,
                          sections: [],
                          exportNotice: "Exports contain derived aggregates only.",
                        },
                      }
                    : path === "/v1/pro/reports"
                      ? {
                          meta: META,
                          data: {
                            provenance: DEMO_PROVENANCE,
                            scope: PRO_SCOPE,
                            period: "daily",
                            periodStart: "2026-09-02T00:00:00.000Z",
                            periodEnd: "2026-09-03T00:00:00.000Z",
                            generatedAt: META.generatedAt,
                            sections: [],
                            coverageCaveats: ["No live analysis has been published."],
                          },
                        }
                      : path === "/v1/map"
                        ? EMPTY_MAP
                        : path === "/v1/search" || path === "/v1/nearby"
                          ? { meta: META, data: { results: [] } }
                          : { meta: META, data: {} });

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}
