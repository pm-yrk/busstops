import type { Incident } from "@busstops/contracts";
import { deterministicUuid } from "@busstops/adapters";

/**
 * The Bus Stops Pro demonstration snapshot.
 *
 * THIS IS NOT LIVE DATA. It is a fixed, dated snapshot used only when no live national analytics
 * artifact has been published, so that the public Pro demo is explorable without a sign-in wall
 * and without pretending to be live. Every response built from it carries
 * `dataMode: "demo_snapshot"`, the snapshot's date, and a notice the UI must display.
 *
 * The specification permits exactly this and nothing more: "real public data or a conspicuously
 * labelled dated snapshot if live national analytics are unavailable". It must never be merged
 * with live figures, never be relabelled, and never be reached when live analytics exist.
 */

export const DEMO_SNAPSHOT_DATE = "2026-08-14";

export const DEMO_SNAPSHOT_NOTICE =
  `Demonstration snapshot from ${DEMO_SNAPSHOT_DATE}. These figures are a fixed historical example, not live data, ` +
  `and are shown because no live national analysis has been published to this deployment yet.`;

export interface DemoSegment {
  segmentId: string;
  name: string;
  coordinate: { lat: number; lon: number };
  direction: string;
  timeWindow: string;
  currentSeconds: number;
  typicalSeconds: number;
  excessVehicleMinutes: number;
  affectedRouteNames: string[];
  affectedVehicleCount: number;
  occurrenceFrequency: number;
  occurrenceSample: number;
  corroboration: string[];
}

export interface DemoRoute {
  routeId: string;
  routeName: string;
  operatorId: string;
  operatorName: string;
  punctualityPercent: number;
  punctualityDenominator: number;
  reliabilityPercent: number;
  reliabilityDenominator: number;
  medianDelaySeconds: number;
  headwayAdherencePercent: number | null;
  headwayDenominator: number;
  worstCorridor: string;
  worstTimeWindow: string;
  weatherSensitivity: string | null;
}

export interface DemoOperator {
  operatorId: string;
  operatorName: string;
  punctualityPercent: number;
  denominator: number;
  contextAdjustedPercent: number;
  contextFactors: string[];
  coverageCaveats: string[];
  rankingEligible: boolean;
  rankingIneligibleReason: string | null;
}

function incident(input: {
  key: string;
  type: Incident["type"];
  severity: Incident["severity"];
  narrative: string;
  startedAt: string;
  corridorId: string;
  official: boolean;
  confidenceScore: number;
  reasons: string[];
}): Incident {
  return {
    id: deterministicUuid("incident", `demo|${input.key}`),
    provenance: {
      source: "bods",
      retrievedAt: `${DEMO_SNAPSHOT_DATE}T08:30:00.000Z`,
      externalIds: [],
    },
    ingestedAt: `${DEMO_SNAPSHOT_DATE}T08:30:00.000Z`,
    qualityFlags: input.confidenceScore < 0.45 ? ["low_confidence"] : ["ok"],
    type: input.type,
    startedAt: input.startedAt,
    endedAt: null,
    geometry: { corridorId: input.corridorId },
    affectedRouteIds: [],
    affectedVehicleRefs: [],
    severity: input.severity,
    confidence: {
      level:
        input.confidenceScore >= 0.7 ? "high" : input.confidenceScore >= 0.45 ? "medium" : "low",
      score: input.confidenceScore,
      reasons: input.reasons,
    },
    evidence: [],
    officialStatus: input.official ? "official" : "derived",
    lifecycle: "active",
    narrative: input.narrative,
  };
}

