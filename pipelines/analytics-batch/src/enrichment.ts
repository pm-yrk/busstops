import type { Confidence, Coordinate, FloodNotice, RoadEvent } from "@busstops/contracts";
import { haversineMetres, tileKey } from "@busstops/pipeline-core";

/**
 * Enrichment joins (docs/07_DATA_PIPELINES.md "Enrichment").
 *
 * Three rules are enforced structurally here rather than left to wording downstream:
 *
 *  - Every join states its distance and time window and carries a match confidence. A road event
 *    "near" a segment means nothing without the number; 40 metres and 4 kilometres are different
 *    claims and must not both be reported as "nearby".
 *  - National Highways covers motorways and trunk roads. Its silence about a local street is not
 *    evidence that the street is clear, so a segment off the strategic network is marked as not
 *    covered rather than as having no incidents.
 *  - Street Manager records are evidence that works were planned or active, never proof that they
 *    caused a delay. The join returns corroboration, and the type name says so.
 */

export const ENRICHMENT_DEFAULTS = {
  /** Maximum distance for a road event to corroborate a segment observation. */
  roadEventRadiusMetres: 500,
  /** Maximum distance for a flood notice to be considered relevant to a segment. */
  floodRadiusMetres: 2000,
  /** Temporal tolerance either side of the observation window. */
  timeToleranceSeconds: 900,
  /** Weather is cached on this grid; finer would multiply requests for no analytical gain. */
  weatherGridDegrees: 0.25,
  /** Weather cache lifetime: Open-Meteo publishes hourly, so a shorter TTL buys nothing. */
  weatherCacheSeconds: 3600,
} as const;

export interface Corroboration<T> {
  record: T;
  distanceMetres: number;
  /** Signed seconds between the record's window and the observation; 0 when they overlap. */
  temporalGapSeconds: number;
  matchConfidence: number;
  /** Plain statement of what was matched and how, for display next to the claim. */
  basis: string;
}

function temporalGapSeconds(
  observationStart: Date,
  observationEnd: Date,
  recordStart: string,
  recordEnd: string | null,
): number {
  const start = new Date(recordStart).getTime();
  const end = recordEnd === null ? Number.POSITIVE_INFINITY : new Date(recordEnd).getTime();
  if (observationEnd.getTime() >= start && observationStart.getTime() <= end) return 0;
  if (observationEnd.getTime() < start) return (start - observationEnd.getTime()) / 1000;
  return (observationStart.getTime() - end) / 1000;
}

function proximityConfidence(distanceMetres: number, radiusMetres: number): number {
  return Math.max(0, 1 - distanceMetres / radiusMetres);
}

function describeProximity(event: RoadEvent, distanceMetres: number): string {
  return event.coordinate
    ? `${Math.round(distanceMetres)}m away`
    : `on the same corridor (${event.corridorId ?? "unknown"})`;
}

export interface RoadEventJoinOptions {
  radiusMetres?: number;
  timeToleranceSeconds?: number;
  /** Whether this segment is on the strategic road network National Highways reports on. */
  onStrategicRoadNetwork: boolean;
  /** Corridor this segment belongs to, used for events published without a coordinate. */
  corridorId?: string;
}

export interface RoadEventJoinResult {
  corroborations: Corroboration<RoadEvent>[];
  /**
   * False when the segment is outside the source's coverage. Distinct from "no events found":
   * absence of evidence is not evidence of absence, and the UI must say which it has.
   */
  covered: boolean;
  coverageNote: string;
}

export function joinRoadEvents(
  segmentPoint: Coordinate,
  observationStart: Date,
  observationEnd: Date,
  events: readonly RoadEvent[],
  options: RoadEventJoinOptions,
): RoadEventJoinResult {
  const radius = options.radiusMetres ?? ENRICHMENT_DEFAULTS.roadEventRadiusMetres;
  const tolerance = options.timeToleranceSeconds ?? ENRICHMENT_DEFAULTS.timeToleranceSeconds;

  if (!options.onStrategicRoadNetwork) {
    return {
      corroborations: [],
      covered: false,
      coverageNote:
        "This location is not on the strategic road network, which is the only part National Highways reports on. No incident data is available here either way.",
    };
  }

  const corroborations: Corroboration<RoadEvent>[] = [];
  for (const event of events) {
    // Events located only by corridor are joined by corridor, not guessed onto a coordinate.
    const distanceMetres = event.coordinate
      ? haversineMetres(segmentPoint, event.coordinate)
      : options.corridorId && event.corridorId === options.corridorId
        ? 0
        : null;
    if (distanceMetres === null || distanceMetres > radius) continue;

    const gap = temporalGapSeconds(
      observationStart,
      observationEnd,
      event.startedAt,
      event.endedAt,
    );
    if (gap > tolerance) continue;

    const temporalConfidence = gap === 0 ? 1 : Math.max(0, 1 - gap / tolerance);
    corroborations.push({
      record: event,
      distanceMetres,
      temporalGapSeconds: gap,
      matchConfidence: proximityConfidence(distanceMetres, radius) * temporalConfidence,
      basis:
        gap === 0
          ? `an active road event ${describeProximity(event, distanceMetres)} overlapping this period`
          : `a road event ${describeProximity(event, distanceMetres)}, ${Math.round(gap / 60)} minutes outside this period`,
    });
  }

  corroborations.sort((a, b) => b.matchConfidence - a.matchConfidence);
  return {
    corroborations,
    covered: true,
    coverageNote:
      corroborations.length === 0
        ? "No road events were reported near here during this period."
        : `${corroborations.length} road event${corroborations.length === 1 ? "" : "s"} reported within ${radius}m.`,
  };
}

