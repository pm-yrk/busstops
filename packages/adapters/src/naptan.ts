import { z } from "zod";
import type { Coordinate, Provenance, Stop, StopType } from "@busstops/contracts";
import { isPlausibleEnglandCoordinate } from "@busstops/pipeline-core";
import { parseCsv } from "./csv.js";
import { osgb36ToWgs84 } from "./osgb36.js";
import { deterministicUuid } from "./identity.js";

/**
 * NaPTAN adapter — canonical stop identity for England (docs/05_DATA_SOURCES.md).
 *
 * The published CSV carries an OSGB36 grid reference and a WGS84 pair; the WGS84 pair is
 * occasionally blank or zeroed, so the grid reference is used as a fallback rather than
 * dropping the stop. Status and revision are preserved so moved and withdrawn stops can be
 * reconciled instead of silently disappearing.
 */

export const NAPTAN_BASE_URL = "https://naptan.api.dft.gov.uk/v1/access-nodes";

/** Raw CSV row, all values strings as they arrive. Only the fields we consume are required. */
export const NaptanCsvRowSchema = z.object({
  ATCOCode: z.string().min(1),
  NaptanCode: z.string().optional().default(""),
  CommonName: z.string().min(1),
  Indicator: z.string().optional().default(""),
  Street: z.string().optional().default(""),
  Landmark: z.string().optional().default(""),
  Bearing: z.string().optional().default(""),
  NptgLocalityCode: z.string().optional().default(""),
  LocalityName: z.string().optional().default(""),
  ParentLocalityName: z.string().optional().default(""),
  Town: z.string().optional().default(""),
  Easting: z.string().optional().default(""),
  Northing: z.string().optional().default(""),
  Longitude: z.string().optional().default(""),
  Latitude: z.string().optional().default(""),
  StopType: z.string().min(1),
  BusStopType: z.string().optional().default(""),
  TimingStatus: z.string().optional().default(""),
  AdministrativeAreaCode: z.string().optional().default(""),
  ModificationDateTime: z.string().optional().default(""),
  RevisionNumber: z.string().optional().default(""),
  Status: z.string().optional().default("active"),
});
export type NaptanCsvRow = z.infer<typeof NaptanCsvRowSchema>;

/** NaPTAN stop-type codes that represent a bus, coach or tram boarding point. */
const BUS_STOP_TYPES: Record<string, StopType> = {
  BCT: "on_street_bus",
  BCS: "bus_station_bay",
  BCQ: "bus_station_bay",
  BCE: "bus_station_bay",
  BST: "bus_station_bay",
  CCP: "coach_bay",
  CBS: "coach_bay",
  PLT: "tram_stop",
  TMU: "tram_stop",
  MET: "tram_stop",
};

export function isBusRelatedStopType(stopType: string): boolean {
  return stopType.toUpperCase() in BUS_STOP_TYPES;
}

export function mapStopType(stopType: string): StopType {
  return BUS_STOP_TYPES[stopType.toUpperCase()] ?? "other";
}

/** NaPTAN records bearing as a compass letter, not degrees. */
const COMPASS_DEGREES: Record<string, number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

export function parseBearing(value: string): number | undefined {
  const trimmed = value.trim().toUpperCase();
  if (trimmed.length === 0) return undefined;
  if (trimmed in COMPASS_DEGREES) return COMPASS_DEGREES[trimmed];
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric < 360) return Math.round(numeric);
  return undefined;
}

export type NaptanStatus = "active" | "pending" | "deleted";

export function parseStatus(value: string): NaptanStatus {
  const normalized = value.trim().toLowerCase();
  if (normalized === "del" || normalized === "deleted" || normalized === "inactive")
    return "deleted";
  if (normalized === "pending" || normalized === "pen") return "pending";
  return "active";
}

/**
 * Resolves a stop's position, preferring the published WGS84 pair and falling back to the
 * OSGB36 grid reference. Returns null when neither yields a plausible England coordinate,
 * so the caller quarantines the row rather than plotting a bus stop in the sea.
 */
export function resolveCoordinate(row: NaptanCsvRow): Coordinate | null {
  const lat = Number(row.Latitude);
  const lon = Number(row.Longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)) {
    const candidate = { lat, lon };
    if (isPlausibleEnglandCoordinate(candidate)) return candidate;
  }

  const easting = Number(row.Easting);
  const northing = Number(row.Northing);
  if (Number.isFinite(easting) && Number.isFinite(northing) && easting > 0 && northing > 0) {
    const converted = osgb36ToWgs84(easting, northing);
    if (converted && isPlausibleEnglandCoordinate(converted)) return converted;
  }
  return null;
}

export interface NormalizeOptions {
  retrievedAt: string;
  ingestedAt?: string;
  sourceVersion?: string;
}