export const DEMO_INCIDENTS: Incident[] = [
  incident({
    key: "a58-congestion",
    type: "congestion",
    severity: "abnormal",
    narrative:
      "Journeys along the A58 into Leeds are taking about nine minutes longer than usual for a Thursday morning.",
    startedAt: `${DEMO_SNAPSHOT_DATE}T07:20:00.000Z`,
    corridorId: "corridor-a58-leeds",
    official: false,
    confidenceScore: 0.78,
    reasons: ["41 traversals across 6 routes", "consistent across the last four intervals"],
  }),
  incident({
    key: "m621-roadworks",
    type: "road_closure",
    severity: "abnormal",
    narrative:
      "A lane closure is in force on the M621 near junction 3, published by National Highways.",
    startedAt: `${DEMO_SNAPSHOT_DATE}T05:00:00.000Z`,
    corridorId: "corridor-m621-j3",
    official: true,
    confidenceScore: 0.95,
    reasons: ["published by National Highways"],
  }),
  incident({
    key: "route-72-bunching",
    type: "bunching",
    severity: "elevated",
    narrative:
      "Two buses on route 72 have been running close together towards Bradford for the last twenty minutes.",
    startedAt: `${DEMO_SNAPSHOT_DATE}T08:05:00.000Z`,
    corridorId: "corridor-a647",
    official: false,
    confidenceScore: 0.62,
    reasons: ["5 reliable position pairs", "gap closing over three consecutive intervals"],
  }),
  incident({
    key: "route-16-gap",
    type: "service_gap",
    severity: "abnormal",
    narrative:
      "No bus has been observed on route 16 towards the city centre for 38 minutes, against a scheduled 12-minute frequency.",
    startedAt: `${DEMO_SNAPSHOT_DATE}T08:00:00.000Z`,
    corridorId: "corridor-dewsbury-road",
    official: false,
    confidenceScore: 0.71,
    reasons: ["feed healthy throughout the gap", "three scheduled journeys unobserved"],
  }),
  incident({
    key: "route-6-diversion",
    type: "diversion",
    severity: "elevated",
    narrative:
      "Buses on route 6 appear to have taken a different route around Headingley for the last four journeys.",
    startedAt: `${DEMO_SNAPSHOT_DATE}T07:45:00.000Z`,
    corridorId: "corridor-otley-road",
    official: false,
    confidenceScore: 0.58,
    reasons: ["4 consecutive journeys off the published shape", "no official closure published"],
  }),
];

export const DEMO_SEGMENTS: DemoSegment[] = [
  {
    segmentId: "seg-a58-leeds-inbound",
    name: "A58 Regent Street, inbound",
    coordinate: { lat: 53.8021, lon: -1.5312 },
    direction: "inbound",
    timeWindow: "07:30–08:30",
    currentSeconds: 512,
    typicalSeconds: 318,
    excessVehicleMinutes: 132.7,
    affectedRouteNames: ["16", "49", "50", "72"],
    affectedVehicleCount: 41,
    occurrenceFrequency: 0.07,
    occurrenceSample: 44,
    corroboration: ["Permitted street works 180m away, active during this period"],
  },
  {
    segmentId: "seg-a647-bradford-road",
    name: "A647 Bradford Road, westbound",
    coordinate: { lat: 53.7994, lon: -1.6221 },
    direction: "westbound",
    timeWindow: "07:30–08:30",
    currentSeconds: 447,
    typicalSeconds: 402,
    excessVehicleMinutes: 88.4,
    affectedRouteNames: ["72", "X6"],
    affectedVehicleCount: 29,
    occurrenceFrequency: 0.41,
    occurrenceSample: 44,
    corroboration: [],
  },
  {
    segmentId: "seg-dewsbury-road",
    name: "Dewsbury Road, northbound",
    coordinate: { lat: 53.7728, lon: -1.5471 },
    direction: "northbound",
    timeWindow: "07:30–08:30",
    currentSeconds: 286,
    typicalSeconds: 199,
    excessVehicleMinutes: 41.2,
    affectedRouteNames: ["13", "16"],
    affectedVehicleCount: 18,
    occurrenceFrequency: 0.11,
    occurrenceSample: 44,
    corroboration: ["An active road event 420m away overlapping this period"],
  },
  {
    segmentId: "seg-m621-j3",
    name: "M621 approaching junction 3",
    coordinate: { lat: 53.7871, lon: -1.5602 },
    direction: "eastbound",
    timeWindow: "07:30–08:30",
    currentSeconds: 205,
    typicalSeconds: 141,
    excessVehicleMinutes: 33.9,
    affectedRouteNames: ["X6", "229"],
    affectedVehicleCount: 12,
    occurrenceFrequency: 0.23,
    occurrenceSample: 44,
    corroboration: ["An active road event 210m away overlapping this period"],
  },
];

