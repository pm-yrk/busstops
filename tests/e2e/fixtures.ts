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
    /*
     * A stop where the register says what kind of boarding point it is and nobody has surveyed
     * anything else — which is the commonest real case, and the one the card has to handle
     * without implying the stop is inaccessible.
     */
    accessibility: {
      atcoCode: "450010001",
      facts: [
        {
          key: "shelter",
          status: "yes",
          source: "naptan",
          sourceField: "amenities.shelter",
          sourceUpdatedAt: null,
          provenance: "NaPTAN stop record",
          confidence: "high",
        },
        {
          key: "step_free",
          status: "unknown",
          detail: "An on-street stop, usually a pole or shelter on the pavement",
          source: "naptan",
          sourceField: "StopType",
          sourceUpdatedAt: "2026-01-15T09:00:00.000Z",
          provenance:
            "NaPTAN records the kind of boarding point, not whether the approach to it is step-free.",
          confidence: "high",
        },
      ],
      sourcesConsulted: [
        { source: "naptan", outcome: "had_data" },
        { source: "gtfs_stop", outcome: "not_available" },
        { source: "osm", outcome: "not_available" },
      ],
    },
    disruptions: [],
    /*
     * Rain at the stop, so the vignette in the art bench is the one worth looking at — the
     * umbrella, the near and far rain layers, and advice with the numbers it was chosen from.
     * Real weather is not reproducible on demand and a screenshot of a clear sky proves nothing
     * about the states that have to work.
     */
    weather: {
      cell: "537_-16",
      cellCentre: { lat: 53.75, lon: -1.55 },
      cellSizeDegrees: 0.1,
      current: {
        time: "2026-09-03T09:00:00.000Z",
        temperatureCelsius: 11.4,
        apparentTemperatureCelsius: 8.9,
        precipitationMm: 1.8,
        precipitationProbability: 82,
        weatherCode: 63,
        windSpeedKph: 21,
        windGustKph: 38,
        uvIndex: 1.2,
        isDay: true,
      },
      next: [
        {
          time: "2026-09-03T10:00:00.000Z",
          temperatureCelsius: 11.9,
          apparentTemperatureCelsius: 9.4,
          precipitationMm: 0.9,
          precipitationProbability: 61,
          weatherCode: 61,
          windSpeedKph: 19,
          windGustKph: 34,
          uvIndex: 1.6,
          isDay: true,
        },
      ],
      retrievedAt: "2026-09-03T08:55:00.000Z",
      attribution:
        "Weather data by Open-Meteo.com (CC BY 4.0), used under its free non-commercial terms",
    },
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
    degraded: false,
    degradationReason: null,
  },
};

/**
 * A viewport with buses in it.
 *
 * Lives here rather than in the bench that uses it so the contract test parses it. It did not,
 * once, and the map fixture went on missing `disruptions` for as long as it took someone to look
 * at a screenshot: the bench asserted that every sprite loaded, a page in its error state has no
 * sprites, and so it passed over a live map that said "Something went wrong".
 */
export const MAP_WITH_TRAFFIC = {
  meta: META,
  data: {
    stops: [
      {
        id: "00000000-0000-5000-8000-0000000000d1",
        atcoCode: "450010001",
        name: "Boar Lane",
        indicator: "Stand A",
        coordinate: { lat: 53.7965, lon: -1.5445 },
        routePublicNames: ["36"],
        hasLiveCoverage: true,
      },
      {
        id: "00000000-0000-5000-8000-0000000000d2",
        atcoCode: "450010002",
        name: "City Square",
        indicator: "B",
        coordinate: { lat: 53.7952, lon: -1.5478 },
        routePublicNames: ["12"],
        hasLiveCoverage: true,
      },
      {
        id: "00000000-0000-5000-8000-0000000000d3",
        atcoCode: "450010003",
        name: "Park Row",
        coordinate: { lat: 53.7988, lon: -1.5462 },
        routePublicNames: [],
        hasLiveCoverage: false,
      },
    ],
    vehicles: [
      {
        vehicleRef: "v1",
        coordinate: { lat: 53.7972, lon: -1.5432 },
        bearingDegrees: 90,
        routePublicName: "36",
        routeId: "00000000-0000-5000-8000-0000000000e1",
        routePatternId: "00000000-0000-5000-8000-0000000000f1",
        destinationName: "Ripon",
        delaySeconds: 60,
        freshnessSeconds: 20,
        motionState: "moving" as const,
      },
      {
        vehicleRef: "v2",
        coordinate: { lat: 53.7944, lon: -1.5495 },
        bearingDegrees: 260,
        routePublicName: "12",
        routeId: "00000000-0000-5000-8000-0000000000e2",
        routePatternId: null,
        destinationName: "Beeston",
        delaySeconds: null,
        freshnessSeconds: 40,
        motionState: "moving" as const,
      },
      {
        // Old enough to be drawn as a stale vehicle rather than a fresh one.
        vehicleRef: "v3",
        coordinate: { lat: 53.7995, lon: -1.543 },
        bearingDegrees: 10,
        routePublicName: "X84",
        // Null on purpose: the viewport could not say which operator's X84 this is, and the map
        // must show it without offering a link to somebody else's route.
        routeId: null,
        routePatternId: null,
        destinationName: "Otley",
        delaySeconds: null,
        freshnessSeconds: 900,
        motionState: "stationary" as const,
      },
    ],
    incidents: [],
    disruptions: [],
    truncated: { stops: false, vehicles: false, incidents: false },
    degraded: false,
    degradationReason: null,
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

/**
 * A disruptions board with both layers present and neither claiming the other's authority.
 *
 * An empty `{ data: {} }` fallback would have rendered a page that had crashed on a missing array,
 * and an accessibility pass over a crashed page proves nothing. This gives the page one official
 * notice, one ranked item, a source that answered and a source that did not, and an uncovered
 * area — every branch the page draws differently.
 */
export const DISRUPTIONS_RESPONSE = {
  meta: META,
  data: {
    official: [
      {
        id: "bods-situation-nh-1",
        source: "bods_situations",
        sourceRef: "NH-1",
        publisher: "First West Yorkshire",
        officialStatus: "official",
        lifecycle: "open",
        severity: "moderate",
        summary: "A64 eastbound closed for resurfacing",
        description: "One carriageway is closed between junctions overnight.",
        advice: "Allow extra time; services 36 and X99 are diverted via the ring road.",
        reason: { category: "EnvironmentReason", value: "Road works" },
        startsAt: "2026-09-03T07:00:00.000Z",
        endsAt: null,
        updatedAt: "2026-09-03T07:05:00.000Z",
        affectedRoutes: [],
        affectedStops: [],
        affectedAreas: ["Leeds city centre"],
        infoLinks: [],
        attribution: "First West Yorkshire, via the Bus Open Data Service",
        provenance: {
          source: "bods",
          retrievedAt: "2026-09-03T08:00:00.000Z",
          externalIds: [],
        },
      },
    ],
    sourcesQueried: [
      {
        source: "bods_situations",
        outcome: "ok",
        records: 1,
        queriedAt: "2026-09-03T08:00:00.000Z",
      },
      {
        source: "tfl_status",
        outcome: "not_configured",
        records: 0,
        queriedAt: "2026-09-03T08:00:00.000Z",
      },
    ],
    officialCollectedAt: "2026-09-03T08:00:00.000Z",
    byDelayBurden: [],
    byAbnormality: [],
    uncoveredAreas: ["Cornwall", "Cumbria"],
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
                      : path === "/v1/disruptions"
                        ? DISRUPTIONS_RESPONSE
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