export interface NaptanNormalizeResult {
  stops: Stop[];
  rejected: Array<{ atcoCode: string; reason: string }>;
  /** Stops NaPTAN marks as deleted, so downstream reconciliation can withdraw them. */
  withdrawnAtcoCodes: string[];
  /** Locality codes seen, used to join against NPTG. */
  localityCodes: Set<string>;
}

export function normalizeNaptanRow(row: NaptanCsvRow, options: NormalizeOptions): Stop | null {
  const coordinate = resolveCoordinate(row);
  if (!coordinate) return null;

  const provenance: Provenance = {
    source: "naptan",
    ...(options.sourceVersion === undefined ? {} : { sourceVersion: options.sourceVersion }),
    retrievedAt: options.retrievedAt,
    externalIds: [
      { source: "naptan", id: row.ATCOCode },
      ...(row.NaptanCode.length > 0 ? [{ source: "naptan_code", id: row.NaptanCode }] : []),
    ],
  };

  const status = parseStatus(row.Status);
  const bearing = parseBearing(row.Bearing);

  return {
    id: deterministicUuid("stop", row.ATCOCode),
    provenance,
    ingestedAt: options.ingestedAt ?? options.retrievedAt,
    qualityFlags: [],
    atcoCode: row.ATCOCode,
    ...(row.NaptanCode.length > 0 ? { naptanCode: row.NaptanCode } : {}),
    name: row.CommonName,
    ...(row.Indicator.length > 0 ? { indicator: row.Indicator } : {}),
    locationCoordinate: coordinate,
    ...(bearing === undefined ? {} : { bearing }),
    stopType: mapStopType(row.StopType),
    localityId:
      row.NptgLocalityCode.length > 0 ? deterministicUuid("locality", row.NptgLocalityCode) : null,
    // Amenities are only populated when a source actually states them; NaPTAN does not.
    amenities: [],
    active: status === "active",
    naptanStatus: status,
    supersededByStopId: null,
  };
}

/** Parses and normalizes a full NaPTAN CSV export, keeping only bus-related stops. */
export function normalizeNaptanCsv(
  csvText: string,
  options: NormalizeOptions,
): NaptanNormalizeResult {
  const rows = parseCsv(csvText);
  const stops: Stop[] = [];
  const rejected: Array<{ atcoCode: string; reason: string }> = [];
  const withdrawnAtcoCodes: string[] = [];
  const localityCodes = new Set<string>();

  for (const raw of rows) {
    const parsed = NaptanCsvRowSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({
        atcoCode: String(raw.ATCOCode ?? "unknown"),
        reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      continue;
    }

    const row = parsed.data;
    if (!isBusRelatedStopType(row.StopType)) continue;

    const status = parseStatus(row.Status);
    if (status === "deleted") {
      withdrawnAtcoCodes.push(row.ATCOCode);
      continue;
    }

    const stop = normalizeNaptanRow(row, options);
    if (!stop) {
      rejected.push({ atcoCode: row.ATCOCode, reason: "no plausible England coordinate" });
      continue;
    }
    stops.push(stop);
    if (row.NptgLocalityCode.length > 0) localityCodes.add(row.NptgLocalityCode);
  }

  return { stops, rejected, withdrawnAtcoCodes, localityCodes };
}

export interface StopReconciliation {
  added: Stop[];
  removed: Stop[];
  moved: Array<{ previous: Stop; current: Stop; movedMetres: number }>;
  renamed: Array<{ previous: Stop; current: Stop }>;
  unchanged: number;
}

/**
 * Weekly full reconciliation against the previous published stop set
 * (docs/07_DATA_PIPELINES.md "Static network"). Reports what changed rather than
 * overwriting silently, so a bad upstream release is visible instead of invisible.
 */
export function reconcileStops(
  previous: readonly Stop[],
  current: readonly Stop[],
  movedThresholdMetres = 25,
  distance: (a: Coordinate, b: Coordinate) => number,
): StopReconciliation {
  const previousByCode = new Map(previous.map((s) => [s.atcoCode, s]));
  const currentByCode = new Map(current.map((s) => [s.atcoCode, s]));

  const added: Stop[] = [];
  const moved: StopReconciliation["moved"] = [];
  const renamed: StopReconciliation["renamed"] = [];
  let unchanged = 0;

  for (const stop of current) {
    const before = previousByCode.get(stop.atcoCode);
    if (!before) {
      added.push(stop);
      continue;
    }
    const movedMetres = distance(before.locationCoordinate, stop.locationCoordinate);
    let changed = false;
    if (movedMetres > movedThresholdMetres) {
      moved.push({ previous: before, current: stop, movedMetres });
      changed = true;
    }
    if (before.name !== stop.name) {
      renamed.push({ previous: before, current: stop });
      changed = true;
    }
    if (!changed) unchanged += 1;
  }

  const removed = previous.filter((s) => !currentByCode.has(s.atcoCode));
  return { added, removed, moved, renamed, unchanged };
}