export const DEMO_ROUTES: DemoRoute[] = [
  {
    routeId: "demo-route-72",
    routeName: "72",
    operatorId: "demo-operator-first",
    operatorName: "First West Yorkshire",
    punctualityPercent: 0.71,
    punctualityDenominator: 486,
    reliabilityPercent: 0.94,
    reliabilityDenominator: 512,
    medianDelaySeconds: 214,
    headwayAdherencePercent: 0.63,
    headwayDenominator: 198,
    worstCorridor: "A647 Bradford Road, westbound",
    worstTimeWindow: "07:30–08:30 on weekdays",
    weatherSensitivity:
      "Journeys here are associated with being about 8% slower in wet weather, compared with dry conditions at the same times. This is an association, not a demonstrated cause.",
  },
  {
    routeId: "demo-route-16",
    routeName: "16",
    operatorId: "demo-operator-first",
    operatorName: "First West Yorkshire",
    punctualityPercent: 0.64,
    punctualityDenominator: 391,
    reliabilityPercent: 0.89,
    reliabilityDenominator: 438,
    medianDelaySeconds: 302,
    headwayAdherencePercent: 0.52,
    headwayDenominator: 164,
    worstCorridor: "Dewsbury Road, northbound",
    worstTimeWindow: "16:30–18:00 on weekdays",
    weatherSensitivity: null,
  },
  {
    routeId: "demo-route-x6",
    routeName: "X6",
    operatorId: "demo-operator-arriva",
    operatorName: "Arriva Yorkshire",
    punctualityPercent: 0.83,
    punctualityDenominator: 212,
    reliabilityPercent: 0.97,
    reliabilityDenominator: 224,
    medianDelaySeconds: 96,
    headwayAdherencePercent: null,
    headwayDenominator: 11,
    worstCorridor: "M621 approaching junction 3",
    worstTimeWindow: "07:00–08:00 on weekdays",
    weatherSensitivity: null,
  },
  {
    routeId: "demo-route-6",
    routeName: "6",
    operatorId: "demo-operator-arriva",
    operatorName: "Arriva Yorkshire",
    punctualityPercent: 0.78,
    punctualityDenominator: 14,
    reliabilityPercent: 0.93,
    reliabilityDenominator: 15,
    medianDelaySeconds: 141,
    headwayAdherencePercent: null,
    headwayDenominator: 4,
    worstCorridor: "Otley Road, northbound",
    worstTimeWindow: "08:00–09:00 on weekdays",
    weatherSensitivity: null,
  },
];

export const DEMO_OPERATORS: DemoOperator[] = [
  {
    operatorId: "demo-operator-first",
    operatorName: "First West Yorkshire",
    punctualityPercent: 0.68,
    denominator: 877,
    contextAdjustedPercent: 0.74,
    contextFactors: [
      "Higher share of city-centre journeys, which run slower for reasons outside the operator's control",
      "Greater exposure to the A58 and A647 corridors during the morning peak",
    ],
    coverageCaveats: [
      "Services outside London are covered by the Bus Open Data Service, whose completeness varies by operator.",
    ],
    rankingEligible: true,
    rankingIneligibleReason: null,
  },
  {
    operatorId: "demo-operator-arriva",
    operatorName: "Arriva Yorkshire",
    punctualityPercent: 0.82,
    denominator: 226,
    contextAdjustedPercent: 0.79,
    contextFactors: [
      "Higher share of inter-urban journeys, which are less exposed to city-centre congestion",
    ],
    coverageCaveats: [
      "Services outside London are covered by the Bus Open Data Service, whose completeness varies by operator.",
    ],
    rankingEligible: true,
    rankingIneligibleReason: null,
  },
  {
    operatorId: "demo-operator-small",
    operatorName: "Yorkshire Tiger",
    punctualityPercent: 0.91,
    denominator: 12,
    contextAdjustedPercent: 0.9,
    contextFactors: [],
    coverageCaveats: [
      "Only a small number of this operator's journeys report positions, so most of its service is unmeasured.",
    ],
    rankingEligible: false,
    rankingIneligibleReason:
      "Only 12 comparable observations. At least 20 are needed before this operator can be compared with others, and comparing it now would be misleading rather than merely imprecise.",
  },
];

export const DEMO_SOURCE_HEALTH = [
  { source: "bods", status: "healthy", detail: "Last successful fetch 18 seconds ago" },
  { source: "tfl", status: "healthy", detail: "Last successful fetch 24 seconds ago" },
  { source: "naptan", status: "healthy", detail: "Rebuilt this morning" },
  {
    source: "street_manager",
    status: "degraded",
    detail: "Two consecutive failures; permitted works may be incomplete",
  },
  {
    source: "national_highways",
    status: "stale",
    detail: "Last successful fetch 41 minutes ago, against a 5 minute target",
  },
];