export interface StreetWorksCorroboration {
  corroborations: Corroboration<RoadEvent>[];
  /** Deliberately named to prevent the result being read as a cause. */
  statement: string;
}

/**
 * Street Manager join. The return type carries no "cause" field and the statement never claims
 * one, because permit records prove only that works were permitted, not that they delayed a bus.
 */
export function joinStreetWorks(
  segmentPoint: Coordinate,
  observationStart: Date,
  observationEnd: Date,
  works: readonly RoadEvent[],
  radiusMetres = ENRICHMENT_DEFAULTS.roadEventRadiusMetres,
): StreetWorksCorroboration {
  const corroborations: Corroboration<RoadEvent>[] = [];
  for (const work of works) {
    if (!work.coordinate) continue;
    const distanceMetres = haversineMetres(segmentPoint, work.coordinate);
    if (distanceMetres > radiusMetres) continue;
    const gap = temporalGapSeconds(observationStart, observationEnd, work.startedAt, work.endedAt);
    if (gap > 0) continue;
    corroborations.push({
      record: work,
      distanceMetres,
      temporalGapSeconds: 0,
      matchConfidence: proximityConfidence(distanceMetres, radiusMetres),
      basis: `permitted street works ${Math.round(distanceMetres)}m away, active during this period`,
    });
  }
  corroborations.sort((a, b) => b.matchConfidence - a.matchConfidence);

  return {
    corroborations,
    statement:
      corroborations.length === 0
        ? "No permitted street works were active near here during this period."
        : `${corroborations.length} permitted street works ${corroborations.length === 1 ? "site was" : "sites were"} active within ${radiusMetres}m during this period. This is context, not a demonstrated cause of any delay.`,
  };
}

export interface FloodJoinResult {
  notices: Corroboration<FloodNotice>[];
  /** Only true when an Environment Agency notice is genuinely in force. */
  officialNoticeActive: boolean;
  highestSeverity: FloodNotice["severity"] | null;
}

export function joinFloodNotices(
  floodAreaIds: readonly string[],
  at: Date,
  notices: readonly FloodNotice[],
): FloodJoinResult {
  // Environment Agency notices are published against a licensed flood area, not a point, so the
  // spatial join is area membership. Inventing a radius around a notice would be our own
  // guess presented with the authority of an official warning.
  const areas = new Set(floodAreaIds);
  const matched: Corroboration<FloodNotice>[] = [];
  for (const notice of notices) {
    if (!areas.has(notice.eaFloodAreaId)) continue;
    const gap = temporalGapSeconds(at, at, notice.raisedAt, notice.activeUntil);
    if (gap > 0) continue;
    matched.push({
      record: notice,
      distanceMetres: 0,
      temporalGapSeconds: 0,
      matchConfidence: 1,
      basis: `an Environment Agency ${notice.severity.replace("_", " ")} in force for flood area ${notice.eaFloodAreaId}, which this route passes through`,
    });
  }
  matched.sort((a, b) => b.matchConfidence - a.matchConfidence);

  const order: Record<FloodNotice["severity"], number> = {
    alert: 1,
    warning: 2,
    severe_warning: 3,
  };
  const highest =
    matched.length === 0
      ? null
      : matched.reduce((worst, candidate) =>
          order[candidate.record.severity] > order[worst.record.severity] ? candidate : worst,
        ).record.severity;

  return {
    notices: matched,
    officialNoticeActive: matched.length > 0,
    highestSeverity: highest,
  };
}

export interface WeatherCacheKey {
  gridKey: string;
  hourKey: string;
}

/**
 * Weather is cached on a coarse space/time grid, as the specification requires. Every segment in
 * a city shares one cell: asking for a forecast per segment would multiply requests by thousands
 * for a variable that does not meaningfully differ across a few kilometres.
 */
export function weatherCacheKey(
  coordinate: Coordinate,
  at: Date,
  gridDegrees = ENRICHMENT_DEFAULTS.weatherGridDegrees,
): WeatherCacheKey {
  const hour = new Date(at);
  hour.setUTCMinutes(0, 0, 0);
  return {
    gridKey: tileKey(coordinate, gridDegrees),
    hourKey: hour.toISOString(),
  };
}

export interface ForecastAttribution {
  /** Which model run produced this forecast, so a stale run is visible rather than assumed fresh. */
  forecastRunAt: string;
  leadTimeHours: number;
  confidence: Confidence;
}

/**
 * Forecast uncertainty grows with lead time, and the attribution states which run it came from.
 * A 36-hour-old forecast run presented without its age would look identical to a fresh one.
 */
export function describeForecast(forecastRunAt: string, validAt: Date): ForecastAttribution {
  const leadTimeHours = Math.max(
    0,
    (validAt.getTime() - new Date(forecastRunAt).getTime()) / 3_600_000,
  );
  const score =
    leadTimeHours <= 6 ? 0.85 : leadTimeHours <= 24 ? 0.65 : leadTimeHours <= 48 ? 0.45 : 0.25;
  return {
    forecastRunAt,
    leadTimeHours,
    confidence: {
      level: score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low",
      score,
      reasons: [
        `forecast run ${new Date(forecastRunAt).toISOString()} with a lead time of ${Math.round(leadTimeHours)} hours`,
      ],
    },
  };
}
